/**
 * T1a.10: the derived cache -- content-derived keys, a hard quota, LRU eviction.
 *
 * The assertions are deliberately structural: not "a file appeared" but "the
 * bytes at that path are the bytes that were put there", not "eviction ran" but
 * "THIS entry is gone and THAT one is not", not "the quota is enforced" but
 * "nothing was written at all when the request could never fit".
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import GisService, {
  CACHE_FORMAT_VERSION, DerivedCache, deriveCacheKey, GisError, type CacheIdentity,
} from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

/** A fresh directory, removed after the test. */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gis-cache-'))
  roots.push(root)
  return root
}

/**
 * Let the clock advance so LRU ordering is observable.
 *
 * 20ms, not 1: the ordering is decided by `Date.now()`, whose resolution here
 * is one millisecond, and a tie would let an eviction pick either entry -- which
 * is exactly how this suite flaked under full-suite load.
 */
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

/** One cache identity, with overrides. */
function identity(overrides: Partial<CacheIdentity> = {}): CacheIdentity {
  return {
    kind: 'cog', extension: 'tif',
    source: 'C:/data/big.tif', sourceSize: 1000, sourceMtimeMs: 111,
    ...overrides,
  }
}

/** Bytes with a recognisable content. */
const blob = (size: number, fill = 7) => new Uint8Array(size).fill(fill)

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose().catch(() => {})))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('the key is derived from content, never from time', () => {
  const base = deriveCacheKey(identity())

  it('changes when the source bytes, the source, the kind or the extension change', () => {
    expect(deriveCacheKey(identity({ sourceSize: 1001 }))).not.toBe(base)
    expect(deriveCacheKey(identity({ sourceMtimeMs: 112 }))).not.toBe(base)
    expect(deriveCacheKey(identity({ source: 'C:/data/other.tif' }))).not.toBe(base)
    expect(deriveCacheKey(identity({ kind: 'mvt' }))).not.toBe(base)
    expect(deriveCacheKey(identity({ extension: 'png' }))).not.toBe(base)
    expect(deriveCacheKey(identity({ params: { zoom: 3 } }))).not.toBe(base)
  })

  it('is stable, order-independent, and case-insensitive about the path', () => {
    expect(deriveCacheKey(identity())).toBe(base)
    expect(deriveCacheKey(identity({ params: { b: 'x', a: 1 } })))
      .toBe(deriveCacheKey(identity({ params: { a: 1, b: 'x' } })))
    expect(deriveCacheKey(identity({ source: 'C:\\DATA\\Big.TIF' })))
      .toBe(deriveCacheKey(identity({ source: 'c:/data/big.tif' })))
    expect(deriveCacheKey(identity())).toMatch(/^ck_[0-9a-f]{32}$/)
  })

  it('refuses segments that would escape the cache root', () => {
    expect(() => deriveCacheKey(identity({ kind: '../evil' }))).toThrow(/kind/)
    expect(() => deriveCacheKey(identity({ extension: 'a/b' }))).toThrow(/extension/)
    expect(() => deriveCacheKey(identity({ kind: 'Cog' }))).toThrow(/kind/)
  })

  it('carries the layout version, so a layout change orphans the old tree', () => {
    expect(CACHE_FORMAT_VERSION).toBeGreaterThan(0)
  })
})

