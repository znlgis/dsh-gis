/**
 * GeoJSON and NDJSON reading.
 *
 * RFC 7946 fixes WGS84 and longitude-first order, and removes the 2008 CRS
 * member -- but real files violate all three. We therefore DETECT rather than
 * assume, and we report what we saw instead of silently reprojecting: an
 * out-of-range coordinate is flagged with its raw extent as a HEURISTIC, not
 * asserted to be a projected CRS (a metres-valued coordinate can land inside
 * the degree range by accident). See design 7.4.
 */
import type { Bbox, CrsInfo, GisIssue } from '@znlgis/dsh-gis-core'
import type { GeoJsonGeometry } from './wkt.ts'
import { extendBbox, type RawFeature, type ReadResult } from './shared.ts'

const DEGREE_RANGE = { x: 180, y: 90 } as const

/**
 * Read a GeoJSON document.
 * @param text - the whole file as text.
 * @returns features, metadata, and any issues found.
 * @throws Error when the text is not valid JSON or not a GeoJSON shape we read.
 */
export function readGeoJson(text: string): ReadResult {
  const parsed: unknown = JSON.parse(text)
  return fromGeoJsonValue(parsed)
}

/**
 * Read newline-delimited GeoJSON: one Feature (or geometry) per line.
 * @param text - the whole file as text.
 * @returns features, metadata, and any issues found.
 */
export function readNdjson(text: string): ReadResult {
  const features: RawFeature[] = []
  const issues: GisIssue[] = []
  let bbox: Bbox | undefined
  let geometryType: string | undefined
  let skipped = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const one = fromGeoJsonValue(JSON.parse(trimmed))
      for (const feature of one.features) {
        features.push(feature)
        if (feature.geometry !== undefined) {
          bbox = extendBbox(bbox, feature.geometry)
          geometryType ??= feature.geometry.type
        }
      }
    } catch {
      skipped += 1
    }
  }
  if (skipped > 0) {
    issues.push({
      code: 'PARSE_FAILED',
      message: `${String(skipped)} line(s) were not valid GeoJSON and were skipped`,
      count: skipped,
    })
  }
  const rangeIssue = rangeWarning(bbox)
  if (rangeIssue !== undefined) issues.push(rangeIssue)
  return {
    features,
    fields: inferFields(features),
    crs: { source: 'assumed-rfc7946', epsg: 4326 },
    ...(geometryType === undefined ? {} : { geometryType }),
    ...(bbox === undefined ? {} : { bbox }),
    issues,
    totalCount: features.length,
  }
}

/** Normalize any accepted GeoJSON root into features. */
function fromGeoJsonValue(parsed: unknown): ReadResult {
  if (parsed === null || typeof parsed !== 'object') throw new Error('GeoJSON root must be an object')
  const root = parsed as Record<string, unknown>
  const issues: GisIssue[] = []
  const features: RawFeature[] = []

  const legacyCrs = root.crs
  const crs: CrsInfo = legacyCrs === undefined
    ? { source: 'assumed-rfc7946', epsg: 4326 }
    : { source: 'native', name: describeLegacyCrs(legacyCrs) }
  if (legacyCrs !== undefined) {
    issues.push({
      code: 'CRS_AMBIGUOUS',
      message: 'the document declares a CRS with the obsolete 2008 "crs" member; RFC 7946 data is WGS84',
    })
  }

  switch (root.type) {
    case 'FeatureCollection': {
      const list = (root.features as unknown[] | undefined) ?? []
      for (const entry of list) features.push(toFeature(entry))
      break
    }
    case 'Feature':
      features.push(toFeature(root))
      break
    case 'GeometryCollection':
    case 'Point': case 'MultiPoint': case 'LineString': case 'MultiLineString':
    case 'Polygon': case 'MultiPolygon':
      features.push({ attributes: {}, geometry: root as GeoJsonGeometry })
      break
    default:
      throw new Error(`unsupported GeoJSON root type: ${String(root.type)}`)
  }

  let bbox: Bbox | undefined
  let geometryType: string | undefined
  for (const feature of features) {
    if (feature.geometry === undefined) continue
    bbox = extendBbox(bbox, feature.geometry)
    geometryType ??= feature.geometry.type
  }
  const rangeIssue = rangeWarning(bbox)
  if (rangeIssue !== undefined) issues.push(rangeIssue)

  return {
    features,
    fields: inferFields(features),
    crs,
    ...(geometryType === undefined ? {} : { geometryType }),
    ...(bbox === undefined ? {} : { bbox }),
    issues,
    totalCount: features.length,
  }
}

/** One GeoJSON Feature (or bare geometry) into a RawFeature. */
function toFeature(entry: unknown): RawFeature {
  if (entry === null || typeof entry !== 'object') throw new Error('GeoJSON feature must be an object')
  const record = entry as Record<string, unknown>
  const geometry = record.geometry
  const properties = record.properties
  return {
    attributes: (properties !== null && typeof properties === 'object' ? properties : {}) as RawFeature['attributes'],
    ...(geometry !== null && typeof geometry === 'object'
      ? { geometry: geometry as GeoJsonGeometry }
      : {}),
  }
}

/**
 * Flag coordinates outside the degree range.
 *
 * Deliberately a WARNING carrying the raw extent, never a hard 'this is
 * projected' assertion: the test is a heuristic that both false-positives and
 * false-negatives.
 */
function rangeWarning(bbox: Bbox | undefined): GisIssue | undefined {
  if (bbox === undefined) return undefined
  const [w, s, e, n] = bbox
  const outside = Math.abs(w) > DEGREE_RANGE.x || Math.abs(e) > DEGREE_RANGE.x
    || Math.abs(s) > DEGREE_RANGE.y || Math.abs(n) > DEGREE_RANGE.y
  if (!outside) return undefined
  return {
    code: 'CRS_AMBIGUOUS',
    message: `coordinates exceed the degree range (raw extent [${w}, ${s}, ${e}, ${n}]), so the data is probably NOT WGS84; supply the real CRS before measuring or overlaying`,
  }
}

/** Best-effort field list from attribute keys. */
function inferFields(features: readonly RawFeature[]) {
  const types = new Map<string, string>()
  for (const feature of features.slice(0, 200)) {
    for (const [key, value] of Object.entries(feature.attributes)) {
      if (types.has(key)) continue
      types.set(key, value === null ? 'Null' : typeof value === 'number' ? 'Number' : typeof value === 'boolean' ? 'Boolean' : 'String')
    }
  }
  return [...types].map(([name, type]) => ({ name, type }))
}

/** One-line description of an obsolete `crs` member. */
function describeLegacyCrs(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const properties = (value as Record<string, unknown>).properties
    if (properties !== null && typeof properties === 'object') {
      const name = (properties as Record<string, unknown>).name
      if (typeof name === 'string') return name
    }
  }
  return 'declared by the document'
}
