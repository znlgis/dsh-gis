/**
 * Content-derived dataset ids (design 6.6).
 *
 * An id is a pure function of what the bytes ARE, not of when they were
 * registered: rescanning the same unchanged file yields the same id, so a
 * replayed session still resolves, while an edited file yields a new id and
 * the old one legitimately stops resolving.
 */
import { createHash } from 'node:crypto'

/** What an id is derived from. */
export interface DatasetIdentity {
  /** Canonical absolute path (or connection profile name). */
  readonly path: string
  /** Container kind, so one path cannot collide across kinds. */
  readonly kind: string
  /** Byte size of the primary member, when known. */
  readonly size?: number
  /** Modification time in ms of the primary member, when known. */
  readonly mtimeMs?: number
  /**
   * Extra members that decide identity, e.g. a shapefile family.
   *
   * A member's ENTRY must capture its bytes, not only its name: the callers
   * encode the member's size and mtime into the string (see
   * `@znlgis/dsh-gis-purejs`). Names alone would keep an id stable while a
   * `.dbf` or `.prj` edit silently changed what the dataset is.
   */
  readonly members?: readonly string[]
}

/**
 * Derive the stable id for one dataset identity.
 * @param identity - canonical inputs; every field participates in the hash.
 * @returns an opaque `ds_`-prefixed id.
 */
export function deriveDatasetId(identity: DatasetIdentity): string {
  const canonical = [
    identity.path.replace(/\\/g, '/').toLowerCase(),
    identity.kind,
    String(identity.size ?? ''),
    String(identity.mtimeMs ?? ''),
    [...(identity.members ?? [])].sort().join(','),
  ].join('\u0000')
  return 'ds_' + createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}
