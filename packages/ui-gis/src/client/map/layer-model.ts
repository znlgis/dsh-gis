/**
 * The layer model: untrusted wire data in, drawable layers out.
 *
 * Two rules drive this file.
 *
 * 1. **Never throw at the view.** The input is a tool result -- a replayed one
 *    may be truncated, hand-edited, or written by an older plugin version. Every
 *    defect becomes a {@link MapIssue} naming the layer it came from, and the
 *    rest of the map still draws. A blank map with no explanation is the outcome
 *    this project treats as a bug in itself.
 * 2. **Three origins, one shape.** A local file, a PostGIS connection and an OGC
 *    service all arrive as `{ kind, url, style }`. The renderer below has no
 *    branch that knows where the bytes came from -- the seam is the URL.
 *
 * Everything here is pure: normalization, style resolution, and the MapLibre
 * source/layer descriptions are plain functions returning plain objects, so the
 * whole model is testable without a map, a browser, or WebGL.
 */
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl'
import type { LayerOrigin, MapLayerKind, MapLayerSpec, MapLayerStyle, MapViewSpec } from './spec.ts'

/** Stable machine codes for everything that can be wrong with a map view. */
export type MapIssueCode =
  /** The value is not a map description at all. */
  | 'SPEC_INVALID'
  /** The extent is not four finite numbers, or is inside out. */
  | 'BBOX_INVALID'
  /** A layer entry is not an object. */
  | 'LAYER_INVALID'
  /** A layer has no usable id. */
  | 'LAYER_ID_MISSING'
  /** A layer has no usable url. */
  | 'LAYER_URL_MISSING'
  /** A layer declares a kind this client does not draw. */
  | 'LAYER_KIND_UNKNOWN'
  /** Two layers claim the same id; the later one cannot be drawn. */
  | 'LAYER_DUPLICATE_ID'
  /** A vector-tile layer names no source layer, so nothing could be drawn. */
  | 'LAYER_SOURCE_LAYER_MISSING'
  /** The style is not an object, or names an unusable primitive. */
  | 'LAYER_STYLE_INVALID'
  /** The layer's bytes could not be turned into something drawable. */
  | 'LAYER_DRAW_FAILED'

/** One thing wrong with a map view, reported instead of thrown. */
export interface MapIssue {
  /** Stable machine code. */
  readonly code: MapIssueCode
  /** The layer the issue belongs to, when it is about one. */
  readonly layerId?: string
  /** One line a host can print or show. */
  readonly message: string
}

/** A normalized view plus everything that had to be repaired or dropped. */
export interface NormalizedMapView {
  readonly spec: MapViewSpec
  readonly issues: readonly MapIssue[]
}

/** Theme colors the map draws with, read from the host's design tokens. */
export interface MapThemeTokens {
  /** Feature color: the brand accent. */
  readonly accent: string
  /** Text and line color. */
  readonly ink: string
  /** Surface color, used for outlines and halos. */
  readonly surface: string
  /** Hairline color. */
  readonly border: string
}

/** Fallbacks for a page that has none of the tokens (a test, a bare harness). */
export const DEFAULT_THEME: MapThemeTokens = {
  accent: '#2f6feb',
  ink: '#0f1115',
  surface: '#ffffff',
  border: 'rgba(0, 0, 0, 0.12)',
}

/** A MapLibre source plus the layer that draws it. */
export interface LayerDescription {
  /** The MapLibre source id, equal to the layer id. */
  readonly id: string
  readonly source: SourceSpecification
  readonly layer: AddLayerObject
}

const KINDS: readonly MapLayerKind[] = ['geojson', 'raster', 'mvt', 'cog']
const ORIGINS: readonly LayerOrigin[] = ['local', 'connection', 'service']
const PRIMITIVES: readonly NonNullable<MapLayerStyle['type']>[] = ['circle', 'line', 'fill']

