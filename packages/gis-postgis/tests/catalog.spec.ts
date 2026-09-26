/**
 * The catalogue's PURE half (T3.2): what it asks the database, and what it makes
 * of the answers.
 *
 * The live check proves the answers are real; these prove the two properties that
 * must hold regardless: **no \`count(*)\` is ever built**, and a driver row that
 * carries a lie (a negative estimate, a numeric-as-string) becomes an honest
 * "unknown" rather than a wrong number.
 */
import { describe, expect, it } from 'vitest'
import { CATALOG_SQL, estimatedExtentSql, literal, normalizeGeometryType, toLayer } from '../src/catalog.ts'

describe('the catalogue query', () => {
  it('never counts rows', () => {
    // The plan's acceptance criterion, asserted on the SQL text itself. A viewer
    // that lists layers must not make the database read every row of every table.
    expect(CATALOG_SQL).not.toMatch(/count\s*\(/iu)
    expect(CATALOG_SQL).toMatch(/reltuples/u)
  })

  it('reads BOTH spatial catalogue views', () => {
    // geography_columns is a different view; reading only geometry_columns
    // silently omits every geography layer.
    expect(CATALOG_SQL).toContain('geometry_columns')
    expect(CATALOG_SQL).toContain('geography_columns')
    // The legacy f_-prefixed names are the ones PostGIS 3.x actually has.
    expect(CATALOG_SQL).toContain('f_table_schema')
    expect(CATALOG_SQL).toContain('f_geometry_column')
    expect(CATALOG_SQL).toContain('f_geography_column')
  })

  it('filters the system schemas out of both halves', () => {
    const wheres = CATALOG_SQL.split('\n').filter(line => line.includes('NOT IN'))
    expect(wheres).toHaveLength(2)
    for (const where of wheres) expect(where).toContain('pg_catalog')
  })

  it('builds the extent call without interpolating a raw name', () => {
    expect(estimatedExtentSql('public', 't', 'geom')).toContain("'public'")
    // A name with a quote is legal in PostgreSQL; it must not break out.
    expect(estimatedExtentSql('pub' + "'" + 'lic', 't', 'geom')).toContain("'pub''lic'")
    expect(literal("it's")).toBe("'it''s'")
  })
})

describe('reading a driver row', () => {
  it('turns the catalogue spelling into the one the rest of the code speaks', () => {
    expect(normalizeGeometryType('POINT')).toBe('Point')
    expect(normalizeGeometryType('MULTIPOLYGON')).toBe('MultiPolygon')
    expect(normalizeGeometryType('GEOMETRY')).toBe('Geometry')
    expect(normalizeGeometryType('')).toBe('Geometry')
  })

  it('reports an estimate as UNKNOWN rather than as a number', () => {
    const row = {
      schema: 's', table_name: 't', column_name: 'geom', spatial_kind: 'geometry',
      srid: 4326, geometry_type: 'POINT', relation_kind: 'r', estimated_rows: -1,
    }
    const layer = toLayer(row)
    expect(layer.estimatedRows).toBe(-1)
    expect(layer.rowsKnown).toBe(false)
    expect(layer.geometryType).toBe('Point')
  })

  it('accepts the numeric-as-string the driver really sends, and floors it', () => {
    const layer = toLayer({
      schema: 's', table_name: 't', column_name: 'geom', spatial_kind: 'geography',
      srid: '0', geometry_type: 'POLYGON', relation_kind: 'v', estimated_rows: '1234.6',
    })
    expect(layer.estimatedRows).toBe(1235)
    expect(layer.rowsKnown).toBe(true)
    expect(layer.spatialKind).toBe('geography')
    expect(layer.srid).toBe(0)
  })
})