describe('a bounded LRU cache', () => {
  it('stores an artifact and resolves it back by key', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 10_000 })
    const entry = await cache.put(identity(), blob(3, 42))

    expect(entry.kind).toBe('cog')
    expect(entry.bytes).toBe(3)
    expect(entry.path.startsWith(join(root, 'cog'))).toBe(true)
    expect(new Uint8Array(await readFile(entry.path))).toEqual(blob(3, 42))

    const hit = await cache.resolve(entry.key)
    expect(hit?.path).toBe(entry.path)
    expect(hit?.bytes).toBe(3)
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: 3, available: true })
  })

  it('evicts the least recently used entry when the quota is reached', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 300, touchIntervalMs: 0 })
    const first = await cache.put(identity({ params: { layer: 'a' } }), blob(200))
    await tick()
    const second = await cache.put(identity({ params: { layer: 'b' } }), blob(200))

    expect(await cache.resolve(first.key)).toBeUndefined()
    expect(await cache.resolve(second.key)).toBeDefined()
    expect(cache.stats().bytes).toBeLessThanOrEqual(300)
  })

  it('counts a hit as use, so the entry that was read survives the next eviction', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 400, touchIntervalMs: 0 })
    const read = await cache.put(identity({ params: { layer: 'read' } }), blob(200))
    await tick()
    const idle = await cache.put(identity({ params: { layer: 'idle' } }), blob(200))
    await tick()
    expect((await cache.resolve(read.key))?.bytes).toBe(200)
    await tick()
    const arriving = await cache.put(identity({ params: { layer: 'new' } }), blob(200))

    expect(await cache.resolve(read.key)).toBeDefined()
    expect(await cache.resolve(arriving.key)).toBeDefined()
    expect(await cache.resolve(idle.key)).toBeUndefined()
  })

  it('refuses an artifact that could never fit, before writing anything', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 100 })
    const failure = await cache.put(identity(), blob(200)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(GisError)
    expect((failure as GisError).code).toBe('CACHE_QUOTA_EXCEEDED')
    expect(cache.stats().bytes).toBe(0)
    // Not even the kind directory was created: the refusal came first.
    expect(await readdir(root)).toEqual([])
  })

  it('treats a zero quota as "cache off"', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 0 })
    await expect(cache.put(identity(), blob(1))).rejects.toMatchObject({ code: 'CACHE_QUOTA_EXCEEDED' })
    expect(await cache.resolve('ck_anything')).toBeUndefined()
  })

  it('reads the quota live, so shrinking it takes effect on the next write', async () => {
    const root = await temporaryRoot()
    let quota = 1000
    const cache = new DerivedCache({ root, quotaBytes: () => quota, touchIntervalMs: 0 })
    await cache.put(identity({ params: { n: 1 } }), blob(400))
    await tick()
    await cache.put(identity({ params: { n: 2 } }), blob(400))
    expect(cache.stats().bytes).toBe(800)

    quota = 500
    await cache.put(identity({ params: { n: 3 } }), blob(400))
    expect(cache.stats().bytes).toBeLessThanOrEqual(500)
  })

  it('brings an oversized tree back under quota when it opens', async () => {
    const root = await temporaryRoot()
    const wide = new DerivedCache({ root, quotaBytes: () => 5000, touchIntervalMs: 0 })
    await wide.put(identity({ params: { n: 1 } }), blob(400))
    await tick()
    await wide.put(identity({ params: { n: 2 } }), blob(400))
    await wide.close()

    const narrow = new DerivedCache({ root, quotaBytes: () => 500 })
    await narrow.ready()
    expect(narrow.stats().bytes).toBeLessThanOrEqual(500)
  })
})

describe('producers stage, then commit', () => {
  it('keeps a staged artifact invisible until it is committed', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 10_000 })
    const pending = await cache.begin(identity(), 100)
    expect(await cache.resolve(pending.key)).toBeUndefined()

    await writeFile(pending.staging, Buffer.from('hello'))
    expect(pending.staging.endsWith('.partial')).toBe(true)

    const entry = await cache.commit(identity())
    expect(entry.bytes).toBe(5)
    expect(await cache.resolve(entry.key)).toBeDefined()
    await expect(stat(pending.staging)).rejects.toThrow()
  })

  it('removes a staged artifact on abort', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 10_000 })
    const pending = await cache.begin(identity(), 100)
    await writeFile(pending.staging, Buffer.from('half a conversion'))
    await cache.abort(identity())

    await expect(stat(pending.staging)).rejects.toThrow()
    expect(cache.stats().entries).toBe(0)
  })

  it('refuses to commit an artifact that was never staged', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 10_000 })
    await expect(cache.commit(identity())).rejects.toThrow(/no artifact was staged/)
  })

  it('removes a staging file that no longer fits, so a refused write leaves nothing', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 100 })
    const pending = await cache.begin(identity(), 50)
    await writeFile(pending.staging, blob(200))
    await expect(cache.commit(identity())).rejects.toMatchObject({ code: 'CACHE_QUOTA_EXCEEDED' })
    await expect(stat(pending.staging)).rejects.toThrow()
    expect(cache.stats().bytes).toBe(0)
  })
})

