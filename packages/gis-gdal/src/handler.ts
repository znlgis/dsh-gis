/**
 * The GDAL-backed read handler.
 *
 * Its reason to exist is the one thing the pure-JS layer cannot do: GDAL carries
 * the PROJ database, so `ogrinfo` reports a real EPSG code (`coordinateSystem.
 * projjson.id`). The hand-rolled `.prj` parser has to recognise CRSs by name and
 * otherwise admits it cannot resolve them -- this closes that gap.
 *
 * Feature reads go through `ogr2ogr -f GeoJSON` and are then parsed by the SAME
 * GeoJSON reader the pure-JS provider uses, so there is one tested feature path
 * rather than two.
 */
import type {
  Bbox, Dataset, GisFormatHandler, GisIssue, InspectResult, QueryRequest, QueryResult,
} from '@znlgis/dsh-gis-core'
import { GisError } from '@znlgis/dsh-gis-core'
import { readGeoJson, toWkt, type GeoJsonGeometry, type RawFeature } from '@znlgis/dsh-gis-formats'
import type { RunRequest, RunResult } from './exec.ts'

/**
 * The slice of the runtime this handler needs.
 *
 * Structural rather than the service class: the handler's whole job is a
 * mapping from `ogrinfo` output to `InspectResult`, and depending on the
 * concrete service would put a Cordis context between that mapping and its
 * tests. The service satisfies this shape.
 */
export interface GdalRuntime {
  /** Run one tool with the configured environment. */
  run(request: Omit<RunRequest, 'env' | 'timeoutMs'> & { readonly env?: RunRequest['env'] }): Promise<RunResult>
}

/** One layer as `ogrinfo -so -json` describes it. */
interface OgrLayer {
  readonly name?: string
  readonly featureCount?: number
  readonly metadata?: Record<string, Record<string, string>>
  readonly geometryFields?: readonly {
    readonly type?: string
    readonly extent?: readonly number[]
    readonly coordinateSystem?: { readonly projjson?: { readonly id?: { readonly code?: number } } }
  }[]
  readonly fields?: readonly { readonly name?: string; readonly type?: string }[]
}

/** The subset of the `ogrinfo` document this handler reads. */
interface OgrDocument {
  readonly driverShortName?: string
  readonly layers?: readonly OgrLayer[]
}

/**
 * Build the handler.
 * @param runtime - the configured runtime that knows where GDAL is.
 * @returns a handler for the kinds only GDAL can read.
 */
