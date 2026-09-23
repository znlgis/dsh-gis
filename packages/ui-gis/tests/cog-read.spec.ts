/**
 * The COG read, against a REAL GeoTIFF from the real GDAL.
 *
 * The pure projections above are checked with hand-written numbers; this file
 * checks the whole path a browser takes -- open, find the extent, ask for a
 * capped window, expand to RGBA -- against bytes produced by gdal_translate.
 * Nothing here is mocked: the file is made, converted, and decoded.
 *
 * Skipped (not faked) when GDAL is absent: a mock GeoTIFF would prove only that
 * the mock agrees with itself.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCogImage } from '../src/client/map/cog-layer.ts'

const GDAL_BIN = process.env.GDAL_BIN ?? 'C:\\OSGeo4W\\bin'
const hasGdal = existsSync(GDAL_BIN + '\\gdal_create.exe') && existsSync(GDAL_BIN + '\\gdal_translate.exe')

const roots: string[] = []

/** Run one GDAL tool with its directory first on PATH. */
function gdal(program: string, argv: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(join(GDAL_BIN, program), [...argv], {
    encoding: 'utf8',
    env: { ...process.env, PATH: GDAL_BIN + ';' + (process.env.PATH ?? '') },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Build a real COG and hand back its bytes. */
async function makeCog(options: { readonly srs: string; readonly bands: number; readonly size: readonly [number, number] }): Promise<ArrayBuffer> {
  const work = await mkdtemp(join(tmpdir(), 'gis-cog-read-'))
  roots.push(work)
  const plain = join(work, 'plain.tif')
  const cog = join(work, 'out.tif')
  const burns = options.bands === 1 ? ['-burn', '200'] : ['-burn', '200', '-burn', '100', '-burn', '50']
  const created = gdal('gdal_create.exe', [
    '-of', 'GTiff', '-outsize', String(options.size[0]), String(options.size[1]),
    '-bands', String(options.bands), '-ot', 'Byte', ...burns,
    '-a_srs', options.srs, '-a_ullr', '100', '40', '110', '30',
    plain,
  ])
  expect(created.status, created.stderr).toBe(0)
  const converted = gdal('gdal_translate.exe', ['-of', 'COG', plain, cog])
  expect(converted.status, converted.stderr).toBe(0)
  const bytes = await readFile(cog)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!hasGdal)('decoding a real COG', () => {
  it('reads a geographic raster, its extent, and its values', async () => {
    const image = await readCogImage(await makeCog({ srs: 'EPSG:4326', bands: 1, size: [64, 32] }))

    // Smaller than the cap, so the full resolution comes back.
    expect(image.width).toBe(64)
    expect(image.height).toBe(32)
    // The burn value is the only value in the file: every pixel is 200 grey.
    expect(image.rgba[0]).toBe(200)
    expect(image.rgba[3]).toBe(255)
    // The extent comes from the file's own tie points, not from a guess.
    expect(image.bbox[0]).toBeCloseTo(100, 4)
    expect(image.bbox[1]).toBeCloseTo(30, 4)
    expect(image.bbox[2]).toBeCloseTo(110, 4)
    expect(image.bbox[3]).toBeCloseTo(40, 4)
  })

  it('caps the window instead of decoding the whole raster', async () => {
    const image = await readCogImage(await makeCog({ srs: 'EPSG:4326', bands: 1, size: [300, 100] }), { maxSize: 64 })
    // Aspect preserved, longer edge at the cap.
    expect(image.width).toBe(64)
    expect(image.height).toBe(21)
    expect(image.rgba.byteLength).toBe(64 * 21 * 4)
  })

  it('reads three bands in file order', async () => {
    const image = await readCogImage(await makeCog({ srs: 'EPSG:4326', bands: 3, size: [16, 16] }))
    expect([image.rgba[0], image.rgba[1], image.rgba[2], image.rgba[3]]).toEqual([200, 100, 50, 255])
  })

  it('REFUSES a projected raster rather than drawing it in the wrong place', async () => {
    // A UTM extent is metres; placing it at lng/lat would draw a plausible map
    // in the wrong hemisphere. Reprojection is T4's work, so this must refuse.
    const bytes = await makeCog({ srs: 'EPSG:32650', bands: 1, size: [16, 16] })
    await expect(readCogImage(bytes)).rejects.toMatchObject({ code: 'CRS_UNKNOWN' })
  })
})
