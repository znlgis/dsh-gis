/**
 * The GIS tool set.
 *
 * Every tool takes EITHER a `path` (open this file) OR an `id` (a dataset this
 * session already registered). Paths never appear in a result: the model only
 * ever sees ids, so a transcript cannot leak the operator's directory layout.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import proj4 from 'proj4'
import { GisError, type Bbox, type Dataset } from '@znlgis/dsh-gis-core'
import { writeFile } from 'node:fs/promises'
import { resolve as resolveFilePath } from 'node:path'
import { parseWkt, toWkt, type GeoJsonGeometry } from '@znlgis/dsh-gis-formats'
import { encodePng } from './png.ts'
import { rasterize } from './raster.ts'
import { renderInspect, renderQuery, text } from './format.ts'

/** Stable Loader identity. */
export const name = 'tool-gis'

/** Both the tool registry and the GIS service must exist first. */
export const inject = ['tools', 'gis']

/**
 * Declares that `execute` returns content blocks directly.
 *
 * The cast is needed because the tool contract types `value` as `JsonValue[]`
 * while `render` must return `ContentBlock[]`; the two are structurally the
 * same array here, since `execute` builds it.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const CONTENT_OUTPUT = {
  // `as const` keeps `type` the literal 'array'; without it the schema widens to
  // `string` and the contract can no longer tell this is a content-array output.
  schema: { type: 'array', items: { type: 'json' } } as const,
  render: (_args: unknown, value: readonly unknown[]) => value as ContentBlock[],
}

/** Register every GIS tool. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'gis_inspect',
    description: [
      'Describe a spatial dataset before using it: format, layers, coordinate reference system, extent, attribute fields, and every data-quality issue found.',
      'Always call this first. If the result reports CRS_UNKNOWN, do NOT measure distances or areas -- pass a CRS explicitly instead.',
      'Give either `path` (a .geojson, .ndjson, .wkt or .shp file) or `id` from an earlier call.',
    ].join(' '),
    parameters: {
      path: { type: 'string', description: 'Path to a data file to open and inspect.' },
      id: { type: 'string', description: 'Id of a dataset registered earlier in this session.' },
      layer: { type: 'string', description: 'Layer name, when the dataset holds several.' },
    },
    output: CONTENT_OUTPUT,
    async execute(args) {
      const dataset = await resolve(ctx, args)
      return text(renderInspect(await ctx.gis.inspect(dataset.id, args.layer)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gis_query',
    description: [
      'Read features from a spatial dataset, paged.',
      '`where` accepts flat comparisons joined by AND/OR (name = \'Beijing\' AND pop > 1000) and `field LIKE \'%pattern%\'`; other SQL is refused rather than approximated.',
      '`bbox` filters by a [west, south, east, north] window and `geometry` chooses wkt (default), geojson, or none.',
    ].join(' '),
    parameters: {
      path: { type: 'string', description: 'Path to a data file to open first.' },
      id: { type: 'string', description: 'Id of a dataset registered earlier.' },
      where: { type: 'string', description: 'Attribute filter, e.g. "pop > 1000 AND name LIKE \'B%\'".' },
      bbox: { type: 'string', description: 'Spatial window as "west,south,east,north" in EPSG:4326.' },
      limit: { type: 'number', description: 'Maximum rows to return (default 20, max 500).' },
      offset: { type: 'number', description: 'Rows to skip, for paging.' },
      geometry: { type: 'string', description: 'Geometry encoding: wkt (default), geojson, or none.' },
      fields: { type: 'string', description: 'Comma-separated attribute names to return.' },
    },
    output: CONTENT_OUTPUT,
    async execute(args) {
      const dataset = await resolve(ctx, args)
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 500)
      const encoding = args.geometry ?? 'wkt'
      if (encoding !== 'wkt' && encoding !== 'geojson' && encoding !== 'none') {
        throw new GisError('PARSE_FAILED', `unknown geometry encoding: ${encoding}`)
      }
      const fields = args.fields === undefined ? undefined : args.fields.split(',').map(f => f.trim()).filter(f => f.length > 0)
      const result = await ctx.gis.query(dataset.id, {
        ...(args.where === undefined ? {} : { where: args.where }),
        ...(args.bbox === undefined ? {} : { bbox: parseBbox(args.bbox) }),
        limit,
        offset: Math.max(args.offset ?? 0, 0),
        geometry: encoding,
        ...(fields === undefined ? {} : { fields }),
      })
      return text(renderQuery(result))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gis_crs',
    description: [
      'Reason about coordinate reference systems.',
      'action=describe reports what a CRS code or WKT means; action=transform converts WKT geometry between two CRSs.',
      'Use transform when a dataset reports CRS_UNKNOWN but you know its CRS, or to overlay two datasets in different CRSs.',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, description: 'Either "describe" or "transform".' },
      crs: { type: 'string', description: 'For describe: an EPSG code such as EPSG:4326, or a WKT string.' },
      from: { type: 'string', description: 'For transform: the source CRS, e.g. EPSG:4526.' },
      to: { type: 'string', description: 'For transform: the target CRS, e.g. EPSG:4326.' },
      geometry: { type: 'string', description: 'For transform: the WKT geometry to convert.' },
    },
    output: CONTENT_OUTPUT,
    async execute(args) {
      if (args.action === 'describe') {
        if (args.crs === undefined) throw new GisError('PARSE_FAILED', 'describe needs a `crs`')
        return text(describeCrs(args.crs))
      }
      if (args.action !== 'transform') {
        throw new GisError('PARSE_FAILED', `unknown action: ${args.action} (expected describe or transform)`)
      }
      if (args.geometry === undefined || args.from === undefined || args.to === undefined) {
        throw new GisError('PARSE_FAILED', 'transform needs `geometry`, `from` and `to`')
      }
      return text(transformWkt(args.geometry, args.from, args.to))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gis_render',
    description: [
      'Render a spatial dataset to a PNG image and return its file path.',
      'Use this to SHOW data rather than describe it. The picture is a plain equirectangular plot with no basemap, no labels and no reprojection, so it is for a quick look, not for cartographic output.',
      'It does not measure anything, but it inherits the dataset CRS: if gis_inspect reported CRS_UNKNOWN the picture is still readable, yet any distance you read off it is meaningless.',
    ].join(' '),
    parameters: {
      path: { type: 'string', description: 'Path to a data file to open first.' },
      id: { type: 'string', description: 'Id of a dataset registered earlier.' },
      width: { type: 'number', description: 'Image width in pixels (default 900, max 2000).' },
      height: { type: 'number', description: 'Image height in pixels (default 600, max 2000).' },
      bbox: { type: 'string', description: 'Extent to draw as "west,south,east,north"; defaults to the dataset extent.' },
      output: { type: 'string', description: 'File path to write; defaults to gis-render-<id>.png in the working directory.' },
    },
    output: CONTENT_OUTPUT,
    async execute(args) {
      const dataset = await resolve(ctx, args)
      const inspection = await ctx.gis.inspect(dataset.id)
      const width = Math.min(Math.max(Math.round(args.width ?? 900), 64), 2000)
      const height = Math.min(Math.max(Math.round(args.height ?? 600), 64), 2000)
      const bbox = args.bbox === undefined ? inspection.bbox : parseBbox(args.bbox)
      if (bbox === undefined) {
        throw new GisError('DATASET_UNREADABLE', 'this dataset reported no extent, so there is nothing to frame; pass bbox explicitly')
      }

      const page = await ctx.gis.query(dataset.id, { limit: 500, offset: 0, geometry: 'geojson' })
      const features = page.rows.map(row => ({ attributes: row.attributes, geometry: row.geometry as GeoJsonGeometry | undefined }))
        .filter((feature): feature is { attributes: typeof feature.attributes; geometry: GeoJsonGeometry } => feature.geometry !== undefined)
      if (features.length === 0) {
        throw new GisError('DATASET_UNREADABLE', 'no feature in this dataset carries geometry, so there is nothing to draw')
      }

      const raster = rasterize(features, { width, height, bbox })
      const png = encodePng(raster.width, raster.height, raster.pixels)
      const target = resolveFilePath(process.cwd(), args.output ?? `gis-render-${dataset.id}.png`)
      await writeFile(target, png)

      const warnings = inspection.issues.map(issue => `  [${issue.code}] ${issue.message}`)
      return text([
        `rendered ${String(raster.drawn)} of ${String(features.length)} feature(s) to ${target}`,
        `image: ${String(raster.width)}x${String(raster.height)} px, extent [${raster.bbox.join(', ')}]`,
        `crs: ${inspection.crs.epsg === undefined ? `${inspection.crs.name ?? 'unknown'} (unresolved)` : `EPSG:${String(inspection.crs.epsg)}`}`,
        warnings.length === 0 ? 'no data-quality issues reported' : ['data-quality issues carried into this picture:', ...warnings].join('\n'),
        'The picture has no scale bar or basemap. Do not quote distances or areas from it.',
      ].join('\n'))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'gis_catalog',
    description: 'List the spatial datasets registered in this session, with the id to use in later calls.',
    parameters: {},
    output: CONTENT_OUTPUT,
    async execute() {
      const datasets = ctx.gis.list()
      if (datasets.length === 0) return text('no datasets registered yet; call gis_inspect with a path first')
      return text(datasets.map(d => `${d.id}  ${d.kind}  ${d.title}`).join('\n'))
    },
  }))
}

/** Resolve the dataset a tool call names, by id first, then by path. */
async function resolve(ctx: Context, args: { id?: string; path?: string }): Promise<Dataset> {
  if (args.id !== undefined) return ctx.gis.resolve(args.id)
  if (args.path !== undefined) return ctx.gis.open(args.path)
  throw new GisError('DATASET_NOT_FOUND', 'give either `path` (a file to open) or `id` (a dataset registered earlier)')
}

