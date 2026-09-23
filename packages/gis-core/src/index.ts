/**
 * `ctx.gis` — the GIS service definition.
 *
 * This package owns the data model, the error taxonomy, and the dataset
 * registry. It deliberately implements NO format: reading is delegated to
 * registered handlers, so the same tools work whether the bytes are parsed by
 * a pure-JS handler or by a GDAL-backed one (design ch.10, capability seams).
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { GisError } from './errors.ts'
import type { Dataset, DatasetKind, InspectResult, QueryRequest, QueryResult } from './types.ts'

export { GisError, isGisError, GIS_ERROR_CODES, type GisErrorCode } from './errors.ts'
export { deriveDatasetId, type DatasetIdentity } from './dataset-id.ts'
export type * from './types.ts'

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
 * A way to turn a caller-supplied path into a registered dataset.
 *
 * Opening is I/O and therefore provider-specific, so gis-core defines only the
 * seam. The pure-JS provider opens files; a GDAL provider may also open
 * containers such as a file geodatabase.
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
   * Inspect the path and return its dataset, already registered.
   * @param path - absolute path the caller named.
   * @returns the registered dataset.
   */
  open(path: string): Promise<Dataset>
}

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
  private readonly handlers = new Map<DatasetKind, GisFormatHandler>()

  private readonly datasets = new Map<string, Dataset>()

  private readonly openers: GisOpener[] = []

  /**
   * @param ctx - owning context; the service is published as `ctx.gis`.
   */
  constructor(ctx: Context) {
    super(ctx, 'gis')
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
   * @param dataset - the dataset to make resolvable.
   */
  registerDataset(dataset: Dataset): void {
    this.datasets.set(dataset.id, dataset)
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
      this.registerDataset(dataset)
      return dataset
    }
    throw new GisError(
      'UNSUPPORTED_FORMAT',
      `no opener handles ${path}`,
      'supported: .geojson, .json, .ndjson, .geojsonl, .shp, .wkt, .csv(wkt)',
    )
  }

  /**
   * Resolve an opaque id.
   * @param id - dataset id as handed to the model or the browser.
   * @returns the dataset.
   * @throws GisError DATASET_NOT_FOUND when the id is unknown or has expired.
   */
  resolve(id: string): Dataset {
    const dataset = this.datasets.get(id)
    if (dataset === undefined) {
      throw new GisError(
        'DATASET_NOT_FOUND',
        `dataset ${id} is not registered (it may have been moved, edited, or never scanned)`,
        're-run the catalog tool to register datasets again',
      )
    }
    return dataset
  }

  /**
   * Every currently registered dataset.
   * @returns a snapshot array.
   */
  list(): readonly Dataset[] {
    return [...this.datasets.values()]
  }

  /**
   * Inspect one dataset through its handler.
   * @param id - dataset id.
   * @param layer - layer name, when chosen.
   * @returns the inspection result.
   */
  inspect(id: string, layer?: string): Promise<InspectResult> {
    const dataset = this.resolve(id)
    return this.handlerFor(dataset).inspect(dataset, layer)
  }

  /**
   * Read one page of features through the dataset's handler.
   * @param id - dataset id.
   * @param request - paging, filter, and geometry encoding.
   * @returns the page.
   */
  query(id: string, request: QueryRequest): Promise<QueryResult> {
    const dataset = this.resolve(id)
    return this.handlerFor(dataset).query(dataset, request)
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The GIS capability facade. */
    gis: GisService
  }
}
