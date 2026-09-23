/**
 * The derived-data cache: bounded on disk, LRU, and safe to delete.
 *
 * Design 8.3 asks for exactly three properties, and each one shapes the code:
 *
 * 1. **A key is content-derived** (${deriveCacheKey}), so nothing ever has to
 *    be invalidated -- an edited source or a different transformation is a
 *    different key.
 * 2. **The tree is bounded by a quota, and over-quota evicts by LRU.** The host
 *    attachment library never deletes anything (design ch.12 item 9), so a
 *    derived tree with no bound would grow forever next to it.
 * 3. **The directory IS the state**: opening rebuilds the index by scanning, and
 *    deleting the whole tree is a supported operation (`clear`, or plain
 *    `rm -r`). Nothing here is migrated, ever -- the artifacts are
 *    rebuildable by definition (design 11.5).
 *
 * Writes are staged in `<artifact>.partial` and renamed into place, so a
 * cancelled or crashed conversion can never be mistaken for a cache hit.
 */
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cacheFileName, deriveCacheKey, type CacheIdentity } from './cache-key.ts'
import { GisError } from './errors.ts'

/** One cached artifact, as the caller sees it. */
export interface CacheEntry {
  /** The content-derived key. */
  readonly key: string
  /** Artifact family (the directory it lives in). */
  readonly kind: string
  /** Absolute path of the artifact. */
  readonly path: string
  /** Size on disk, as measured now. */
  readonly bytes: number
  /** Last access, in ms since epoch. */
  readonly lastUsed: number
}

/** Where a caller produces an artifact before it is committed. */
export interface PendingArtifact {
  /** The key the artifact will be stored under. */
  readonly key: string
  /** Path to WRITE: invisible to ${DerivedCache.resolve} until commit. */
  readonly staging: string
  /** Path the artifact will have once committed. */
  readonly target: string
}

/** What the cache currently holds. */
export interface CacheStats {
  readonly root: string
  readonly entries: number
  readonly bytes: number
  readonly quotaBytes: number
  /** False when the tree could not be prepared; every op then degrades or fails loudly. */
  readonly available: boolean
}

/** Construction options. */
export interface DerivedCacheOptions {
  /** Absolute root of the cache tree. */
  readonly root: string
  /**
   * Live quota in bytes.
   *
   * A function, not a number: the quota is a user setting, and reading it per
   * operation is what makes "change the setting" take effect without a reload.
   * Zero disables the cache (every write is refused, every lookup misses).
   */
  readonly quotaBytes: () => number
  /** Sink for non-fatal problems (an unusable tree, a failed sweep). */
  readonly warn?: (message: string) => void
  /**
   * How stale a hit's recorded access may get before the artifact's mtime is
   * refreshed.
   *
   * Without this the LRU order would reset to "write order" on every restart,
   * because mtime is the only access record that survives the process. The
   * interval bounds what keeping it fresh costs.
   */
  readonly touchIntervalMs?: number
}

/** Internal index record; `bytes` and `lastUsed` are refreshed on access. */
interface Entry {
  readonly key: string
  readonly kind: string
  readonly path: string
  bytes: number
  lastUsed: number
  lastTouched: number
}

const DEFAULT_TOUCH_INTERVAL_MS = 3_600_000
const noop = (): void => {}

/**
 * A filesystem cache of derived artifacts with a quota and LRU eviction.
 *
 * Lookups are an in-memory index hit plus one `stat` (the index can be
 * stale when somebody deleted a file). Mutations -- staging, committing,
 * evicting, clearing -- are serialized on one chain, so quota accounting can
 * never interleave.
 */
export class DerivedCache {
  private readonly entries = new Map<string, Entry>()

  /** Tail of the write chain; every link settles (rejections reach the caller's slice). */
  private chain: Promise<void> = Promise.resolve()

  private opening: Promise<void> | undefined

  /** Set when the tree could not be prepared; ops then degrade or throw it. */
  private failure: unknown

  /**
   * @param options - root, live quota, and the warning sink.
   */
  constructor(private readonly options: DerivedCacheOptions) {}

  /** Absolute root of the cache tree. */
  get root(): string {
    return this.options.root
  }

  /**
   * Prepare the tree and rebuild the index. Safe to call repeatedly, and it
   * never rejects: a cache that cannot be prepared must not take the plugin
   * down with it.
   * @returns resolution once the attempt finished.
   */
  ready(): Promise<void> {
    this.opening ??= this.openOnce()
    return this.opening
  }

