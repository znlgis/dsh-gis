/**
 * End-to-end provider test: real files in, gis-core types out.
 *
 * This is the M1a integration proof. Only the Cordis wiring is skipped -- the
 * opener, the filesystem, the format readers, the where-evaluator and the paging
 * are all the shipping code paths.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createHandler } from '../src/handler.ts'
import { describeDataset } from '../src/io.ts'

const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url))
const handler = createHandler()

/** Default paging used by the tests. */
const PAGE = { limit: 100, offset: 0, geometry: 'wkt' } as const

describe('pure-JS provider over real fixtures', () => {
  it('inspects a GeoJSON dataset and reports WGS84', async () => {
    const dataset = await describeDataset(FIXTURES + 'points.geojson')
    const result = await handler.inspect(dataset, undefined)
    expect(result.kind).toBe('geojson')
    expect(result.featureCount).toBe(3)
    expect(result.crs).toEqual({ source: 'assumed-rfc7946', epsg: 4326 })
    expect(result.bbox).toEqual([113.26, 23.13, 121.47, 39.9])
    expect(result.capabilities.read).toBe(true)
    expect(result.capabilities.write).toBe(false)
    expect(result.fields.map(f => f.name)).toEqual(['name', 'rank'])
  })

  it('reports the projected-GeoJSON hazard through inspect', async () => {
    const dataset = await describeDataset(FIXTURES + 'projected.geojson')
    const result = await handler.inspect(dataset, undefined)
    expect(result.issues.map(i => i.code)).toContain('CRS_AMBIGUOUS')
  })

  it('CRITICAL: a shapefile with no .prj inspects as CRS_UNKNOWN', async () => {
    const dataset = await describeDataset(FIXTURES + 'cities-noprj.shp')
    const result = await handler.inspect(dataset, undefined)
    expect(result.kind).toBe('shapefile')
    expect(result.crs.source).toBe('unknown')
    expect(result.issues.map(i => i.code)).toContain('CRS_UNKNOWN')
  })

  it('CRITICAL: GBK attributes survive the whole pipeline', async () => {
    const dataset = await describeDataset(FIXTURES + 'cities-gbk.shp')
    const result = await handler.query(dataset, { ...PAGE, geometry: 'none' })
    expect(result.rows.map(r => r.attributes.NAME)).toEqual(['北京', '上海', '广州'])
    expect(result.rows[0]?.attributes.POP).toBe(2189)
  })

  it('returns geometry as WKT and as GeoJSON on request', async () => {
    const dataset = await describeDataset(FIXTURES + 'points.geojson')
    const wkt = await handler.query(dataset, { ...PAGE, geometry: 'wkt' })
    expect(wkt.rows[0]?.geometry).toBe('POINT (116.4 39.9)')
    const geojson = await handler.query(dataset, { ...PAGE, geometry: 'geojson' })
    expect(geojson.rows[0]?.geometry).toEqual({ type: 'Point', coordinates: [116.4, 39.9] })
    const none = await handler.query(dataset, { ...PAGE, geometry: 'none' })
    expect(none.rows[0]?.geometry).toBeUndefined()
  })

  it('filters by attribute and by spatial window', async () => {
    const dataset = await describeDataset(FIXTURES + 'points.geojson')
    const named = await handler.query(dataset, { ...PAGE, geometry: 'none', where: "name = 'Beta'" })
    expect(named.rows).toHaveLength(1)
    expect(named.rows[0]?.attributes.rank).toBe(2)

    // a window over eastern China keeps Shanghai and Guangzhou, drops Beijing
    const windowed = await handler.query(dataset, { ...PAGE, geometry: 'none', bbox: [110, 20, 125, 35] })
    expect(windowed.rows.map(r => r.attributes.name)).toEqual(['Beta', 'Gamma'])
  })

  it('composes AND / OR and refuses SQL it cannot honour', async () => {
    const dataset = await describeDataset(FIXTURES + 'points.geojson')
    const and = await handler.query(dataset, { ...PAGE, geometry: 'none', where: 'rank > 1 AND rank < 3' })
    expect(and.rows.map(r => r.attributes.name)).toEqual(['Beta'])
    const or = await handler.query(dataset, { ...PAGE, geometry: 'none', where: "name = 'Alpha' OR name = 'Gamma'" })
    expect(or.rows.map(r => r.attributes.name)).toEqual(['Alpha', 'Gamma'])
    const like = await handler.query(dataset, { ...PAGE, geometry: 'none', where: "name LIKE 'B%'" })
    expect(like.rows.map(r => r.attributes.name)).toEqual(['Beta'])
    await expect(handler.query(dataset, { ...PAGE, where: 'SELECT * FROM x' })).rejects.toThrow(/unsupported/)
  })

  it('pages without lying about the totals', async () => {
    const dataset = await describeDataset(FIXTURES + 'points.geojson')
    const first = await handler.query(dataset, { limit: 2, offset: 0, geometry: 'none' })
    expect(first.rowCount).toBe(2)
    expect(first.totalCount).toBe(3)
    expect(first.truncated).toBe(true)
    const second = await handler.query(dataset, { limit: 2, offset: 2, geometry: 'none' })
    expect(second.rowCount).toBe(1)
    expect(second.truncated).toBe(false)
  })

  it('honours a field projection', async () => {
    const dataset = await describeDataset(FIXTURES + 'points.geojson')
    const result = await handler.query(dataset, { ...PAGE, geometry: 'none', fields: ['name'] })
    expect(result.columns).toEqual(['name'])
    expect(result.rows[0]?.attributes).toEqual({ name: 'Alpha' })
  })

  it('reads NDJSON and reports the line it skipped', async () => {
    const dataset = await describeDataset(FIXTURES + 'events.ndjson')
    const result = await handler.inspect(dataset, undefined)
    expect(result.featureCount).toBe(3)
    expect(result.issues.map(i => i.code)).toContain('PARSE_FAILED')
  })

  it('gives a shapefile family a stable id that changes when its bytes change', async () => {
    const first = await describeDataset(FIXTURES + 'cities-gbk.shp')
    const second = await describeDataset(FIXTURES + 'cities-gbk.shp')
    expect(first.id).toBe(second.id)
    expect(first.id).toMatch(/^ds_[0-9a-f]{16}$/)
    const other = await describeDataset(FIXTURES + 'cities-noprj.shp')
    expect(other.id).not.toBe(first.id)
  })
})
