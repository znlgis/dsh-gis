/**
 * Does a COG actually draw in a real browser? (T2.4's direct read)
 *
 * The unit tests prove the projections and the decode against real GDAL bytes,
 * in Node. They cannot prove the part that only exists in a page: that the
 * client bundle's TIFF reader chunks LOAD through the plugin module loader, that
 * geotiff's range requests reach the byte route through the connection fence,
 * and that a raster ends up on the map without a draw failure.
 *
 * Usage: node scripts/t2-cog-browser-check.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dirname, join as joinPath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { bootInstance, prepareWorkdir } from './lib/verify-instance.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_REPO = process.env.DSH_REPO ?? 'D:/self/code/deepseek-harness'
const GDAL_BIN = process.env.GDAL_BIN ?? 'C:\\OSGeo4W\\bin'
const PORT = Number(process.env.GIS_COG_PORT ?? 3089)
const COMPOSER = '[data-composer-input="true"]'
const SEND = 'button[aria-label="发送消息"]'
const failures = []

/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

/** Run one GDAL tool. */
function gdal(program, argv) {
  const result = spawnSync(join(GDAL_BIN, program), argv, {
    encoding: 'utf8',
    env: { ...process.env, PATH: GDAL_BIN + ';' + (process.env.PATH ?? '') },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The installed Chromium. */
function findChromium() {
  if (process.env.CHROME_PATH !== undefined) return process.env.CHROME_PATH
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  const build = readdirSync(root).find(name => /^chromium-\d+$/.test(name))
  if (build === undefined) throw new Error('no chromium build under ' + root)
  return join(root, build, 'chrome-win64', 'chrome.exe')
}

const { work, patch } = await prepareWorkdir({
  prefix: 'gis-cog-browser-',
  port: PORT,
  extraPatch: ['- id: session-title-llm', '  disabled: true', ''],
})

// A real, small, GEOGRAPHIC COG: 256x128 over a known extent.
const plain = join(work, 'data', 'sample.tif')
const cog = join(work, 'data', 'sample-cog.tif')
const created = gdal('gdal_create.exe', [
  '-of', 'GTiff', '-outsize', '256', '128', '-bands', '1', '-ot', 'Byte', '-burn', '200',
  '-a_srs', 'EPSG:4326', '-a_ullr', '100', '40', '110', '30', plain,
])
if (created.status !== 0) throw new Error('gdal_create failed: ' + created.stderr)
const converted = gdal('gdal_translate.exe', ['-of', 'COG', plain, cog])
if (converted.status !== 0) throw new Error('gdal_translate failed: ' + converted.stderr)
console.log('fixture COG: ' + cog)

const { startMockLlmServer } = await import(pathToFileURL(join(DSH_REPO, 'packages', 'test-support', 'llm-mock-server', 'lib', 'index.js')).href)
const model = await startMockLlmServer({
  host: '127.0.0.1', port: 0, apiKey: 'mock-key',
  sequence: ['tool_call_success', 'success'],
  successText: 'drawn.',
  toolName: 'gis_render',
  toolArguments: JSON.stringify({ path: cog }),
})

const instance = await bootInstance({
  work, patch, timeoutMs: 120_000,
  env: { DEEPSEEK_BASE_URL: model.baseURL + '/v1', DEEPSEEK_API_KEY: 'mock-key' },
})
let browser
try {
  check(instance.url !== undefined, 'the instance announced its URL', instance.url ?? ('see ' + instance.log))
  browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage()
  const pageErrors = []
  const ranged = []
  // The decode must happen OFF the main thread. A worker is the evidence: the
  // capped read of a big COG measured seconds, and a page that blocks that long
  // is the failure this check now guards against.
  const workers = []
  page.on('worker', (worker) => { workers.push(worker.url().slice(0, 40)) })
  page.on('pageerror', error => pageErrors.push(String(error)))
  const fetched = []
  page.on('request', (request) => {
    fetched.push(request.url())
    if (!/\/api\/gis\/blob\?id=/.test(request.url())) return
    const range = request.headers()['range']
    if (range !== undefined) ranged.push(range)
  })

  await page.goto(instance.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForSelector(COMPOSER, { timeout: 60_000 })
  await page.waitForTimeout(1500)
  await page.click(COMPOSER)
  await page.keyboard.type('draw the raster')
  await page.click(SEND)

  const settled = '[data-gis-render-card="ready"], [data-gis-render-card="failed"], [data-gis-render-card="data-unavailable"]'
  await page.waitForSelector(settled, { state: 'attached', timeout: 120_000 })
  await page.locator('[data-tool="gis_render"]').first().click({ timeout: 10_000 }).catch(() => {})
  const ready = await page.waitForSelector('[data-gis-map="ready"]', { state: 'attached', timeout: 60_000 }).then(() => true, () => false)
  check(ready, 'the card reached ready with a raster layer')

  // The decisive assertion: NO draw failure. A chunk that did not load, or a
  // decode that threw, lands here as LAYER_DRAW_FAILED.
  const issues = await page.locator('[data-gis-render-issues] li').allTextContents()
  check(issues.length === 0, 'the raster drew with no reported issue', issues.join(' | '))

  // Range reads prove the browser really ranged-read the COG through the route.
  await page.waitForTimeout(1500)
  // ONE block is enough for a small COG: geotiff reads the header window and
  // finds every IFD inside it. The property that matters is that the read went
  // through the range protocol at all -- a whole-file GET carries no Range header.
  check(ranged.length >= 1, 'the browser ranged-read the COG through the byte route', String(ranged.length) + ': ' + ranged.slice(0, 5).join(', '))
  check(ranged.some(range => !/^bytes=0-$/.test(range)), 'the reads asked for windows, not the whole file', ranged.join(' '))
  check(pageErrors.length === 0, 'the page raised no error', pageErrors.join(' | '))

  const canvas = await page.locator('[data-gis-map-canvas] canvas').count()
  check(canvas > 0, 'MapLibre created a canvas for the raster', String(canvas))
  check(workers.length > 0, 'the raster was decoded in a worker, not on the main thread', String(workers.length) + ' worker(s)')

  if (failures.length > 0) {
    const states = await page.locator('[data-gis-render-card]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-gis-render-card')))
    const html = await page.locator('[data-gis-render-card]').first().evaluate(node => node.outerHTML).catch(() => 'none')
    const rows = await page.locator('[data-tool="gis_render"]').evaluateAll(nodes => nodes.map(node => node.textContent?.slice(0, 300)))
    const issueTexts = await page.locator('[data-gis-render-issues] li').allTextContents()
    console.log('--- card states --- ' + JSON.stringify(states))
    console.log('--- ISSUES --- ' + JSON.stringify(issueTexts))
    console.log('--- card html --- ' + String(html).slice(0, 700))
    console.log('--- tool rows --- ' + JSON.stringify(rows))
    const followUp = JSON.stringify(model.requests[1]?.body ?? {})
    const at = followUp.indexOf('gis_render')
    console.log('--- what the tool answered --- ' + followUp.slice(Math.max(0, at - 80), at + 900))
    const chunks = fetched.filter(url => /client\.[A-Za-z0-9._-]+\.js/.test(url)).map(url => url.replace(/.*\//, '').replace(/\?.*/, ''))
    console.log('--- chunks fetched (order) --- ' + chunks.join(', '))
    console.log('--- instance log (tail) --- ' + await instance.tail(20))
  }
} catch (error) {
  failures.push('the run threw: ' + String(error).split('\n')[0])
  console.log('  FAIL  the run threw -- ' + String(error).split('\n')[0])
  if (browser !== undefined) {
    const page = browser.contexts()[0]?.pages()[0]
    if (page !== undefined) {
      console.log('--- page text (tail) ---\n' + (await page.innerText('body').catch(() => '')).slice(-600))
      console.log('--- card states ---\n' + String(await page.locator('[data-gis-render-card]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-gis-render-card'))).catch(() => 'none')))
      console.log('--- issues ---\n' + String(await page.locator('[data-gis-render-issues]').allTextContents().catch(() => [])))
      console.log('--- instance log (tail) ---\n' + await instance.tail(25))
    }
  }
} finally {
  if (browser !== undefined) await browser.close()
  await instance.stop()
  await model.close()
  if (process.env.GIS_COG_KEEP !== '1') {
    const { rm } = await import('node:fs/promises')
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

console.log(failures.length === 0 ? '\nCOG BROWSER CHECK PASSED' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
