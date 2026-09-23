/**
 * The pure-JS read handler: filesystem in, gis-core types out.
 *
 * A dataset is read once and cached by (id, encoding). Because the id already
 * folds in size and mtime, an edited file simply gets a different id -- there is
 * no stale-cache path to get wrong.
 */
import type {
  Dataset, Feature, GisFormatHandler, GisIssue, InspectResult, QueryRequest, QueryResult,
} from '@znlgis/dsh-gis-core'
import { GisError } from '@znlgis/dsh-gis-core'
import {
  extendBbox, parseWkt, readGeoJson, readNdjson, readShapefile, toWkt,
  type GeoJsonGeometry, type RawFeature, type ReadResult,
} from '@znlgis/dsh-gis-formats'
import { readBytes, readText } from './io.ts'
import { compileWhere } from './predicate.ts'

/** Dataset kinds this handler serves. */
const KINDS = ['geojson', 'ndjson', 'wkt', 'shapefile'] as const

/**
 * Build the handler.
 * @returns a handler over the pure-JS readers.
 */
export function createHandler(): GisFormatHandler {
  const cache = new Map<string, ReadResult>()

  /** Read a dataset, or return the cached read. */
  async function load(dataset: Dataset, encoding?: string): Promise<ReadResult> {
    const key = `${dataset.id}|${encoding ?? ''}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const result = await read(dataset, encoding)
    cache.set(key, result)
    return result
  }

  return {
    name: 'gis-purejs',
    kinds: KINDS,

    async inspect(dataset, layer) {
      const result = await load(dataset)
      if (layer !== undefined && !dataset.layers.some(one => one.name === layer)) {
        throw new GisError('LAYER_NOT_FOUND', `dataset ${dataset.id} has no layer named ${layer}`)
      }
      return {
        datasetId: dataset.id,
        kind: dataset.kind,
        layers: dataset.layers.map(one => ({
          ...one,
          ...(result.geometryType === undefined ? {} : { geometryType: result.geometryType }),
          featureCount: result.features.length,
          ...(result.bbox === undefined ? {} : { bbox: result.bbox }),
        })),
        crs: result.crs,
        ...(result.encoding === undefined ? {} : { encoding: result.encoding }),
        fields: result.fields,
        ...(result.bbox === undefined ? {} : { bbox: result.bbox }),
        featureCount: result.features.length,
        capabilities: {
          read: true,
          write: false,
          tiles: false,
          reason: 'the pure-JS provider is read-only and serves no tiles; install the GDAL provider for more',
        },
        issues: result.issues,
      } satisfies InspectResult
    },

    async query(dataset, request) {
      const result = await load(dataset)
      const matches = compileWhere(request.where ?? '')
      const selected = request.fields

      const filtered = result.features.filter(feature => {
        if (!matches(feature.attributes)) return false
        if (request.bbox === undefined) return true
        if (feature.geometry === undefined) return false
        const extent = extendBbox(undefined, feature.geometry)
        if (extent === undefined) return false
        return extent[0] <= request.bbox[2] && extent[2] >= request.bbox[0]
          && extent[1] <= request.bbox[3] && extent[3] >= request.bbox[1]
      })

      const page = filtered.slice(request.offset, request.offset + request.limit)
      const rows: Feature[] = page.map(feature => ({
        attributes: selected === undefined
          ? feature.attributes
          : Object.fromEntries(Object.entries(feature.attributes).filter(([name]) => selected.includes(name))),
        ...(request.geometry === 'none' || feature.geometry === undefined
          ? {}
          : { geometry: request.geometry === 'wkt' ? toWkt(feature.geometry as GeoJsonGeometry) : feature.geometry }),
      }))

      return {
        columns: selected ?? result.fields.map(field => field.name),
        rows,
        rowCount: rows.length,
        totalCount: filtered.length,
        truncated: request.offset + rows.length < filtered.length,
      } satisfies QueryResult
    },
  }
}

/** Read one dataset from disk according to its kind. */
async function read(dataset: Dataset, encoding?: string): Promise<ReadResult> {
  switch (dataset.kind) {
    case 'geojson': return readGeoJson(await readText(dataset.path))
    case 'ndjson': return readNdjson(await readText(dataset.path))
    case 'wkt': return readWktFile(await readText(dataset.path))
    case 'shapefile': {
      const stem = dataset.main.slice(0, -4)
      const prj = await optionalText(stem + '.prj')
      const cpg = await optionalText(stem + '.cpg')
      const dbf = await optionalBytes(stem + '.dbf')
      return readShapefile(
        {
          shp: await readBytes(dataset.main),
          ...(dbf === undefined ? {} : { dbf }),
          ...(prj === undefined ? {} : { prj }),
          ...(cpg === undefined ? {} : { cpg }),
        },
        encoding === undefined ? {} : { encoding },
      )
    }
    default:
      throw new GisError('UNSUPPORTED_FORMAT', `the pure-JS provider cannot read ${dataset.kind} datasets`)
  }
}

/**
 * Read a `.wkt` file: one WKT geometry per line, optionally with an id.
 *
 * There is no such standard, but a bare WKT file is a common handoff, and
 * refusing it would be unhelpful. The CRS is UNKNOWN by construction: WKT
 * carries no coordinate reference system.
 */
function readWktFile(text: string): ReadResult {
  const features: RawFeature[] = []
  const issues: GisIssue[] = [{
    code: 'CRS_UNKNOWN',
    message: 'a bare WKT file carries no coordinate reference system; supply one before measuring or overlaying',
  }]
  let bbox: ReturnType<typeof extendBbox>
  let skipped = 0
  let index = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    index += 1
    try {
      const geometry = parseWkt(trimmed).geometry as GeoJsonGeometry
      features.push({ attributes: { fid: index }, geometry })
      bbox = extendBbox(bbox, geometry)
    } catch {
      skipped += 1
    }
  }
  if (skipped > 0) issues.push({ code: 'PARSE_FAILED', message: `${String(skipped)} line(s) were not valid WKT and were skipped`, count: skipped })
  return {
    features,
    fields: [{ name: 'fid', type: 'Integer' }],
    crs: { source: 'unknown' },
    ...(bbox === undefined ? {} : { bbox }),
    issues,
    totalCount: features.length,
  }
}

/** Text of an optional sibling, or undefined. */
async function optionalText(path: string): Promise<string | undefined> {
  try { return await readText(path) } catch { return undefined }
}

/** Bytes of an optional sibling, or undefined. */
async function optionalBytes(path: string): Promise<Uint8Array | undefined> {
  try { return await readBytes(path) } catch { return undefined }
}
