/**
 * GET/HEAD /api/gis/blob?id=<opaque id> -- the byte route the map reads through.
 *
 * Design 3.5 puts every GIS byte route behind `ctx.connection.fetch` (the
 * browser's authentication fence) with an EXACT path and a query parameter, and
 * design 12 forbids the one shape that would turn this into an arbitrary-file
 * read: the route never accepts a path, only an id the registry already knows.
 *
 * Range support is the whole point of the route (design 6.4): geotiff.js and
 * pmtiles drive it with many small ranges, so a COG is read lazily instead of
 * being copied into the browser. What that requires, precisely:
 *
 *   - `Accept-Ranges: bytes` on every 200, so a client knows to ask;
 *   - a single range answered with 206 + `Content-Range`, STREAMED (a 2 GB
 *     raster must never be read into memory to serve 64 KiB of it);
 *   - several ranges answered as `multipart/byteranges`, because clients DO ask
 *     (browsers coalesce, but geotiff.js issues multi-range reads);
 *   - an unsatisfiable range answered with 416 and a `Content-Range` whose
 *     range part is a star, meaning "no satisfiable range";
 *   - a malformed or oversized range set IGNORED, with the whole file served --
 *     which RFC 9110 explicitly allows, and which beats answering with
 *     something the client did not ask for.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

/** One artifact the route can serve. */
export interface BlobTarget {
  /** Absolute path of the file whose bytes are served. */
  readonly path: string
  /** Media type for the whole file. */
  readonly contentType: string
  /**
   * Validator for conditional requests.
   *
   * The dataset id is derived from the source bytes, so it IS an entity tag;
   * passing it through means a re-fetch of unchanged data is a cheap 304.
   */
  readonly etag: string
}

/** Construction options. */
export interface BlobRouteOptions {
  /**
   * Resolve an opaque id into a servable file.
   * @throws GisError `DATASET_NOT_FOUND` when the id is unknown or stale.
   */
  readonly resolve: (id: string) => Promise<BlobTarget>
  /** Range count beyond which the range set is ignored. Defaults to 16. */
  readonly maxRanges?: number
  /** Total bytes beyond which a multi-range answer is ignored. Defaults to 8 MiB. */
  readonly maxMultipartBytes?: number
}

/** A range request, classified. */
export type RangeRequest =
  | { readonly kind: 'none' }
  | { readonly kind: 'unsatisfiable' }
  | { readonly kind: 'ranges'; readonly ranges: readonly ByteRange[] }

/** One closed byte range, inclusive on both ends. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

const DEFAULT_MAX_RANGES = 16
const DEFAULT_MAX_MULTIPART_BYTES = 8 * 1024 * 1024
const IMMUTABLE = 'private, max-age=31536000, immutable'

/**
 * Classify a Range header against a known entity size.
 *
 * A syntactically invalid header is IGNORED (returns `none`), per RFC 9110: a
 * server that cannot understand the request must answer with the whole entity
 * rather than guess. A syntactically valid but unsatisfiable one (every range
 * starts past the end) returns `unsatisfiable`, which the caller answers with
 * 416.
 * @param header - the raw Range header, or null.
 * @param size - entity size in bytes.
 * @param maxRanges - how many ranges are honoured; more means "ignore the header".
 * @returns the classification.
 */
export function parseRangeHeader(header: string | null, size: number, maxRanges: number = DEFAULT_MAX_RANGES): RangeRequest {
  if (header === null) return { kind: 'none' }
  const match = /^bytes=(.*)$/i.exec(header.trim())
  if (match === null) return { kind: 'none' }
  const parts = (match[1] ?? '').split(',').map(part => part.trim())
  if (parts.length === 0 || parts.length > maxRanges) return { kind: 'none' }
  const ranges: ByteRange[] = []
  for (const part of parts) {
    const range = parseOne(part, size)
    // One malformed member poisons the set: RFC 9110 says ignore the header.
    if (range === 'invalid') return { kind: 'none' }
    // Unsatisfiable members are dropped; if every member is, the set is 416.
    if (range !== undefined) ranges.push(range)
  }
  return ranges.length === 0 ? { kind: 'unsatisfiable' } : { kind: 'ranges', ranges }
}

/**
 * Build the request handler.
 * @param options - the id resolver and the range limits.
 * @returns a Fetch handler for the registered route.
 */
