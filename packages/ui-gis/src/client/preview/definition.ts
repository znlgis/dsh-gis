/**
 * GIS document previews (T2.8, design L1).
 *
 * The host already dispatches file previews by extension, and its matching
 * order is **external \`'extension'\` band first, then longest suffix, then
 * registration order**. That is what lets a plugin claim \`.geojson\`, \`.fgb\` and
 * \`.tif\` without touching the built-in text/code previews -- and it is why the
 * metadata here declares \`priority: 'extension'\`: without it, \`.json\` would be
 * claimed by the plain text preview and a map would never appear.
 *
 * TWO definitions, not one, because \`loading\` is a property of the definition:
 * text formats are delivered as text pages (so the body can parse them without
 * any fetch), binary ones as complete bytes. One definition cannot be both.
 */
import type { DocumentPreviewDefinition } from './types.ts'

/** Implementation identity for text-based GIS files; also the document slot key. */
export const GIS_TEXT_PREVIEW_ID = '@znlgis/dsh-ui-gis/preview-text'
/** Implementation identity for binary GIS files; also the document slot key. */
export const GIS_BINARY_PREVIEW_ID = '@znlgis/dsh-ui-gis/preview-binary'

/** Text formats the map preview reads directly. */
export const GIS_TEXT_EXTENSIONS = ['geojson', 'topojson', 'ndjson', 'geojsonl', 'jsonl', 'wkt', 'kml', 'gpx'] as const

/**
 * Binary formats. FlatGeobuf and GeoTIFF are actually rendered; the rest are
 * claimed so the tab exists and the body can say what to do instead -- an empty
 * preview with no explanation is the failure this project keeps refusing.
 */
export const GIS_BINARY_EXTENSIONS = ['fgb', 'tif', 'tiff', 'cog', 'pmtiles', 'shp', 'gpkg'] as const

/**
 * Metadata for the text half.
 * @param title - locale-owned implementation name.
 * @returns the definition to register.
 */
export function gisTextPreviewDefinition(title: () => string): DocumentPreviewDefinition {
  return {
    id: GIS_TEXT_PREVIEW_ID,
    extensions: GIS_TEXT_EXTENSIONS,
    // \`.json\` is deliberately absent: a JSON file that is not GeoJSON belongs to
    // the text preview, and claiming it would put a failed map in front of a user
    // who just wanted to read a config.
    priority: 'extension',
    title,
    loading: 'text-pages',
    wrap: false,
  }
}

/**
 * Metadata for the binary half.
 * @param title - locale-owned implementation name.
 * @returns the definition to register.
 */
export function gisBinaryPreviewDefinition(title: () => string): DocumentPreviewDefinition {
  return {
    id: GIS_BINARY_PREVIEW_ID,
    extensions: GIS_BINARY_EXTENSIONS,
    binaryExtensions: GIS_BINARY_EXTENSIONS,
    priority: 'extension',
    title,
    // Complete bytes, not \`renderer\`: the byte route addresses DATASETS, and a
    // preview is opened on a PATH, so a renderer-owned load would have no id to
    // fetch by. The body refuses politely above its own size cap instead of
    // pulling a 2 GB raster into the tab (see MapBinaryBody).
    loading: 'bytes-complete',
    wrap: false,
  }
}