/**
 * Turn whatever a tool result carried into a drawable view.
 *
 * The input is copied, never aliased: MapLibre keeps the style objects it is
 * given, and mutating a replayed tool result in place would corrupt the
 * transcript for the next render.
 * @param value - the raw `presentationMeta` value (any shape).
 * @returns the normalized view and the issues found while normalizing.
 */
export function normalizeMapView(value: unknown): NormalizedMapView {
  if (!isRecord(value)) {
    return {
      spec: { layers: [] },
      issues: [{ code: 'SPEC_INVALID', message: 'the map description is not an object, so nothing can be drawn' }],
    }
  }
  const issues: MapIssue[] = []
  const bbox = normalizeBbox(value['bbox'], issues)
  const rawLayers = value['layers']
  if (rawLayers !== undefined && !Array.isArray(rawLayers)) {
    issues.push({ code: 'SPEC_INVALID', message: 'the map description has a "layers" field that is not a list' })
  }
  const layers: MapLayerSpec[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(rawLayers) ? rawLayers : []) {
    const layer = normalizeLayer(entry, issues)
    if (layer === undefined) continue
    if (seen.has(layer.id)) {
      issues.push({
        code: 'LAYER_DUPLICATE_ID',
        layerId: layer.id,
        message: 'two layers claim the id "' + layer.id + '"; only the first can be drawn',
      })
      continue
    }
    seen.add(layer.id)
    layers.push(layer)
  }
  const mapId = typeof value['mapId'] === 'string' && value['mapId'].length > 0 ? value['mapId'] : undefined
  return {
    spec: {
      ...mapId === undefined ? {} : { mapId },
      ...bbox === undefined ? {} : { bbox },
      layers,
    },
    issues,
  }
}

/**
 * Resolve the drawing hints for one layer, filling in theme-aware defaults.
 *
 * A host that stated paint keeps it verbatim: the style in the transcript is
 * what the operator asked for, and second-guessing it would make a replay
 * render differently from the run that produced it.
 * @param layer - the layer.
 * @param tokens - theme colors for the defaults.
 * @returns the style to hand MapLibre.
 */
export function resolveLayerStyle(layer: MapLayerSpec, tokens: MapThemeTokens): MapLayerStyle {
  const stated = layer.style
  // A raster layer draws pixels: no primitive to pick and no default paint, but
  // the raster paint properties the host stated (opacity, brightness) still apply.
  if (layer.kind === 'raster') return stated?.paint === undefined ? {} : { paint: { ...stated.paint } }
  if (stated?.paint !== undefined) {
    return { ...stated.type === undefined ? {} : { type: stated.type }, paint: { ...stated.paint }, ...stated.layout === undefined ? {} : { layout: { ...stated.layout } } }
  }
  const type = stated?.type ?? (layer.kind === 'mvt' ? 'fill' : 'circle')
  const layout = stated?.layout === undefined ? {} : { ...stated.layout }
  return { type, paint: defaultPaint(type, tokens), ...Object.keys(layout).length === 0 ? {} : { layout } }
}

/**
 * Build the MapLibre source and layer for each drawable layer.
 *
 * A layer that cannot be drawn (a vector tile with no source layer, say) yields
 * an issue instead: MapLibre would throw on the malformed layer, and a thrown
 * render is a blank card with no explanation.
 * @param layers - normalized layers.
 * @param tokens - theme colors for the defaults.
 * @returns the descriptions to add, and the issues found.
 */
