/**
 * Decoding a raster OFF the main thread (design 6.4 L1).
 *
 * WHY, with numbers rather than principle: the capped read (2048 px on the long
 * edge) of a realistic 8000x8000 COG measured **5259 ms**, and a plain GeoTIFF
 * with no overviews 2723 ms -- seconds of a frozen tab for a file a user merely
 * clicked. The fix is not a smaller cap (the picture would go to mush) but moving
 * the work to a worker.
 *
 * WHY THE LIBRARY IS INLINED AS TEXT: a plugin chunk is served to the PAGE by the
 * module loader, and a worker has no \`window.__ModuleLoader__\` to register with
 * -- so a worker cannot import the chunk that holds the TIFF reader. The reader
 * therefore travels as text inside our chunk and is instantiated from a Blob URL,
 * which is exactly how MapLibre ships its own worker (runtime contract #22; the
 * earlier probe confirmed an inlined blob worker runs in this page).
 *
 * WHAT CROSSES THE BOUNDARY IS RAW SAMPLES. The RGBA expansion stays on the main
 * thread, which is what keeps this worker free of any import from our module
 * graph: an import of the shared pixel module made this chunk and the COG chunk
 * require each other, and the loader cannot resolve a chunk require at all
 * (contracts #31/#39).
 *
 * The worker is a CLASSIC worker: the reader is a UMD bundle, and a classic
 * worker is where its wrapper attaches itself to \`self\`.
 */
import geotiffSource from 'geotiff?raw'
import bodySource from './decode-worker-body.js?raw'
import { GisClientError } from './client-error.ts'

/** What the worker sends back: samples plus everything the caller needs to expand them. */
export interface WorkerRaster {
  readonly width: number
  readonly height: number
  /** Samples per pixel, as the file declares them. */
  readonly bands: number
  readonly bitsPerSample: number
  /** The file's declared nodata value, when it has one (null means the file declares none). */
  readonly noData?: number | null | undefined
  /** \`[west, south, east, north]\` from the file's own georeferencing. */
  readonly bbox: [number, number, number, number]
  /** Interleaved sample values. */
  readonly values: ArrayLike<number>
}

/** One job's reply, as the worker posts it. */
type WorkerReply =
  | {
    readonly id: number
    readonly ok: true
    readonly width: number
    readonly height: number
    readonly bands: number
    readonly bitsPerSample: number
    readonly noData?: number | null
    readonly bbox: [number, number, number, number]
    readonly values: ArrayBuffer
    readonly valueType: string
  }
  | { readonly id: number; readonly ok: false; readonly message: string; readonly code: string }

/** Whether this page can run the worker at all. */
export function workerAvailable(): boolean {
  return typeof Worker === 'function' && typeof Blob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
}

let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, { resolve: (value: WorkerRaster) => void; reject: (error: unknown) => void }>()

/**
 * The worker's source: the reader, then the handler.
 *
 * Nothing of ours is concatenated in: see the note at the top about why the
 * pixel arithmetic must NOT be shared with the worker.
 * @returns the worker source text.
 */
export function workerSource(): string {
  return String(geotiffSource) + '\n' + String(bodySource)
}

/** Wrap the transferred buffer back into the typed array the file used. */
function typedValues(type: string, buffer: ArrayBuffer): ArrayLike<number> {
  if (type === 'Uint16Array') return new Uint16Array(buffer)
  if (type === 'Int16Array') return new Int16Array(buffer)
  if (type === 'Uint32Array') return new Uint32Array(buffer)
  if (type === 'Int32Array') return new Int32Array(buffer)
  if (type === 'Float32Array') return new Float32Array(buffer)
  if (type === 'Float64Array') return new Float64Array(buffer)
  if (type === 'Int8Array') return new Int8Array(buffer)
  return new Uint8Array(buffer)
}

/**
 * Make a byte-route URL absolute against the page.
 * @param source - the URL as the render value carries it.
 * @returns an absolute URL the worker can fetch.
 */
function absoluteUrl(source: string): string {
  const base = typeof document === 'undefined' ? undefined : document.baseURI
  if (base === undefined) return source
  try {
    return new URL(source, base).href
  } catch {
    return source
  }
}

/** Start (or reuse) the decode worker. */
function ensureWorker(): Worker {
  if (worker !== undefined) return worker
  const url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }))
  const started = new Worker(url)
  URL.revokeObjectURL(url)
  started.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data
    const waiter = pending.get(reply.id)
    if (waiter === undefined) return
    pending.delete(reply.id)
    if (reply.ok) {
      waiter.resolve({
        width: reply.width,
        height: reply.height,
        bands: reply.bands,
        bitsPerSample: reply.bitsPerSample,
        ...reply.noData === undefined ? {} : { noData: reply.noData },
        bbox: reply.bbox,
        values: typedValues(reply.valueType, reply.values),
      })
    } else {
      waiter.reject(new GisClientError(reply.code, reply.message))
    }
  }
  started.onerror = (event) => {
    const message = String((event as ErrorEvent).message ?? 'unknown error')
    for (const [, waiter] of pending) waiter.reject(new GisClientError('RASTER_UNSUPPORTED', 'the decode worker failed: ' + message))
    pending.clear()
    worker = undefined
  }
  worker = started
  return started
}

/**
 * Decode a raster in the worker.
 *
 * Accepts a URL (the reader ranges against it) or BYTES (a preview hands over
 * what it already has). Bytes are TRANSFERRED, not copied: a 48 MB raster would
 * otherwise be duplicated into the worker's heap before decoding.
 * @param source - the byte route URL, or the file's bytes.
 * @param maxSize - the longest edge to decode.
 * @returns the samples and their shape.
 * @throws GisClientError \`WORKER_UNAVAILABLE\` when the page cannot start one.
 */
export function decodeInWorker(source: string | ArrayBuffer, maxSize: number): Promise<WorkerRaster> {
  if (!workerAvailable()) {
    return Promise.reject(new GisClientError('WORKER_UNAVAILABLE', 'this page cannot start a decode worker'))
  }
  const live = ensureWorker()
  const id = nextId
  nextId += 1
  return new Promise<WorkerRaster>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    // ABSOLUTE, resolved here: inside a blob worker `self.location` is the blob
    // URL, so a relative fetch would resolve to `blob:http://host/api/...` and
    // fail as a network error. The main thread still knows the page's base.
    if (typeof source === 'string') live.postMessage({ id, url: absoluteUrl(source), maxSize })
    else live.postMessage({ id, buffer: source, maxSize }, [source])
  })
}

/** Release the worker, if one was started. */
export function stopDecodeWorker(): void {
  worker?.terminate()
  worker = undefined
  pending.clear()
}
