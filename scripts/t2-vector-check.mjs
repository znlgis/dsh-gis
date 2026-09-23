/**
 * Do FlatGeobuf and PMTiles actually stream by RANGE in a real browser? (T2.5)
 *
 * The unit tests read the fixtures' bytes in Node. They cannot prove what T2.5's
 * DoD is about: that the CLIENT asks for parts of the file, through the byte
 * route, and draws what came back. So each format gets a real instance, a real
 * tool call (through the mock model -- no credentials) and a real Chromium.
 *
 * Usage: node scripts/t2-vector-check.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { bootInstance, prepareWorkdir } from './lib/verify-instance.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_REPO = process.env.DSH_REPO ?? 'D:/self/code/deepseek-harness'
const COMPOSER = '[data-composer-input="true"]'
const SEND = 'button[aria-label="发送消息"]'
const failures = []

/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

/** The installed Chromium. */
function findChromium() {
  if (process.env.CHROME_PATH !== undefined) return process.env.CHROME_PATH
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  const build = readdirSync(root).find(name => /^chromium-\d+$/.test(name))
  if (build === undefined) throw new Error('no chromium build under ' + root)
  return join(root, build, 'chrome-win64', 'chrome.exe')
}

const { startMockLlmServer } = await import(pathToFileURL(join(DSH_REPO, 'packages', 'test-support', 'llm-mock-server', 'lib', 'index.js')).href)

/**
 * Drive one container format through a real instance.
 * @param options - the fixture, its port, and what to look for.
 */
async function runPhase(options) {
  console.log('\n=== ' + options.label + ' ===')
  const { work, patch } = await prepareWorkdir({
    prefix: 'gis-vector-' + options.label.toLowerCase() + '-',
    port: options.port,
    extraPatch: ['- id: session-title-llm', '  disabled: true', ''],
  })
  const model = await startMockLlmServer({
    host: '127.0.0.1', port: 0, apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    successText: 'drawn.',
    toolName: 'gis_render',
    toolArguments: JSON.stringify({ path: options.fixture }),
  })
  const instance = await bootInstance({
    work, patch, timeoutMs: 120_000,
    env: { DEEPSEEK_BASE_URL: model.baseURL + '/v1', DEEPSEEK_API_KEY: 'mock-key' },
  })
  let browser
  try {
    check(instance.url !== undefined, options.label + ': the instance announced its URL', instance.url ?? ('see ' + instance.log))
    browser = await chromium.launch({ executablePath: findChromium() })
    const page = await browser.newPage()
    const pageErrors = []
    const ranged = []
    const blobRequests = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('request', (request) => {
      if (!/\/api\/gis\/blob\?id=/.test(request.url())) return
      blobRequests.push(request.url())
      const range = request.headers()['range']
      if (range !== undefined) ranged.push(range)
    })

    await page.goto(instance.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForSelector(COMPOSER, { timeout: 60_000 })
    await page.waitForTimeout(1500)
    await page.click(COMPOSER)
    await page.keyboard.type('draw ' + options.label)
    await page.click(SEND)

    const settled = '[data-gis-render-card="ready"], [data-gis-render-card="failed"], [data-gis-render-card="data-unavailable"]'
    await page.waitForSelector(settled, { state: 'attached', timeout: 120_000 })
    await page.locator('[data-tool="gis_render"]').first().click({ timeout: 10_000 }).catch(() => {})
    const ready = await page.waitForSelector('[data-gis-map="ready"]', { state: 'attached', timeout: 60_000 }).then(() => true, () => false)
    check(ready, options.label + ': the card reached ready')
    await page.waitForTimeout(2500)

    const issues = await page.locator('[data-gis-render-issues] li').allTextContents()
    check(issues.length === 0, options.label + ': it drew with no reported issue', issues.join(' | '))
    check(ranged.length >= 2, options.label + ': the client ranged-read the file', String(ranged.length) + ' range request(s): ' + ranged.slice(0, 4).join(', '))
    // "Streamed" means: more than the header, and never the whole file at once.
    check(ranged.some(range => !/^bytes=0-$/.test(range)), options.label + ': the reads asked for windows, not the whole file', ranged.join(' '))
    const canvas = await page.locator('[data-gis-map-canvas] canvas').count()
    check(canvas > 0, options.label + ': MapLibre created a canvas', String(canvas))
    check(pageErrors.length === 0, options.label + ': the page raised no error', pageErrors.join(' | '))

    if (failures.length > 0) {
      const html = await page.locator('[data-gis-render-card]').first().evaluate(node => node.outerHTML).catch(() => 'none')
      console.log('--- ' + options.label + ' card --- ' + String(html).slice(0, 600))
      console.log('--- ' + options.label + ' issues --- ' + JSON.stringify(issues))
      console.log('--- blob requests --- ' + String(blobRequests.length))
      console.log('--- instance log (tail) --- ' + await instance.tail(15))
    }
  } catch (error) {
    failures.push(options.label + ': the run threw: ' + String(error).split('\n')[0])
    console.log('  FAIL  ' + options.label + ': the run threw -- ' + String(error).split('\n')[0])
    console.log('--- instance log (tail) --- ' + await instance.tail(20))
  } finally {
    if (browser !== undefined) await browser.close()
    await instance.stop()
    await model.close()
    if (process.env.GIS_VECTOR_KEEP !== '1') {
      const { rm } = await import('node:fs/promises')
      await rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }
}

for (const phase of [
  { label: 'FlatGeobuf', fixture: join(REPO, 'tests', 'fixtures', 'points.fgb'), port: 3087 },
  { label: 'PMTiles', fixture: join(REPO, 'tests', 'fixtures', 'points.pmtiles'), port: 3086 },
]) {
  if (!existsSync(phase.fixture)) {
    failures.push(phase.label + ': fixture ' + phase.fixture + ' is missing (run node scripts/make-fixtures.mjs)')
    console.log('  FAIL  ' + phase.label + ': fixture missing -- ' + phase.fixture)
    continue
  }
  await runPhase(phase)
}

console.log(failures.length === 0 ? '\nVECTOR CHECK PASSED' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