export function describeLayers(
  layers: readonly MapLayerSpec[],
  tokens: MapThemeTokens,
): { readonly descriptions: readonly LayerDescription[]; readonly issues: readonly MapIssue[] } {
  const descriptions: LayerDescription[] = []
  const issues: MapIssue[] = []
  for (const layer of layers) {
    // A `cog` layer has no synchronous description: its pixels do not exist
    // until the browser has ranged-read and decoded the file, which the
    // controller does through its raster seam. Describing it here would fetch
    // the raster as if it were GeoJSON -- a bug that looked like "the raster
    // never loads" and cost a debugging round.
    if (layer.kind === 'cog') continue
    if (layer.kind === 'mvt' && (layer.sourceLayer === undefined || layer.sourceLayer.length === 0)) {
      issues.push({
        code: 'LAYER_SOURCE_LAYER_MISSING',
        layerId: layer.id,
        message: 'the vector-tile layer "' + layer.id + '" names no source layer, so nothing could be drawn from it',
      })
      continue
    }
    descriptions.push({ id: layer.id, source: sourceOf(layer), layer: drawOf(layer, tokens) })
  }
  return { descriptions, issues }
}

/**
 * Read the host's design tokens from an element's computed style.
 *
 * Layer colors have to be concrete values -- WebGL knows nothing about CSS
 * variables -- so the tokens are resolved once per mount instead of being
 * duplicated as literals here. A page without the tokens (a test harness, an
 * embed) falls back to {@link DEFAULT_THEME}.
 * @param element - element to read the custom properties from.
 * @param read - property reader; defaults to `getComputedStyle`.
 * @returns the resolved tokens.
 */
export function themeTokensOf(
  element: Element | undefined,
  read?: (name: string) => string | undefined,
): MapThemeTokens {
  const lookup = read ?? readerFor(element)
  return {
    accent: lookup('--dsw-alias-brand-primary') ?? DEFAULT_THEME.accent,
    ink: lookup('--dsw-alias-label-primary') ?? DEFAULT_THEME.ink,
    surface: lookup('--dsw-alias-bg-base') ?? DEFAULT_THEME.surface,
    border: lookup('--dsw-alias-border-l2') ?? DEFAULT_THEME.border,
  }
}

/** The computed-style reader for one element, or one that finds nothing. */
function readerFor(element: Element | undefined): (name: string) => string | undefined {
  if (element === undefined || typeof getComputedStyle !== 'function') return () => undefined
  const style = getComputedStyle(element)
  return name => {
    const value = style.getPropertyValue(name).trim()
    return value.length === 0 ? undefined : value
  }
}

/** Normalize one layer entry; undefined means "skip it". */
function normalizeLayer(entry: unknown, issues: MapIssue[]): MapLayerSpec | undefined {
  if (!isRecord(entry)) {
    issues.push({ code: 'LAYER_INVALID', message: 'a layer entry is not an object and was skipped' })
    return undefined
  }
  const id = text(entry['id'])
  if (id === undefined) {
    issues.push({ code: 'LAYER_ID_MISSING', message: 'a layer has no id and was skipped' })
    return undefined
  }
  const url = text(entry['url'])
  if (url === undefined) {
    issues.push({ code: 'LAYER_URL_MISSING', layerId: id, message: 'the layer "' + id + '" has no url and was skipped' })
    return undefined
  }
  const kind = entry['kind']
  if (typeof kind !== 'string' || !KINDS.includes(kind as MapLayerKind)) {
    issues.push({
      code: 'LAYER_KIND_UNKNOWN',
      layerId: id,
      message: 'the layer "' + id + '" has kind ' + JSON.stringify(kind) + '; known kinds are ' + KINDS.join(', '),
    })
    return undefined
  }
  const style = normalizeStyle(entry['style'], id, issues)
  const origin = ORIGINS.includes(entry['origin'] as LayerOrigin) ? entry['origin'] as LayerOrigin : undefined
  const sourceLayer = text(entry['sourceLayer'])
  return {
    id,
    kind: kind as MapLayerKind,
    url,
    ...origin === undefined ? {} : { origin },
    ...sourceLayer === undefined ? {} : { sourceLayer },
    ...style === undefined ? {} : { style },
  }
}

