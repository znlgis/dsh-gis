/**
 * T2.1 browser check: does the real page fetch the map only when it is asked to?
 *
 * The artifact check (`scripts/check-client-bundle.mjs`) proves the chunk graph
 * offline. This drives the REAL page in a REAL browser against a REAL instance,
 * because "first screen" is a network fact, not a file-listing fact:
 *
 *   1. the client half loads and its factory runs (its `<style data-plugin>` tags
 *      appear);
 *   2. the first screen fetches NEITHER the map chunk NOR the MapLibre chunk --
 *      both are behind the development button on the probe card;
 *   3. the page raises no error.
 *
 * Isolation: a second instance on its own port, with the session store, the
 * storage root, and the derived cache all redirected into a temporary
 * directory, so a verification run cannot touch the running GUI's data. The
 * instance is killed as soon as the check ends.
 *
 * Usage: `node scripts/t2-browser-check.mjs` (GIS_T2_KEEP=1 keeps the work dir,
 * GIS_T2_PORT overrides the port, CHROME_PATH overrides the browser).
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_BIN = process.env.DSH_BIN ?? 'D:/self/code/deepseek-harness/apps/cli/lib/bin.js'
const PROFILE = 'gisweb'
const PORT = Number(process.env.GIS_T2_PORT ?? 3099)
const READY_TIMEOUT_MS = 120_000

/** POSIX-style slashes: YAML accepts them on Windows. */
const slashes = path => path.replace(/\\\\/g, '/')

/** The installed Playwright Chromium, whatever revision it is. */
function findChromium() {
  if (process.env.CHROME_PATH !== undefined) return process.env.CHROME_PATH
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  const build = readdirSync(root).find(name => /^chromium-\d+$/.test(name))
  if (build === undefined) throw new Error('no chromium build under ' + root)
  return join(root, build, 'chrome-win64', 'chrome.exe')
}

const failures = []
/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

/**
 * Wait for the instance's own announcement line and return its URL.
 *
 * The page is behind a connection token (`?token=...`): fetching the bare
 * origin gets a refusal, and the token only exists in the line the instance
 * prints, so the URL is read from the log rather than guessed.
 * @param logPath - the instance's captured output.
 * @returns the booted URL, or undefined on timeout.
 */
async function waitForInstance(logPath) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    if (existsSync(logPath)) {
      const announced = /dsh web: (http:\/\/\S+)/.exec(await readFile(logPath, 'utf8'))
      if (announced !== null) return announced[1]
    }
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

const work = await mkdtemp(join(tmpdir(), 'gis-t2-'))
const data = join(work, 'data')
const url = 'http://127.0.0.1:' + String(PORT) + '/'
await mkdir(data, { recursive: true })
await writeFile(join(work, 'patch.yml'), [
  '# Verification overlay: a second instance with all of its state redirected.',
  '- id: storage-json',
  '  config:',
  '    root: ' + slashes(join(work, 'storages')),
  '- id: session-persistence-jsonl',
  '  config:',
  '    root: ' + slashes(join(work, 'sessions')),
  '- id: gis-core',
  '  config:',
  '    cacheDir: ' + slashes(join(work, 'cache')),
  '    cacheQuotaMb: 64',
  '- id: webserver',
  '  config:',
  "    host: '127.0.0.1'",
  '    port: ' + String(PORT),
  '',
].join('\n'))

const log = join(work, 'instance.log')
const output = (await import('node:fs')).createWriteStream(log)
// `--no-open`: the instance prints its URL and would otherwise launch the
// user's default browser at a verification page.
const instance = spawn(process.execPath, [DSH_BIN, '--profile', PROFILE, '--patch', join(work, 'patch.yml'), '--no-open'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
})
instance.stdout.pipe(output)
instance.stderr.pipe(output)

console.log('work directory: ' + work)
console.log('instance: ' + url + '  (profile ' + PROFILE + ')')
console.log('chromium: ' + findChromium())

