/**
 * Turning decoded raster samples into something a map can draw (the COG direct
 * read; the same projection PMTiles/FlatGeobuf tiles will use).
 *
 * Everything here is a PURE function of the decoded bytes, which is the point:
 * the pixel arithmetic is where this kind of code goes silently wrong (a 16-bit
 * DEM drawn as if it were 8-bit is a black square, a 4-band image drawn with the
 * wrong stride is diagonal stripes), and pure functions are testable against
 * real GeoTIFFs without a browser.
 */
import { GisClientError } from './client-error.ts'

/** One decoded raster, ready to become an image. */
export interface RasterImage {
  readonly width: number
  readonly height: number
  /** RGBA, 4 bytes per pixel, row-major -- the shape \`ImageData\` wants. */
  readonly rgba: Uint8ClampedArray
}

/** What the reader knows about the samples it decoded. */
export interface RasterSamples {
  /** Interleaved sample values: pixel 0's samples, then pixel 1's, ... */
  readonly values: ArrayLike<number>
  /** Samples per pixel, as the file declares it. */
  readonly bands: number
  /** Bits per sample (8, 16, 32...). */
  readonly bitsPerSample: number
  /** Width of the decoded window; its height is derived from the value count. */
  readonly width: number
  /** A value that means "no data", drawn transparent. */
  readonly noData?: number
}

/**
 * Expand a decoded raster into RGBA.
 *
 * Four cases, and each is a decision:
 * - **1 band** is a grey ramp (a DEM, a mask) -- drawn opaque, because a
 *   single-band raster with full alpha would be invisible;
 * - **2 bands** is grey + alpha, the TIFF convention;
 * - **3 or 4** are RGB(A) in file order.
 *
 * Values wider than 8 bits are scaled by their DECLARED depth rather than
 * clipped at 255: a 16-bit DEM would otherwise render as a white rectangle.
 * 32-bit and wider are left alone, because those are nearly always elevation
 * where the numbers are the point, and dividing them down would flatten the map.
 * @param samples - the decoded values and their shape.
 * @returns the RGBA image.
 * @throws GisClientError when the sample count cannot be drawn, or is empty.
 */
export function toRgba(samples: RasterSamples): RasterImage {
  const { values, bands, bitsPerSample, noData } = samples
  if (bands < 1 || bands > 4) {
    throw new GisClientError('RASTER_UNSUPPORTED', 'this raster has ' + String(bands) + ' samples per pixel, which is not drawable')
  }
  const pixels = Math.floor(values.length / bands)
  if (pixels <= 0) throw new GisClientError('RASTER_EMPTY', 'this raster decoded to zero pixels')
  const width = samples.width > 0 ? samples.width : pixels
  const height = Math.max(1, Math.round(pixels / width))

  const max = bitsPerSample > 8 && bitsPerSample < 32 ? Math.pow(2, bitsPerSample) - 1 : 255
  const scale = max > 255 ? 255 / max : 1
  const at = (pixel: number, band: number): number => Number(values[pixel * bands + band] ?? 0)

  const rgba = new Uint8ClampedArray(pixels * 4)
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const base = pixel * 4
    const first = at(pixel, 0)
    if (noData !== undefined && first === noData) {
      // Transparent, but only where the FILE says so: guessing a nodata value
      // out of the data would erase real zeroes.
      rgba[base + 3] = 0
      continue
    }
    const grey = first * scale
    if (bands === 1) {
      rgba[base] = grey
      rgba[base + 1] = grey
      rgba[base + 2] = grey
      rgba[base + 3] = 255
    } else if (bands === 2) {
      rgba[base] = grey
      rgba[base + 1] = grey
      rgba[base + 2] = grey
      rgba[base + 3] = at(pixel, 1) * scale
    } else {
      rgba[base] = grey
      rgba[base + 1] = at(pixel, 1) * scale
      rgba[base + 2] = at(pixel, 2) * scale
      rgba[base + 3] = bands === 4 ? at(pixel, 3) * scale : 255
    }
  }
  return { width, height, rgba }
}

/**
 * The read size for a raster that must not be decoded whole.
 *
 * A 26000x26000 COG is 676 Mpx: decoding it to draw a thumbnail would freeze the
 * tab and allocate gigabytes. The cap holds the LONGER edge at \`maxSize\` and
 * preserves the aspect ratio, so the reader asks for a downsampled window --
 * which geotiff serves from the file's own overviews instead of the full
 * resolution tiles. That is the difference between a 40 ms read and a 40 s one.
 * @param width - the raster's full width.
 * @param height - the raster's full height.
 * @param maxSize - the longest edge to decode.
 * @returns the target size, never larger than the source.
 */
export function planReadSize(width: number, height: number, maxSize: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new GisClientError('RASTER_EMPTY', 'this raster has no extent')
  const longest = Math.max(width, height)
  if (longest <= maxSize) return { width, height }
  const ratio = maxSize / longest
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}

/**
 * The MapLibre \`image\` source coordinates for a raster's extent.
 *
 * MapLibre wants them in a fixed order -- top-left, top-right, bottom-right,
 * bottom-left -- and getting it wrong draws the raster mirrored or transposed,
 * which looks like a projection bug and is not one.
 * @param bbox - \`[west, south, east, north]\` in EPSG:4326.
 * @returns four \`[lng, lat]\` corners, clockwise from the top left.
 */
export function imageCoordinates(bbox: readonly [number, number, number, number]): [[number, number], [number, number], [number, number], [number, number]] {
  const [west, south, east, north] = bbox
  return [[west, north], [east, north], [east, south], [west, south]]
}
