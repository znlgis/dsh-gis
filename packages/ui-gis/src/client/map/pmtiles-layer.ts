/**
 * Drawing a PMTiles archive in the browser, by range.
 *
 * A PMTiles archive is a header, a directory tree and the tiles themselves, so
 * MapLibre can be handed a `pmtiles://` source and fetch exactly the tiles in
 * view. The protocol handler below is what resolves those URLs: it asks the
 * archive for one tile's bytes and hands MapLibre the buffer.
 *
 * Two details are load-bearing, and both were wrong in the first draft:
 *
 * - **The archive's own layer names come from its metadata**, not from a guess.
 *   A vector source with no `source-layer` draws nothing, and MapLibre does not
 *   say why.
 * - **The protocol is registered on the MapLibre MODULE**, which the map instance
 *   does not expose -- so it is reached through the same loader seam the card
 *   uses, and NOT through a static import (that would make this chunk require the
 *   MapLibre chunk synchronously, which the loader cannot resolve: contract #31).
 */
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl'
import { GisClientError } from './client-error.ts'
import type { MapInstance } from './controller.ts'
import type { MapLibreModule } from './load-maplibre.ts'
import type { MapLayerSpec } from './spec.ts'

/** How many of an archive's vector layers are drawn. */
export const MAX_PMTILES_LAYERS = 4

/** The default paint for tiles whose geometry type the archive does not state. */
const DEFAULT_PAINT: Readonly<Record<string, unknown>> = {
  'fill-color': '#2f6feb',
  'fill-opacity': 0.35,
  'fill-outline-color': '#ffffff',
}

/**
 * The vector layer names an archive declares.
 *
 * Pure, so the metadata shape is testable without an archive: GDAL, tippecanoe
 * and pmtiles all emit `vector_layers` with a `id`, and anything else is
 * ignored rather than guessed.
 * @param metadata - whatever `getMetadata()` returned.
 * @returns the layer names, in archive order.
 */
export function vectorLayersOf(metadata: unknown): readonly string[] {
  if (typeof metadata !== 'object' || metadata === null) return []
  const declared = (metadata as { vector_layers?: unknown }).vector_layers
  if (!Array.isArray(declared)) return []
  const names: string[] = []
  for (const entry of declared) {
    const id = (entry as { id?: unknown } | null)?.id
    if (typeof id === 'string' && id.length > 0) names.push(id)
  }
  return names
}

/**
 * Draw one PMTiles layer onto a live map.
 * @param map - the map.
 * @param layer - the layer; its `url` is ranged for header, directories and tiles.
 * @returns a disposer that removes every layer it added and its source.
 * @throws GisClientError when the archive declares no vector layer.
 */
export async function addPmtilesLayer(
  map: MapInstance,
  layer: MapLayerSpec,
  maplibre: MapLibreModule,
  options: { readonly frame?: boolean } = {},
): Promise<() => void> {
  const { PMTiles, Protocol } = await import('./pmtiles.ts')
  const archive = new PMTiles(layer.url)
  const metadata = await archive.getMetadata()
  const names = vectorLayersOf(metadata)
  if (names.length === 0) {
    throw new GisClientError(
      'LAYER_EMPTY',
      'this PMTiles archive declares no vector layer',
      'a raster-only archive needs a raster source; check the archive with gis_inspect',
    )
  }

  // The library is passed IN (see the signature), not imported: a shared import
  // makes rolldown emit a facade chunk that synchronously requires the card's
  // chunk, which the loader cannot resolve (contract #31).
  maplibre.addProtocol('pmtiles', new Protocol().tile)

  const source: SourceSpecification = { type: 'vector', url: 'pmtiles://' + layer.url }
  map.addSource(layer.id, source)
  const drawn: string[] = []
  for (const name of names.slice(0, MAX_PMTILES_LAYERS)) {
    const id = layer.id + ':' + name
    const hatched: AddLayerObject = {
      id,
      type: 'fill',
      source: layer.id,
      'source-layer': name,
      paint: { ...DEFAULT_PAINT },
    }
    map.addLayer(hatched)
    drawn.push(id)
  }
  if (options.frame === true) {
    // The archive states its own bounds in the header -- cheaper and more
    // truthful than anything derived from whichever tiles happen to be loaded.
    const header = await archive.getHeader()
    if (Number.isFinite(header.minLon) && Number.isFinite(header.minLat)) {
      map.fitBounds([[header.minLon, header.minLat], [header.maxLon, header.maxLat]], { padding: 32, duration: 0 })
    }
  }
  return () => {
    for (const id of drawn) if (map.getLayer(id) !== undefined) map.removeLayer(id)
    if (map.getSource(layer.id) !== undefined) map.removeSource(layer.id)
  }
}