/** Normalize a layer's style, dropping what cannot be used. */
function normalizeStyle(value: unknown, layerId: string, issues: MapIssue[]): MapLayerStyle | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    issues.push({
      code: 'LAYER_STYLE_INVALID',
      layerId,
      message: 'the style of layer "' + layerId + '" is not an object; theme defaults are used instead',
    })
    return undefined
  }
  const type = value['type']
  if (type !== undefined && !PRIMITIVES.includes(type as NonNullable<MapLayerStyle['type']>)) {
    issues.push({
      code: 'LAYER_STYLE_INVALID',
      layerId,
      message: 'the style of layer "' + layerId + '" asks for ' + JSON.stringify(type) + '; drawable primitives are ' + PRIMITIVES.join(', '),
    })
  }
  const paint = isRecord(value['paint']) ? { ...value['paint'] } : undefined
  const layout = isRecord(value['layout']) ? { ...value['layout'] } : undefined
  return {
    ...type === undefined || typeof type !== 'string' || !PRIMITIVES.includes(type as NonNullable<MapLayerStyle['type']>)
      ? {}
      : { type: type as NonNullable<MapLayerStyle['type']> },
    ...paint === undefined ? {} : { paint },
    ...layout === undefined ? {} : { layout },
  }
}

/** Normalize the extent, reporting an extent that could not be used. */
function normalizeBbox(value: unknown, issues: MapIssue[]): readonly [number, number, number, number] | undefined {
  if (value === undefined) return undefined
  const usable = Array.isArray(value) && value.length === 4 && value.every(item => typeof item === 'number' && Number.isFinite(item))
  if (!usable) {
    issues.push({ code: 'BBOX_INVALID', message: 'the extent is not four finite numbers; the view is not framed' })
    return undefined
  }
  const [west, south, east, north] = value as number[]
  if (west! > east! || south! > north!) {
    issues.push({ code: 'BBOX_INVALID', message: 'the extent is inside out (west > east or south > north); the view is not framed' })
    return undefined
  }
  return [west!, south!, east!, north!]
}

/**
 * The MapLibre source for one layer.
 *
 * `cog` never reaches here (see {@link describeLayers}), so the fallthrough is
 * GeoJSON -- and if a future kind is added without a case, this is where it must
 * be taught, not silently defaulted.
 */
function sourceOf(layer: MapLayerSpec): SourceSpecification {
  if (layer.kind === 'raster') return { type: 'raster', tiles: [layer.url], tileSize: 256 }
  if (layer.kind === 'mvt') return { type: 'vector', tiles: [layer.url] }
  return { type: 'geojson', data: layer.url }
}

/** The MapLibre layer that draws one source. */
function drawOf(layer: MapLayerSpec, tokens: MapThemeTokens): AddLayerObject {
  const style = resolveLayerStyle(layer, tokens)
  // One documented cast: paint and layout arrive from the wire, and MapLibre
  // validates them inside addLayer, throwing on a bad property by name.
  return {
    id: layer.id,
    type: layer.kind === 'raster' ? 'raster' : style.type ?? 'circle',
    source: layer.id,
    ...layer.sourceLayer === undefined ? {} : { 'source-layer': layer.sourceLayer },
    ...style.paint === undefined ? {} : { paint: style.paint },
    ...style.layout === undefined ? {} : { layout: style.layout },
  } as unknown as AddLayerObject
}

/** The paint a primitive gets when the host stated none. */
function defaultPaint(type: NonNullable<MapLayerStyle['type']>, tokens: MapThemeTokens): Record<string, unknown> {
  if (type === 'line') return { 'line-color': tokens.accent, 'line-width': 1.5 }
  if (type === 'fill') return { 'fill-color': tokens.accent, 'fill-opacity': 0.35, 'fill-outline-color': tokens.accent }
  return {
    'circle-radius': 5,
    'circle-color': tokens.accent,
    'circle-stroke-color': tokens.surface,
    'circle-stroke-width': 1,
  }
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}
