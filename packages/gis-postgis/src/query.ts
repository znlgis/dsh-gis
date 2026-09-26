/**
 * Reading a page of features (T3.3).
 *
 * Four decisions are made here, each because the alternative is a bug a user
 * eventually sees:
 *
 * 1. **Identifiers are quoted; LIMIT/OFFSET are validated integers.** A table name
 *    cannot be a bound parameter, so it goes through {@link quoteIdent}. The two
 *    numbers are checked to be non-negative whole numbers (and capped) FIRST, after
 *    which interpolating them is arithmetic rather than string handling -- and it keeps
 *    the SQL text identical between runs, which is what makes it readable in a log.
 * 2. **The page is ORDERED.** \`LIMIT/OFFSET\` without an \`ORDER BY\` has no defined
 *    order, so page 2 can repeat or skip rows from page 1. The order key is the
 *    primary key when the table has one, and \`ctid\` otherwise -- stable for one
 *    query, which is what paging needs, and honest about not being a real key.
 * 3. **Geometry crosses as GeoJSON.** \`ST_AsGeoJSON\` runs in the database, so a
 *    page carries coordinates rather than WKB hex, and the tool layer does not
 *    have to parse a geometry format in JavaScript.
 * 4. **An over-large page is REFUSED, not clamped.** Silently returning 500 of the
 *    5000 rows a caller asked for is the kind of lie that ends up in an export.
 */
import { GisError } from '@znlgis/dsh-gis-core'
import { quoteIdent, type CatalogLayer } from './catalog.ts'
import { compileFilter, type CompiledFilter } from './filter.ts'
import type { Queryable } from './connect.ts'

/** How many features one page may carry, and how many it carries by default. */
export const PAGE_LIMITS = { default: 100, max: 1000 } as const

/** What the caller asks for. */
export interface PageRequest {
  /** Features per page; defaults to {@link PAGE_LIMITS.default}. */
  readonly limit?: number
  /**
   * A `field OP value` filter joined by AND/OR. Compiled to SQL with BOUND values
   * against a whitelist of this layer's columns (see filter.ts) -- user input never
   * becomes SQL text.
   */
  readonly where?: string
  /** Features to skip. */
  readonly offset?: number
  /** Columns to return besides the geometry; all columns when omitted. */
  readonly columns?: readonly string[]
}

/** One feature as it crossed the wire. */
export interface PageFeature {
  /** GeoJSON geometry, parsed from the database's own encoding. */
  readonly geometry: unknown
  /** Attribute values, JSON-safe. */
  readonly properties: Readonly<Record<string, unknown>>
}

/** One page of features. */
export interface Page {
  /** The features. */
  readonly features: readonly PageFeature[]
  /** The limit actually applied. */
  readonly limit: number
  /** The offset actually applied. */
  readonly offset: number
  /** Whether a further page probably exists (a full page came back). */
  readonly hasMore: boolean
  /** The column the page was ordered by. */
  readonly orderBy: string
  /** The columns returned. */
  readonly columns: readonly string[]
}

/**
 * The column a page is ordered by.
 * @param primaryKey - the table's primary key column, when it has one.
 * @returns the order key.
 */
export function orderKeyOf(primaryKey: string | undefined): string {
  // \`ctid\` is not a key and does change under updates: it is the honest fallback
  // for a table without a primary key (the plan's F7 fixture has one), and the page
  // reports which one was used so a caller can tell.
  return primaryKey ?? 'ctid'
}

/**
 * Build one page query.
 * @param layer - the layer to read.
 * @param primaryKey - its primary key column, when it has one.
 * @param request - page size and offset.
 * @returns SQL text with $1/$2 bound.
 */
export function buildPageSql(
  layer: CatalogLayer,
  primaryKey: string | undefined,
  request: PageRequest = {},
  filter: CompiledFilter = { sql: '', values: [], terms: 0 },
): string {
  const limit = normalizeLimit(request.limit)
  const offset = normalizeOffset(request.offset)
  const columns = request.columns === undefined || request.columns.length === 0
    ? '*'
    : request.columns.map(quoteIdent).join(', ')
  const geometry = layer.spatialKind === 'geography'
    // Geography is cast to geometry so ST_AsGeoJSON has a geometry to encode; the
    // coordinates stay lon/lat either way.
    ? 'ST_AsGeoJSON(' + quoteIdent(layer.column) + '::geometry)'
    : 'ST_AsGeoJSON(' + quoteIdent(layer.column) + ')'
  return [
    'SELECT ' + columns + ', ' + geometry + ' AS __geometry',
    'FROM ' + quoteIdent(layer.schema) + '.' + quoteIdent(layer.table),
    // The filter arrives already compiled: its identifiers were whitelisted and its
    // values are $n placeholders, so nothing here is user text.
    ...filter.sql.length === 0 ? [] : ['WHERE ' + filter.sql],
    'ORDER BY ' + quoteIdent(orderKeyOf(primaryKey)),
    'LIMIT ' + String(limit) + ' OFFSET ' + String(offset),
  ].join('\n')
}

/**
 * Validate a page size.
 * @param limit - the requested size, or undefined for the default.
 * @returns the size to use.
 * @throws GisError \`LIMIT_EXCEEDED\` when it is above the cap.
 */
