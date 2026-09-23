/**
 * T2.3: the byte route.
 *
 * The route is driven directly -- a real temp file behind it, a fake id resolver
 * in front of it -- because everything that can be wrong here is a BYTE-level
 * contract: which status, which headers, which slice, and whether an id can ever
 * turn into a path. A live HTTP hop would only add latency to the same
 * assertions (the fence and the real registry are checked against a live
 * instance by scripts/t2-blob-route-check.mjs).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../src/index.ts'
import { createBlobHandler, parseRangeHeader, type BlobTarget } from '../src/server/blob.ts'

const BODY = 'abcdefghij'
const roots: string[] = []

/** A temp directory removed after the test. */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gis-blob-'))
  roots.push(root)
  return root
}

/** Write a file and return the target the resolver would hand back. */
async function fixture(contents = BODY): Promise<BlobTarget> {
  const root = await temporaryRoot()
  const path = join(root, 'points.geojson')
  await writeFile(path, contents)
  return { path, contentType: 'application/geo+json', etag: '"ds_test"' }
}

/** The ids the resolver was asked about, in order. */
interface Seen { ids: string[]; target: BlobTarget; failure?: unknown }

/**
 * A handler whose resolver knows exactly one id -- the realistic shape, since a
 * permissive resolver would hide the id boundary this suite exists to check.
 * @param fixture - the single servable target, or the literal 'directory'.
 * @param knownId - the one id the resolver answers to.
 * @returns the handler and the ids it was asked about.
 */
function handlerFor(fixture: BlobTarget | 'directory', knownId = 'ds_test'): { handle: (request: Request) => Promise<Response>; seen: Seen } {
  const seen: Seen = { ids: [], target: fixture === 'directory' ? undefined as unknown as BlobTarget : fixture }
  const handle = createBlobHandler({
    resolve: async (id: string) => {
      seen.ids.push(id)
      if (id !== knownId) {
        throw Object.assign(new Error('dataset ' + id + ' is not registered'), { code: 'DATASET_NOT_FOUND' })
      }
      if (fixture === 'directory') {
        const root = await temporaryRoot()
        const directory = join(root, 'nested')
        await mkdir(directory)
        return { path: directory, contentType: 'application/octet-stream', etag: '"ds_dir"' }
      }
      return fixture
    },
  })
  return { handle, seen }
}

/** One request against a handler. */
const request = (handle: (request: Request) => Promise<Response>, search: string, headers: Record<string, string> = {}, method = 'GET') =>
  handle(new Request('http://localhost/api/gis/blob' + search, { method, headers }))

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('serving the whole entity', () => {
  it('answers 200 with the headers a range client needs', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    const response = await request(handle, '?id=ds_test')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/geo+json')
    expect(response.headers.get('content-length')).toBe(String(BODY.length))
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('etag')).toBe('"ds_test"')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe(BODY)
  })

  it('answers HEAD with the same headers and no body', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    const response = await request(handle, '?id=ds_test', {}, 'HEAD')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(BODY.length))
    expect(await response.text()).toBe('')
  })

  it('answers 304 when the entity tag still matches', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    const unchanged = await request(handle, '?id=ds_test', { 'if-none-match': '"ds_test"' })
    expect(unchanged.status).toBe(304)
    expect(await unchanged.text()).toBe('')

    const stale = await request(handle, '?id=ds_test', { 'if-none-match': '"ds_other"' })
    expect(stale.status).toBe(200)
  })
})