let browser
try {
  const booted = await waitForInstance(log)
  check(booted !== undefined, 'the verification instance announced its URL', booted ?? 'see ' + log)
  if (booted !== undefined) {
    console.log('page: ' + booted)
    browser = await chromium.launch({ executablePath: findChromium() })
    const page = await browser.newPage()
    const requests = []
    const pageErrors = []
    page.on('request', request => requests.push(request.url()))
    page.on('pageerror', error => pageErrors.push(String(error)))

    // NOT `networkidle`: a DSH page holds an event stream open for its whole
    // life, so "the network went quiet" never happens. Wait for the boot to be
    // done the way the shell itself signals it -- the plugin bundle arriving.
    await page.goto(booted, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const bundleDeadline = Date.now() + 60_000
    while (Date.now() < bundleDeadline) {
      if (requests.some(request => request.includes('dsh-ui-gis/client.js'))) break
      await page.waitForTimeout(250)
    }
    // The factory runs after the fetch; give it a moment to inject its styles.
    await page.waitForTimeout(2000)

    const entryFetched = requests.filter(request => request.includes('dsh-ui-gis/client.js'))
    check(entryFetched.length > 0, 'the page fetched the client bundle', entryFetched.join(', '))

    // POLL, do not sample once: the shell re-fetches plugin bundles when their
    // revision changes, and a reload removes the plugin's style tags before
    // re-adding them. A single sample races that window and reports a false
    // failure (observed: the bundle was fetched at two different revisions
    // during one page load).
    let styleTags = []
    const styleDeadline = Date.now() + 20_000
    for (;;) {
      styleTags = await page.evaluate(() =>
        [...document.querySelectorAll('style[data-plugin]')].map(tag => tag.getAttribute('data-plugin')))
      if (styleTags.includes('@znlgis/dsh-ui-gis')) break
      if (Date.now() > styleDeadline) break
      await page.waitForTimeout(250)
    }
    check(styleTags.includes('@znlgis/dsh-ui-gis'), 'the plugin factory ran (its style tags are in the document)', 'saw ' + String(styleTags.length) + ' plugin style tags')

    const mapRequests = requests.filter(request => /client\.(GisMap|GisRenderCard|maplibre)\.js/.test(request))
    check(mapRequests.length === 0, 'the first screen fetched no map card, no map chunk and no MapLibre chunk', mapRequests.map(url => new globalThis.URL(url).pathname).join(', '))

    check(pageErrors.length === 0, 'the page raised no error', pageErrors.join(' | '))
    console.log('\nrequests mentioning the plugin:\n' + requests.filter(r => r.includes('dsh-ui-gis')).map(r => '  ' + r).join('\n'))

    // ---------------------------------------------------------------------
    // Capability probe: can THIS browser run the library build we ship?
    //
    // Not the plugin chunk (that needs a product surface -- T2.6), but the two
    // things that would silently kill a map later: WebGL availability in the
    // page, and a worker created from a blob: URL under the page's CSP. The
    // library file injected here is the exact 5.x UMD build our chunk inlines.
    // ---------------------------------------------------------------------
    const libraryPath = join(REPO, 'packages', 'ui-gis', 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl.js')
    await page.addScriptTag({ path: libraryPath })
    const probe = await page.evaluate(async () => {
      const maplibregl = globalThis.maplibregl
      if (maplibregl === undefined) return { started: false, reason: 'the library did not attach to the page' }
      const container = document.createElement('div')
      container.style.width = '320px'
      container.style.height = '240px'
      document.body.appendChild(container)
      return await new Promise(resolve => {
        const timer = setTimeout(() => resolve({ started: false, reason: 'the load event never fired' }), 20_000)
        try {
          const map = new maplibregl.Map({ container, style: { version: 8, sources: {}, layers: [] }, attributionControl: false })
          map.on('load', () => {
            clearTimeout(timer)
            const canvas = container.querySelector('canvas')
            resolve({ started: true, canvas: canvas !== null, width: canvas?.width ?? 0, height: canvas?.height ?? 0 })
          })
          map.on('error', (event) => {
            clearTimeout(timer)
            resolve({ started: false, reason: String(event?.error?.message ?? event?.error ?? 'map error') })
          })
        } catch (error) {
          clearTimeout(timer)
          resolve({ started: false, reason: String(error) })
        }
      })
    })
    check(probe.started === true, 'MapLibre initializes in this page (WebGL + inlined blob worker)', probe.reason ?? '')
    if (probe.started === true) check(probe.canvas === true && probe.width > 0, 'the map created a sized canvas', JSON.stringify(probe))
  }
} finally {
  if (browser !== undefined) await browser.close()
  instance.kill()
  output.close()
  await new Promise(resolve => setTimeout(resolve, 500))
  if (failures.length > 0 && existsSync(log)) {
    console.log('\n--- instance log (tail) ---\n' + (await readFile(log, 'utf8')).split('\n').filter(Boolean).slice(-25).join('\n'))
  }
  if (process.env.GIS_T2_KEEP !== '1') await rm(work, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nBROWSER CHECK PASSED' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
