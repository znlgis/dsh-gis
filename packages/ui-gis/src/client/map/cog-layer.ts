/**
 * Drawing a COG in the browser, by range.
 *
 * The bytes stay on the server: geotiff's `fromUrl` sends `Range` requests
 * through the byte route, reads the file's header and the overview it needs, and
 * hands back a downsampled window. A 2 GB raster therefore costs a few hundred
 * kilobytes of traffic to display, which is the whole reason COG exists.
 *
 * Two guards make this honest rather than merely convenient:
 *
 * - **Only geographic rasters are drawn.** A projected GeoTIFF's extent is in
 *   metres; placing it at lng/lat coordinates draws a plausible-looking map in
 *   the wrong place, which is worse than drawing nothing. Reprojection is T4's
 *   work, so this refuses and says so.
 * - **The window is capped.** Decoding 676 Mpx for a thumbnail would freeze the
 *   tab; the cap makes geotiff read an overview instead.
 */
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl'
import { GisClientError } from './client-error.ts'
import { imageCoordinates, planReadSize, toRgba, type RasterImage } from './cog-image.ts'
import type { MapInstance } from './controller.ts'
import type { MapLayerSpec } from './spec.ts'

/** The longest edge decoded for display: 2048 px is a screen, not a print. */
export const MAX_COG_PIXELS = 2048

/** A decoded raster plus where it belongs. */
export interface CogReadResult extends RasterImage {
  /** `[west, south, east, north]` in EPSG:4326, from the file's own georeferencing. */
  readonly bbox: [number, number, number, number]
}

/**
 * Decode a GeoTIFF (a COG, ideally) into an RGBA image.
 * @param source - a URL to range-read, or bytes already in hand (a drop, a test).
 * @param options - the decode cap.
 * @returns the image and its extent.
 * @throws GisClientError `CRS_UNKNOWN` for a non-geographic raster.
 */
export async function readCogImage(source: string | ArrayBuffer, options: { readonly maxSize?: number } = {}): Promise<CogReadResult> {
  // Dynamic, through the ESM wrapper: this is what keeps the TIFF reader out of
  // the vector card's chunk AND keeps the emitted dynamic import resolvable by
  // the plugin loader (see ./geotiff.ts).
  const geotiff = await import('./geotiff.ts')
  // `allowFullFile: false` is the default and is load-bearing: a server that
  // answers 200 to a range request would otherwise have its WHOLE body spliced
  // in where the reader asked for the middle. geotiff fails loudly instead.
  const tiff = typeof source === 'string'
    ? await geotiff.fromUrl(source, { maxRanges: 0, allowFullFile: false })
    : await geotiff.fromArrayBuffer(source)
  const image = await tiff.getImage()

  // GTModelTypeGeoKey is the AUTHORITATIVE answer (2 = geographic, 1 = projected);
  // GeographicTypeGeoKey alone is not enough, because GDAL writes it for a
  // projected raster too (the CRS it is based on), which would let a UTM raster
  // through to be drawn at lng/lat coordinates.
  const geoKeys = image.getGeoKeys() as Record<string, unknown> | null | undefined
  const geographic = geoKeys?.GTModelTypeGeoKey === 2
  if (geoKeys === null || geoKeys === undefined || !geographic) {
    throw new GisClientError(
      'CRS_UNKNOWN',
      'this raster is not georeferenced in a geographic CRS, so it cannot be placed on a world map',
      'reproject it to EPSG:4326 (or a geographic CRS) before drawing it in the browser',
    )
  }

  const size = planReadSize(image.getWidth(), image.getHeight(), options.maxSize ?? MAX_COG_PIXELS)
  const raster = await image.readRasters({ width: size.width, height: size.height, interleave: true })
  const bits = image.getBitsPerSample() as number | readonly number[]
  const noData = image.getGDALNoData()
  const decoded = toRgba({
    values: raster as unknown as ArrayLike<number>,
    bands: image.getSamplesPerPixel(),
    bitsPerSample: Array.isArray(bits) ? (bits[0] ?? 8) : bits,
    width: size.width,
    ...noData === null || noData === undefined ? {} : { noData: Number(noData) },
  })

  const box = image.getBoundingBox() as [number, number, number, number]
  return { ...decoded, bbox: box }
}

/**
 * Draw one raster layer onto a live map.
 * @param map - the map.
 * @param layer - the layer; its `url` is range-read.
 * @returns a disposer that removes the layer and its source.
 */
export async function addCogLayer(map: MapInstance, layer: MapLayerSpec): Promise<() => void> {
  const image = await readCogImage(layer.url)
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new GisClientError('RASTER_UNSUPPORTED', 'this page has no 2D canvas context to draw a raster into')
  }
  context.putImageData(new ImageData(image.rgba, image.width, image.height), 0, 0)

  const source: SourceSpecification = { type: 'image', url: canvas.toDataURL('image/png'), coordinates: imageCoordinates(image.bbox) }
  const drawn: AddLayerObject = { id: layer.id, type: 'raster', source: layer.id }
  map.addSource(layer.id, source)
  map.addLayer(drawn)
  return () => {
    if (map.getLayer(layer.id) !== undefined) map.removeLayer(layer.id)
    if (map.getSource(layer.id) !== undefined) map.removeSource(layer.id)
  }
}
