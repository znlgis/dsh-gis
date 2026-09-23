/**
 * T2.3 real-instance check: does /api/gis/blob serve bytes the way a range
 * client needs, behind the authentication fence?
 *
 * The unit tests own the byte-level contract (statuses, headers, slices). What
 * they cannot show is the wiring: a route registered through
 * `ctx.connection.fetch` must actually be reachable in a live profile, must
 * carry the fence's trust policy, and must resolve an id through the real
 * registry (T1a.2) into real file bytes.
 *
 * So: boot a real instance with an isolated work directory, let a probe plugin
 * register a fixture through `ctx.gis`, then drive the route FROM THE PAGE --
 * same origin, same credentials a map card would have.
 *
 * Usage: `node scripts/t2-blob-route-check.mjs` (GIS_T2B_KEEP=1 keeps the work
 * directory, GIS_T2B_PORT overrides the port).
 */
import { copyFile, readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { bootInstance, prepareWorkdir, slashes } from './lib/verify-instance.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.GIS_T2B_PORT ?? 3098)
const failures = []

/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

/** The installed Playwright Chromium, whatever revision it is. */
function findChromium() {
  if (process.env.CHROME_PATH !== undefined) return process.env.CHROME_PATH
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  const build = readdirSync(root).find(name => /^chromium-\d+$/.test(name))
  if (build === undefined) throw new Error('no chromium build under ' + root)
  return join(root, build, 'chrome-win64', 'chrome.exe')
}

const { work, patch } = await prepareWorkdir({
  prefix: 'gis-t2b-',
  port: PORT,
  extraPatch: [
    '- insert:',
    '    - id: gis-t2b-probe',
    "      name: '" + slashes(join(REPO, 'scripts', 't2b-probe.mjs')) + "'",
  ],
})
const fixture = join(work, 'data', 'points.geojson')
await copyFile(join(REPO, 'tests', 'fixtures', 'points.geojson'), fixture)
const report = join(work, 'probe.jsonl')

console.log('work directory: ' + work)
const instance = await bootInstance({
  work,
  patch,
  env: { GIS_T2B_OUT: report, GIS_T2B_FIXTURE: fixture },
})
let browser
try {
  check(instance.url !== undefined, 'the instance announced its URL', instance.url ?? 'see ' + instance.log)

  // Wait for the probe to register the fixture.
  const deadline = Date.now() + 60_000
  let registered
  for (;;) {
    if (existsSync(report)) {
      const lines = (await readFile(report, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      registered = lines.find(line => line.id !== undefined)
      if (registered !== undefined) break
    }
    if (Date.now() > deadline) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  check(registered !== undefined, 'a dataset was registered through the real ctx.gis', JSON.stringify(registered ?? {}))
  const expected = await readFile(fixture, 'utf8')

  if (instance.url !== undefined && registered !== undefined) {
    browser = await chromium.launch({ executablePath: findChromium() })
    const page = await browser.newPage()
    await page.goto(instance.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(3000)

    const result = await page.evaluate(async ({ id, size }) => {
      const base = '/api/gis/blob?id=' + encodeURIComponent(id)
      const whole = await fetch(base)
      const wholeText = await whole.text()
      const ranged = await fetch(base, { headers: { range: 'bytes=0-9' } })
      const rangedText = await ranged.text()
      const multi = await fetch(base, { headers: { range: 'bytes=0-1,8-9' } })
      const multiText = await multi.text()
      const missing = await fetch('/api/gis/blob?id=ds_0000000000000000')
      const missingBody = await missing.text()
      const head = await fetch(base, { method: 'HEAD' })
      return {
        size,
        whole: { status: whole.status, accepts: whole.headers.get('accept-ranges'), type: whole.headers.get('content-type'), length: whole.headers.get('content-length'), first: wholeText.slice(0, 20), bytes: wholeText.length },
        ranged: { status: ranged.status, contentRange: ranged.headers.get('content-range'), bytes: rangedText.length, text: rangedText.slice(0, 20) },
        multi: { status: multi.status, type: multi.headers.get('content-type'), hasTwoParts: multiText.includes('content-range: bytes 0-1/') && multiText.includes('content-range: bytes 8-9/') },
        missing: { status: missing.status, body: missingBody.slice(0, 120) },
        head: { status: head.status, length: head.headers.get('content-length') },
      }
    }, { id: registered.id, size: registered.size })

    check(result.whole.status === 200, 'the page fetched the whole entity', JSON.stringify(result.whole))
    check(result.whole.accepts === 'bytes', 'the whole-entity answer advertises range support')
    check(Number(result.whole.length) === result.size, 'the whole entity has the file\'s length', String(result.size))
    check(result.whole.first === expected.slice(0, 20), 'the bytes are the file\'s bytes', JSON.stringify(result.whole.first))
    check(result.ranged.status === 206, 'a single range answers 206', JSON.stringify(result.ranged))
    check((result.ranged.contentRange ?? '').startsWith('bytes 0-9/'), 'the single range reports its content range', String(result.ranged.contentRange))
    check(result.ranged.bytes === 10 && result.ranged.text === expected.slice(0, 10), 'the single range returns exactly that slice')
    check(result.multi.status === 206 && result.multi.hasTwoParts, 'several ranges answer multipart/byteranges', JSON.stringify(result.multi))
    check(result.head.status === 200 && Number(result.head.length) === result.size, 'HEAD answers headers only', JSON.stringify(result.head))
    check(result.missing.status === 404 && result.missing.body.includes('DATASET_NOT_FOUND'), 'an unknown id answers a structured 404', JSON.stringify(result.missing))

    // Outside the page there is no trust: the route lives inside Connection's
    // authentication fence, so a bare fetch must not be served.
    let bare
    try {
      const response = await fetch(new globalThis.URL('/api/gis/blob?id=' + registered.id, instance.url))
      bare = { status: response.status, type: response.headers.get('content-type') }
    } catch (error) {
      bare = { status: 0, error: String(error) }
    }
    check(bare.status !== 200, 'a request from outside the fence is refused', JSON.stringify(bare))
  }
} finally {
  if (browser !== undefined) await browser.close()
  await instance.stop()
  if (failures.length > 0) console.log('\n--- instance log (tail) ---\n' + await instance.tail())
  if (process.env.GIS_T2B_KEEP !== '1') {
    const { rm } = await import('node:fs/promises')
    await rm(work, { recursive: true, force: true })
  }
}

console.log(failures.length === 0 ? '\nBLOB ROUTE CHECK PASSED' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
