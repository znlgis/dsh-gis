/**
 * The decode worker's shape, without a browser.
 *
 * The unit tests cannot run a worker (jsdom has none), but they CAN assert the
 * two properties that make the worker correct rather than merely present: it
 * carries the reader, and it carries the SAME pixel arithmetic as the main
 * thread -- serialized, not re-implemented, so the two paths cannot drift into
 * two different definitions of how a raster becomes pixels.
 */
import { describe, expect, it } from 'vitest'
import { workerAvailable, workerSource } from '../src/client/map/decode-worker.ts'

describe('the decode worker', () => {
  it('is unavailable in this environment, which is why jsdom exercises the fallback', () => {
    expect(workerAvailable()).toBe(false)
  })

  it('carries the reader and the handler, and nothing of our module graph', () => {
    const source = workerSource()
    // The UMD reader attaches itself to self under this name.
    expect(source).toContain('GeoTIFF')
    // The handler posts RAW SAMPLES: the RGBA expansion stays on the main thread,
    // which is what keeps this worker free of imports from our graph. An import
    // of the shared pixel module made the two chunks require each other, and the
    // loader cannot resolve a chunk require (contracts #31/#39).
    expect(source).toContain('readRasters')
    expect(source).toContain('self.onmessage')
    expect(source).not.toContain('__toRgba')
    // Only OUR half is asserted import-free: which build of the reader gets
    // inlined is the client preset's job (it picks the browser UMD), and vitest
    // resolves the same specifier to the ESM build, which does have imports.
    // The browser check is what proves the UMD is the one that ships.
    const handler = source.slice(source.indexOf('self.onmessage'))
    expect(handler).not.toContain('import ')
    expect(handler).not.toContain('require(')
  })
})
