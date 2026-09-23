/**
 * M1a exit criteria, asserted against committed fixtures.
 *
 * These are the three SILENT failure modes the design singles out -- an
 * unknown CRS, a wrong attribute encoding, and coordinates that are not
 * degrees -- plus WKT round-tripping, which is the model's primary geometry
 * exchange. Each one is asserted by CODE, not by prose.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  crsFromPrj, hasResolvedCrs, parseWkt, readGeoJson, readNdjson, readShapefile, toWkt,
} from '../src/index.ts'

const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url))

/** Read one fixture as text. */
function text(name: string): string { return readFileSync(FIXTURES + name, 'utf8') }

/** Read one fixture as bytes. */
function bytes(name: string): Uint8Array { return new Uint8Array(readFileSync(FIXTURES + name)) }

/** Read one fixture when it exists, else undefined. */
function optional(name: string): Uint8Array | undefined {
  try { return bytes(name) } catch { return undefined }
}

describe('WKT round-trip', () => {
  it('parses and re-serializes every supported geometry', () => {
    const cases = [
      'POINT (116.4 39.9)',
      'LINESTRING (0 0, 10 0, 10 10)',
      'POLYGON ((0 0, 10 0, 10 10, 0 0))',
      'MULTIPOINT ((1 2), (3 4))',
      'MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))',
      'MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))',
      'GEOMETRYCOLLECTION (POINT (1 2), LINESTRING (0 0, 1 1))',
    ]
    for (const wkt of cases) {
      const parsed = parseWkt(wkt)
      expect(toWkt(parsed.geometry), wkt).toBe(wkt)
    }
  })

  it('keeps the EWKT SRID out of band', () => {
    const parsed = parseWkt('SRID=4326;POINT (1 2)')
    expect(parsed.srid).toBe(4326)
    expect(toWkt(parsed.geometry)).toBe('POINT (1 2)')
  })

  it('records dimensionality without folding Z into the geometry', () => {
    expect(parseWkt('POINT Z (1 2 3)').dimensions).toBe(3)
    expect(parseWkt('POINT (1 2)').dimensions).toBe(2)
  })

  it('accepts EMPTY geometries', () => {
    expect(parseWkt('POINT EMPTY').geometry).toEqual({ type: 'Point', coordinates: [] })
  })

  it('rejects malformed text instead of guessing', () => {
    expect(() => parseWkt('CIRCLE (0 0 5)')).toThrow(/unsupported WKT geometry type/)
    expect(() => parseWkt('POINT (1 2')).toThrow()
  })
})

describe('GeoJSON', () => {
  it('assumes RFC 7946 WGS84 and reports the extent', () => {
    const result = readGeoJson(text('points.geojson'))
    expect(result.features).toHaveLength(3)
    expect(result.crs).toEqual({ source: 'assumed-rfc7946', epsg: 4326 })
    expect(result.bbox).toEqual([113.26, 23.13, 121.47, 39.9])
    expect(result.issues).toHaveLength(0)
  })

  it('FLAGS projected coordinates with their raw extent rather than drawing them', () => {
    const result = readGeoJson(text('projected.geojson'))
    const issue = result.issues.find(i => i.code === 'CRS_AMBIGUOUS')
    expect(issue).toBeDefined()
    // The raw extent is what makes the report actionable, so assert it is present.
    expect(issue?.message).toContain('500000')
    expect(issue?.message).toContain('3400000')
    expect(hasResolvedCrs(result.crs)).toBe(true) // declared WGS84 ...
  })

  it('reads NDJSON and counts the lines it had to skip', () => {
    const result = readNdjson(text('events.ndjson'))
    expect(result.features).toHaveLength(3)
    expect(result.issues.find(i => i.code === 'PARSE_FAILED')?.count).toBe(1)
  })
})

describe('shapefile family', () => {
  const noPrj = { shp: bytes('cities-noprj.shp'), dbf: bytes('cities-noprj.dbf') }
  const gbk = {
    shp: bytes('cities-gbk.shp'),
    dbf: bytes('cities-gbk.dbf'),
    prj: text('cities-gbk.prj'),
    cpg: text('cities-gbk.cpg'),
  }

  it('decodes Point geometries and the header extent', () => {
    const result = readShapefile(noPrj)
    expect(result.geometryType).toBe('Point')
    expect(result.features).toHaveLength(3)
    expect(result.features[0]?.geometry).toEqual({ type: 'Point', coordinates: [116.4, 39.9] })
    expect(result.bbox).toEqual([113.26, 23.13, 121.47, 39.9])
  })

  it('CRITICAL: a missing .prj yields CRS_UNKNOWN, not a guessed CRS', () => {
    const result = readShapefile(noPrj)
    expect(result.crs.source).toBe('unknown')
    expect(result.crs.epsg).toBeUndefined()
    expect(hasResolvedCrs(result.crs)).toBe(false)
    const issue = result.issues.find(i => i.code === 'CRS_UNKNOWN')
    expect(issue).toBeDefined()
    expect(issue?.message).toMatch(/measurements and overlays are refused/)
  })

  it('flags an undecidable attribute encoding instead of assuming UTF-8', () => {
    const result = readShapefile(noPrj)
    expect(result.encoding?.source).toBe('unknown')
    expect(result.issues.find(i => i.code === 'ENCODING_UNDECIDED')).toBeDefined()
  })

  it('CRITICAL: .cpg GBK decodes Chinese attributes correctly', () => {
    const result = readShapefile(gbk)
    expect(result.encoding).toEqual({ used: 'gbk', source: 'cpg' })
    expect(result.features.map(f => f.attributes.NAME)).toEqual(['北京', '上海', '广州'])
    expect(result.features[0]?.attributes.POP).toBe(2189)
    expect(result.issues.find(i => i.code === 'ENCODING_UNDECIDED')).toBeUndefined()
  })

  it('lets an explicit encoding override a wrong .cpg', () => {
    const result = readShapefile(noPrj, { encoding: 'gbk' })
    expect(result.encoding).toEqual({ used: 'gbk', source: 'user' })
  })

  it('resolves the CRS from a .prj and recognises a stated EPSG authority', () => {
    const result = readShapefile(gbk)
    expect(result.crs.source).toBe('prj')
    expect(hasResolvedCrs(result.crs)).toBe(true)
    expect(readShapefile(gbk).crs.name).toContain('WGS 84')
    expect(crsFromPrj(text('webmercator.prj')).epsg).toBe(3857)
  })

  it('tolerates a family with no .dbf at all', () => {
    const result = readShapefile({ shp: bytes('cities-noprj.shp') })
    expect(result.features).toHaveLength(3)
    expect(result.features[0]?.attributes).toEqual({})
    expect(result.issues.find(i => i.code === 'DATASET_UNREADABLE')).toBeDefined()
  })

  it('keeps the optional helper honest about what exists', () => {
    expect(optional('cities-gbk.cpg')).toBeDefined()
    expect(optional('does-not-exist.cpg')).toBeUndefined()
  })
})
