/**
 * The map description a render hands to the browser card (design 6.3).
 *
 * Two projections of ONE value, and the split is the whole point:
 *
 *   - \`render\` produces the prose the MODEL reads;
 *   - \`presentationMeta\` produces a bounded, byte-free map description that is
 *     PERSISTED with the tool result.
 *
 * The card is then a pure function of that persisted description: a replayed
 * session draws the same map as the run that produced it, without re-running
 * anything and without a single byte of geometry in the transcript.
 *
 * What can be drawn today is honest about today: only GeoJSON has a route the
 * browser can read directly (T2.3). Shapefile, GDB and connection datasets say
 * so in an issue instead of drawing an empty map (their routes are T2.4/T2.5).
 */
import type { Dataset } from '@znlgis/dsh-gis-core'

/**
 * One drawable layer, as the card receives it.
 *
 * A TYPE ALIAS, not an interface, and that is load-bearing: only aliases get an
 * implicit index signature, and without one this is not assignable to the
 * contract's \`JsonValue\` (the compiler says so, precisely: "Index signature for
 * type 'string' is missing").
 */
export type MapLayerDescription = {
  readonly id: string
  readonly kind: 'geojson' | 'raster' | 'mvt' | 'cog'
  readonly url: string
  readonly origin: 'local' | 'connection' | 'service'
  /** Drawing hints, exactly the shape the client's layer model accepts. */
  readonly style?: MapLayerStyle
}

/** Drawing hints; mutable records on purpose, so the description stays a JSON value. */
export type MapLayerStyle = {
  readonly type?: 'circle' | 'line' | 'fill'
  /** MapLibre paint values, which are JSON scalars; the card passes them through. */
  readonly paint?: Record<string, string | number | boolean>
}

/**
 * The persisted map description (design 6.3).
 *
 * Deliberately a JSON-shaped type rather than a \`Record<string, unknown>\`: this
 * value is persisted with the session log, and the tool contract types it as a
 * JSON value -- an \`unknown\`-valued record is not one.
 */
export type MapDescription = {
  readonly mapId: string
  readonly bbox: number[]
  readonly layers: MapLayerDescription[]
  readonly basemap: 'none'
}

/** One data-quality note carried alongside the render. */
export interface RenderIssue {
  readonly code: string
  readonly message: string
}

/** What one \`gis_render\` call produces. */
export interface RenderValue {
  /** Stable id for this map view; derived from the dataset id, so it replays. */
  readonly mapId: string
  readonly datasetId: string
  /** Extent actually drawn, EPSG:4326 \`[west, south, east, north]\`. */
  readonly bbox: readonly [number, number, number, number]
  /**
   * The server-side picture, or `null` when there is none to make.
   *
   * A RASTER has no server-side plot on purpose: the card decodes the COG in the
   * browser by range, so rendering a second picture on the host would be work
   * nobody looks at. `null` says that out loud instead of shipping a
   * placeholder nobody asked for.
   */
  readonly image: {
    readonly path: string
    readonly width: number
    readonly height: number
    readonly drawn: number
    readonly features: number
  } | null
  readonly layers: readonly MapLayerDescription[]
  /** One line describing the CRS, already resolved to something printable. */
  readonly crs: string
  readonly issues: readonly RenderIssue[]
}

/** How many layers the persisted description may carry; extras drop. */
const MAX_LAYERS = 8

/**
 * The layers the browser can draw for one dataset.
 *
 * Two direct-read cases exist today: a GeoJSON file is served by the byte route
 * (T2.3) and MapLibre parses it in place, and a COG is served the same way and
 * decoded IN THE BROWSER by range (so a 2 GB raster never crosses the wire
 * whole). Everything else needs a conversion that does not exist yet, so it is
 * REPORTED -- an empty map with no explanation is the failure this project keeps
 * treating as a bug.
 * @param dataset - the dataset that was rendered.
 * @returns the drawable layers and the notes explaining what is missing.
 */
export function mapLayersOf(dataset: Dataset): { readonly layers: readonly MapLayerDescription[]; readonly notes: readonly RenderIssue[] } {
  if (dataset.kind === 'geojson') {
    return {
      layers: [{
        id: dataset.id,
        kind: 'geojson',
        url: '/api/gis/blob?id=' + dataset.id,
        origin: 'local',
        // A default here, and only here: the host that produced the picture
        // knows how it drew it, and the card must not invent a second style.
        style: {
          type: 'circle',
          paint: { 'circle-radius': 5, 'circle-color': '#2f6feb', 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' },
        },
      }],
      notes: [],
    }
  }
  if (dataset.kind === 'cog') {
    // No style: a raster is drawn as pixels, not as a primitive.
    return {
      layers: [{ id: dataset.id, kind: 'cog', url: '/api/gis/blob?id=' + dataset.id, origin: 'local' }],
      notes: [],
    }
  }
  const reason = dataset.kind === 'ndjson'
    ? 'NDJSON is streamed line by line, which the browser cannot parse as a layer'
    : dataset.kind === 'shapefile'
      ? 'a shapefile is a family of files, which the browser cannot read directly'
      : dataset.kind === 'gdb'
        ? 'a file geodatabase needs a conversion the browser cannot do'
        : 'a connection dataset has no bytes to hand the browser'
  return {
    layers: [],
    notes: [{
      code: 'UNSUPPORTED_FORMAT',
      message: 'this dataset is not drawn in the browser yet: ' + reason + '; the picture below is the server-side plot',
    }],
  }
}

/**
 * Project a render into the bounded map description that gets persisted.
 * @param value - the render result.
 * @returns the description (never a byte of geometry).
 */
export function mapDescriptionOf(value: RenderValue): MapDescription {
  return {
    mapId: value.mapId,
    bbox: [...value.bbox],
    layers: value.layers.slice(0, MAX_LAYERS).map(layer => ({
      id: layer.id,
      kind: layer.kind,
      url: layer.url,
      origin: layer.origin,
      ...layer.style === undefined ? {} : { style: layer.style },
    })),
    basemap: 'none',
  }
}

/**
 * The prose the model reads.
 * @param value - the render result.
 * @returns one text block's worth of lines.
 */
export function renderProseOf(value: RenderValue): string {
  const warnings = value.issues.map(issue => '  [' + issue.code + '] ' + issue.message)
  const picture = value.image === null
    ? ['this dataset is a raster: the map card decodes it in the browser, so there is no server-side PNG']
    : [
        'rendered ' + String(value.image.drawn) + ' of ' + String(value.image.features) + ' feature(s) to ' + value.image.path,
        'image: ' + String(value.image.width) + 'x' + String(value.image.height) + ' px, extent [' + value.bbox.join(', ') + ']',
      ]
  return [
    ...picture,
    'crs: ' + value.crs,
    warnings.length === 0 ? 'no data-quality issues reported' : ['data-quality issues carried into this picture:', ...warnings].join('\n'),
    value.image === null
      ? 'Ask for a rendered PNG only if a still image is genuinely needed.'
      : 'The picture has no scale bar or basemap. Do not quote distances or areas from it.',
  ].join('\n')
}
