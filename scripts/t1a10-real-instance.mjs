/**
 * T1a.10 real-instance verification: is the derived cache real in a live profile?
 *
 * The unit tests own the cache's semantics (keys, quota, LRU, staging). What
 * they cannot show is the wiring a profile actually performs: the Loader
 * handing our row its validated config, `ctx.gis.cache` being reachable
 * through the service proxy, and the artifact landing under the configured
 * directory in a real process.
 *
 * Three boots of the real `gisweb` profile, each with the probe from
 * `scripts/t1a10-probe.mjs` injected through `--patch`:
 *
 *   1. `put`     -- quota is 1 MiB, two 600 KiB artifacts are written, so
 *                  the first must be evicted and a 2 MiB artifact must be
 *                  refused BEFORE anything is written;
 *   2. `resolve` -- a SECOND process: both keys are looked up with nothing
 *                  in memory, then a third artifact evicts the least recently
 *                  used one (cross-process LRU, read back from disk);
 *   3. `clear`   -- the "clear cache" entry point empties the tree.
 *
 * Isolation: the cache root and the storage root both live in a temporary
 * directory (`--patch` overrides the row config), and the `webserver` row is
 * disabled so the run cannot bind or steal port 3080.
 *
 * Usage: `node scripts/t1a10-real-instance.mjs` (GIS_T1A10_KEEP=1 keeps the
 * temporary directory for inspection).
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_BIN = process.env.DSH_BIN ?? 'D:/self/code/deepseek-harness/apps/cli/lib/bin.js'
const PROFILE = 'gisweb'
const QUOTA_MB = 1
const HALF_KIB = 600
const BOOT_TIMEOUT_MS = 120_000
const POLL_MS = 250

/** POSIX-style slashes: YAML and the Loader both accept them on Windows. */
const slashes = path => path.replace(/\\/g, '/')

/** Parse the probe's JSON-lines report, ignoring a half-written last line. */
const parseLines = text => text.split('\n').filter(Boolean).flatMap((line) => {
  try {
    return [JSON.parse(line)]
  } catch {
    return []
  }
})

