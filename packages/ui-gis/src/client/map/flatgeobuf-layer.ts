/**
 * Drawing a FlatGeobuf file in the browser, by range.
 *
 * FlatGeobuf is a packed Hilbert R-tree followed by the features: the reader
 * seeks to the node covering the view and reads only those bytes. The library's
 * GeoJSON helper issues those range requests itself, through the byte route, so
 * a 500 MB file costs a few kilobytes to display.
 *
 * The feature cap is deliberate. A file with ten million features would be
 * decoded into the tab's memory and freeze it; drawing the first N and SAYING so
 * is the honest version of that trade, and the number is in the issue list.
 */
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl'
import { GisClientError } from './client-error.ts'
import type { MapInstance } from './controller.ts'
import type { MapLayerSpec } from './spec.ts'

/** How many features are decoded for one view before the rest is reported. */
export const MAX_FLATGEOBUF_FEATURES = 20_000

/**
 * The extent of a feature list, in `[west, south, east, north]`.
 *
 * Deliberately simple: this exists to FRAME a card, not to be a precise
 * cartographic bound, and a feature list with no coordinates simply has no bbox.
 * @param features - GeoJSON features.
 * @returns the extent, or undefined when nothing carried coordinates.
 */
export function bboxOfFeatures(features: readonly unknown[]): [number, number, number, number] | undefined {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      west = Math.min(west, value[0])
      east = Math.max(east, value[0])
      south = Math.min(south, value[1])
      north = Math.max(north, value[1])
      return
    }
    for (const child of value) visit(child)
  }
  for (const feature of features) visit((feature as { geometry?: { coordinates?: unknown } }).geometry?.coordinates)
  return Number.isFinite(west) && Number.isFinite(south) ? [west, south, east, north] : undefined
}

/** The default paint for vector features the host did not style. */
const DEFAULT_PAINT: Readonly<Record<string, unknown>> = {
  'circle-radius': 5,
  'circle-color': '#2f6feb',
  'circle-stroke-width': 1,
  'circle-stroke-color': '#ffffff',
}

/**
 * Read a FlatGeobuf file into GeoJSON features.
 *
 * Accepts BYTES as well as a URL: the browser hands it the byte route (the
 * library then issues the range requests itself), and a test hands it a file it
 * already read -- so the reader can be checked against a real fixture without a
 * server, which is the difference between testing the parse and testing nothing.
 * @param source - the byte route URL, or the file's bytes.
 * @param maxFeatures - the cap.
 * @returns the features and whether the cap cut the file short.
 */
export async function readFlatGeobuf(
  source: string | Uint8Array,
  options: { readonly rect?: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }; readonly maxFeatures?: number } = {},
): Promise<{ readonly features: unknown[]; readonly truncated: boolean }> {
  const { deserialize } = await import('./flatgeobuf.ts')
  const maxFeatures = options.maxFeatures ?? MAX_FLATGEOBUF_FEATURES
  const features: unknown[] = []
  let truncated = false
  // Branched, not passed as a union: the library declares one overload per source
  // shape, and TypeScript refuses to pick one for `string | Uint8Array`.
  // The RECT is the point of the format: the packed R-tree is searched for the
  // nodes covering the view, and only their bytes are fetched.
  const stream = typeof source === 'string'
    ? deserialize(source, options.rect)
    : deserialize(source, options.rect)
  for await (const feature of stream) {
    if (features.length >= maxFeatures) {
      truncated = true
      break
    }
    features.push(feature)
  }
  return { features, truncated }
}

/**
 * Draw one FlatGeobuf layer onto a live map.
 * @param map - the map.
 * @param layer - the layer; its `url` is range-read.
 * @returns a disposer.
 * @throws GisClientError `LAYER_EMPTY` when the file yielded nothing.
 */
export async function addFlatGeobufLayer(
  map: MapInstance,
  layer: MapLayerSpec,
  options: { readonly frame?: boolean } = {},
): Promise<() => void> {
  // The view rectangle, so the reader fetches only the features it will draw.
  // Before framing, that is the whole world -- still a range request, not a
  // download: the R-tree answers which nodes matter.
  const bounds = map.getBounds()
  const rect = {
    minX: bounds.getWest(),
    minY: bounds.getSouth(),
    maxX: bounds.getEast(),
    maxY: bounds.getNorth(),
  }
  const { features } = await readFlatGeobuf(layer.url, { rect })
  if (features.length === 0) {
    throw new GisClientError('LAYER_EMPTY', 'this FlatGeobuf file yielded no feature', 'check that gis_inspect can read it on the host')
  }
  const source: SourceSpecification = { type: 'geojson', data: { type: 'FeatureCollection', features } as never }
  // One documented cast, same as the layer model's: paint and layout arrive from
  // the wire, and MapLibre validates them by name inside addLayer.
  const drawn = (layer.style?.type === undefined
    ? { id: layer.id, type: 'circle', source: layer.id, paint: { ...DEFAULT_PAINT } }
    : { id: layer.id, type: layer.style.type, source: layer.id, paint: { ...(layer.style.paint ?? {}) } }) as unknown as AddLayerObject
  map.addSource(layer.id, source)
  map.addLayer(drawn)
  if (options.frame === true) {
    // Frame what was READ, and only when nothing else framed it: the host's own
    // extent wins when it has one.
    const bbox = bboxOfFeatures(features)
    if (bbox !== undefined) map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 32, duration: 0 })
  }
  return () => {
    if (map.getLayer(layer.id) !== undefined) map.removeLayer(layer.id)
    if (map.getSource(layer.id) !== undefined) map.removeSource(layer.id)
  }
}