export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return PAGE_LIMITS.default
  if (!Number.isInteger(limit) || limit < 1) {
    throw new GisError('LIMIT_EXCEEDED', 'a page limit must be a positive whole number, got ' + String(limit))
  }
  if (limit > PAGE_LIMITS.max) {
    throw new GisError('LIMIT_EXCEEDED', 'this build pages at most ' + String(PAGE_LIMITS.max) + ' features at a time, asked for ' + String(limit) + '; page with offset instead')
  }
  return limit
}

/**
 * Validate an offset.
 * @param offset - the requested offset, or undefined for zero.
 * @returns the offset to use.
 * @throws GisError \`LIMIT_EXCEEDED\` when it is not a non-negative whole number.
 */
export function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0
  if (!Number.isInteger(offset) || offset < 0) {
    throw new GisError('LIMIT_EXCEEDED', 'an offset must be zero or a positive whole number, got ' + String(offset))
  }
  return offset
}

/**
 * The primary key of one relation, when it has a single-column one.
 * @param client - a connected client or pool.
 * @param schema - schema name.
 * @param table - table name.
 * @returns the column name, or undefined for a table with no (or a composite) key.
 */
export async function readPrimaryKey(client: Queryable, schema: string, table: string): Promise<string | undefined> {
  const result = await client.query(
    [
      'SELECT a.attname AS column_name',
      'FROM pg_index i',
      'JOIN pg_class c ON c.oid = i.indrelid',
      'JOIN pg_namespace n ON n.oid = c.relnamespace',
      'JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)',
      'WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2',
      'ORDER BY array_position(i.indkey, a.attnum)',
    ].join('\n'),
    [schema, table],
  )
  const rows = result.rows as unknown as readonly { column_name: string }[]
  // A COMPOSITE key is reported as no single key: ordering by one column of a
  // composite key is not deterministic, and pretending otherwise is worse than
  // falling back to ctid.
  return rows.length === 1 ? String(rows[0]?.column_name) : undefined
}

/**
 * The columns of one relation, as the DATABASE reports them.
 *
 * This is the whitelist a filter is compiled against. Reading it from the database
 * means the set cannot be influenced by the request being filtered.
 * @param client - a connected client or pool.
 * @param layer - the layer whose columns are wanted.
 * @returns the column names.
 */
export async function readColumnNames(client: Queryable, layer: CatalogLayer): Promise<readonly string[]> {
  const result = await client.query(
    [
      'SELECT a.attname AS column_name',
      'FROM pg_attribute a',
      'JOIN pg_class c ON c.oid = a.attrelid',
      'JOIN pg_namespace n ON n.oid = c.relnamespace',
      'WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped',
      'ORDER BY a.attnum',
    ].join('\n'),
    [layer.schema, layer.table],
  )
  return (result.rows as unknown as readonly { column_name: string }[]).map(row => String(row.column_name))
}

/**
 * Read one page of features.
 * @param client - a connected client or pool.
 * @param layer - the layer to read.
 * @param request - page size and offset.
 * @returns the page.
 */
export async function readPage(client: Queryable, layer: CatalogLayer, request: PageRequest = {}): Promise<Page> {
  const limit = normalizeLimit(request.limit)
  const offset = normalizeOffset(request.offset)
  const primaryKey = await readPrimaryKey(client, layer.schema, layer.table)
  // The whitelist is the CATALOGUE's column list, read from the database rather
  // than from the request: a caller cannot widen it by naming a column that the
  // layer does not have.
  const filter = request.where === undefined
    ? { sql: '', values: [], terms: 0 }
    : compileFilter(request.where, await readColumnNames(client, layer))
  const sql = buildPageSql(layer, primaryKey, { ...request, limit, offset }, filter)
  const result = await client.query(sql, [...filter.values])
  const rows = result.rows as unknown as readonly Readonly<Record<string, unknown>>[]
  const features = rows.map(row => toFeature(row, layer.column))
  const columns = rows.length === 0 ? [] : Object.keys(rows[0] as Record<string, unknown>)
  return {
    features,
    limit,
    offset,
    hasMore: features.length === limit,
    orderBy: orderKeyOf(primaryKey),
    columns,
  }
}

/**
 * Turn one driver row into a feature.
 * @param row - the row, carrying \`__geometry\` as GeoJSON text.
 * @param geometryColumn - the spatial column, excluded from the properties.
 * @returns the feature.
 */
export function toFeature(row: Readonly<Record<string, unknown>>, geometryColumn: string): PageFeature {
  const properties: Record<string, unknown> = {}
  let geometry: unknown = null
  for (const [key, value] of Object.entries(row)) {
    if (key === '__geometry') {
      geometry = typeof value === 'string' ? safeParse(value) : null
      continue
    }
    if (key === geometryColumn) continue
    properties[key] = jsonSafe(value)
  }
  return { geometry, properties }
}

/** Parse GeoJSON text without letting a malformed value throw. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Make a driver value safe to hand to the model and the UI. */
function jsonSafe(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  // bigint, Date, Buffer and numeric-as-string all arrive here; a plain string is
  // the honest common denominator.
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Date) return value.toISOString()
  return String(value)
}