  /**
   * Look an artifact up, confirming it is still on disk.
   *
   * A hit refreshes the entry's access time (in memory always, on disk at most
   * once per touch interval) so eviction stays LRU across restarts.
   * @param key - content-derived key.
   * @returns the artifact, or `undefined` on a miss or a vanished file.
   */
  async resolve(key: string): Promise<CacheEntry | undefined> {
    await this.ready()
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    let info
    try {
      info = await stat(entry.path)
    } catch {
      // Somebody removed it behind our back: the index self-heals and the
      // caller regenerates. A miss is a normal state for a cache.
      this.entries.delete(key)
      return undefined
    }
    if (!info.isFile()) {
      this.entries.delete(key)
      return undefined
    }
    const now = Date.now()
    entry.bytes = info.size
    entry.lastUsed = now
    if (now - entry.lastTouched >= (this.options.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS)) {
      entry.lastTouched = now
      void utimes(entry.path, new Date(now), new Date(now)).catch(() => {})
    }
    return publicEntry(entry)
  }

  /**
   * Reserve room for an artifact the caller is about to produce.
   *
   * This is the "check the quota BEFORE spending minutes on a conversion" seam
   * (design 11.4): it evicts what LRU allows and refuses the request outright
   * when the artifact could never fit, so the caller sees
   * `CACHE_QUOTA_EXCEEDED` before the work starts rather than after it.
   * @param identity - the artifact's identity.
   * @param estimatedBytes - expected size; the real size is checked again at commit.
   * @returns the staging path to write, and the path it will be committed to.
   * @throws GisError CACHE_QUOTA_EXCEEDED when the estimate cannot fit.
   */
  begin(identity: CacheIdentity, estimatedBytes: number): Promise<PendingArtifact> {
    const paths = this.pathsFor(identity)
    return this.enqueue(async () => {
      this.assertAvailable()
      await this.evictFor(estimatedBytes, paths.key)
      await mkdir(dirname(paths.target), { recursive: true })
      // A leftover staging file means a previous attempt died or was cancelled.
      await rm(paths.staging, { force: true })
      return paths
    })
  }

  /**
   * Publish a staged artifact: rename it into place, index it, and enforce the
   * quota against its REAL size.
   * @param identity - the identity the staging path was derived from.
   * @returns the committed entry.
   * @throws Error when nothing was staged at the expected path.
   * @throws GisError CACHE_QUOTA_EXCEEDED when the artifact cannot fit; the
   *   staging file is removed, so a refused artifact leaves nothing behind.
   */
  commit(identity: CacheIdentity): Promise<CacheEntry> {
    const paths = this.pathsFor(identity)
    return this.enqueue(async () => {
      this.assertAvailable()
      let info
      try {
        info = await stat(paths.staging)
      } catch {
        throw new Error(`no artifact was staged at ${paths.staging}`)
      }
      try {
        await this.evictFor(info.size, paths.key)
      } catch (error) {
        await rm(paths.staging, { force: true })
        throw error
      }
      await rm(paths.target, { force: true })
      await rename(paths.staging, paths.target)
      const now = Date.now()
      const entry: Entry = {
        key: paths.key, kind: identity.kind, path: paths.target,
        bytes: info.size, lastUsed: now, lastTouched: now,
      }
      this.entries.set(paths.key, entry)
      return publicEntry(entry)
    })
  }

  /**
   * Drop a staged artifact that will never be committed (cancellation, failure).
   * @param identity - the identity the staging path was derived from.
   * @returns resolution once the staging file is gone.
   */
  abort(identity: CacheIdentity): Promise<void> {
    const paths = this.pathsFor(identity)
    return this.enqueue(async () => {
      await rm(paths.staging, { force: true })
    })
  }

  /**
   * Store a small artifact held in memory (a captured document, a rendered
   * frame). Large artifacts should stream to the staging path from
   * `begin` instead of being read into memory.
   * @param identity - the artifact's identity.
   * @param bytes - the artifact.
   * @returns the committed entry.
   */
  async put(identity: CacheIdentity, bytes: Uint8Array): Promise<CacheEntry> {
    const pending = await this.begin(identity, bytes.byteLength)
    await writeFile(pending.staging, bytes)
    return this.commit(identity)
  }

  /**
   * Remove one artifact.
   * @param key - content-derived key.
   * @returns true when an entry was removed.
   */
  remove(key: string): Promise<boolean> {
    return this.enqueue(async () => {
      const entry = this.entries.get(key)
      if (entry === undefined) return false
      await rm(entry.path, { force: true })
      this.entries.delete(key)
      return true
    })
  }

  /**
   * Delete the whole tree -- the "clear cache" entry the settings page needs --
   * and recreate an empty root.
   * @returns bytes freed.
   */
  clear(): Promise<number> {
    return this.enqueue(async () => {
      const freed = this.totalBytes()
      await rm(this.options.root, { recursive: true, force: true })
      await mkdir(this.options.root, { recursive: true })
      this.entries.clear()
      return freed
    })
  }

  /** Current size and bounds. */
  stats(): CacheStats {
    return {
      root: this.options.root,
      entries: this.entries.size,
      bytes: this.totalBytes(),
      quotaBytes: this.quota(),
      available: this.failure === undefined,
    }
  }

