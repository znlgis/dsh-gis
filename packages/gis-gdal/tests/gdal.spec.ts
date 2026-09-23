/**
 * The GDAL mapping, driven by the REAL ogrinfo and ogr2ogr on this machine.
 *
 * This is the verification that a tool call would otherwise be needed for: the
 * handler's only real dependency is `runtime.run`, so supplying a runner that
 * spawns the actual binaries exercises the whole mapping -- argv, JSON shape,
 * CRS resolution, encoding metadata and the feature path -- without Cordis and
 * without a model.
 *
 * The fixtures are generated, not hand-written: cities.gdb was produced by
 * `ogr2ogr -f OpenFileGDB` from cities-gbk.shp, so it is a genuine Esri file
 * geodatabase rather than something shaped like one.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deriveDatasetId, type Dataset } from '@znlgis/dsh-gis-core'
import { createGdalHandler } from '../src/handler.ts'

const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url))
const GDAL_BIN = 'C:\\OSGeo4W\\bin'

/** Run a real GDAL tool, with the configured directory first on PATH. */
const runtime = {
  async run({ argv, cwd }: { argv: readonly string[]; cwd: string }) {
    const [program, ...rest] = argv
    const result = spawnSync(program as string, rest as string[], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${GDAL_BIN};${process.env.PATH ?? ''}` },
      maxBuffer: 64 * 1024 * 1024,
    })
    return {
      exitCode: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      completed: result.status !== null,
      enforcement: 'full',
    }
  },
}

const handler = createGdalHandler(runtime)

/** A gdb dataset pointed at the generated sample. */
function gdb(): Dataset {
  const dir = FIXTURES + 'cities.gdb'
  return { id: deriveDatasetId({ path: dir, kind: 'gdb' }), kind: 'gdb', title: 'cities.gdb', dir, layers: [{ name: 'cities.gdb' }] }
}

/** A shapefile dataset read through GDAL, to compare against the pure-JS reader. */
function shp(): Dataset {
  const main = FIXTURES + 'cities-gbk.shp'
  return { id: deriveDatasetId({ path: main, kind: 'shapefile' }), kind: 'shapefile', title: 'cities-gbk.shp', main, siblings: [main], layers: [{ name: 'cities-gbk' }] }
}

const hasGdal = existsSync(GDAL_BIN + '\\ogrinfo.exe')
const hasGdb = existsSync(FIXTURES + 'cities.gdb')

describe.skipIf(!hasGdal || !hasGdb)('GDAL handler against real binaries', () => {
  it('inspects a file geodatabase and resolves the CRS to a real EPSG code', async () => {
    const result = await handler.inspect(gdb(), undefined)
    expect(result.kind).toBe('gdb')
    // The whole reason the GDAL provider exists: a resolved EPSG code, not a guess.
    expect(result.crs.epsg).toBe(4326)
    expect(result.crs.source).toBe('native')
    expect(result.featureCount).toBe(3)
    expect(result.fields.map(f => f.name)).toEqual(['NAME', 'POP'])
    expect(result.issues.find(i => i.code === 'CRS_UNKNOWN')).toBeUndefined()
  })

  it('reports the laundered layer name GDAL actually uses', async () => {
    const result = await handler.inspect(gdb(), undefined)
    // ogr2ogr warned it normalized 'cities-gbk'; the handler must report the real name.
    expect(result.layers.map(l => l.name)).toContain('cities_gbk')
  })

  it('reads features through ogr2ogr and decodes GBK text', async () => {
    const page = await handler.query(gdb(), { limit: 10, offset: 0, geometry: 'none' })
    expect(page.rowCount).toBe(3)
    expect(page.rows.map(r => r.attributes.NAME).sort()).toEqual(['上海', '广州', '北京'].sort())
  })

  it('returns geometry as WKT through the shared GeoJSON reader', async () => {
    const page = await handler.query(gdb(), { limit: 1, offset: 0, geometry: 'wkt' })
    expect(String(page.rows[0]?.geometry)).toMatch(/^POINT \(/)
  })

  it('inspects a shapefile through GDAL and agrees with the pure-JS reader about the CRS', async () => {
    const result = await handler.inspect(shp(), undefined)
    expect(result.crs.epsg).toBe(4326)
    // GDAL's own view of the encoding, from the .cpg the pure-JS layer also honours.
    expect(result.encoding?.used).toBe('GBK')
  })

  it('reports a layer that does not exist rather than returning nothing', async () => {
    await expect(handler.inspect(gdb(), 'no-such-layer')).rejects.toThrow(/no layer named/)
  })
})

describe.skipIf(hasGdal)('when GDAL is absent', () => {
  it('is skipped on a machine without ogrinfo', () => {
    expect(hasGdal).toBe(false)
  })
})
