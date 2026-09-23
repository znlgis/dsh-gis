/**
 * The map description a card hands to the shared map component.
 *
 * This is the CLIENT view of the wire contract in design 6.3: bounded, no bytes,
 * replayable. The card reads it from the tool result's `presentationMeta`; the
 * bytes themselves are fetched by URL, never carried in the transcript.
 *
 * `layer-model.ts` is what turns UNTRUSTED wire data into these shapes;
 * everything below is the already-normalized form.
 */

/**
 * How one layer's bytes are addressed.
 *
 * `cog` is the one kind the CLIENT decodes: it ranges-reads a Cloud-Optimized
 * GeoTIFF through the byte route and draws the window it needs, which is what
 * lets a 2 GB raster appear without being downloaded.
 */
export type MapLayerKind = 'geojson' | 'raster' | 'mvt' | 'cog' | 'flatgeobuf' | 'pmtiles'

/**
 * Where the data comes from. The component treats every origin identically --
 * that is the point of the seam: a local file, a PostGIS connection and an OGC
 * service all arrive as a URL plus a kind, and the map cannot tell them apart.
 * The field exists for labelling and diagnostics only.
 */
export type LayerOrigin = 'local' | 'connection' | 'service'

/** Drawing hints for one layer. */
export interface MapLayerStyle {
  /** Geometry primitive to draw with. */
  readonly type?: 'circle' | 'line' | 'fill'
  /** MapLibre paint properties, passed through. */
  readonly paint?: Readonly<Record<string, unknown>>
  /** MapLibre layout properties, passed through. */
  readonly layout?: Readonly<Record<string, unknown>>
}

/** One drawable layer: where its bytes come from, and how to draw them. */
export interface MapLayerSpec {
  /** Stable layer id, also used as the MapLibre source and layer id. */
  readonly id: string
  readonly kind: MapLayerKind
  /** Route that serves the bytes, e.g. `/api/gis/blob?id=ds_...`. */
  readonly url: string
  /** Declared origin; never affects rendering. */
  readonly origin?: LayerOrigin
  /** Vector-tile layer name inside the tiles; required to draw an `mvt` layer. */
  readonly sourceLayer?: string
  readonly style?: MapLayerStyle
}

/** Everything the component needs to draw a view. */
export interface MapViewSpec {
  /** Identifier of the map this view belongs to, when the host has one. */
  readonly mapId?: string
  /** Extent to frame, `[west, south, east, north]` in EPSG:4326. */
  readonly bbox?: readonly [number, number, number, number]
  /** Layers to draw, in paint order. */
  readonly layers: readonly MapLayerSpec[]
}