  /**
   * Wait for in-flight mutations to land.
   *
   * The cache holds no handles, so this is not a resource release: it is the
   * promise that a reload does not inherit a half-finished write.
   * @returns resolution once the chain is drained.
   */
  async close(): Promise<void> {
    await this.chain
  }

  /** Validate the identity and derive every path it owns. */
  private pathsFor(identity: CacheIdentity): PendingArtifact {
    // The key is derived FIRST: it validates kind and extension, so the joins
    // below can only ever see path-safe segments.
    const key = deriveCacheKey(identity)
    const target = join(this.options.root, identity.kind, cacheFileName(identity))
    return { key, staging: `${target}.partial`, target }
  }

  /** Prepare the root and rebuild the index from the tree. */
  private async openOnce(): Promise<void> {
    try {
      await mkdir(this.options.root, { recursive: true })
      await this.scan()
      // A lowered quota must bound the tree that is already on disk, or the
      // setting would only apply to whatever is written next.
      await this.evictFor(0, '')
      this.failure = undefined
    } catch (error) {
      this.failure = error
      this.options.warn?.(
        `gis-core: the derived cache at ${this.options.root} is unavailable (${String(error)}); `
        + 'every derived artifact will be rebuilt instead of reused',
      )
    }
  }

  /**
   * Rebuild the index by walking `<root>/<kind>/<key>.<ext>`.
   *
   * The tree is the truth and the index is a convenience: whatever is on disk
   * after a restart is what the cache holds, and stale staging files -- proof of
   * an interrupted conversion -- are removed here rather than served.
   */
  private async scan(): Promise<void> {
    this.entries.clear()
    let staging = 0
    for (const dirent of await readdir(this.options.root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue
      const kind = dirent.name
      const directory = join(this.options.root, kind)
      for (const file of await readdir(directory, { withFileTypes: true })) {
        if (!file.isFile()) continue
        const path = join(directory, file.name)
        if (file.name.endsWith('.partial')) {
          await rm(path, { force: true })
          staging += 1
          continue
        }
        const key = file.name.slice(0, file.name.lastIndexOf('.'))
        const info = await stat(path)
        this.entries.set(key, {
          key, kind, path, bytes: info.size,
          // mtime is the only access record that survives a restart.
          lastUsed: info.mtimeMs, lastTouched: info.mtimeMs,
        })
      }
    }
    if (staging > 0) {
      this.options.warn?.(`gis-core: removed ${String(staging)} unfinished cache artifact(s) under ${this.options.root}`)
    }
  }

  /** Make room for `incoming` bytes, evicting least-recently-used entries. */
  private async evictFor(incoming: number, keepKey: string): Promise<void> {
    const quota = this.quota()
    if (incoming > quota) {
      throw new GisError(
        'CACHE_QUOTA_EXCEEDED',
        `the artifact needs ${String(incoming)} bytes but the cache quota is ${String(quota)}`,
        'raise the cache quota in the GIS settings, or clear the cache',
      )
    }
    const candidates = [...this.entries.values()]
      .filter(entry => entry.key !== keepKey)
      .sort((left, right) => left.lastUsed - right.lastUsed)
    let used = this.totalBytes()
    for (const entry of candidates) {
      if (used + incoming <= quota) return
      await rm(entry.path, { force: true })
      this.entries.delete(entry.key)
      used -= entry.bytes
    }
    if (used + incoming > quota) {
      // Reachable only when an entry's recorded size disagrees with the disk;
      // the next scan or lookup corrects it, and this call refuses to guess.
      throw new GisError(
        'CACHE_QUOTA_EXCEEDED',
        `the cache holds ${String(used)} bytes against a ${String(quota)}-byte quota and could not free enough room`,
        'clear the cache and try again',
      )
    }
  }

  /** Current quota, clamped to a usable byte count. */
  private quota(): number {
    const raw = this.options.quotaBytes()
    return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0
  }

  /** Sum of the indexed sizes. */
  private totalBytes(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.bytes
    return total
  }

  /** Fail loudly when the tree could not be prepared. */
  private assertAvailable(): void {
    if (this.failure === undefined) return
    throw new Error(
      `the derived cache at ${this.options.root} is unavailable: ${String(this.failure)}`,
    )
  }

  /**
   * Serialize one mutation on the shared chain, after the index exists.
   *
   * The `ready()` hop is load-bearing: every mutation accounts against the
   * index -- what to evict, how much was freed -- so running one against an
   * index that has not been built yet silently under-counts. (Found by running
   * `clear()` as the first call in a fresh process: it deleted the tree and
   * reported zero bytes freed.)
   */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      await this.ready()
      return job()
    })
    this.chain = result.then(noop, noop)
    return result
  }
}

/** Strip the internal-only bookkeeping from an entry. */
function publicEntry(entry: Entry): CacheEntry {
  return { key: entry.key, kind: entry.kind, path: entry.path, bytes: entry.bytes, lastUsed: entry.lastUsed }
}
