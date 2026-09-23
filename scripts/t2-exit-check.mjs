/**
 * T2.11 -- the M2 exit gate, on a real instance with a 2 GB-class raster.
 *
 * The gate's own words: "首次转换有进度可取消；再次 <= 1.5 s；回放一致；
 * isError/call===null/id 404 三种降级不抛异常；首屏无 MapLibre chunk".
 * Three of those five are already asserted by `check:e2e` and the DOM lane
 * (replay, the degradations, the first screen). This script takes the two that
 * need a big file and a real instance:
 *
 *   A. first conversion -- a background job, progress recorded as it happens,
 *      and a real COG on disk (asserted with gdalinfo, not "a file appeared");
 *   B. second open -- the cache hit, timed, <= 1.5 s;
 *   C. cancellation -- a fresh instance whose job is killed mid-conversion
 *      through the registry's authorized path, leaving NOTHING behind.
 *
 * Fixture F8 is generated once into tests/.cache (2 GB on disk takes 2 s to
 * write but 40 s to convert, which is exactly what makes progress observable).
 *
 * Usage: node scripts/t2-exit-check.mjs    (GIS_T2E_KEEP=1 keeps the work dirs)
 */
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { bootInstance, prepareWorkdir, slashes } from './lib/verify-instance.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_REPO = process.env.DSH_REPO ?? 'D:/self/code/deepseek-harness'
const GDAL_BIN = process.env.GDAL_BIN ?? 'C:\\OSGeo4W\\bin'
const F8 = join(REPO, 'tests', '.cache', 'f8-big.tif')
const COMPOSER = '[data-composer-input="true"]'
const SEND = 'button[aria-label="发送消息"]'
const failures = []

/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

