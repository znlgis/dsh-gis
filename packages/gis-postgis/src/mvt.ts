/**
 * Server-side vector tiles (T3.4).
 *
 * The tile is built by PostGIS (\`ST_AsMVTGeom\` + \`ST_AsMVT\`), not by GDAL and not
 * in JavaScript. That matters beyond taste: the database already holds the data,
 * the index, and the projection code, so a tile costs one round trip and no
 * temporary file, no subprocess, and no second copy of the geometry pipeline.
 *
 * TWO DETAILS DECIDE WHETHER THIS IS FAST OR USELESS:
 *
 * 1. **The intersection test happens in the LAYER's CRS, not the tile's.** The
 *    obvious form -- \`ST_Intersects(ST_Transform(geom, 3857), tile)\` -- transforms
 *    every row and therefore cannot use the spatial index. Transforming the TILE
 *    into the layer's CRS instead lets \`&&\` use the GiST index, which is the whole
 *    reason the index exists.
 * 2. **A layer with no declared SRID cannot be tiled.** Without an SRID there is
 *    nothing to transform from, and guessing 4326 would place a projected dataset
 *    at plausible-looking wrong coordinates. It is refused with \`CRS_UNKNOWN\`.
 */
import { GisError } from '@znlgis/dsh-gis-core'
import { quoteIdent, type CatalogLayer } from './catalog.ts'
import type { Queryable } from './connect.ts'

/** Tile geometry extent, in the tile's own coordinate space. */
export const TILE_EXTENT = 4096

/** How much geometry outside the tile is kept, in extent units, so lines and labels do not end abruptly. */
export const TILE_BUFFER = 64

/** Features per tile before the query stops; a guard rail, not a promise. */
export const MAX_FEATURES_PER_TILE = 20_000

/** What the caller asks for. */
export interface TileRequest {
  /** Zoom level. */
  readonly z: number
  /** Tile column. */
  readonly x: number
  /** Tile row. */
  readonly y: number
  /** Tile extent; defaults to {@link TILE_EXTENT}. */
  readonly extent?: number
  /** Clip buffer in extent units; defaults to {@link TILE_BUFFER}. */
  readonly buffer?: number
  /** Feature cap; defaults to {@link MAX_FEATURES_PER_TILE}. */
  readonly maxFeatures?: number
}

/** A tile and what produced it. */
export interface Tile {
  /** The MVT bytes; empty when the tile has no features. */
  readonly data: Uint8Array
  /** The layer name inside the tile. */
  readonly layerName: string
  /** Zoom, column, row. */
  readonly z: number
  /** Tile column. */
  readonly x: number
  /** Tile row. */
  readonly y: number
  /** The extent the geometries were quantized to. */
  readonly extent: number
}

/**
 * The MVT layer name for a catalogue layer.
 *
 * Clients compare layer names, so this has to be stable and readable rather than
 * clever: schema and table, joined by a dot.
 * @param layer - the catalogue layer.
 * @returns the layer name.
 */
export function tileLayerName(layer: CatalogLayer): string {
  return layer.schema + '.' + layer.table
}

/**
 * Validate a tile address.
 * @param request - the requested tile.
 * @returns the validated address and knobs.
 * @throws GisError \`LIMIT_EXCEEDED\` for an out-of-range address or extent.
 */
export function normalizeTile(request: TileRequest): Required<TileRequest> {
  const { z, x, y } = request
  if (!Number.isInteger(z) || z < 0 || z > 24) throw new GisError('LIMIT_EXCEEDED', 'a tile zoom must be a whole number between 0 and 24, got ' + String(z))
  const span = 2 ** z
  if (!Number.isInteger(x) || x < 0 || x >= span) throw new GisError('LIMIT_EXCEEDED', 'tile column ' + String(x) + ' is outside 0..' + String(span - 1) + ' at zoom ' + String(z))
  if (!Number.isInteger(y) || y < 0 || y >= span) throw new GisError('LIMIT_EXCEEDED', 'tile row ' + String(y) + ' is outside 0..' + String(span - 1) + ' at zoom ' + String(z))
  const extent = request.extent ?? TILE_EXTENT
  if (!Number.isInteger(extent) || extent < 256 || extent > 8192) throw new GisError('LIMIT_EXCEEDED', 'a tile extent must be a whole number between 256 and 8192, got ' + String(extent))
  const buffer = request.buffer ?? TILE_BUFFER
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 1024) throw new GisError('LIMIT_EXCEEDED', 'a tile buffer must be a whole number between 0 and 1024, got ' + String(buffer))
  const maxFeatures = request.maxFeatures ?? MAX_FEATURES_PER_TILE
  if (!Number.isInteger(maxFeatures) || maxFeatures < 1) throw new GisError('LIMIT_EXCEEDED', 'a feature cap must be a positive whole number, got ' + String(maxFeatures))
  return { z, x, y, extent, buffer, maxFeatures }
}

