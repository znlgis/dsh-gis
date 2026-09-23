/**
 * The raster projections, against hand-checked numbers.
 *
 * These are the functions where a raster reader goes silently wrong: a 16-bit
 * DEM drawn as 8-bit is a black square, a 4-band image with the wrong stride is
 * diagonal stripes, a mirrored extent looks like a projection bug. None of that
 * throws, so each case is asserted by value.
 */
import { describe, expect, it } from 'vitest'
import { imageCoordinates, planReadSize, toRgba } from '../src/client/map/cog-image.ts'

describe('samples become pixels', () => {
  it('draws one band as an opaque grey ramp', () => {
    const image = toRgba({ values: [0, 128, 255, 64], bands: 1, bitsPerSample: 8, width: 2 })
    expect(image.width).toBe(2)
    expect(image.height).toBe(2)
    expect([...image.rgba]).toEqual([
      0, 0, 0, 255,
      128, 128, 128, 255,
      255, 255, 255, 255,
      64, 64, 64, 255,
    ])
  })

  it('scales a 16-bit raster by its DECLARED depth, not by clipping', () => {
    // 65535 is white; 32768 is mid-grey. Clipping would make both white.
    const image = toRgba({ values: [65535, 32768, 0], bands: 1, bitsPerSample: 16, width: 3 })
    expect([...image.rgba].filter((_value, index) => index % 4 === 0)).toEqual([255, 128, 0])
  })

  it('keeps 32-bit values as they are', () => {
    // Elevation: dividing by 2^24 would flatten a 100 m DEM to black.
    const image = toRgba({ values: [100, 200], bands: 1, bitsPerSample: 32, width: 2 })
    expect([...image.rgba].filter((_value, index) => index % 4 === 0)).toEqual([100, 200])
  })

  it('reads three bands as RGB and four as RGBA', () => {
    const rgb = toRgba({ values: [10, 20, 30], bands: 3, bitsPerSample: 8, width: 1 })
    expect([...rgb.rgba]).toEqual([10, 20, 30, 255])
    const rgba = toRgba({ values: [10, 20, 30, 40], bands: 4, bitsPerSample: 8, width: 1 })
    expect([...rgba.rgba]).toEqual([10, 20, 30, 40])
  })

  it('reads two bands as grey plus alpha, the TIFF convention', () => {
    const image = toRgba({ values: [200, 128], bands: 2, bitsPerSample: 8, width: 1 })
    expect([...image.rgba]).toEqual([200, 200, 200, 128])
  })

  it('makes ONLY the declared nodata transparent', () => {
    const image = toRgba({ values: [0, 7, 9], bands: 1, bitsPerSample: 8, width: 3, noData: 7 })
    const alphas = [...image.rgba].filter((_value, index) => index % 4 === 3)
    // A real zero stays opaque: guessing nodata from the data erases real zeroes.
    expect(alphas).toEqual([255, 0, 255])
  })

  it('refuses what it cannot draw, loudly', () => {
    expect(() => toRgba({ values: [1, 2, 3, 4, 5], bands: 5, bitsPerSample: 8, width: 1 })).toThrow(/5 samples/u)
    expect(() => toRgba({ values: [], bands: 1, bitsPerSample: 8, width: 1 })).toThrow(/zero pixels/u)
  })
})

describe('the read is capped, the extent is exact', () => {
  it('holds the longer edge at the cap and keeps the aspect ratio', () => {
    expect(planReadSize(26000, 13000, 2048)).toEqual({ width: 2048, height: 1024 })
    expect(planReadSize(100, 4000, 2048)).toEqual({ width: 51, height: 2048 })
    // Never larger than the source.
    expect(planReadSize(64, 32, 2048)).toEqual({ width: 64, height: 32 })
    expect(() => planReadSize(0, 10, 2048)).toThrow(/no extent/u)
  })

  it('orders the image corners the way a MapLibre image source wants them', () => {
    // Clockwise from the top left: a mirrored raster is a silent wrong answer.
    expect(imageCoordinates([100, 30, 110, 40])).toEqual([[100, 40], [110, 40], [110, 30], [100, 30]])
  })
})
