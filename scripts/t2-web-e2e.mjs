/**
 * T2.10 browser e2e: a real turn, a real tool call, a real replay.
 *
 * Everything else in this repository tests the card's parts. This drives the
 * whole chain in a real browser against a real instance:
 *
 *   mock model -> gis_render (the real tool, real rasterizer) -> tool result
 *   with presentationMeta -> the session log -> the card -> MapLibre -> the
 *   byte route (T2.3) -> a canvas with data on it.
 *
 * NO CREDENTIALS ARE NEEDED: the model is @deepseek-ai/dsh-llm-mock-server,
 * scripted to answer with one tool call and then a completion. That is the
 * discovery that unblocked this check (see docs/T2.7-执行记录.md).
 *
 * The three assertions a unit test cannot make:
 *   1. the card renders, and the lazy chunks arrive ONLY because it did;
 *   2. reloading the page replays the same card from the log alone;
 *   3. when the bytes behind the logged id are gone, the card says so.
 *
 * Usage: node scripts/t2-web-e2e.mjs   (GIS_T2E_KEEP=1 keeps the work directory)
 */
import { readdirSync, existsSync } from 'node:fs'
import { appendFile, copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { bootInstance, prepareWorkdir } from './lib/verify-instance.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_REPO = process.env.DSH_REPO ?? 'D:/self/code/deepseek-harness'
const PORT = Number(process.env.GIS_T2E_PORT ?? 3095)
const COMPOSER = '[data-composer-input="true"]'
const SEND = 'button[aria-label="发送消息"]'
const failures = []

/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

/** The installed Playwright Chromium. */
function findChromium() {
  if (process.env.CHROME_PATH !== undefined) return process.env.CHROME_PATH
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  const build = readdirSync(root).find(name => /^chromium-\d+$/.test(name))
  if (build === undefined) throw new Error('no chromium build under ' + root)
  return join(root, build, 'chrome-win64', 'chrome.exe')
}

const { work, patch } = await prepareWorkdir({
  prefix: 'gis-t2e-',
  port: PORT,
  extraPatch: [
    // The title generator asks the model for a name BEFORE the first turn, which
    // would consume the mock's first scripted behaviour and make the turn count
    // depend on whether naming happened to run first. Disabled for determinism.
    '- id: session-title-llm',
    '  disabled: true',
  ],
})
const fixture = join(work, 'data', 'points.geojson')
await copyFile(join(REPO, 'tests', 'fixtures', 'points.geojson'), fixture)

// The mock model: one tool call, then a completion, twice (the second turn
// exercises the failure path after the fixture is deleted).
const { startMockLlmServer } = await import(pathToFileURL(join(DSH_REPO, 'packages', 'test-support', 'llm-mock-server', 'lib', 'index.js')).href)
const model = await startMockLlmServer({
  host: '127.0.0.1',
  port: 0,
  apiKey: 'mock-key',
  sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
  successText: 'rendered.',
  toolName: 'gis_render',
  toolArguments: JSON.stringify({ path: fixture, width: 640, height: 480 }),
})
console.log('work directory: ' + work)
console.log('mock model: ' + model.baseURL)

const instance = await bootInstance({
  work,
  patch,
  timeoutMs: 120_000,
  env: {
    DEEPSEEK_BASE_URL: model.baseURL + '/v1',
    DEEPSEEK_API_KEY: 'mock-key',
  },
})
let browser
const console_ = []
try {
  check(instance.url !== undefined, 'the instance announced its URL', instance.url ?? 'see ' + instance.log)
  if (instance.url !== undefined) {
    browser = await chromium.launch({ executablePath: findChromium() })
    const page = await browser.newPage()
    const requests = []
    const pageErrors = []
    page.on('request', request => requests.push(request.url()))
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => console_.push(message.type() + ': ' + message.text().slice(0, 160)))

    await page.goto(instance.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForSelector(COMPOSER, { timeout: 60_000 })
    await page.waitForTimeout(2000)

    const beforeTurn = requests.filter(url => /GisRenderCard|maplibre/.test(url)).length
    check(beforeTurn === 0, 'no card and no MapLibre chunk before any render exists', String(beforeTurn))

    // ONE REAL TURN: the prompt goes through the mock model, which answers with
    // a gis_render call; the real tool renders the fixture.
    await page.click(COMPOSER)
    await page.keyboard.type('render the fixture')
    await page.click(SEND)

    // The card appears as soon as the CALL is logged, then settles when the
    // result lands. Wait for a settled state, and expand the row: a collapsed
    // row has no size, and a 0x0 container is not a rendered map.
    const settled = '[data-gis-render-card="ready"], [data-gis-render-card="failed"], [data-gis-render-card="data-unavailable"]'
    await page.waitForSelector(settled, { state: 'attached', timeout: 120_000 })
    await page.locator('[data-tool="gis_render"]').first().click({ timeout: 10_000 }).catch(() => {})
    await page.waitForSelector('[data-gis-map="ready"]', { state: 'attached', timeout: 60_000 })
    const liveHtml = await page.locator('[data-gis-render-card]').first().innerHTML()
    check(true, 'the card rendered and the map reached ready')
    console.log('session url after the turn: ' + page.url())

    const canvas = await page.locator('[data-gis-map-canvas] canvas').count()
    check(canvas > 0, 'MapLibre created a canvas inside the card', String(canvas))

    const cardChunk = requests.filter(url => /client\.GisRenderCard\.js/.test(url)).length
    const libraryChunk = requests.filter(url => /client\.maplibre\.js/.test(url)).length
    check(cardChunk > 0, 'the card chunk arrived because a card mounted', String(cardChunk))
    check(libraryChunk > 0, 'the MapLibre chunk arrived because a card mounted', String(libraryChunk))

    const blob = requests.filter(url => /\/api\/gis\/blob\?id=/.test(url))
    check(blob.length > 0, 'the card fetched its bytes through the byte route', String(blob.length))
    check(pageErrors.length === 0, 'the page raised no error', pageErrors.join(' | '))

    // REPLAY: reload the page. Nothing re-runs -- the card is rebuilt from the
    // persisted log, and must come out identical. The app restores the last
    // session on reload; if it lands elsewhere, ask for the session again.
    const sessionUrl = page.url()
    await page.reload({ waitUntil: 'domcontentloaded' })
    try {
      await page.waitForSelector(settled, { state: 'attached', timeout: 30_000 })
    } catch {
      await page.goto(sessionUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForSelector(settled, { state: 'attached', timeout: 60_000 })
    }
    await page.locator('[data-tool="gis_render"]').first().click({ timeout: 10_000 }).catch(() => {})
    await page.waitForSelector('[data-gis-map="ready"]', { state: 'attached', timeout: 60_000 })
    const replayHtml = await page.locator('[data-gis-render-card]').first().innerHTML()
    check(replayHtml === liveHtml, 'a reload replays the same card from the log alone')

    // DEGRADATION: the id is content-derived, so appending one byte to the
    // source makes the logged id stale. The route drops it, the card says so.
    await appendFile(fixture, '\n')
    await page.reload({ waitUntil: 'domcontentloaded' })
    try {
      await page.waitForSelector('[data-gis-render-card="data-unavailable"]', { state: 'attached', timeout: 30_000 })
    } catch {
      await page.goto(sessionUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForSelector('[data-gis-render-card="data-unavailable"]', { state: 'attached', timeout: 60_000 })
    }
    const note = await page.locator('[data-gis-render-missing]').first().textContent()
    // The copy may be translated, so assert on the degradation being SAID and
    // naming the layer -- not on one language's wording.
    check(/(no longer available|不可用)/.test(note ?? '') && (note ?? '').includes('ds_'), 'a stale id degrades the card to "data no longer available"', String(note))

    // FAILURE: with the file gone, a second turn makes the tool itself fail;
    // the card must show the diagnosis rather than nothing.
    //
    // In a NEW session, because the mock always names its tool call
    // `mock-call-1`: a second call with that id inside one conversation makes
    // the client's conversation model refuse the event feed (its own guard
    // against duplicate call ids). A harness limitation, not a plugin one.
    await rm(fixture, { force: true })
    await page.getByText('新会话', { exact: true }).first().click()
    await page.waitForSelector(COMPOSER, { timeout: 30_000 })
    await page.waitForTimeout(500)
    await page.click(COMPOSER)
    await page.keyboard.type('render it again')
    await page.click(SEND)
    await page.waitForSelector('[data-gis-render-card="failed"]', { state: 'attached', timeout: 120_000 })
    const failed = await page.locator('[data-gis-render-card="failed"]').first().textContent()
    check((failed ?? '').length > 0, 'a failed render shows a diagnosis in the browser', String(failed).slice(0, 120))
    check(pageErrors.length === 0, 'the page still raised no error', pageErrors.join(' | '))

    check(model.requests.length >= 2, 'the mock model served every turn', String(model.requests.length))
  }
} catch (error) {
  failures.push('the run threw: ' + String(error).split('\n')[0])
  console.log('  FAIL  the run threw -- ' + String(error).split('\n')[0])
  if (browser !== undefined) {
    const page = browser.contexts()[0]?.pages()[0]
    if (page !== undefined) {
      console.log('--- page text (tail) ---\n' + (await page.innerText('body').catch(() => '')).slice(-700))
      console.log('--- card states ---\n' + String(await page.locator('[data-gis-render-card]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-gis-render-card'))).catch(() => 'none')))
      console.log('--- map states ---\n' + String(await page.locator('[data-gis-map]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-gis-map'))).catch(() => 'none')))
      console.log('--- first card html ---\n' + String(await page.locator('[data-gis-render-card]').first().evaluate(node => node.outerHTML).catch(() => 'none')).slice(0, 900))
      console.log('--- console (last 15) ---\n' + console_.slice(-15).join('\n'))
    }
  }
} finally {
  if (browser !== undefined) await browser.close()
  await instance.stop()
  await model.close()
  if (failures.length > 0) console.log('\n--- instance log (tail) ---\n' + await instance.tail(30))
  if (process.env.GIS_T2E_KEEP !== '1') await rm(work, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nWEB E2E PASSED' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
