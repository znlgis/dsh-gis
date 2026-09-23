/**
 * Renderer test: geometry in, a real PNG out.
 *
 * Asserts the file structure (signature, IHDR dimensions) and that the picture
 * actually contains drawn pixels -- a blank PNG would satisfy a weaker test that
 * only checked the signature. It also writes the image to tests/fixtures/out so
 * a human can look at it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RawFeature } from '@znlgis/dsh-gis-formats'
import { encodePng } from '../src/png.ts'
import { fitBbox, rasterize } from '../src/raster.ts'

const OUT = fileURLToPath(new URL('../../../tests/fixtures/out/', import.meta.url))

/** A square ring. */
function box(w: number, s: number, e: number, n: number): number[][] {
  return [[w, s], [e, s], [e, n], [w, n], [w, s]]
}

/** One polygon with a hole, one line, two points. */
const FEATURES: RawFeature[] = [
  {
    attributes: { name: 'block-with-hole' },
    geometry: { type: 'Polygon', coordinates: [box(0, 0, 100, 80), box(30, 25, 60, 50)] },
  },
  { attributes: { name: 'small' }, geometry: { type: 'Polygon', coordinates: [box(110, 15, 150, 45)] } },
  { attributes: { name: 'route' }, geometry: { type: 'LineString', coordinates: [[0, 90], [60, 110], [150, 95], [200, 120]] } },
  { attributes: { name: 'p1' }, geometry: { type: 'Point', coordinates: [20, 65] } },
  { attributes: { name: 'p2' }, geometry: { type: 'Point', coordinates: [130, 70] } },
]

/** Read a big-endian uint32 out of a buffer. */
function u32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at)
}

describe('PNG encoder', () => {
  it('writes a well-formed PNG header', () => {
    const raster = rasterize(FEATURES, { width: 400, height: 300, bbox: [-10, -10, 210, 130] })
    const png = encodePng(raster.width, raster.height, raster.pixels)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // first chunk must be IHDR, and its dimensions must match what we asked for
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR')
    expect(u32(png, 16)).toBe(400)
    expect(u32(png, 20)).toBe(300)
    expect(png.byteLength).toBeGreaterThan(1000)
  })

  it('actually draws: the image is not one flat colour', () => {
    const raster = rasterize(FEATURES, { width: 400, height: 300, bbox: [-10, -10, 210, 130] })
    expect(raster.drawn).toBe(5)
    const seen = new Set<string>()
    for (let at = 0; at < raster.pixels.length; at += 4) {
      seen.add(`${String(raster.pixels[at])},${String(raster.pixels[at + 1])},${String(raster.pixels[at + 2])}`)
    }
    // background, fill, outline and point ink at the very least
    expect(seen.size).toBeGreaterThan(3)
  })

  it('keeps the hole empty, so even-odd filling is real', () => {
    const raster = rasterize(FEATURES, { width: 400, height: 300, bbox: [-10, -10, 210, 130] })
    const inside = (lon: number, lat: number): string => {
      const x = Math.round((lon - raster.bbox[0]) / (raster.bbox[2] - raster.bbox[0]) * raster.width)
      const y = Math.round((raster.bbox[3] - lat) / (raster.bbox[3] - raster.bbox[1]) * raster.height)
      const at = (y * raster.width + x) * 4
      return `${String(raster.pixels[at])},${String(raster.pixels[at + 1])},${String(raster.pixels[at + 2])}`
    }
    expect(inside(45, 37)).toBe('250,250,248')   // centre of the hole stays background
    expect(inside(10, 40)).not.toBe('250,250,248') // the ring itself is painted
  })

  it('fits the extent to the image aspect ratio instead of stretching', () => {
    const fitted = fitBbox([0, 0, 100, 100], 400, 200)
    const spanX = fitted[2] - fitted[0]
    const spanY = fitted[3] - fitted[1]
    expect(spanX / spanY).toBeCloseTo(2, 5)
    expect((fitted[0] + fitted[2]) / 2).toBeCloseTo(50, 5)
  })

  it('writes the sample image for human inspection', () => {
    mkdirSync(OUT, { recursive: true })
    const raster = rasterize(FEATURES, { width: 800, height: 520, bbox: [-10, -10, 210, 130] })
    writeFileSync(OUT + 'render-check.png', encodePng(raster.width, raster.height, raster.pixels))
    expect(raster.drawn).toBe(5)
  })
})
