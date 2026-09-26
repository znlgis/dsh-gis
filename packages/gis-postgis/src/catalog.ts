/**
 * The PostGIS catalogue (T3.2).
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: run \`count(*)\`. The plan's acceptance
 * criterion says so, and the reason is not style -- a viewer that wants to list
 * layers must not make the database read every row of every table it lists.
 * Row COUNTS come from \`pg_class.reltuples\`, and EXTENTS come from
 * \`ST_EstimatedExtent\`, which reads the statistics table rather than the data.
 *
 * Both are ESTIMATES, and the type says so (\`estimatedRows\`, \`estimated\`). When a
 * table has never been analyzed, PostgreSQL reports \`reltuples = -1\` and
 * \`ST_EstimatedExtent\` returns NULL: that is a normal state with a normal answer
 * ("unknown"), not an error, and the layer is still listed -- a layer a user
 * cannot see because its statistics are missing is worse than one whose extent is
 * unknown.
 *
 * Geography columns live in \`geography_columns\`, geometry ones in
 * \`geometry_columns\`. Reading only the first silently omits every geography
 * layer, so the catalogue reads both and says which is which.
 */
import type { Queryable } from './connect.ts'

/** Which catalogue view a layer column came from. */
export type SpatialKind = 'geometry' | 'geography'

/** One layer: a spatial column of a table or view. */
export interface CatalogLayer {
  /** Schema name. */
  readonly schema: string
  /** Table, view, or materialized view name. */
  readonly table: string
  /** The spatial column. */
  readonly column: string
  /** Geometry or geography. */
  readonly spatialKind: SpatialKind
  /** Declared SRID, or 0 when the column is unconstrained. */
  readonly srid: number
  /** Declared geometry type, or 'Geometry' when unconstrained. */
  readonly geometryType: string
  /** Whether the relation is a table, view, materialized view, or foreign table. */
  readonly relationKind: string
  /** \`pg_class.reltuples\`: an ESTIMATE, or -1 when the relation was never analyzed. */
  readonly estimatedRows: number
  /** Whether {@link estimatedRows} is a real estimate rather than "unknown". */
  readonly rowsKnown: boolean
}

/** An extent, as reported by the statistics. */
export interface EstimatedExtent {
  /** West. */
  readonly minX: number
  /** South. */
  readonly minY: number
  /** East. */
  readonly maxX: number
  /** North. */
  readonly maxY: number
}

/** A layer plus what the statistics currently say about it. */
export interface LayerMetadata {
  /** The layer. */
  readonly layer: CatalogLayer
  /** The estimated extent, when the statistics provide one. */
  readonly extent?: EstimatedExtent
  /** Why the extent is unknown, when it is. */
  readonly extentUnknownReason?: string
}

/**
 * The catalogue query: both spatial views, joined to relation statistics.
 *
 * ONE round trip. The union of the two views is joined to \`pg_class\`/\`pg_namespace\`
 * so \`reltuples\` and the relation kind arrive with the columns rather than in a
 * second query per layer -- listing 200 layers must not be 200 queries.
 */
export const CATALOG_SQL = [
  'SELECT',
  '  c.f_table_schema AS schema,',
  '  c.f_table_name AS table_name,',
  '  c.f_geometry_column AS column_name,',
  "  'geometry' AS spatial_kind,",
  '  c.srid AS srid,',
  '  c.type AS geometry_type,',
  '  COALESCE(cls.relkind::text, \'?\') AS relation_kind,',
  '  COALESCE(cls.reltuples, -1)::float8 AS estimated_rows',
  'FROM geometry_columns c',
  'LEFT JOIN pg_namespace n ON n.nspname = c.f_table_schema',
  'LEFT JOIN pg_class cls ON cls.relname = c.f_table_name AND cls.relnamespace = n.oid',
  "WHERE c.f_table_schema NOT IN ('pg_catalog', 'information_schema')",
  'UNION ALL',
  'SELECT',
  '  g.f_table_schema,',
  '  g.f_table_name,',
  '  g.f_geography_column,',
  "  'geography',",
  '  g.srid,',
  '  g.type,',
  '  COALESCE(cls2.relkind::text, \'?\'),',
  '  COALESCE(cls2.reltuples, -1)::float8',
  'FROM geography_columns g',
  'LEFT JOIN pg_namespace n2 ON n2.nspname = g.f_table_schema',
  'LEFT JOIN pg_class cls2 ON cls2.relname = g.f_table_name AND cls2.relnamespace = n2.oid',
  "WHERE g.f_table_schema NOT IN ('pg_catalog', 'information_schema')",
  'ORDER BY 1, 2, 3',
].join('\n')

/** The driver row shape, narrowed without trusting it. */
interface CatalogRow {
  readonly schema: string
  readonly table_name: string
  readonly column_name: string
  readonly spatial_kind: string
  readonly srid: number | string
  readonly geometry_type: string
  readonly relation_kind: string
  readonly estimated_rows: number | string
}

/**
 * Read the catalogue.
 * @param client - a connected client or pool.
 * @returns every spatial column, with its relation's row estimate.
 */
export async function readCatalog(client: Queryable): Promise<readonly CatalogLayer[]> {
  const result = await client.query(CATALOG_SQL)
  // `unknown` first: the driver types rows as `QueryResultRow`, and this cast is
  // the boundary where its untyped columns become ours -- which is why toLayer()
  // normalizes every single field instead of trusting the shape.
  return (result.rows as unknown as readonly CatalogRow[]).map(row => toLayer(row))
}

/**
 * Turn one driver row into a layer.
 *
 * Every field is normalized rather than trusted: the driver hands back \`numeric\`
 * as a STRING, and \`reltuples\` arrives as \`-1\` for a relation that has never been
 * analyzed. A catalogue that reported \`-1\` as a row count would be lying.
 * @param row - the driver row.
 * @returns the layer.
 */