/** Parse a "west,south,east,north" window. */
function parseBbox(raw: string): Bbox {
  const parts = raw.split(',').map(p => Number(p.trim()))
  if (parts.length !== 4 || parts.some(p => !Number.isFinite(p))) {
    throw new GisError('PARSE_FAILED', `bbox must be four numbers "west,south,east,north"; got: ${raw}`)
  }
  return parts as unknown as Bbox
}

/** Report what a CRS code or WKT means. */
function describeCrs(crs: string): string {
  const definition = proj4.defs(crs)
  if (definition === undefined) {
    return `proj4 has no definition for ${crs}. Known forms: EPSG:4326, EPSG:3857, or a full PROJ/WKT string it can parse.`
  }
  const d = definition as unknown as { projName?: string; units?: string; datumCode?: string }
  return [
    `${crs}: ${d.projName ?? 'unknown projection'}`,
    `units: ${d.units ?? 'unknown'}`,
    `datum: ${d.datumCode ?? 'unknown'}`,
  ].join('\n')
}

/**
 * Transform every coordinate of a WKT geometry between two CRSs.
 *
 * Deliberately explicit: both ends must be named. There is no implicit
 * "assume WGS84" step anywhere in this plugin.
 */
function transformWkt(wkt: string, from: string, to: string): string {
  const parsed = parseWkt(wkt)
  const moved = mapPositions(parsed.geometry as GeoJsonGeometry, (position) => {
    const [x, y] = position
    if (typeof x !== 'number' || typeof y !== 'number') return position
    const out = proj4(from, to, [x, y]) as number[]
    return [out[0] as number, out[1] as number]
  })
  return `${toWkt(moved)}`
}

/** Rewrite every position of a geometry. */
function mapPositions(geometry: GeoJsonGeometry, move: (position: readonly number[]) => readonly number[]): GeoJsonGeometry {
  const type = geometry.type
  const coordinates = geometry.coordinates as unknown
  if (type === 'Point') return { type, coordinates: move(coordinates as number[]) }
  if (type === 'LineString' || type === 'MultiPoint') {
    return { type, coordinates: (coordinates as number[][]).map(move) }
  }
  if (type === 'Polygon' || type === 'MultiLineString') {
    return { type, coordinates: (coordinates as number[][][]).map(ring => ring.map(move)) }
  }
  if (type === 'MultiPolygon') {
    return { type, coordinates: (coordinates as number[][][][]).map(poly => poly.map(ring => ring.map(move))) }
  }
  if (type === 'GeometryCollection') {
    return { type, geometries: ((geometry.geometries as GeoJsonGeometry[] | undefined) ?? []).map(child => mapPositions(child, move)) }
  }
  return geometry
}