describe('serving ranges', () => {
  it('answers a single range with 206 and the exact slice', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    const response = await request(handle, '?id=ds_test', { range: 'bytes=0-3' })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-3/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(await response.text()).toBe('abcd')
  })

  it('answers an open-ended range and a suffix range', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    const openEnded = await request(handle, '?id=ds_test', { range: 'bytes=5-' })
    expect(openEnded.status).toBe(206)
    expect(await openEnded.text()).toBe('fghij')

    const suffix = await request(handle, '?id=ds_test', { range: 'bytes=-4' })
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 6-9/10')
    expect(await suffix.text()).toBe('ghij')
  })

  it('clamps a range that runs past the end', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    const response = await request(handle, '?id=ds_test', { range: 'bytes=8-99' })
    expect(response.headers.get('content-range')).toBe('bytes 8-9/10')
    expect(await response.text()).toBe('ij')
  })

  it('answers several ranges as multipart/byteranges', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    const response = await request(handle, '?id=ds_test', { range: 'bytes=0-1,8-9' })

    expect(response.status).toBe(206)
    const contentType = response.headers.get('content-type') ?? ''
    expect(contentType.startsWith('multipart/byteranges; boundary=')).toBe(true)
    const boundary = contentType.slice('multipart/byteranges; boundary='.length)
    const body = await response.text()

    expect(body).toContain('--' + boundary + '\r\n')
    expect(body).toContain('content-range: bytes 0-1/10')
    expect(body).toContain('content-range: bytes 8-9/10')
    expect(body).toContain('content-type: application/geo+json')
    expect(body.endsWith('--' + boundary + '--\r\n')).toBe(true)
    // The parts carry the requested bytes, in order.
    expect(body.indexOf('ab')).toBeGreaterThan(-1)
    expect(body.indexOf('ij')).toBeGreaterThan(body.indexOf('ab'))
    expect(Number(response.headers.get('content-length'))).toBe(Buffer.byteLength(body))
  })

  it('answers 416 when no range can be satisfied', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    const response = await request(handle, '?id=ds_test', { range: 'bytes=20-25' })

    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
  })

  it('serves the satisfiable members and drops the rest', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    const response = await request(handle, '?id=ds_test', { range: 'bytes=0-1,20-25' })
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('ab')
  })

  it('ignores a range set it cannot trust, and serves the whole entity', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    for (const [range, label] of [
      ['bytes=abc', 'not a range'],
      ['bytes=5-2', 'reversed'],
      ['items=0-2', 'not bytes'],
      ['bytes=0-1,' + Array.from({ length: 20 }, (_, i) => String(i) + '-' + String(i)).join(','), 'too many members'],
    ] as const) {
      const response = await request(handle, '?id=ds_test', { range })
      expect(response.status, label).toBe(200)
      expect(await response.text(), label).toBe(BODY)
    }
  })

  it('refuses to build an expensive multipart body', async () => {
    const target = await fixture()
    const handle = createBlobHandler({ resolve: async () => target, maxMultipartBytes: 2 })
    const response = await request(handle, '?id=ds_test', { range: 'bytes=0-1,2-3' })
    // Ignoring the header is allowed; answering with a body the client cannot
    // afford to receive is not.
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(BODY)
  })
})