export function toLayer(row: CatalogRow): CatalogLayer {
  const rows = Number(row.estimated_rows)
  return {
    schema: String(row.schema),
    table: String(row.table_name),
    column: String(row.column_name),
    spatialKind: row.spatial_kind === 'geography' ? 'geography' : 'geometry',
    srid: Number(row.srid) || 0,
    geometryType: normalizeGeometryType(String(row.geometry_type ?? 'Geometry')),
    relationKind: String(row.relation_kind ?? '?'),
    estimatedRows: Number.isFinite(rows) && rows >= 0 ? Math.round(rows) : -1,
    rowsKnown: Number.isFinite(rows) && rows >= 0,
  }
}

/**
 * Put a catalogue geometry type into the spelling the rest of this codebase uses.
 *
 * `geometry_columns.type` reports `POINT`, `MULTIPOLYGON`, ... in UPPERCASE, while
 * every other layer of this plugin -- the map spec, the description prose, the
 * tool schemas -- speaks GeoJSON's `Point`, `MultiPolygon`. Normalizing HERE, at
 * the boundary, is what keeps that from becoming a comparison that quietly never
 * matches; the live check caught the mismatch on its first run.
 * @param raw - the catalogue's spelling.
 * @returns the GeoJSON-style spelling.
 */
export function normalizeGeometryType(raw: string): string {
  const lower = raw.trim().toLowerCase()
  if (lower.length === 0) return 'Geometry'
  // An explicit table, because "capitalize the first letter" is wrong for exactly
  // the compound names that matter most: MULTILINESTRING must become
  // MultiLineString, not Multilinestring.
  const known = GEOJSON_GEOMETRY_NAMES[lower]
  if (known !== undefined) return known
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/** The GeoJSON spelling of every geometry type PostGIS reports. */
const GEOJSON_GEOMETRY_NAMES: Readonly<Record<string, string>> = {
  geometry: 'Geometry',
  point: 'Point',
  linestring: 'LineString',
  polygon: 'Polygon',
  multipoint: 'MultiPoint',
  multilinestring: 'MultiLineString',
  multipolygon: 'MultiPolygon',
  geometrycollection: 'GeometryCollection',
  circularstring: 'CircularString',
  compoundcurve: 'CompoundCurve',
  curvepolygon: 'CurvePolygon',
  multicurve: 'MultiCurve',
  multisurface: 'MultiSurface',
  polyhedralsurface: 'PolyhedralSurface',
  triangle: 'Triangle',
  tin: 'TIN',
}

/**
 * The estimated extent of one layer, from the statistics.
 *
 * \`ST_EstimatedExtent\` returns NULL when the table has no statistics. It does NOT
 * scan the table to find out.
 * @param schema - schema name.
 * @param table - table name.
 * @param column - spatial column.
 * @returns the extent, or undefined when the statistics cannot supply one.
 */
export function estimatedExtentSql(schema: string, table: string, column: string): string {
  return 'SELECT ST_EstimatedExtent(' + literal(schema) + ', ' + literal(table) + ', ' + literal(column) + ') AS extent'
}

/**
 * Quote a value as a SQL string literal.
 *
 * These three names come from the catalogue itself, not from a user, but they are
 * still escaped: a schema named \`it's\` is legal in PostgreSQL, and concatenating it
 * raw is a syntax error at best.
 * @param value - the raw name.
 * @returns a quoted literal, safe to concatenate.
 */
export function literal(value: string): string {
  return "'" + value.split("'").join("''") + "'"
}

/**
 * Quote an IDENTIFIER (a table, schema or column name).
 *
 * Identifiers cannot be bound as parameters -- `LIMIT $1` works, `FROM $1` does
 * not -- so a name that reaches SQL text must be quoted here. These names come
 * from the catalogue rather than from a user, but "from the catalogue" is not the
 * same as "safe": PostgreSQL allows a table called `we"ird`, and only doubling the
 * quotes keeps it one identifier.
 * @param name - the raw identifier.
 * @returns the quoted identifier.
 */
export function quoteIdent(name: string): string {
  return '"' + name.split('"').join('""') + '"'
}

/** The driver's extent row. */
interface ExtentRow {
  readonly extent: string | null
}

/**
 * Read one layer's estimated extent.
 * @param client - a connected client or pool.
 * @param layer - the layer to describe.
 * @returns the metadata, with a REASON when the extent is unknown.
 */
export async function readLayerMetadata(client: Queryable, layer: CatalogLayer): Promise<LayerMetadata> {
  // A VIEW has no statistics of its own and no geometry_columns statistics entry;
  // asking is harmless (NULL) but the reason is worth stating.
  const result = await client.query(estimatedExtentSql(layer.schema, layer.table, layer.column))
  const box = (result.rows as unknown as readonly ExtentRow[])[0]?.extent
  if (typeof box !== 'string' || box.length === 0) {
    return {
      layer,
      extentUnknownReason: layer.relationKind === 'v' || layer.relationKind === 'm'
        ? 'a view has no statistics of its own, so no estimated extent exists'
        : 'this table has no statistics yet; run ANALYZE (or VACUUM ANALYZE) to give it an estimated extent',
    }
  }
  const numbers = box.replace(/[A-Za-z()]/gu, ' ').trim().split(/[\s,]+/u).map(Number).filter(value => Number.isFinite(value))
  if (numbers.length < 4) {
    return { layer, extentUnknownReason: 'the statistics returned an extent this build cannot read: ' + box }
  }
  return { layer, extent: { minX: numbers[0] as number, minY: numbers[1] as number, maxX: numbers[2] as number, maxY: numbers[3] as number } }
}
