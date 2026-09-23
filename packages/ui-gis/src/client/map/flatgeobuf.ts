/**
 * The FlatGeobuf reader, wrapped so the bundle's dynamic import stays ESM.
 *
 * Same reason as ./geotiff.ts: `import('flatgeobuf')` from source would compile
 * to an internal helper call when the package resolves to CJS, and the plugin
 * module loader can only resolve `require.async('./client.<name>.js')`.
 *
 * The geojson subpath is used deliberately: it is the helper that speaks the
 * GeoJSON feature shape MapLibre wants, and it comes with an HTTP reader that
 * issues RANGE requests by itself -- which is the whole point of T2.5.
 */
import { deserialize, serialize } from 'flatgeobuf/lib/mjs/geojson.js'

export { deserialize, serialize }