/**
 * Build the tile query.
 *
 * The tile address, extent, buffer and cap are validated integers by the time they
 * reach the text; the identifiers are quoted (see catalog.quoteIdent).
 * @param layer - the layer to tile.
 * @param request - the tile address.
 * @param columns - attribute columns to carry into the tile.
 * @returns SQL text.
 * @throws GisError \`CRS_UNKNOWN\` when the layer declares no SRID.
 */
export function buildTileSql(layer: CatalogLayer, request: TileRequest, columns: readonly string[] = []): string {
  const { z, x, y, extent, buffer, maxFeatures } = normalizeTile(request)
  if (layer.srid <= 0) {
    throw new GisError('CRS_UNKNOWN', 'the layer "' + layer.schema + '.' + layer.table + '" declares no SRID, so it cannot be placed in a tile; assign one with SELECT UpdateGeometrySRID(...)')
  }
  const sourceColumn = quoteIdent(layer.column)
  const attributes = columns.length === 0
    ? ''
    : ', ' + columns.map(quoteIdent).join(', ')
  // The envelope is computed in 3857 (what ST_TileEnvelope returns, and what MVT
  // coordinates are defined in) and transformed BACK to the layer for the index
  // test, so the GiST index is usable.
  return [
    'WITH bounds AS (',
    '  SELECT ST_TileEnvelope(' + String(z) + ', ' + String(x) + ', ' + String(y) + ') AS tile',
    '),',
    'rows AS (',
    '  SELECT',
    '    ST_AsMVTGeom(',
    '      ST_Transform(t.' + sourceColumn + ', 3857),',
    '      bounds.tile,',
    '      ' + String(extent) + ',',
    '      ' + String(buffer) + ',',
    '      true',
    '    ) AS geom' + attributes,
    '  FROM ' + quoteIdent(layer.schema) + '.' + quoteIdent(layer.table) + ' t, bounds',
    '  WHERE t.' + sourceColumn + ' IS NOT NULL',
    // In the LAYER's CRS, so the index can be used.
    '    AND t.' + sourceColumn + ' && ST_Transform(bounds.tile, ' + String(layer.srid) + ')',
    '  LIMIT ' + String(maxFeatures),
    ')',
    'SELECT ST_AsMVT(rows.*, ' + literal(tileLayerName(layer)) + ', ' + String(extent) + ', ' + "'geom'" + ') AS tile FROM rows',
  ].join('\n')
}

/** Quote a SQL string literal; see catalog.literal. */
function literal(value: string): string {
  return "'" + value.split("'").join("''") + "'"
}

/**
 * Read one tile.
 * @param client - a connected client or pool.
 * @param layer - the layer to tile.
 * @param request - the tile address.
 * @param columns - attribute columns to carry into the tile.
 * @returns the tile; \`data\` is empty when nothing intersects.
 */
export async function readTile(client: Queryable, layer: CatalogLayer, request: TileRequest, columns: readonly string[] = []): Promise<Tile> {
  const normal = normalizeTile(request)
  const sql = buildTileSql(layer, normal, columns)
  const result = await client.query(sql)
  const raw = (result.rows as unknown as readonly { tile: Buffer | Uint8Array | null }[])[0]?.tile
  // ST_AsMVT returns an empty bytea (not NULL) when no row survived the clip, so
  // "no features here" arrives as zero bytes rather than as a missing row.
  const data = raw === null || raw === undefined ? new Uint8Array(0) : new Uint8Array(raw)
  return { data, layerName: tileLayerName(layer), z: normal.z, x: normal.x, y: normal.y, extent: normal.extent }
}
