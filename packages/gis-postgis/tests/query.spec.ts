/**
 * The page builder's PURE half (T3.3).
 *
 * These assertions are about SQL TEXT and about what a driver row becomes -- the
 * two places where a mistake stays silent: an unquoted identifier is a syntax
 * error at best and a second table at worst, an unordered page quietly repeats
 * rows, and a value that is not JSON-safe breaks the tool call carrying it.
 */
import { describe, expect, it } from 'vitest'
import type { CatalogLayer } from '../src/catalog.ts'
import { buildPageSql, normalizeLimit, normalizeOffset, orderKeyOf, PAGE_LIMITS, toFeature } from '../src/query.ts'

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

describe('building a page query', () => {
  it('quotes every identifier and encodes geometry in the database', () => {
    const sql = buildPageSql(cities, 'id', { limit: 10, offset: 20 })
    expect(sql).toContain('FROM "dsh_gis_fixture"."cities"')
    expect(sql).toContain('ST_AsGeoJSON("geom")')
    expect(sql).toContain('ORDER BY "id"')
    expect(sql).toContain('LIMIT 10 OFFSET 20')
  })

  it('casts GEOGRAPHY to geometry so the encoder has something to encode', () => {
    const sql = buildPageSql({ ...cities, spatialKind: 'geography', column: 'geog', table: 'areas_geog' }, undefined)
    expect(sql).toContain('ST_AsGeoJSON("geog"::geometry)')
  })

  it('orders by ctid when there is no primary key, and says so', () => {
    // LIMIT/OFFSET without ORDER BY has no defined order: page 2 can repeat rows.
    expect(orderKeyOf(undefined)).toBe('ctid')
    expect(orderKeyOf('id')).toBe('id')
    expect(buildPageSql(cities, undefined, { limit: 1 })).toContain('ORDER BY "ctid"')
  })

  it('refuses a page above the cap instead of clamping it', () => {
    expect(() => normalizeLimit(PAGE_LIMITS.max + 1)).toThrowError(/at most/u)
    expect(() => normalizeLimit(0)).toThrowError(/positive whole number/u)
    expect(() => normalizeLimit(2.5)).toThrowError(/positive whole number/u)
    expect(normalizeLimit(undefined)).toBe(PAGE_LIMITS.default)
    expect(() => normalizeOffset(-1)).toThrowError(/zero or a positive/u)
    expect(normalizeOffset(undefined)).toBe(0)
  })

  it('cannot be made to emit a non-integer, and survives a hostile identifier', () => {
    // The numbers that DO reach the text have been through the validator above, so
    // the only remaining input is a catalogue name -- and PostgreSQL allows this
    // one, which is why quoting doubles the quote rather than escaping it.
    expect(buildPageSql(cities, 'id', { limit: 999, offset: 0 })).toContain('LIMIT 999 OFFSET 0')
    expect(buildPageSql({ ...cities, table: 'we"ird' }, 'id', { limit: 1 })).toContain('"we""ird"')
  })
})

describe('turning a row into a feature', () => {
  it('parses the geometry, and keeps it out of the properties', () => {
    const feature = toFeature({
      id: 7,
      name: 'city-7',
      geom: 'POINT(100 30)',
      __geometry: '{"type":"Point","coordinates":[100.7,30.35]}',
    }, 'geom')
    expect(feature.geometry).toEqual({ type: 'Point', coordinates: [100.7, 30.35] })
    expect(feature.properties).toEqual({ id: 7, name: 'city-7' })
  })

  it('never throws on a geometry the database could not encode', () => {
    expect(toFeature({ __geometry: 'not json' }, 'geom').geometry).toBeNull()
    expect(toFeature({ __geometry: null }, 'geom').geometry).toBeNull()
  })

  it('makes every attribute JSON-safe', () => {
    const feature = toFeature({
      big: BigInt(42),
      when: new Date(0),
      buf: Buffer.from('ab'),
      nil: null,
      flag: true,
      __geometry: null,
    }, 'geom')
    expect(feature.properties).toEqual({
      big: 42,
      when: '1970-01-01T00:00:00.000Z',
      buf: 'ab',
      nil: null,
      flag: true,
    })
  })
})
