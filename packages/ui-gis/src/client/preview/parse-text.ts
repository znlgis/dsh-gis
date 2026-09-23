/**
 * Turning a previewed file's text into something the map can draw.
 *
 * Pure, so the interesting decisions are testable without a browser: what counts
 * as GeoJSON, what to say when it is something else, and what extent to frame.
 * The preview is the SECOND consumer of the shared map component (the chat card
 * is the first), so it hands it the same normalized \`MapViewSpec\`.
 */
import type { MapViewSpec } from '../map/spec.ts'

/** What a text file turned out to be. */
export type PreviewParse =
  | { readonly kind: 'map'; readonly spec: MapViewSpec; readonly note?: string }
  | { readonly kind: 'unsupported'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string }

/** The GeoJSON feature kinds a map can draw. */
const DRAWABLE = new Set(['FeatureCollection', 'Feature', 'GeometryCollection', 'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'])

/**
 * How much text this preview will render.
 *
 * A data URL carries the text into MapLibre, and a 100 MB GeoJSON would become a
 * 130 MB URL string in the tab. Refusing above the cap and SAYING so is the
 * honest version of that limit.
 */
export const MAX_PREVIEW_TEXT = 8 * 1024 * 1024

/**
 * Read a text file as a map view.
 *
 * Only GeoJSON is drawn. WKT, KML and GPX are claimed by the metadata so the tab
 * exists, and this is where the body says so in words -- a blank map with no
 * explanation is the outcome this project treats as a bug.
 * @param path - the file's decoded path, used only to decide the family.
 * @param text - the file's text.
 * @returns the view, or why there is none, or nothing drawable with a reason.
 */
export function parseTextPreview(path: string, text: string): PreviewParse {
  const suffix = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (suffix === 'wkt' || suffix === 'kml' || suffix === 'gpx') {
    return {
      kind: 'unsupported',
      message: 'a map preview for .' + suffix + ' is not implemented yet: the browser reader only parses GeoJSON today',
    }
  }
  if (text.length > MAX_PREVIEW_TEXT) {
    return {
      kind: 'unsupported',
      message: 'this file is ' + (text.length / 1024 / 1024).toFixed(1) + ' MB of text, above the ' + String(MAX_PREVIEW_TEXT / 1024 / 1024) + ' MB preview limit; open it through the GIS tools instead',
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { kind: 'invalid', message: 'this file is not JSON: ' + (error instanceof Error ? error.message : String(error)) }
  }
  const type = (parsed as { type?: unknown } | null)?.type
  if (typeof type !== 'string' || !DRAWABLE.has(type)) {
    return {
      kind: 'invalid',
      message: 'this JSON is not GeoJSON: expected a FeatureCollection, Feature or geometry, found ' + JSON.stringify(type ?? null),
    }
  }
  return {
    kind: 'map',
    spec: {
      mapId: 'preview:' + path,
      // No bbox: the map frames the data itself. A GeoJSON file carries no
      // extent field the browser should trust, and MapLibre fits a GeoJSON
      // source on its own when nothing else has framed the view.
      // A DATA URL, built here: pure, no blob lifetime to manage, and the map
      // component needs no new kind -- it already knows how to load a GeoJSON URL.
      layers: [{
        id: 'preview',
        kind: 'geojson',
        url: 'data:application/geo+json,' + encodeURIComponent(text),
        origin: 'local',
        style: { type: 'circle', paint: { 'circle-radius': 5, 'circle-color': '#2f6feb', 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' } },
      }],
    },
  }
}