describe('the id boundary', () => {
  it('needs an id at all', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    const response = await request(handle, '')
    expect(response.status).toBe(400)
    expect((await response.json() as { code: string }).code).toBe('PARSE_FAILED')
  })

  it('answers an unknown id with a structured 404', async () => {
    const target = await fixture()
    const { handle } = handlerFor(target)
    const failure = Object.assign(new Error('dataset ds_missing is not registered'), { code: 'DATASET_NOT_FOUND' })
    const handleWith = createBlobHandler({ resolve: async () => { throw failure } })
    const response = await request(handleWith, '?id=ds_missing')

    expect(response.status).toBe(404)
    const body = await response.json() as { code: string; message: string }
    expect(body.code).toBe('DATASET_NOT_FOUND')
    expect(body.message).toContain('ds_missing')
  })

  it('never treats an id as a path', async () => {
    const target = await fixture()
    const { handle, seen } = handlerFor(target)
    const hostile = '..%2F..%2Fetc%2Fpasswd'
    const response = await request(handle, '?id=' + hostile)

    // The resolver is handed the ID verbatim and decides; the route itself has
    // no path plumbing to exploit (design ch.12).
    expect(seen.ids).toEqual(['../../etc/passwd'])
    expect(response.status).toBe(404)
  })

  it('answers 404 when the id names something that is not a single file', async () => {
    const { handle } = handlerFor('directory')
    const response = await request(handle, '?id=ds_dir')
    expect(response.status).toBe(404)
    expect((await response.json() as { code: string }).code).toBe('DATASET_NOT_FOUND')
  })

  it('answers 404 when the bytes vanished behind a resolvable id', async () => {
    const target = await fixture()
    await rm(target.path, { force: true })
    const { handle } = handlerFor(target)
    const response = await request(handle, '?id=ds_test')
    expect(response.status).toBe(404)
  })

  it('keeps the domain error code in the body for other refusals', async () => {
    const unreadable = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const unsupported = Object.assign(new Error('no handler'), { code: 'UNSUPPORTED_FORMAT' })
    const noPath = await request(createBlobHandler({ resolve: async () => { throw unsupported } }), '?id=ds_x')
    expect(noPath.status).toBe(415)
    expect((await noPath.json() as { code: string }).code).toBe('UNSUPPORTED_FORMAT')

    const denied = await request(createBlobHandler({
      resolve: async () => ({ path: join(tmpdir(), 'definitely-missing'), contentType: 'text/plain', etag: '"x"' }),
    }), '?id=ds_x')
    expect(denied.status).toBe(404)
    expect(unreadable.code).toBe('EACCES')
  })
})

describe('registration', () => {
  it('registers the exact route inside the fence, and gives it back on dispose', async () => {
    const target = await fixture()
    const registered: { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }[] = []
    let released = false
    const ctx = new Context()
    ctx.provide('connection', {
      fetch: {
        register: (route: { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }) => {
          registered.push(route)
          return async () => { released = true }
        },
      },
    } as unknown as Context['connection'])
    ctx.provide('gis', {
      resolveFresh: async (id: string) => {
        if (id !== 'ds_test') throw Object.assign(new Error('unknown'), { code: 'DATASET_NOT_FOUND' })
        return { id, kind: 'geojson', title: 'points.geojson', path: target.path, layers: [{ name: 'points' }] }
      },
    } as unknown as Context['gis'])

    const fiber = await ctx.plugin({ name, inject, apply })
    expect(registered.map(route => [route.path, [...route.methods]])).toEqual([['/api/gis/blob', ['GET', 'HEAD']]])

    // The registered handler really serves the dataset it resolved.
    const request = () => registered[0]!.fetch(new Request('http://localhost/api/gis/blob?id=ds_test'))
    const served = await request()
    expect(served.status).toBe(200)
    expect(await served.text()).toBe(BODY)

    // The route is an effect of this plugin: unloading it hands the exact path
    // back (a reload would otherwise collide with its own predecessor, contract
    // #18), and the handler left behind can no longer reach a service.
    await fiber.dispose()
    expect(released).toBe(true)
    const orphaned = await request()
    expect(orphaned.status).not.toBe(200)
  })
})

describe('range parsing on its own', () => {
  it('classifies headers without touching a file', () => {
    expect(parseRangeHeader(null, 10)).toEqual({ kind: 'none' })
    expect(parseRangeHeader('bytes=0-0', 10)).toEqual({ kind: 'ranges', ranges: [{ start: 0, end: 0 }] })
    expect(parseRangeHeader('bytes=0-0,2-2', 10)).toEqual({ kind: 'ranges', ranges: [{ start: 0, end: 0 }, { start: 2, end: 2 }] })
    expect(parseRangeHeader('bytes=10-', 10)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRangeHeader('bytes=-0', 10)).toEqual({ kind: 'unsatisfiable' })
    // More members than the route honours: ignore the header, serve the entity.
    expect(parseRangeHeader('bytes=0-1,2-3', 10, 1)).toEqual({ kind: 'none' })
    expect(parseRangeHeader('bytes=', 10)).toEqual({ kind: 'none' })
  })
})