export function createGdalHandler(runtime: GdalRuntime): GisFormatHandler {
  /** Run ogrinfo for one dataset and return its JSON. */
  async function ogrinfo(dataset: Dataset, summary: boolean): Promise<OgrDocument> {
    const argv = ['ogrinfo', '-json', ...(summary ? ['-so'] : []), '-al', targetOf(dataset)]
    const result = await runtime.run({
      argv, cwd: process.cwd(), mode: 'read-only', workspaceRoot: process.cwd(),
    })
    if (result.exitCode !== 0) {
      throw new GisError(
        'DATASET_UNREADABLE',
        `ogrinfo failed for ${dataset.id}: ${(result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? 'no detail'}`,
      )
    }
    try {
      return JSON.parse(result.stdout) as OgrDocument
    } catch {
      throw new GisError('PARSE_FAILED', `ogrinfo did not return JSON for ${dataset.id}`)
    }
  }

  return {
    name: 'gis-gdal',
    // Only the kinds the pure-JS provider cannot read: gis-core refuses a second
    // handler for a kind it already has, so GDAL takes the container formats.
    kinds: ['gdb'],

    async inspect(dataset, layer) {
      const document = await ogrinfo(dataset, true)
      const layers = document.layers ?? []
      if (layer !== undefined && !layers.some(one => one.name === layer)) {
        throw new GisError('LAYER_NOT_FOUND', `dataset ${dataset.id} has no layer named ${layer}`)
      }
      const issues: GisIssue[] = []
      if (layers.length > 1 && layer === undefined) {
        issues.push({
          code: 'LAYER_AMBIGUOUS',
          message: `this container holds ${String(layers.length)} layers; pass \`layer\` to read one specifically`,
          count: layers.length,
        })
      }

      const first = layers[0]
      const epsg = first?.geometryFields?.[0]?.coordinateSystem?.projjson?.id?.code
      if (epsg === undefined) {
        issues.push({
          code: 'CRS_UNKNOWN',
          message: 'GDAL reported no EPSG code for this dataset, so its coordinate reference system is unresolved; measurements are refused until you supply one',
        })
      }

      const shp = first?.metadata?.SHAPEFILE
      const used = shp?.SOURCE_ENCODING
      if (shp !== undefined && used === undefined) {
        issues.push({
          code: 'ENCODING_UNDECIDED',
          message: 'attribute text has no declared encoding, so non-ASCII text may be wrong',
        })
      }

      // ogrinfo reports [0,0,0,0] when it has not computed an extent; never pass
      // that on as a real window.
      const raw = first?.geometryFields?.[0]?.extent
      const bbox = raw !== undefined && raw.some(value => value !== 0)
        ? [raw[0], raw[1], raw[2], raw[3]] as Bbox
        : undefined

      return {
        datasetId: dataset.id,
        kind: dataset.kind,
        layers: layers.map(one => ({
          name: one.name ?? dataset.title,
          ...(one.geometryFields?.[0]?.type === undefined ? {} : { geometryType: one.geometryFields[0].type }),
          ...(one.featureCount === undefined ? {} : { featureCount: one.featureCount }),
          ...(epsg === undefined ? {} : { srid: epsg }),
        })),
        crs: epsg === undefined
          ? { source: 'unknown' }
          : { epsg, source: 'native', name: `resolved by GDAL (${document.driverShortName ?? 'driver'})` },
        ...(used === undefined ? {} : { encoding: { used, source: 'cpg' } }),
        fields: (first?.fields ?? []).map(field => ({ name: field.name ?? '', type: field.type ?? '' })),
        ...(bbox === undefined ? {} : { bbox }),
        ...(first?.featureCount === undefined ? {} : { featureCount: first.featureCount }),
        capabilities: { read: true, write: false, tiles: false },
        issues,
      } satisfies InspectResult
    },

    async query(dataset, request) {
      // ogr2ogr emits GeoJSON; the tested GeoJSON reader does the rest.
      const result = await runtime.run({
        argv: ['ogr2ogr', '-f', 'GeoJSON', '/vsistdout/', targetOf(dataset), ...(request.layer === undefined ? [] : [request.layer])],
        cwd: process.cwd(), mode: 'read-only', workspaceRoot: process.cwd(),
      })
      if (result.exitCode !== 0) {
        throw new GisError('DATASET_UNREADABLE', `ogr2ogr failed for ${dataset.id}: ${result.stderr.trim().split(/\r?\n/)[0] ?? 'no detail'}`)
      }
      const parsed = readGeoJson(result.stdout)
      const filtered = request.bbox === undefined
        ? parsed.features
        : parsed.features.filter(feature => inWindow(feature, request.bbox as Bbox))
      const page = filtered.slice(request.offset, request.offset + request.limit)
      return {
        columns: request.fields ?? parsed.fields.map(field => field.name),
        rows: page.map(feature => ({
          attributes: feature.attributes,
          ...(request.geometry === 'none' || feature.geometry === undefined
            ? {}
            : { geometry: request.geometry === 'wkt' ? toWkt(feature.geometry as GeoJsonGeometry) : feature.geometry }),
        })),
        rowCount: page.length,
        totalCount: filtered.length,
        truncated: request.offset + page.length < filtered.length,
      } satisfies QueryResult
    },
  }
}

/**
 * The path GDAL should be pointed at for one dataset.
 *
 * `dataset.title` is a DISPLAY name and must never be handed to a tool: for a
 * shapefile it is a bare file name, so GDAL resolves it against the working
 * directory and fails with `No such file or directory`. Caught by running the
 * handler against the real fixture rather than a mock.
 * @param dataset - the dataset to locate.
 * @returns the absolute path or container directory.
 * @throws GisError when this handler has no way to address the kind.
 */
function targetOf(dataset: Dataset): string {
  if (dataset.kind === 'gdb') return dataset.dir
  if (dataset.kind === 'shapefile') return dataset.main
  if (dataset.kind === 'geojson' || dataset.kind === 'ndjson' || dataset.kind === 'wkt') return dataset.path
  throw new GisError('UNSUPPORTED_FORMAT', `the GDAL handler cannot address ${dataset.kind} datasets`)
}

/** Whether a feature's extent intersects a window. */
function inWindow(feature: RawFeature, bbox: Bbox): boolean {
  const geometry = feature.geometry
  if (geometry === undefined) return false
  const points: number[][] = []
  collect(geometry, points)
  if (points.length === 0) return false
  const xs = points.map(p => p[0] as number)
  const ys = points.map(p => p[1] as number)
  return Math.min(...xs) <= bbox[2] && Math.max(...xs) >= bbox[0]
    && Math.min(...ys) <= bbox[3] && Math.max(...ys) >= bbox[1]
}

/** Gather every position of a geometry. */
function collect(geometry: GeoJsonGeometry, into: number[][]): void {
  const type = geometry.type
  if (type === 'GeometryCollection') {
    for (const child of (geometry.geometries as GeoJsonGeometry[] | undefined) ?? []) collect(child, into)
    return
  }
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return
    if (typeof value[0] === 'number') { into.push(value as number[]); return }
    for (const child of value) walk(child)
  }
  walk(geometry.coordinates)
}
