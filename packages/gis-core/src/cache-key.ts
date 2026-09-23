/**
 * Content-derived cache keys for derived data (design 8.3).
 *
 * The whole point of a derived cache is that it can never serve a stale
 * artifact: a key is a hash of WHAT the artifact was made from -- the source
 * path, its size and mtime, and the transformation parameters -- so editing the
 * source (or asking for a different transformation) simply misses and
 * regenerates, with no invalidation logic anywhere.
 *
 * Why the cache needs this at all: the host's attachment library never expires
 * anything, so a 20 GB raster dropped on the workspace is kept forever, and the
 * tiles/COGs derived from it must carry their own bound (design 8.3, risk 7).
 */
import { createHash } from 'node:crypto'

/**
 * Cache layout version.
 *
 * Bump it whenever the key derivation or the on-disk layout changes: the root
 * directory is named by content and can be deleted wholesale, so an old tree is
 * simply never looked up again rather than migrated (design 11.5: 能重建的就
 * 不要迁移).
 */
export const CACHE_FORMAT_VERSION = 1

/** One path segment of the cache tree; anything else could escape the root. */
const SAFE_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*$/

/**
 * What a derived artifact is derived from.
 *
 * Every field except `kind`/`extension` describes the SOURCE and the
 * TRANSFORMATION; all of them participate in the key.
 */
export interface CacheIdentity {
  /** Artifact family, and the directory it lives under, e.g. `cog` or `mvt`. */
  readonly kind: string
  /**
   * File extension of the artifact, without the dot. Part of the key because
   * the bytes of "the same" conversion by a different format are a different
   * artifact; the default suits opaque blobs.
   */
  readonly extension?: string
  /** Canonical absolute path of the source, when the artifact derives from one. */
  readonly source?: string
  /** Source byte size; part of the key so an edited source misses. */
  readonly sourceSize?: number
  /** Source mtime in ms; part of the key so a same-size rewrite still misses. */
  readonly sourceMtimeMs?: number
  /**
   * Transformation parameters: zoom, bbox, format, layer, CRS, and so on.
   * Order-independent -- the derivation sorts them -- so building the same
   * request twice can never produce two keys.
   */
  readonly params?: Readonly<Record<string, string | number | boolean>>
}

/**
 * Derive the cache key for one identity.
 * @param identity - source and transformation; every field participates.
 * @returns an opaque `ck_`-prefixed key, also usable as a file name.
 * @throws Error when `kind` or `extension` is not a safe path segment.
 */
export function deriveCacheKey(identity: CacheIdentity): string {
  const kind = assertSegment(identity.kind, 'kind')
  const extension = assertSegment(identity.extension ?? 'bin', 'extension')
  const params = Object.entries(identity.params ?? {})
    .map(([name, value]) => `${name}=${String(value)}`)
    .sort()
    .join('&')
  const canonical = [
    `v${String(CACHE_FORMAT_VERSION)}`,
    kind,
    extension,
    // Same canonicalization as dataset ids (dataset-id.ts): one source must not
    // hash two ways because a caller passed 'C:\\a' and another 'c:/a'.
    (identity.source ?? '').replace(/\\/g, '/').toLowerCase(),
    String(identity.sourceSize ?? ''),
    String(identity.sourceMtimeMs ?? ''),
    params,
  ].join('\u0000')
  return 'ck_' + createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/**
 * The artifact's file name for one identity: `<key>.<extension>`.
 * @param identity - the identity the key was derived from.
 * @returns the file name, safe as a single path segment.
 */
export function cacheFileName(identity: CacheIdentity): string {
  return `${deriveCacheKey(identity)}.${assertSegment(identity.extension ?? 'bin', 'extension')}`
}

/** Reject a value that would not be a safe single path segment. */
function assertSegment(value: string, field: string): string {
  if (!SAFE_SEGMENT_RE.test(value)) {
    throw new Error(`cache ${field} '${value}' must match ${SAFE_SEGMENT_RE} (it becomes a path segment)`)
  }
  return value
}
