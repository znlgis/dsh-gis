/**
 * `ctx.gis` — the GIS service definition.
 *
 * This package owns the data model, the error taxonomy, and the dataset
 * registry. It deliberately implements NO format: reading is delegated to
 * registered handlers, so the same tools work whether the bytes are parsed by
 * a pure-JS handler or by a GDAL-backed one (design ch.10, capability seams).
 *
 * The registry is durable when the profile mounts the storage hub, and purely
 * in-process when it does not — see {@link GisService.openRegistryDomain}.
 */
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshCachePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
// Type-only: the declaration merge below is what makes `ctx.storageDomain`
// visible here (runtime contract #6 -- a service you can read but cannot name
// is a compile error waiting to happen).
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { resolve } from 'node:path'
import { DerivedCache } from './cache.ts'
import { GisError } from './errors.ts'
import { sourcePathOf } from './dataset-source.ts'
import { DatasetRegistry, type PersistenceMode } from './registry.ts'
import { GIS_DATASET_TABLE, GIS_DOMAIN_NAME, gisDatasetDomainSpec } from './registry-domain.ts'
import type { Dataset, DatasetKind, InspectResult, QueryRequest, QueryResult } from './types.ts'

export { GisError, isGisError, GIS_ERROR_CODES, type GisErrorCode } from './errors.ts'
export { CACHE_FORMAT_VERSION, cacheFileName, deriveCacheKey, type CacheIdentity } from './cache-key.ts'
export {
  DerivedCache, type CacheEntry, type CacheStats, type DerivedCacheOptions, type PendingArtifact,
} from './cache.ts'
export { deriveDatasetId, type DatasetIdentity } from './dataset-id.ts'
export { sourcePathOf } from './dataset-source.ts'
export { DatasetRegistry, type PersistenceMode } from './registry.ts'
export {
  GIS_DATASET_TABLE, GIS_DOMAIN_NAME, gisDatasetDomainSpec, parseStoredDataset,
  toDataset, toStoredDataset, type StoredDataset, type StoredLayer,
} from './registry-domain.ts'
export type * from './types.ts'

/** Configuration this bundle accepts from the active profile. */
export interface Config {
  /**
   * Directory holding derived artifacts. Empty means `<DSH_HOME>/cache/gis`.
   *
   * Not volatile: the tree's identity is its location, so moving it is a
   * reload-time decision, not a live knob.
   */
  cacheDir: string
  /**
   * Derived-cache quota in MiB; over-quota evicts by LRU. Zero turns the cache
   * off (every derived artifact is rebuilt on demand).
   *
   * Volatile: this is the number a user raises when a conversion reports
   * `CACHE_QUOTA_EXCEEDED`, and it takes effect on the next operation.
   */
  cacheQuotaMb: Volatile<number>
}

/** Configuration schema. No annotation: the inference must line up with `Volatile<T>`. */
export const Config = z.object({
  cacheDir: z.string().default(''),
  cacheQuotaMb: z.number().default(5120).volatile(),
})

/**
 * One format implementation. A handler declares the dataset kinds it can
 * read; the service routes every read to the first handler claiming that kind.
 */
export interface GisFormatHandler {
  /** Stable name for diagnostics. */
  readonly name: string
  /** Dataset kinds this handler serves. */
  readonly kinds: readonly DatasetKind[]
  /**
   * Read structure and metadata without materializing every feature.
   * @param dataset - the registered dataset.
   * @param layer - layer name, when the caller chose one.
   * @returns the inspection result.
   */
  inspect(dataset: Dataset, layer: string | undefined): Promise<InspectResult>
  /**
   * Read one page of features.
   * @param dataset - the registered dataset.
   * @param request - paging, filter, and geometry encoding.
   * @returns the page.
   */
  query(dataset: Dataset, request: QueryRequest): Promise<QueryResult>
}

/**
 * A way to turn a caller-supplied path into a dataset.
 *
 * Opening is I/O and therefore provider-specific, so gis-core defines only the
 * seam. The pure-JS provider opens files; a GDAL provider may also open
 * containers such as a file geodatabase.
 *
 * `open` is a pure factory: it describes the path and returns the dataset, and
 * registering it is the service's job. Keeping it side-effect free is what lets
 * the service re-open a source later to decide whether a stored id still
 * matches the bytes on disk.
 */