/** Run one boot; return once the probe reports DONE or the process exits. */
async function boot(work, phase, environment) {
  const out = join(work, 'result-' + phase + '.jsonl')
  const log = join(work, 'boot-' + phase + '.log')
  await writeFile(out, '')
  const child = spawn(process.execPath, [DSH_BIN, '--profile', PROFILE, '--patch', join(work, 'patch.yml')], {
    env: { ...process.env, GIS_T1A10_OUT: out, GIS_T1A10_PHASE: phase, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let captured = ''
  child.stdout.on('data', chunk => { captured += String(chunk) })
  child.stderr.on('data', chunk => { captured += String(chunk) })
  const exited = new Promise(resolve => { child.on('exit', code => { resolve(code) }) })

  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let lines = []
  for (;;) {
    lines = parseLines(await readFile(out, 'utf8'))
    if (lines.some(line => line.done === true)) break
    const settled = await Promise.race([exited.then(() => true), Promise.resolve(false)])
    if (settled) {
      lines = parseLines(await readFile(out, 'utf8'))
      break
    }
    if (Date.now() > deadline) break
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  const code = await Promise.race([exited, Promise.resolve('still-running')])
  if (code === 'still-running') child.kill()
  await writeFile(log, captured)
  return { lines, exit: code, log }
}

/** The probe's report for one phase. */
const reportOf = (booted, phase) => booted.lines.find(line => line.phase === phase && line.done !== true)

const failures = []
/** Record one check, printing its verdict immediately. */
function check(condition, message) {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message)
  if (!condition) failures.push(message)
}

const work = await mkdtemp(join(tmpdir(), 'gis-t1a10-'))
const storages = join(work, 'storages')
const cacheRoot = join(work, 'derived')
await mkdir(work, { recursive: true })
await copyFile(join(REPO, 'scripts', 't1a10-probe.mjs'), join(work, 'probe.mjs'))
await writeFile(join(work, 'patch.yml'), [
  '# Verification overlay: isolate the medium and the cache, stay off the live port.',
  '- id: storage-json',
  '  config:',
  '    root: ' + slashes(storages),
  '- id: gis-core',
  '  config:',
  '    cacheDir: ' + slashes(cacheRoot),
  '    cacheQuotaMb: ' + String(QUOTA_MB),
  '- id: webserver',
  '  disabled: true',
  '- insert:',
  '    - id: gis-t1a10-probe',
  "      name: '" + slashes(join(work, 'probe.mjs')) + "'",
  '',
].join('\n'))

console.log('work directory: ' + work)
console.log('dsh: ' + DSH_BIN + '  profile: ' + PROFILE)

try {
  console.log('\n[1/3] boot A -- quota and eviction in a live process')
  const first = await boot(work, 'put', {})
  console.log(first.lines.map(line => '  probe: ' + JSON.stringify(line)).join('\n'))
  const put = reportOf(first, 'put')
  check(put?.root === cacheRoot, 'the cache lives where the row config says (' + String(put?.root) + ')')
  check(put?.quotaBytes === QUOTA_MB * 1024 * 1024, 'the quota comes from the row config (' + String(put?.quotaBytes) + ' bytes)')
  check(put?.betaBytes === HALF_KIB * 1024, 'the second artifact was stored and resolves (' + String(put?.betaBytes) + ' bytes)')
  check(put?.alphaBytes === null, 'the first artifact was evicted by LRU when the quota was reached')
  check(put?.refusal === 'CACHE_QUOTA_EXCEEDED', 'a 2 MiB artifact against a 1 MiB quota is refused (' + String(put?.refusal) + ')')
  check(put?.stats?.entries === 1 && put?.stats?.bytes === HALF_KIB * 1024, 'the tree holds exactly one artifact (' + JSON.stringify(put?.stats) + ')')
  const onDisk = existsSync(join(cacheRoot, 'probe')) ? readdirSync(join(cacheRoot, 'probe')) : []
  check(onDisk.length === 1, 'the directory on disk agrees: ' + JSON.stringify(onDisk))

  console.log('\n[2/3] boot B -- a second process reads the same tree, and LRU survives it')
  const second = await boot(work, 'resolve', { GIS_T1A10_KEY_ALPHA: put?.alpha ?? '', GIS_T1A10_KEY_BETA: put?.beta ?? '' })
  console.log(second.lines.map(line => '  probe: ' + JSON.stringify(line)).join('\n'))
  const resolved = reportOf(second, 'resolve')
  check(resolved?.betaPresent === true && resolved?.betaBytes === HALF_KIB * 1024, 'the artifact from boot A is still a hit in a new process')
  check(resolved?.alphaPresent === false, 'the evicted artifact stayed evicted')
  check(resolved?.betaAfterGamma === false, 'the newly written artifact evicted the least recently used one (LRU read back from disk)')
  check(resolved?.stats?.entries === 1, 'still exactly one artifact after the eviction')

  console.log('\n[3/3] boot C -- clearing the cache')
  const third = await boot(work, 'clear', {})
  console.log(third.lines.map(line => '  probe: ' + JSON.stringify(line)).join('\n'))
  const cleared = reportOf(third, 'clear')
  check(cleared?.freed === HALF_KIB * 1024, 'clear reports what it freed (' + String(cleared?.freed) + ' bytes)')
  check(cleared?.stats?.entries === 0 && cleared?.stats?.bytes === 0, 'the cache is empty afterwards')
  const leftOnDisk = existsSync(join(cacheRoot, 'probe')) ? readdirSync(join(cacheRoot, 'probe')) : []
  check(leftOnDisk.length === 0, 'nothing is left under the cache root: ' + JSON.stringify(leftOnDisk))

  if (failures.length > 0) {
    console.log('\n--- boot logs (tail) ---')
    for (const phase of ['put', 'resolve', 'clear']) {
      const log = join(work, 'boot-' + phase + '.log')
      if (!existsSync(log)) continue
      console.log('\n[boot ' + phase + ']\n' + (await readFile(log, 'utf8')).split('\n').filter(Boolean).slice(-25).join('\n'))
    }
  }
} finally {
  if (process.env.GIS_T1A10_KEEP !== '1') await rm(work, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL REAL-INSTANCE CHECKS PASSED' : '\nFAILED: ' + failures.length)
process.exit(failures.length === 0 ? 0 : 1)