export function createBlobHandler(options: BlobRouteOptions) {
  const maxRanges = options.maxRanges ?? DEFAULT_MAX_RANGES
  const maxMultipartBytes = options.maxMultipartBytes ?? DEFAULT_MAX_MULTIPART_BYTES

  return async function handleBlob(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return problem(405, 'METHOD_NOT_ALLOWED', 'this route serves GET and HEAD only')
    }
    const id = new URL(request.url).searchParams.get('id')
    if (id === null || id.trim().length === 0) {
      return problem(400, 'PARSE_FAILED', 'the route needs an "id" query parameter')
    }

    let target: BlobTarget
    try {
      target = await options.resolve(id)
    } catch (error) {
      return refusal(error)
    }

    let info
    try {
      info = await stat(target.path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return problem(404, 'DATASET_NOT_FOUND', 'the bytes behind this id are gone', target.etag)
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return problem(403, 'DATASET_UNREADABLE', 'the bytes behind this id are not readable')
      }
      return problem(500, 'DATASET_UNREADABLE', 'the bytes behind this id could not be read')
    }
    if (!info.isFile()) {
      return problem(404, 'DATASET_NOT_FOUND', 'this dataset is not a single file, so it has no byte route', target.etag)
    }

    const size = info.size
    const headers = new Headers({
      'content-type': target.contentType,
      'accept-ranges': 'bytes',
      'cache-control': IMMUTABLE,
      // A range response is attacker-shaped input to a MIME sniffer; the type
      // we state is the type it must be.
      'x-content-type-options': 'nosniff',
      etag: target.etag,
    })

    const ifNoneMatch = request.headers.get('if-none-match')
    if (ifNoneMatch !== null && matchesEtag(ifNoneMatch, target.etag)) {
      return new Response(null, { status: 304, headers })
    }

    const range = parseRangeHeader(request.headers.get('range'), size, maxRanges)
    if (range.kind === 'unsatisfiable') {
      headers.set('content-range', 'bytes */' + String(size))
      return new Response(null, { status: 416, headers })
    }

    const ranges = range.kind === 'ranges' ? range.ranges : []
    const single = ranges.length === 1 ? ranges[0] : undefined
    if (single !== undefined) {
      headers.set('content-range', 'bytes ' + String(single.start) + '-' + String(single.end) + '/' + String(size))
      headers.set('content-length', String(single.end - single.start + 1))
      if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
      return new Response(streamOf(target.path, single.start, single.end), { status: 206, headers })
    }

    if (ranges.length > 1 && totalBytes(ranges) <= maxMultipartBytes) {
      const boundary = 'gis-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
      headers.set('content-type', 'multipart/byteranges; boundary=' + boundary)
      const body = await multipart(target, ranges, size, boundary)
      headers.set('content-length', String(body.byteLength))
      if (request.method === 'HEAD') return new Response(null, { status: 206, headers })
      return new Response(body, { status: 206, headers })
    }

    // Whole entity: either no Range header, one we chose to ignore (malformed,
    // too many ranges, or a multipart body that would cost more than it is
    // worth), or a HEAD.
    headers.set('content-length', String(size))
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(streamOf(target.path, 0, size - 1), { status: 200, headers })
  }
}

/** Parse one range member; `invalid` poisons the set, undefined means unsatisfiable. */
function parseOne(part: string, size: number): ByteRange | 'invalid' | undefined {
  const match = /^(\d*)-(\d*)$/.exec(part)
  if (match === null) return 'invalid'
  const [, rawStart = '', rawEnd = ''] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'
  if (rawStart === '') {
    // A suffix range: the LAST n bytes.
    const length = Number(rawEnd)
    if (!Number.isSafeInteger(length)) return 'invalid'
    if (length === 0) return undefined
    const start = Math.max(size - length, 0)
    return size === 0 ? undefined : { start, end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isSafeInteger(start)) return 'invalid'
  if (start >= size) return undefined
  if (rawEnd === '') return { start, end: size - 1 }
  const end = Number(rawEnd)
  if (!Number.isSafeInteger(end)) return 'invalid'
  if (end < start) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

/** Whether an If-None-Match header names the given entity tag. */
function matchesEtag(header: string, etag: string): boolean {
  return header.split(',').map(candidate => candidate.trim()).some(candidate => candidate === '*' || candidate === etag)
}

/** Total bytes a range set would return. */
function totalBytes(ranges: readonly ByteRange[]): number {
  let total = 0
  for (const range of ranges) total += range.end - range.start + 1
  return total
}

/** A web stream over one slice of a file. */
function streamOf(path: string, start: number, end: number): ReadableStream {
  return Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
}

/** One multipart/byteranges body, built in memory (the caller bounded its size). */
async function multipart(target: BlobTarget, ranges: readonly ByteRange[], size: number, boundary: string): Promise<Buffer> {
  const parts: Buffer[] = []
  for (const range of ranges) {
    parts.push(Buffer.from(
      '--' + boundary + '\r\n'
      + 'content-type: ' + target.contentType + '\r\n'
      + 'content-range: bytes ' + String(range.start) + '-' + String(range.end) + '/' + String(size) + '\r\n\r\n',
    ))
    parts.push(await readSlice(target.path, range))
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from('--' + boundary + '--\r\n'))
  return Buffer.concat(parts)
}

/** Read one slice into memory. */
async function readSlice(path: string, range: ByteRange): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of createReadStream(path, { start: range.start, end: range.end })) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** A structured refusal: the code is the plugin's own error taxonomy. */
function problem(status: number, code: string, message: string, etag?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  if (etag !== undefined) headers.set('etag', etag)
  return new Response(JSON.stringify({ code, message }), { status, headers })
}

/** Map a resolver failure onto a status, keeping the domain code in the body. */
function refusal(error: unknown): Response {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'DATASET_NOT_FOUND') return problem(404, 'DATASET_NOT_FOUND', message)
  if (code === 'UNSUPPORTED_FORMAT' || code === 'DATASET_UNREADABLE') return problem(415, String(code), message)
  return problem(500, typeof code === 'string' ? code : 'INTERNAL', message)
}