export interface GisOpener {
  /** Stable name for diagnostics. */
  readonly name: string
  /**
   * Whether this opener handles a path.
   * @param path - absolute path the caller named.
   * @returns true when {@link open} can handle it.
   */
  canOpen(path: string): boolean
  /**
   * Inspect the path and return its dataset.
   * @param path - absolute path the caller named.
   * @returns the dataset, carrying its content-derived id.
   */
  open(path: string): Promise<Dataset>
}

/** How a stored id looked when it was re-checked against its source. */
type Freshness = 'fresh' | 'stale' | 'unknown'

/**
 * The GIS capability facade every tool talks to.
 *
 * CRITICAL: the fields below use TypeScript `private`, NOT `#private`. Cordis
 * hands out services through a Proxy, and ECMAScript private fields are not
 * forwarded through one -- reaching a `#field` from a method invoked on the
 * proxy throws "Cannot read private member #x from an object whose class did
 * not declare it". TypeScript `private` is erased at runtime, so it is a plain
 * property and survives the proxy. (Found by starting a real instance; no unit
 * test could see it, because there is no proxy in a direct call.)
 */
export default class GisService extends Service {
  /** Configuration schema, so the Loader validates the profile's values. */
  static readonly Config = Config

  /**
   * The derived-data cache (design 8.3). Bounded by `cacheQuotaMb`, evicted by
   * LRU, and safe to delete wholesale: every artifact in it is rebuildable.
   */
  readonly cache: DerivedCache

  private readonly handlers = new Map<DatasetKind, GisFormatHandler>()

  private readonly registry = new DatasetRegistry((message: string) => {
    this.ctx.logger.warn(message)
  })

  private readonly openers: GisOpener[] = []

  /**
   * @param ctx - owning context; the service is published as `ctx.gis`.
   * @param config - validated row config; the cache root is fixed here, the
   *   quota is read live from `config.cacheQuotaMb` on every operation.
   */
  constructor(ctx: Context, public readonly config: Config) {
    super(ctx, 'gis')
    this.cache = new DerivedCache({
      root: cacheRootOf(config.cacheDir),
      quotaBytes: () => config.cacheQuotaMb.get() * 1024 * 1024,
      warn: message => { ctx.logger.warn(message) },
    })
  }

  /**
   * Attach the durable half, when the profile has one.
   *
   * `storageDomain` is deliberately NOT in `static inject`: an unsatisfied
   * inject leaves this row `waiting-for-services` forever, so a profile that
   * never mounts the storage hub would lose the whole GIS plugin. `ctx.inject`
   * gives the same late binding without the hard requirement -- the callback
   * runs whenever the service shows up and unloads when it goes away.
   */
  protected [Service.init](): void {
    this.ctx.inject(['storageDomain'], (storageCtx) => {
      storageCtx.effect(() => this.openRegistryDomain(storageCtx), 'gis-core: dataset registry')
    })
    // Prepare the cache tree now rather than on the first request: the index is
    // a directory scan, and paying for it inside the first map render would be
    // a latency spike nobody could attribute. `ready()` never rejects.
    void this.cache.ready()
    this.ctx.effect(() => () => this.cache.close(), 'gis-core: derived cache')
  }

  /** Whether ids survive a restart in this profile. */
  get persistence(): PersistenceMode {
    return this.registry.persistence
  }

  /**
   * Register a format handler. Disposing the owner unregisters it, so a
   * provider that fails to load simply leaves its kinds unreadable.
   * @param handler - the implementation.
   * @returns the disposer removing it.
   */
  registerHandler(handler: GisFormatHandler): () => void {
    for (const kind of handler.kinds) {
      if (this.handlers.has(kind)) {
        throw new GisError('UNSUPPORTED_FORMAT', `a handler for ${kind} is already registered`)
      }
      this.handlers.set(kind, handler)
    }
    return () => {
      for (const kind of handler.kinds) {
        if (this.handlers.get(kind) === handler) this.handlers.delete(kind)
      }
    }
  }

  /**
   * Register or replace one dataset under its derived id.
   *
   * Resolves after the durable write when the profile has storage, so an id
   * handed to the model is an id that survives a restart. Without storage the
   * registration is in-process only, and `persistence` says so.
   * @param dataset - the dataset to make resolvable.
   * @returns resolution after the best-effort durable write.
   */
  async registerDataset(dataset: Dataset): Promise<void> {
    await this.registry.register(dataset)
  }

