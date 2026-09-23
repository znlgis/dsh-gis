/**
 * The ESM entry point of the lazy MapLibre chunk.
 *
 * MapLibre 5 ships UMD (`module.exports = ...`), and a bundler therefore wraps
 * a dynamic import of it as `Promise.resolve().then(() => __toESM(require(...)))`.
 * The client preset only knows how to turn
 * `Promise.resolve().then(() => require('./client.<name>.js'))` into the
 * loader's `require.async`, so a bare dynamic import of the package FAILS THE
 * BUILD with "dynamic chunk has no generated import expression" -- loudly, which
 * is how this was found.
 *
 * Importing this ESM module instead puts the interop INSIDE the lazy chunk and
 * leaves a plain ESM dynamic import at the call site, which the preset rewrites
 * as intended.
 */
import maplibre from 'maplibre-gl'

/** The MapLibre module surface (synthetic default: the package has no ESM default). */
export type MapLibreModule = typeof maplibre

export default maplibre
