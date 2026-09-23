import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  // The entry lives under lib/types, which tsc has just emitted. A default
  // clean would wipe that output before rolldown reads it.
  clean: false,
  // package.json main is lib/index.js, so pin the extension (.mjs is tsdown's default).
  outExtensions: () => ({ js: '.js' }),
})