  /**
   * Register an opener. Disposing the owner unregisters it.
   * @param opener - the implementation.
   * @returns the disposer removing it.
   */
  registerOpener(opener: GisOpener): () => void {
    this.openers.push(opener)
    return () => {
      const at = this.openers.indexOf(opener)
      if (at >= 0) this.openers.splice(at, 1)
    }
  }

  /**
   * Turn a path into a registered dataset.
   * @param path - absolute path the caller named.
   * @returns the registered dataset.
   * @throws GisError UNSUPPORTED_FORMAT when no opener claims the path.
   */
  async open(path: string): Promise<Dataset> {
    for (const opener of this.openers) {
      if (!opener.canOpen(path)) continue
      const dataset = await opener.open(path)
      await this.registerDataset(dataset)
      return dataset
    }
    throw new GisError(
      'UNSUPPORTED_FORMAT',
      `no opener handles ${path}`,
      'supported: .geojson, .json, .ndjson, .geojsonl, .shp, .wkt, .csv(wkt)',
    )
  }

  /**
   * Resolve an opaque id against this process's catalog.
   *
   * Synchronous and storage-free by design: handlers must not wait on I/O to
   * find out what they are reading. It does NOT re-check the source -- use
   * {@link resolveFresh} on any path that is about to read bytes.
   * @param id - dataset id as handed to the model or the browser.
   * @returns the dataset.
   * @throws GisError DATASET_NOT_FOUND when the id is unknown or has expired.
   */
  resolve(id: string): Dataset {
    const dataset = this.registry.resolve(id)
    if (dataset === undefined) throw notFound(id)
    return dataset
  }

  /**
   * Resolve an id and confirm it still names the bytes it was derived from.
   *
   * An id is a hash of path + size + mtime + family members, so it may only be
   * served while those still hold. When the source moved on, the entry is
   * dropped (memory and medium) and the caller gets the same structured 404 an
   * unknown id gets -- an id that quietly reads DIFFERENT bytes under the old
   * name is exactly the silent error this project refuses (design 6.6).
   *
   * A source that cannot be re-read for a transient reason (a locked or
   * unreachable file) is NOT treated as stale: the entry stays and the read
   * fails loudly on its own terms.
   * @param id - dataset id.
   * @returns the dataset, still matching its source.
   * @throws GisError DATASET_NOT_FOUND when unknown or no longer matching.
   */
  async resolveFresh(id: string): Promise<Dataset> {
    const dataset = this.resolve(id)
    const freshness = await this.freshness(dataset)
    if (freshness !== 'stale') return dataset
    await this.registry.forget(id)
    throw new GisError(
      'DATASET_NOT_FOUND',
      `dataset ${id} no longer matches its source, so it was dropped from the catalog`,
      'open the path again: a new id will be derived from the current bytes',
    )
  }

  /**
   * Every currently registered dataset.
   * @returns a snapshot array.
   */
  list(): readonly Dataset[] {
    return this.registry.list()
  }

  /**
   * Inspect one dataset through its handler.
   * @param id - dataset id.
   * @param layer - layer name, when chosen.
   * @returns the inspection result.
   */
  async inspect(id: string, layer?: string): Promise<InspectResult> {
    const dataset = await this.resolveFresh(id)
    return this.handlerFor(dataset).inspect(dataset, layer)
  }

  /**
   * Read one page of features through the dataset's handler.
   * @param id - dataset id.
   * @param request - paging, filter, and geometry encoding.
   * @returns the page.
   */
  async query(id: string, request: QueryRequest): Promise<QueryResult> {
    const dataset = await this.resolveFresh(id)
    return this.handlerFor(dataset).query(dataset, request)
  }