describe('the directory is the state', () => {
  it('sweeps interrupted conversions when it opens', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'cog')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'ck_deadbeef.partial'), 'half')
    const warnings: string[] = []

    const cache = new DerivedCache({ root, quotaBytes: () => 1000, warn: message => warnings.push(message) })
    await cache.ready()

    await expect(stat(join(directory, 'ck_deadbeef.partial'))).rejects.toThrow()
    expect(warnings.some(message => message.includes('unfinished'))).toBe(true)
  })

  it('rebuilds its index from the tree, and keeps LRU order across a restart', async () => {
    const root = await temporaryRoot()
    const first = new DerivedCache({ root, quotaBytes: () => 5000, touchIntervalMs: 0 })
    const older = await first.put(identity({ params: { n: 1 } }), blob(100))
    const newer = await first.put(identity({ params: { n: 2 } }), blob(100))
    await first.close()
    // The access order that survives a restart IS the file mtime, so the test
    // states it instead of hoping two writes land in different milliseconds:
    // a millisecond tie made this test flake under full-suite load.
    const minuteAgo = new Date(Date.now() - 120_000)
    const halfMinuteAgo = new Date(Date.now() - 60_000)
    await utimes(older.path, minuteAgo, minuteAgo)
    await utimes(newer.path, halfMinuteAgo, halfMinuteAgo)

    // A new process: nothing in memory, everything on disk.
    const second = new DerivedCache({ root, quotaBytes: () => 250, touchIntervalMs: 0 })
    await second.ready()
    // Read ONLY the one that must survive. Reading both would make both "recent"
    // and hand the next eviction a coin toss -- which is how this test flaked
    // under full-suite load. Two entries in the index is the presence check.
    expect((await second.resolve(older.key))?.bytes).toBe(100)
    expect(second.stats().entries).toBe(2)

    // `older` was just read; `newer` is now the least recently used.
    await tick()
    const arriving = await second.put(identity({ params: { n: 3 } }), blob(100))
    expect(await second.resolve(older.key)).toBeDefined()
    expect(await second.resolve(arriving.key)).toBeDefined()
    expect(await second.resolve(newer.key)).toBeUndefined()
  })

  it('heals when a file disappears behind its back', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 10_000 })
    const entry = await cache.put(identity(), blob(10))
    await rm(entry.path, { force: true })

    expect(await cache.resolve(entry.key)).toBeUndefined()
    expect(cache.stats().entries).toBe(0)
  })

  it('reports what clear freed even when it is the first call in a fresh process', async () => {
    const root = await temporaryRoot()
    const writer = new DerivedCache({ root, quotaBytes: () => 10_000 })
    await writer.put(identity(), blob(600))
    await writer.close()

    // A new process: nothing in memory, and nobody has called ready() yet.
    const reader = new DerivedCache({ root, quotaBytes: () => 10_000 })
    expect(await reader.clear()).toBe(600)
    expect(reader.stats()).toMatchObject({ entries: 0, bytes: 0 })
  })

  it('clears everything and reports what it freed', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 10_000 })
    await cache.put(identity({ params: { n: 1 } }), blob(120))
    await cache.put(identity({ params: { n: 2 } }), blob(80))

    expect(await cache.clear()).toBe(200)
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 })
    expect(await readdir(root)).toEqual([])
  })

  it('removes one artifact by key', async () => {
    const root = await temporaryRoot()
    const cache = new DerivedCache({ root, quotaBytes: () => 10_000 })
    const entry = await cache.put(identity(), blob(10))
    expect(await cache.remove(entry.key)).toBe(true)
    expect(await cache.remove(entry.key)).toBe(false)
    expect(cache.stats().entries).toBe(0)
  })

  it('degrades loudly, without taking anything else down, when the tree is unusable', async () => {
    const root = await temporaryRoot()
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'occupied')
    const warnings: string[] = []
    const cache = new DerivedCache({
      root: join(file, 'cache'), quotaBytes: () => 1000, warn: message => warnings.push(message),
    })
    await cache.ready()

    expect(cache.stats().available).toBe(false)
    expect(warnings).toHaveLength(1)
    // A miss is a normal state: lookups answer "not cached" instead of throwing.
    expect(await cache.resolve('ck_whatever')).toBeUndefined()
    // A write cannot be faked, so it fails loudly rather than looping forever.
    await expect(cache.put(identity(), blob(1))).rejects.toThrow(/unavailable/)
  })
})

describe('the service owns the cache', () => {
  it('uses the configured directory and quota', async () => {
    const root = await temporaryRoot()
    const configured = join(root, 'derived')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(GisService, { cacheDir: configured, cacheQuotaMb: 1 })

    expect(ctx.gis.cache.root).toBe(configured)
    expect(ctx.gis.cache.stats().quotaBytes).toBe(1024 * 1024)
    const entry = await ctx.gis.cache.put(identity(), blob(10))
    expect((await ctx.gis.cache.resolve(entry.key))?.bytes).toBe(10)
    await expect(ctx.gis.cache.put(identity({ params: { big: true } }), blob(2 * 1024 * 1024)))
      .rejects.toMatchObject({ code: 'CACHE_QUOTA_EXCEEDED' })
  })

  it('defaults to <DSH_HOME>/cache/gis', async () => {
    const home = await temporaryRoot()
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(GisService, {})
      expect(ctx.gis.cache.root).toBe(join(home, 'cache', 'gis'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('creates the cache tree at activation, not at the first request', async () => {
    const root = await temporaryRoot()
    const configured = join(root, 'derived')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(GisService, { cacheDir: configured })
    await ctx.gis.cache.ready()
    expect((await stat(configured)).isDirectory()).toBe(true)
  })
})
