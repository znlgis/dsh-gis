/**
 * The one place MapLibre is reached from.
 *
 * The import is DYNAMIC on purpose: it is what makes the library land in its
 * own lazy chunk instead of the first-screen payload. Nothing in this plugin
 * may import maplibre-gl statically from the eager graph --
 * `scripts/check-client-bundle.mjs` fails if the entry chunk ever carries it.
 *
 * VERSION PIN, and why it is 5.x rather than 6.x (runtime contract #22):
 * maplibre-gl 6 ships ESM only and loads its worker with
 * `new URL('./maplibre-gl-worker.mjs', import.meta.url)`. Inside a plugin chunk
 * served from `/plugins/<pkg>/...` that URL names a sibling file the plugin
 * server does not serve, so the map silently never initializes. The 5.x UMD
 * build inlines the whole worker bundle as a string and installs it with
 * `setWorkerUrl(URL.createObjectURL(new Blob([...])))`, which is what a bundled
 * plugin needs.
 */
import type { MapLibreModule } from './maplibre.ts'

export type { MapLibreModule }

/** How the component reaches MapLibre; injectable so tests need no browser. */
export type MapLibreLoader = () => Promise<MapLibreModule>

/**
 * Load MapLibre, unwrapping the interop hop of its UMD distribution.
 * @returns the MapLibre module.
 */
export async function loadMapLibre(): Promise<MapLibreModule> {
  const loaded = await import('./maplibre.ts')
  return (loaded.default ?? loaded) as MapLibreModule
}