  /**
   * Open the registry domain and keep it open for this service's lifetime.
   *
   * The returned disposer is the `ctx.effect` teardown: it waits for an open
   * that is still in flight, detaches the table, and closes the domain --
   * closing is what frees the domain name, so skipping it would make every
   * reload (HMR included) fail with `already-open` and silently fall back to a
   * memory-only catalog.
   * @param storageCtx - the context that owns `storageDomain`.
   * @returns the async disposer that closes the domain.
   */
  private openRegistryDomain(storageCtx: Context): () => Promise<void> {
    let domain: Domain<typeof gisDatasetDomainSpec> | undefined
    let disposed = false
    const started = openWhenFree(storageCtx, gisDatasetDomainSpec).then(
      async (opened) => {
        // The service was disposed while the domain was opening: give the name
        // straight back instead of leaking it into a dead fiber.
        if (disposed) {
          await opened.close()
          return
        }
        domain = opened
        await this.registry.attach(opened.table(GIS_DATASET_TABLE))
      },
      (error: unknown) => {
        storageCtx.logger.warn(
          `gis-core: dataset ids will not survive a restart -- storage domain '${GIS_DOMAIN_NAME}' did not open: ${String(error)}`,
        )
      },
    )
    return async () => {
      disposed = true
      await started
      this.registry.detach()
      await domain?.close()
    }
  }

  /**
   * Decide whether a stored id still names the bytes it was derived from.
   * @param dataset - the dataset behind the id.
   * @returns `fresh`, `stale`, or `unknown` when nothing can re-read the source.
   */
  private async freshness(dataset: Dataset): Promise<Freshness> {
    const path = sourcePathOf(dataset)
    // Connection datasets are addressed by profile name, not by a file.
    if (path === undefined) return 'fresh'
    const opener = this.openers.find(candidate => candidate.canOpen(path))
    // No provider loaded (yet): nothing to compare against, so do not guess.
    if (opener === undefined) return 'unknown'
    try {
      const current = await opener.open(path)
      return current.id === dataset.id ? 'fresh' : 'stale'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      // Gone is gone; anything else (locked, permission, network) is not proof.
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'stale'
      this.ctx.logger.warn(`gis-core: could not re-check dataset ${dataset.id} against ${path}: ${String(error)}`)
      return 'unknown'
    }
  }

  /**
   * Pick the handler for one dataset, failing loudly when none exists.
   * @param dataset - the dataset to read.
   * @returns its handler.
   */
  private handlerFor(dataset: Dataset): GisFormatHandler {
    const handler = this.handlers.get(dataset.kind)
    if (handler === undefined) {
      throw new GisError(
        'UNSUPPORTED_FORMAT',
        `no handler is registered for ${dataset.kind} datasets`,
        'install the GDAL provider, or convert the data to a format the pure-JS handler reads',
      )
    }
    return handler
  }
}

/**
 * Resolve the configured cache directory.
 *
 * An empty setting means "wherever this harness keeps disposable data":
 * `<DSH_HOME>/cache/gis`. The default deliberately lives under the harness
 * home and not next to the user's data, because the whole tree is deletable
 * (design 8.3, risk 7).
 * @param configured - the row's `cacheDir`, possibly empty.
 * @returns an absolute path.
 */
function cacheRootOf(configured: string): string {
  const trimmed = configured.trim()
  return trimmed === '' ? dshCachePath('gis') : resolve(expandHomePath(trimmed))
}

/** The one structured 404 of this package. */
function notFound(id: string): GisError {
  return new GisError(
    'DATASET_NOT_FOUND',
    `dataset ${id} is not registered (it may have been moved, edited, or never scanned)`,
    'open the path again to register it, or list what is registered',
  )
}

/** How many times to wait for a domain name a previous incarnation still holds. */
const OPEN_ATTEMPTS = 4

/**
 * Open a domain, waiting out an `already-open` reservation.
 *
 * `DomainFacility` keeps the name reserved until the previous handle's
 * `close()` finishes its teardown, and close is asynchronous. A reload that
 * happens back-to-back with an unload (HMR, a profile restart in one process)
 * therefore races the old teardown; without a retry the loser silently
 * degrades to a memory-only registry, which is the failure mode nobody sees.
 * @param ctx - the context that owns `storageDomain`.
 * @param spec - the domain declaration.
 * @returns the opened domain.
 */
async function openWhenFree<S extends DomainSpec>(ctx: Context, spec: S): Promise<Domain<S>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ctx.storageDomain.open(spec)
    } catch (error) {
      // Matched by code, not by `instanceof DomainError`: the facility that
      // throws it belongs to the host's copy of the storage-domain package, so
      // a class identity check would silently never fire.
      const retryable = (error as { code?: unknown } | null)?.code === 'already-open'
      if (!retryable || attempt >= OPEN_ATTEMPTS) throw error
      await new Promise(resolve => setTimeout(resolve, 50 * attempt))
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The GIS capability facade. */
    gis: GisService
  }
}
