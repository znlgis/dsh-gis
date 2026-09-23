/**
 * T2.9 at instance level: does a real profile publish the session map state, and
 * does a REPLAY of the real log agree with what was live?
 *
 * The unit tests fold typed events; this one folds the log a real session wrote.
 * The chain: a real turn through the mock model calls \`gis_render\`, the host
 * appends a real \`tool/result\` with our map description, the \`gis/map\`
 * projection folds it and publishes its client view -- which a probe records.
 * Then the instance is STOPPED, the persisted log is decoded, and the same pure
 * fold runs over it. The two must be identical: that is the DoD.
 *
 * Usage: node scripts/t2-mapstate-check.mjs
 */
import { existsSync, readdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { chromium } from 'playwright-core'

/** The decoder, bound once (the helper below is called per file). */
const await_zstd = () => ({ zstdDecompressSync })
import { bootInstance, prepareWorkdir, slashes } from './lib/verify-instance.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_REPO = process.env.DSH_REPO ?? 'D:/self/code/deepseek-harness'
const PORT = Number(process.env.GIS_T2M_PORT ?? 3085)
const COMPOSER = '[data-composer-input="true"]'
const SEND = 'button[aria-label="发送消息"]'
const failures = []

/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

/** Where each zstd frame in a concatenated stream begins. */
function zstdFrameOffsets(raw) {
  const offsets = []
  for (let at = 0; at + 3 < raw.length; at += 1) {
    if (raw[at] === 0x28 && raw[at + 1] === 0xb5 && raw[at + 2] === 0x2f && raw[at + 3] === 0xfd) offsets.push(at)
  }
  return offsets
}

/**
 * Decode every frame of a concatenated zstd file.
 *
 * A frame boundary is found by the magic number, and a candidate that does not
 * decode is widened to the next boundary: the alternative (trusting the first
 * split) would silently DROP whichever frame could not stand alone, which is the
 * failure mode this helper exists to avoid.
 * @param raw - the file's bytes.
 * @returns the concatenated decoded text.
 */
function decodeZstdFrames(raw) {
  const { zstdDecompressSync } = await_zstd()
  const offsets = zstdFrameOffsets(raw)
  if (offsets.length === 0) return ''
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    for (let end = index + 1; end <= offsets.length; end += 1) {
      const slice = raw.subarray(offsets[index], end < offsets.length ? offsets[end] : raw.length)
      try {
        text += zstdDecompressSync(slice).toString('utf8')
        break
      } catch {
        // Not a whole frame on its own: widen and try again.
      }
    }
  }
  return text
}

/** The installed Chromium. */
function findChromium() {
  if (process.env.CHROME_PATH !== undefined) return process.env.CHROME_PATH
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  const build = readdirSync(root).find(name => /^chromium-\d+$/.test(name))
  if (build === undefined) throw new Error('no chromium build under ' + root)
  return join(root, build, 'chrome-win64', 'chrome.exe')
}

/**
 * Decode every persisted session event for one work directory.
 *
 * The JSONL store appends one zstd FRAME per flush, so the file is a
 * concatenated multi-frame stream whose first frame holds the session header
 * alone. NEITHER Node decoder continues past the first frame -- `zstdDecompressSync`
 * returned 250 bytes and `createZstdDecompress` 240 for an 18 KB file with four
 * frames -- so both look exactly like "the log has no events". The frames are
 * therefore split by their magic number and decoded one by one.
 * @param work - the isolated work directory.
 * @returns the events, in file order.
 */
async function persistedEvents(work) {
  const { zstdDecompressSync } = await import('node:zlib')
  const dir = join(work, 'sessions')
  if (!existsSync(dir)) return []
  const events = []
  for (const entry of readdirSync(dir, { recursive: true })) {
    const name = String(entry)
    if (!name.endsWith('.jsonl.zstd')) continue
    const raw = await readFile(join(dir, name)).catch(() => undefined)
    if (raw === undefined) continue
    const text = decodeZstdFrames(raw)
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      const record = JSON.parse(line)
      if (record.type !== undefined && record.seq !== undefined) events.push(record)
    }
  }
  return events
}

