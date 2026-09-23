/**
 * The decode worker's own code, shipped as TEXT inside our chunk.
 *
 * It runs in a CLASSIC worker, where the TIFF reader (a UMD bundle concatenated
 * in front of this file) attaches itself to \`self.GeoTIFF\`. It must not use
 * \`import\`, and it must not assume DOM APIs: it has neither.
 *
 * WHAT COMES BACK IS RAW SAMPLES, not pixels. The expensive half -- ranged
 * fetches, inflate, the downsampled read -- is what needs to leave the main
 * thread; the RGBA expansion is O(pixels) arithmetic (tens of milliseconds) and
 * staying on the main thread keeps this worker free of any import from our own
 * module graph. That matters: a worker that imports our shared pixel module makes
 * the two chunks require each other, and the loader cannot resolve a chunk
 * require at all (runtime contracts #31/#39).
 */
self.onmessage = async (event) => {
  const { id, url, buffer, maxSize } = event.data
  try {
    const reader = self.GeoTIFF
    if (reader === undefined) throw new Error('the TIFF reader did not attach itself in this worker')
    // Either a URL the reader ranges against, or bytes the caller already had.
    const tiff = buffer !== undefined
      ? await reader.fromArrayBuffer(buffer)
      : await reader.fromUrl(url, { maxRanges: 0, allowFullFile: false })
    const image = await tiff.getImage()
    const geoKeys = image.getGeoKeys()
    // The same guard the main-thread reader applies, for the same reason: a
    // projected raster placed at lng/lat coordinates is a plausible-looking map
    // in the wrong place.
    if (geoKeys === null || geoKeys === undefined || geoKeys.GTModelTypeGeoKey !== 2) {
      self.postMessage({ id, ok: false, code: 'CRS_UNKNOWN', message: 'this raster is not georeferenced in a geographic CRS, so it cannot be placed on a world map' })
      return
    }
    const longest = Math.max(image.getWidth(), image.getHeight())
    const ratio = longest <= maxSize ? 1 : maxSize / longest
    const width = Math.max(1, Math.round(image.getWidth() * ratio))
    const height = Math.max(1, Math.round(image.getHeight() * ratio))
    const raster = await image.readRasters({ width, height, interleave: true })
    const bits = image.getBitsPerSample()
    const bbox = image.getBoundingBox()
    // The samples cross as a transferable buffer: no copy, and the worker's heap
    // is released the moment the main thread owns them.
    const values = raster instanceof Uint8Array ? raster : new Uint8Array(raster.buffer.slice(0))
    self.postMessage({
      id,
      ok: true,
      width,
      height,
      bands: image.getSamplesPerPixel(),
      bitsPerSample: Array.isArray(bits) ? (bits[0] || 8) : bits,
      noData: image.getGDALNoData(),
      bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
      values: values.buffer,
      valueType: values.constructor.name,
    }, [values.buffer])
  } catch (error) {
    self.postMessage({ id, ok: false, code: 'RASTER_UNSUPPORTED', message: String(error && error.message ? error.message : error) })
  }
}
