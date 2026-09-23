/**
 * The TIFF reader, wrapped so the bundle's dynamic import stays ESM.
 *
 * \`import('geotiff')\` from source compiles to \`Promise.resolve().then(() =>
 * require_geotiff())\` when the target is the package's UMD browser build -- an
 * INTERNAL helper call, not \`require.async('./client.<name>.js')\`, which is the
 * only form the plugin module loader can resolve. The preset refuses to emit
 * that shape (it did for MapLibre too), so the dynamic import targets this ESM
 * wrapper instead, and this module holds the static import.
 *
 * The UMD build is chosen deliberately: see \`BROWSER_BUILD_PREFERENCE\` in
 * tsdown.client.ts -- the package's \`import\` condition resolves to a Node build
 * that reaches \`http\`, which cannot load in a browser plugin.
 */
import { fromArrayBuffer, fromUrl } from 'geotiff'

export { fromArrayBuffer, fromUrl }