const { work, patch } = await prepareWorkdir({
  prefix: 'gis-mapstate-',
  port: PORT,
  extraPatch: [
    '- id: session-title-llm',
    '  disabled: true',
    '- insert:',
    '    - id: gis-t2-mapstate-probe',
    "      name: '" + slashes(join(REPO, 'scripts', 'lib', 't2-mapstate-probe.mjs')) + "'",
    '',
  ],
})
const fixture = join(work, 'data', 'points.geojson')
await (await import('node:fs/promises')).copyFile(join(REPO, 'tests', 'fixtures', 'points.geojson'), fixture)
const probeLog = join(work, 'mapstate.jsonl')

const { startMockLlmServer } = await import(pathToFileURL(join(DSH_REPO, 'packages', 'test-support', 'llm-mock-server', 'lib', 'index.js')).href)
const model = await startMockLlmServer({
  host: '127.0.0.1', port: 0, apiKey: 'mock-key',
  sequence: ['tool_call_success', 'success'],
  successText: 'drawn.',
  toolName: 'gis_render',
  toolArguments: JSON.stringify({ path: fixture }),
})

const instance = await bootInstance({
  work, patch, timeoutMs: 120_000,
  env: { GIS_T2M_OUT: probeLog, DEEPSEEK_BASE_URL: model.baseURL + '/v1', DEEPSEEK_API_KEY: 'mock-key' },
})
let browser
try {
  check(instance.url !== undefined, 'the instance announced its URL', instance.url ?? ('see ' + instance.log))
  browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  await page.goto(instance.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForSelector(COMPOSER, { timeout: 60_000 })
  await page.waitForTimeout(1500)
  await page.click(COMPOSER)
  await page.keyboard.type('draw the points')
  await page.click(SEND)

  // The projection publishes when the tool result commits.
  let lines = []
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    lines = existsSync(probeLog) ? (await readFile(probeLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    if (lines.some(line => line.event === 'changed' && line.key === 'gis/map')) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const change = lines.find(line => line.event === 'changed' && line.key === 'gis/map')
  check(lines.some(line => line.event === 'probe-ready'), 'the probe loaded and subscribed')
  check(change !== undefined, 'a real gis_render turn published a gis/map change', JSON.stringify(lines.slice(-3)))
  check(change?.value?.layers?.length === 1, 'the published state names the layer it drew', JSON.stringify(change?.value))

  // Live value captured. Now STOP the instance and fold the persisted log.
  await browser.close()
  browser = undefined
  await instance.stop()
  const events = await persistedEvents(work)
  check(events.length > 0, 'the session log persisted events', String(events.length))

  const { applyGisMapEvent, gisMapProjection } = await import(pathToFileURL(join(REPO, 'packages', 'gis-core', 'lib', 'index.js')).href)
  let replayed = gisMapProjection.init({}, 0)
  for (const event of events) replayed = applyGisMapEvent(replayed, event)
  check(replayed.layers.length === 1, 'the persisted log folds to a map state', JSON.stringify(replayed))
  // THE DoD: what a replay reconstructs equals what was live.
  check(JSON.stringify(replayed) === JSON.stringify(change?.value), 'a replay of the persisted log equals the live state', JSON.stringify({ replayed, live: change?.value }))
  check(pageErrors.length === 0, 'the page raised no error', pageErrors.join(' | '))
} catch (error) {
  failures.push('the run threw: ' + String(error).split('\n')[0])
  console.log('  FAIL  the run threw -- ' + String(error).split('\n')[0])
  console.log('--- instance log (tail) --- ' + await instance.tail(20))
} finally {
  if (browser !== undefined) await browser.close()
  await instance.stop()
  await model.close()
  if (process.env.GIS_T2M_KEEP !== '1') await rm(work, { recursive: true, force: true }).catch(() => {})
}

console.log(failures.length === 0 ? '\nMAP STATE CHECK PASSED' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
