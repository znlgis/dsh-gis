/**
 * Shared tsdown preset for a node-half package: tsc emits declarations and JS
 * to `lib/types`, then tsdown bundles `lib/types/index.js` to `lib/index.js`.
 *
 * Two defaults are deliberate (both learned in M0): `clean` must stay OFF
 * because the entry lives under the directory a default clean would wipe, and
 * the ESM extension is pinned to `.js` because tsdown defaults to `.mjs`.
 */
import { defineConfig } from 'tsdown'
import type { UserConfig } from 'tsdown'

/**
 * Build the tsdown config for one node-half package.
 * @param id - package name, used for diagnostics only.
 * @param entry - tsc output to bundle; defaults to the package root entry.
 * @returns the tsdown config.
 */
export function nodePackage(id: string, entry = 'lib/types/index.js'): UserConfig {
  return defineConfig({
    name: id,
    entry: [entry],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: false,
    clean: false,
    outExtensions: () => ({ js: '.js' }),
  })
}
