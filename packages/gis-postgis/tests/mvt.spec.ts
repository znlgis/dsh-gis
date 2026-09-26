/**
 * The tile builder's PURE half (T3.4).
 *
 * "The database made the tile" is asserted against the live server. What is
 * asserted HERE is the property that decides whether that query is fast or a table
 * scan, and the refusals that keep a wrong tile from being produced at all.
 */
import { describe, expect, it } from 'vitest'
import type { CatalogLayer } from '../src/catalog.ts'
import { buildTileSql, MAX_FEATURES_PER_TILE, normalizeTile, TILE_EXTENT, tileLayerName } from '../src/mvt.ts'

const cities: CatalogLayer = {
  schema: 'dsh_gis_fixture',
  table: 'cities',
  column: 'geom',
  spatialKind: 'geometry',
  srid: 4326,
  geometryType: 'Point',
  relationKind: 'r',
  estimatedRows: 40,
  rowsKnown: true,
}

describe('building a tile query', () => {
  it('intersects in the LAYER CRS so the spatial index stays usable', () => {
    const sql = buildTileSql(cities, { z: 6, x: 49, y: 26 })
    const where = sql.slice(sql.indexOf('WHERE'))
    // Transforming the ROWS in the WHERE clause is the obvious form and the wrong
    // one: it defeats the GiST index. The tile envelope is transformed instead.
    expect(where).toContain('ST_Transform(bounds.tile, 4326)')
    expect(sql).toContain('ST_AsMVTGeom(')
    expect(sql).not.toMatch(/ST_Intersects\(\s*ST_Transform\(t\./u)
  })

  it('lets PostGIS build the tile, with our extent, buffer and layer name', () => {
    const sql = buildTileSql(cities, { z: 6, x: 49, y: 26 }, ['name'])
    expect(sql).toContain('ST_AsMVT(rows.*, ' + "'dsh_gis_fixture.cities'")
    expect(sql).toContain('4096')
    expect(sql).toContain('"name"')
    expect(sql).toContain('ST_TileEnvelope(6, 49, 26)')
    expect(tileLayerName(cities)).toBe('dsh_gis_fixture.cities')
  })

  it('refuses a layer with no SRID instead of guessing one', () => {
    // Guessing 4326 puts a projected dataset at plausible-looking wrong
    // coordinates, which is worse than saying no.
    expect(() => buildTileSql({ ...cities, srid: 0 }, { z: 1, x: 0, y: 0 })).toThrowError(/declares no SRID/u)
  })

  it('refuses tile addresses and knobs outside their range', () => {
    expect(() => normalizeTile({ z: 25, x: 0, y: 0 })).toThrowError(/zoom/u)
    expect(() => normalizeTile({ z: 2, x: 4, y: 0 })).toThrowError(/outside 0\.\.3/u)
    expect(() => normalizeTile({ z: 2, x: 0, y: -1 })).toThrowError(/outside/u)
    expect(() => normalizeTile({ z: 2, x: 0, y: 0, extent: 10 })).toThrowError(/extent/u)
    const normal = normalizeTile({ z: 2, x: 0, y: 0 })
    expect(normal.extent).toBe(TILE_EXTENT)
    expect(normal.maxFeatures).toBe(MAX_FEATURES_PER_TILE)
  })

  it('does not depend on GDAL', async () => {
    // The acceptance criterion is "tiles come from the database, not from GDAL", and
    // the strongest form of that is the dependency graph: this package must not
    // reference the GDAL package at all.
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = Object.keys(manifest.dependencies ?? {})
    expect(dependencies.some(name => name.includes('gdal'))).toBe(false)
  })
})
