/**
 * T1a.2 real-instance verification: does a dataset id survive a REAL restart?
 *
 * The unit tests simulate a restart with a fresh `Context` over a real storage
 * medium. That covers the registry, but not the parts that exist only in a live
 * profile: the Cordis Loader activating our row, `ctx.inject('storageDomain')`
 * binding to the row `dsh-base` mounted earlier in the tree, and the plugin
 * writing through the profile's own storage backend.
 *
 * So this script boots the actual `gisweb` profile three times, with
 * `scripts/t1a2-probe.mjs` injected through `--patch`:
 *
 *   1. `open`    -- open a fixture, report the derived id and the persistence mode;
 *   2. `resolve` -- a SECOND process resolving that id from storage alone (the
 *                    claim under test: an id outlives the process that made it);
 *   3. `stale`   -- edit the fixture, then a THIRD process asks for the old id
 *                    and must get the structured DATASET_NOT_FOUND.
 *
 * Isolation, so a verification run cannot touch the user's live profile:
 *  - the `storage-json` row's `root` is overridden to a temporary directory,
 *    so the real `~/.dsh/storages` is never opened;
 *  - the `webserver` row is disabled, so the run can never bind (or steal)
 *    port 3080 from a running GUI;
 *  - each boot is killed as soon as the probe reports DONE.
 *
 * Usage: `node scripts/t1a2-real-instance.mjs` (GIS_T1A2_KEEP=1 keeps the
 * temporary directory for inspection).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_BIN = process.env.DSH_BIN ?? 'D:/self/code/deepseek-harness/apps/cli/lib/bin.js'
const PROFILE = 'gisweb'
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
  const out = join(work, `result-${phase}.jsonl`)
  const log = join(work, `boot-${phase}.log`)
  await writeFile(out, '')
  const child = spawn(process.execPath, [DSH_BIN, '--profile', PROFILE, '--patch', join(work, 'patch.yml')], {
    env: { ...process.env, GIS_T1A2_OUT: out, GIS_T1A2_PHASE: phase, ...environment },
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

const failures = []
/** Record one check, printing its verdict immediately. */
function check(condition, message) {
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${message}`)
  if (!condition) failures.push(message)
}

const work = await mkdtemp(join(tmpdir(), 'gis-t1a2-'))
const data = join(work, 'data')
const storages = join(work, 'storages')
await mkdir(data, { recursive: true })
const fixture = join(data, 'points.geojson')
await copyFile(join(REPO, 'tests', 'fixtures', 'points.geojson'), fixture)
await copyFile(join(REPO, 'scripts', 't1a2-probe.mjs'), join(work, 'probe.mjs'))
await writeFile(join(work, 'patch.yml'), [
  '# Verification overlay: isolate the medium and keep off the live port.',
  '- id: storage-json',
  '  config:',
  `    root: ${slashes(storages)}`,
  '# The derived cache is not what this script checks, but it must not write into',
  '# the real harness home either.',
  '- id: gis-core',
  '  config:',
  `    cacheDir: ${slashes(join(work, 'cache'))}`,
  '    cacheQuotaMb: 64',
  '- id: webserver',
  '  disabled: true',
  '- insert:',
  '    - id: gis-t1a2-probe',
  `      name: '${slashes(join(work, 'probe.mjs'))}'`,
  '',
].join('\n'))

console.log(`work directory: ${work}`)
console.log(`dsh: ${DSH_BIN}  profile: ${PROFILE}`)

try {
  console.log('\n[1/3] boot A -- open the fixture, derive the id')
  const first = await boot(work, 'open', { GIS_T1A2_FIXTURE: fixture })
  console.log(first.lines.map(line => `  probe: ${JSON.stringify(line)}`).join('\n'))
  const opened = first.lines.find(line => line.phase === 'open' && line.id !== undefined)
  check(opened !== undefined, 'boot A opened the fixture through the real ctx.gis')
  check(opened?.persistence === 'storage', `ids are durable in this profile (persistence=${String(opened?.persistence)})`)
  const id = opened?.id
  if (id !== undefined) {
    const record = join(storages, 'gis', 'datasets', `${id}.json`)
    check(existsSync(record), `the profile wrote a per-record document: ${slashes(record)}`)
    if (existsSync(record)) console.log(`  document: ${(await readFile(record, 'utf8')).trim().replace(/\n/g, ' ')}`)
  }

  console.log('\n[2/3] boot B -- a second process resolves that id from storage alone')
  const second = await boot(work, 'resolve', { GIS_T1A2_EXPECT_ID: id ?? '' })
  console.log(second.lines.map(line => `  probe: ${JSON.stringify(line)}`).join('\n'))
  const resolved = second.lines.find(line => line.phase === 'resolve' && line.resolved !== undefined)
  check(resolved !== undefined, 'boot B resolved the id in a process that never opened the file')
  check(resolved?.fresh === true, 'the stored id still matches the bytes on disk')
  check(second.lines.every(line => line.persistence === undefined || line.persistence === 'storage'), 'boot B is storage-backed too')

  console.log('\n[3/3] boot C -- edit the source; the old id must 404')
  const edited = (await readFile(fixture, 'utf8')).replace('"rank": 1', '"rank": 99')
  await writeFile(fixture, edited)
  const third = await boot(work, 'stale', { GIS_T1A2_EXPECT_ID: id ?? '', GIS_T1A2_FIXTURE: fixture })
  console.log(third.lines.map(line => `  probe: ${JSON.stringify(line)}`).join('\n'))
  const stale = third.lines.find(line => line.phase === 'stale' && line.code !== undefined)
  check(stale?.changed === true, 'the edited source derives a NEW id for the same path')
  check(stale?.code === 'DATASET_NOT_FOUND', `the old id answers with DATASET_NOT_FOUND (got ${String(stale?.code)})`)
  check(Array.isArray(stale?.listed) && !stale.listed.includes(id), 'the dropped id left the catalog')

  if (failures.length > 0) {
    console.log('\n--- boot logs (tail) ---')
    for (const phase of ['open', 'resolve', 'stale']) {
      const log = join(work, `boot-${phase}.log`)
      if (!existsSync(log)) continue
      const tail = (await readFile(log, 'utf8')).split('\n').filter(Boolean).slice(-25).join('\n')
      console.log(`\n[boot ${phase}]\n${tail}`)
    }
  }
} finally {
  if (process.env.GIS_T1A2_KEEP !== '1') await rm(work, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL REAL-INSTANCE CHECKS PASSED' : `\nFAILED: ${failures.length}`)
process.exit(failures.length === 0 ? 0 : 1)
