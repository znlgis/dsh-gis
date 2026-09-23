/** Shared shapes the format readers produce before gis-core normalizes them. */
import type { Bbox, CrsInfo, EncodingInfo, FieldInfo, GisIssue } from '@znlgis/dsh-gis-core'
import type { GeoJsonGeometry } from './wkt.ts'

/** One feature as a reader hands it over, geometry still in GeoJSON form. */
export interface RawFeature {
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>
  readonly geometry?: GeoJsonGeometry
}

/** Everything one reader learned from a source. */
export interface ReadResult {
  readonly features: readonly RawFeature[]
  readonly fields: readonly FieldInfo[]
  readonly crs: CrsInfo
  readonly encoding?: EncodingInfo
  /** Dominant GeoJSON geometry type, when the source declared or implied one. */
  readonly geometryType?: string
  /** Extent of the coordinates as read, in the source CRS. */
  readonly bbox?: Bbox
  readonly issues: readonly GisIssue[]
  /** Total features known without a full scan, when the source can say. */
  readonly totalCount?: number
}

/**
 * Fold a bbox over one geometry's coordinates.
 * @param current - accumulated extent, or undefined on the first geometry.
 * @param geometry - the geometry to include.
 * @returns the widened extent.
 */
export function extendBbox(current: Bbox | undefined, geometry: GeoJsonGeometry): Bbox | undefined {
  let west = Number.POSITIVE_INFINITY
  let south = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  let north = Number.NEGATIVE_INFINITY
  let seen = false
  visit(geometry, (position) => {
    const [x, y] = position
    if (typeof x !== 'number' || typeof y !== 'number') return
    seen = true
    if (x < west) west = x
    if (y < south) south = y
    if (x > east) east = x
    if (y > north) north = y
  })
  if (!seen) return current
  return current === undefined
    ? [west, south, east, north]
    : [Math.min(current[0], west), Math.min(current[1], south), Math.max(current[2], east), Math.max(current[3], north)]
}

/**
 * Visit every position of a geometry.
 * @param geometry - geometry to walk.
 * @param onPosition - called once per coordinate tuple.
 */
export function visit(geometry: GeoJsonGeometry, onPosition: (position: readonly number[]) => void): void {
  const type = geometry.type
  const coordinates = geometry.coordinates as unknown
  if (type === 'GeometryCollection') {
    for (const child of (geometry.geometries as GeoJsonGeometry[] | undefined) ?? []) visit(child, onPosition)
    return
  }
  if (type === 'Point') { onPosition(coordinates as number[]); return }
  if (type === 'LineString' || type === 'MultiPoint') {
    for (const position of coordinates as number[][]) onPosition(position)
    return
  }
  if (type === 'Polygon' || type === 'MultiLineString') {
    for (const ring of coordinates as number[][][]) for (const position of ring) onPosition(position)
    return
  }
  if (type === 'MultiPolygon') {
    for (const polygon of coordinates as number[][][][]) for (const ring of polygon) for (const position of ring) onPosition(position)
  }
}