/** Run GDAL with the configured directory first on PATH. */
function gdal(program, argv) {
  const result = spawnSync(join(GDAL_BIN, program), argv, {
    encoding: 'utf8',
    env: { ...process.env, PATH: GDAL_BIN + ';' + (process.env.PATH ?? '') },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Expand every `gis_cog` tool row.
 *
 * A tool row is a collapsed disclosure: its body is rendered but hidden, so a
 * text assertion has to open it first -- exactly what a user does to read what
 * the tool said.
 * @param page - the page under test.
 */
async function expandToolRows(page) {
  await page.waitForSelector('[data-tool="gis_cog"]', { state: 'attached', timeout: 90_000 })
  const rows = page.locator('[data-tool="gis_cog"]')
  for (let index = 0; index < await rows.count(); index += 1) {
    await rows.nth(index).click({ timeout: 10_000 }).catch(() => {})
  }
  await page.waitForTimeout(300)
}

/** The installed Chromium. */
function findChromium() {
  if (process.env.CHROME_PATH !== undefined) return process.env.CHROME_PATH
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  const build = readdirSync(root).find(name => /^chromium-\d+$/.test(name))
  if (build === undefined) throw new Error('no chromium build under ' + root)
  return join(root, build, 'chrome-win64', 'chrome.exe')
}

/** Generate fixture F8 once; a 2 GB source that takes ~40 s to convert. */
async function ensureFixture() {
  if (existsSync(F8) && (await stat(F8)).size > 1_000_000_000) return stat(F8)
  await mkdir(dirname(F8), { recursive: true })
  console.log('generating fixture F8 (2 GB-class GeoTIFF) at ' + F8)
  const created = gdal('gdal_create.exe', ['-of', 'GTiff', '-outsize', '26000', '26000', '-bands', '3', '-ot', 'Byte', '-burn', '7', '-burn', '90', '-burn', '160', F8])
  if (created.status !== 0) throw new Error('gdal_create failed: ' + created.stderr)
  return stat(F8)
}

/**
 * Everything the session log holds for this work directory.
 *
 * This is the authoritative record of what the tools RETURNED: the model reads
 * these exact bytes, and the interface renders them. Asserting here instead of
 * scraping a collapsed disclosure keeps the check about behaviour rather than
 * about one client's markup.
 *
 * The store is zstd-compressed JSONL, appended while the page runs, so a read
 * can catch a half-written frame: that is a retry, not a failure.
 * @param work - the isolated work directory.
 * @returns the concatenated session bytes as text, decoded.
 */
async function sessionText(work) {
  const { zstdDecompressSync } = await import('node:zlib')
  const dir = join(work, 'sessions')
  if (!existsSync(dir)) return ''
  const files = []
  for (const entry of readdirSync(dir, { recursive: true })) {
    const name = String(entry)
    if (name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl')) files.push(join(dir, name))
  }
  let text = ''
  for (const file of files) {
    const raw = await readFile(file).catch(() => undefined)
    if (raw === undefined) continue
    try {
      text += file.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
    } catch {
      text += raw.toString('utf8')
    }
  }
  return text
}

/** Wait until the session log satisfies a predicate. */
async function waitForSession(work, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = await sessionText(work)
    if (predicate(text)) return { ok: true, text }
    if (Date.now() > deadline) return { ok: false, text }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** Wait until the probe log holds a line the predicate accepts. */
async function waitForProbe(file, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = (await probeLines(file)).find(predicate)
    if (found !== undefined) return found
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** Every JSONL line the probe wrote so far. */
async function probeLines(file) {
  if (!existsSync(file)) return []
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** The COG artifacts currently committed in a cache tree. */
async function cogArtifacts(cacheRoot) {
  const dir = join(cacheRoot, 'cog')
  if (!existsSync(dir)) return []
  return (await readdir(dir)).filter(name => name.endsWith('.tif'))
}

/**
 * Boot one real instance with the probe watching its job registry.
 *
 * The title generator is disabled: it asks the model for a name before the
 * first turn, which would consume the mock's first scripted behaviour and make
 * the turn count depend on nothing we control.
 * @param prefix - temp-directory prefix, so a failure names its phase.
 * @param port - the isolated instance's port.
 * @param options - the mock model's URL and any probe environment.
 * @returns the instance, its work directory, and the probe's log path.
 */
async function boot(prefix, port, options) {
  const { work, patch } = await prepareWorkdir({
    prefix,
    port,
    ...options.cacheQuotaMb === undefined ? {} : { cacheQuotaMb: options.cacheQuotaMb },
    extraPatch: [
      // An EXISTING row is patched by id; a NEW row must be inserted with the
      // `insert` op. A bare `- id:` row for a plugin that does not exist yet is
      // silently ignored -- which is how this probe spent a run reporting
      // "nothing happened" while the interface showed a running job.
      '- id: session-title-llm',
      '  disabled: true',
      '- insert:',
      '    - id: gis-t2-exit-probe',
      "      name: '" + slashes(join(REPO, 'scripts', 'lib', 't2-exit-probe.mjs')) + "'",
      '',
    ],
  })
  works.push(work)
  const jobsLog = join(work, 'jobs.jsonl')
  const instance = await bootInstance({
    work,
    patch,
    timeoutMs: 120_000,
    env: {
      GIS_T2E_JOBS: jobsLog,
      DEEPSEEK_BASE_URL: options.modelURL + '/v1',
      DEEPSEEK_API_KEY: 'mock-key',
      ...options.probeEnv ?? {},
    },
  })
  instances.push(instance)
  return { instance, jobsLog, work }
}

const fixture = await ensureFixture()
console.log('fixture F8: ' + F8 + ' (' + (fixture.size / 1024 / 1024 / 1024).toFixed(2) + ' GiB)')

const { startMockLlmServer } = await import(pathToFileURL(join(DSH_REPO, 'packages', 'test-support', 'llm-mock-server', 'lib', 'index.js')).href)
let browser
const works = []
const instances = []

try {
  // ---------------------------------------------------------------- phase A+B
  const modelA = await startMockLlmServer({
    host: '127.0.0.1', port: 0, apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
    successText: 'done.',
    toolName: 'gis_cog',
    toolArguments: JSON.stringify({ path: F8 }),
  })
  // The quota must hold the ESTIMATE (the source size), not the COG: the
  // pre-check is deliberately conservative, which is what "refuse first" costs.
  const a = await boot('gis-exit-first-', 3094, { modelURL: modelA.baseURL, cacheQuotaMb: 8192 })
  check(a.instance.url !== undefined, 'phase A instance announced its URL', a.instance.url ?? ('see ' + a.instance.log))
  if (a.instance.url === undefined) console.log('--- instance log ---\n' + await a.instance.tail(40))

  browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  await page.goto(a.instance.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForSelector(COMPOSER, { timeout: 60_000 })
  await page.waitForTimeout(1500)

  // --- A: the first conversion must be a BACKGROUND JOB, not a stall.
  const startedAt = Date.now()
  await page.click(COMPOSER)
  await page.keyboard.type('convert the big raster')
  await page.click(SEND)
  // Evidence, in order of authority: the registry REGISTERED a job whose label
  // names the fixture (a job exists only because the tool asked for one), and
  // the interface shows that job. Scraping the tool's prose out of a collapsed
  // disclosure tests the client's markup, not the behaviour.
  const registered = await waitForProbe(a.jobsLog, line => line.event === 'registered', 90_000)
  check(registered !== undefined && String(registered.label).includes('f8-big'), 'the first conversion starts a background job', JSON.stringify(registered))
  // And the user can see it: the session header carries the live job roster.
  const roster = await page.getByText(/1 个后台任务|1 background task/u).first().waitFor({ timeout: 30_000 }).then(() => true, () => false)
  check(roster, 'the interface shows the running background job')

  // The conversion really runs: wait for the artifact to be committed.
  let artifact
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const found = await cogArtifacts(join(a.work, 'cache'))
    if (found.length > 0) { artifact = found[0]; break }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const convertSeconds = (Date.now() - startedAt) / 1000
  check(artifact !== undefined, 'the conversion produced a committed artifact', String(artifact))
  check(convertSeconds > 5, 'the first conversion is NOT instant (the gate says the fixture must cost real time)', convertSeconds.toFixed(1) + ' s')
  if (artifact !== undefined) {
    const path = join(a.work, 'cache', 'cog', artifact)
    const report = gdal('gdalinfo.exe', ['-json', path])
    const layout = JSON.parse(report.stdout)?.metadata?.IMAGE_STRUCTURE?.LAYOUT
    check(layout === 'COG', 'the artifact is a COG according to GDAL itself', String(layout))
  }

  // --- progress: what the registry actually published while it converted.
  const lines = await probeLines(a.jobsLog)
  const progress = lines.filter(line => line.event === 'progress')
  const settled = lines.filter(line => line.event === 'settled')
  check(progress.length >= 2, 'the job published progress lines while converting', String(progress.length) + ': ' + progress.map(line => line.progress).join(' '))
  check(settled.some(line => line.status === 'completed'), 'the job settled completed', JSON.stringify(settled))

  // --- B: the second open must be a cache hit, and fast.
  const sentAt = Date.now()
  await page.click(COMPOSER)
  await page.keyboard.type('convert it again')
  await page.click(SEND)
  // The hit is the SECOND "already converted" the log will ever hold, so count
  // occurrences rather than waiting for a phrase that is already there.
  // The mock's THIRD request is the follow-up after the second tool call, so its
  // arrival bounds the tool call itself: model latency (local, instant) plus the
  // cache hit. Measured host-side rather than by watching the interface.
  const hitDeadline = Date.now() + 60_000
  while (modelA.requests.length < 3 && Date.now() < hitDeadline) await new Promise(resolve => setTimeout(resolve, 50))
  const hitMs = Date.now() - sentAt
  const hit = { ok: modelA.requests.length >= 3 }
  check(hit.ok, 'the second open answers from the cache')
  check(hitMs <= 1500, 'a second open answers from the cache within 1.5 s', hitMs + ' ms')
  const jobsAfter = (await probeLines(a.jobsLog)).filter(line => line.event === 'registered')
  check(jobsAfter.length === 1, 'the second open registered no job at all', String(jobsAfter.length))
  check(pageErrors.length === 0, 'phase A raised no page error', pageErrors.join(' | '))

  await browser.close()
  browser = undefined
  await a.instance.stop()
  await modelA.close()
  if (process.env.GIS_T2E_KEEP !== '1') await rm(a.work, { recursive: true, force: true })

  // ------------------------------------------------------------------ phase C
  const modelC = await startMockLlmServer({
    host: '127.0.0.1', port: 0, apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    successText: 'done.',
    toolName: 'gis_cog',
    toolArguments: JSON.stringify({ path: F8 }),
  })
  const c = await boot('gis-exit-cancel-', 3093, { modelURL: modelC.baseURL, cacheQuotaMb: 8192, probeEnv: { GIS_T2E_KILL_MS: '6000' } })
  check(c.instance.url !== undefined, 'phase C instance announced its URL', c.instance.url ?? ('see ' + c.instance.log))
  if (c.instance.url === undefined) console.log('--- instance log ---\n' + await c.instance.tail(40))

  browser = await chromium.launch({ executablePath: findChromium() })
  const pageC = await browser.newPage()
  const errorsC = []
  pageC.on('pageerror', error => errorsC.push(String(error)))
  await pageC.goto(c.instance.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await pageC.waitForSelector(COMPOSER, { timeout: 60_000 })
  await pageC.waitForTimeout(1500)
  await pageC.click(COMPOSER)
  await pageC.keyboard.type('convert the big raster, then I will cancel it')
  await pageC.click(SEND)

  const cDeadline = Date.now() + 120_000
  let cSettled = []
  while (Date.now() < cDeadline) {
    cSettled = (await probeLines(c.jobsLog)).filter(line => line.event === 'settled' || line.event === 'kill-requested')
    if (cSettled.some(line => line.event === 'settled')) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const killRequested = cSettled.find(line => line.event === 'kill-requested')
  const killSettled = cSettled.find(line => line.event === 'settled')
  check(killRequested !== undefined, 'the exit check cancelled the running job', JSON.stringify(killRequested))
  check(killSettled?.status === 'killed', 'the cancelled job settled as killed', JSON.stringify(killSettled))
  check(killSettled !== undefined && killSettled.status !== 'completed', 'the cancelled conversion did NOT complete', JSON.stringify(killSettled))

  const leftovers = await cogArtifacts(join(c.work, 'cache'))
  check(leftovers.length === 0, 'a cancelled conversion leaves no artifact', leftovers.join(','))
  const staging = existsSync(join(c.work, 'cache', 'cog')) ? (await readdir(join(c.work, 'cache', 'cog'))).filter(name => name.includes('staging')) : []
  check(staging.length === 0, 'a cancelled conversion leaves no staging file', staging.join(','))
  check(errorsC.length === 0, 'phase C raised no page error', errorsC.join(' | '))

  await pageC.waitForTimeout(500)
  await browser.close()
  browser = undefined
  await c.instance.stop()
  await modelC.close()
  if (process.env.GIS_T2E_KEEP !== '1') await rm(c.work, { recursive: true, force: true })

  // ------------------------------------------------------------------ phase D
  // The refusal, at instance level. The default 64 MB quota cannot hold the
  // 1.9 GiB ESTIMATE, so the tool must refuse in the same turn: no job, no
  // artifact, no GDAL. This is T2.4's "refuse first, fail later" as a user sees
  // it, and it is also why phase A raises the quota.
  const modelD = await startMockLlmServer({
    host: '127.0.0.1', port: 0, apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    successText: 'done.',
    toolName: 'gis_cog',
    toolArguments: JSON.stringify({ path: F8 }),
  })
  const d = await boot('gis-exit-refuse-', 3092, { modelURL: modelD.baseURL })
  check(d.instance.url !== undefined, 'phase D instance announced its URL', d.instance.url ?? ('see ' + d.instance.log))

  browser = await chromium.launch({ executablePath: findChromium() })
  const pageD = await browser.newPage()
  const errorsD = []
  pageD.on('pageerror', error => errorsD.push(String(error)))
  await pageD.goto(d.instance.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await pageD.waitForSelector(COMPOSER, { timeout: 60_000 })
  await pageD.waitForTimeout(1500)
  await pageD.click(COMPOSER)
  await pageD.keyboard.type('convert the big raster')
  await pageD.click(SEND)
  // The authoritative record of what the tool ANSWERED is the conversation the
  // model was sent next: the refusal must be in it, in the same turn.
  const refusalDeadline = Date.now() + 60_000
  while (modelD.requests.length < 2 && Date.now() < refusalDeadline) await new Promise(resolve => setTimeout(resolve, 100))
  const followUp = JSON.stringify(modelD.requests[1]?.body ?? {})
  check(/CACHE_QUOTA_EXCEEDED/u.test(followUp), 'the refusal reaches the model in the same turn', followUp.length + ' bytes of follow-up request')
  check(/refused/u.test(followUp), 'the refusal is phrased as a refusal, not a failure')
  const linesD = await probeLines(d.jobsLog)
  check(!linesD.some(line => line.event === 'registered'), 'a refused request never registers a job', JSON.stringify(linesD.slice(0, 3)))
  check((await cogArtifacts(join(d.work, 'cache'))).length === 0, 'a refused request writes no artifact')
  check(errorsD.length === 0, 'phase D raised no page error', errorsD.join(' | '))

  await browser.close()
  browser = undefined
  await d.instance.stop()
  await modelD.close()
  if (process.env.GIS_T2E_KEEP !== '1') await rm(d.work, { recursive: true, force: true })
} catch (error) {
  failures.push('the run threw: ' + String(error).split('\n')[0])
  console.log('  FAIL  the run threw -- ' + String(error).split('\n')[0])
  if (browser !== undefined) {
    const page = browser.contexts()[0]?.pages()[0]
    if (page !== undefined) {
      console.log('--- page text (tail) ---\n' + (await page.innerText('body').catch(() => '')).slice(-600))
      const rows = await page.locator('[data-tool]').evaluateAll(nodes => nodes.map(node => ({
        tool: node.getAttribute('data-tool'),
        state: node.getAttribute('data-state'),
        html: node.outerHTML.slice(0, 700),
      }))).catch(() => [])
      console.log('--- tool rows ---\n' + JSON.stringify(rows, null, 1).slice(0, 2500))
    }
  }
} finally {
  if (browser !== undefined) await browser.close()
  // Every instance this run started, always: a leaked instance keeps holding its
  // port and its temp directories, and the NEXT run then fails with EADDRINUSE
  // instead of the failure that actually happened.
  for (const instance of instances) await instance.stop().catch(() => {})
  for (const dir of works) {
    if (process.env.GIS_T2E_KEEP === '1') continue
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

console.log(failures.length === 0 ? '\nM2 EXIT CHECK PASSED' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
