/**
 * T3.1 in a real profile: does the row load, does describing work, and can a
 * plaintext password get in?
 *
 * Two boots. The first configures two profiles (one referencing a credential the
 * isolated credentials file really holds) and asserts the reported state AND that
 * the secret appears nowhere in the instance log. The second hands the same row a
 * profile carrying \`password:\` and demands it be rejected BY NAME -- the DoD says
 * a plaintext password is not configurable, and the only convincing place to show
 * that is the parser a user's patch actually goes through.
 *
 * The row is inserted by ABSOLUTE PATH to the built package rather than by its
 * package name: the bundle patch names it, which requires the profile to be
 * re-installed, and re-installing would write into the user's ~/.dsh.
 *
 * Usage: node scripts/t3-postgis-check.mjs
 */
import { existsSync } from 'node:fs'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootInstance, prepareWorkdir, slashes } from './lib/verify-instance.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.GIS_PG_PORT ?? 3082)
const SECRET = 'hunter2-check-secret'
const failures = []
/** Newline, spelled this way so no editor or generator can turn it into a real line break. */
const NL = String.fromCharCode(10)

/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

/** Wait for a line in the instance log. */
async function waitForLine(log, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = existsSync(log) ? await readFile(log, 'utf8') : ''
    const line = text.split(NL).find(candidate => pattern.test(candidate))
    if (line !== undefined) return line
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  return undefined
}

const { work, patch } = await prepareWorkdir({
  prefix: 'gis-postgis-',
  port: PORT,
  extraPatch: [
    '- id: session-title-llm',
    '  disabled: true',
    '- insert:',
    '    - id: gis-postgis-isolated',
    "      name: '" + slashes(join(REPO, 'packages', 'gis-postgis', 'lib', 'index.js')) + "'",
    '      config:',
    '        profiles:',
    '          city:',
    '            host: db.internal',
    '            database: gis',
    '            user: reader',
    '            credential: postgis_city',
    '          local:',
    '            host: 127.0.0.1',
    '            database: gis',
    '            user: reader',
    '    - id: gis-t3-probe',
    "      name: '" + slashes(join(REPO, 'scripts', 'lib', 't3-postgis-probe.mjs')) + "'",
    // The real local credentials provider, pointed at the isolated file. The path
    // travels as an ENV VAR because \`!!js\` expressions are allowed in a patch and
    // the work directory does not exist yet at this point.
    '- id: credentials',
    '  config:',
    '    path: !!js process.env.GIS_PG_CREDENTIALS',
    '    watch: false',
    '',
  ],
})
// The CURRENT credentials document layout. The pre-release flat form ('key: value')
// makes the credentials row FAIL to activate, which fails the whole startup -- and
// the symptom is not 'the credential is missing' but 'the probe never reports'.
await writeFile(join(work, 'credentials.yaml'), ['version: 1', 'refs:', '  postgis_city: ' + SECRET, ''].join(NL))

const instance = await bootInstance({
  work,
  patch,
  timeoutMs: 120_000,
  env: { GIS_PG_CREDENTIALS: join(work, 'credentials.yaml') },
}).catch(async (error) => {
  console.log('  FAIL  the instance did not boot -- ' + String(error).split(NL)[0])
  failures.push('boot')
  return { stop: async () => {}, log: join(work, 'instance.log'), tail: async () => '' }
})
try {
  const line = await waitForLine(instance.log, /"event":"(profiles|service|probe-error)"/u, 90_000)
  const reports = (await readFile(instance.log, 'utf8').catch(() => '')).split(NL)
    .filter(candidate => candidate.includes('gis-t3-postgis-probe'))
    .map(candidate => JSON.parse(candidate.slice(candidate.indexOf('{'))))
  const profiles = reports.find(report => report.event === 'profiles')
  const service = reports.find(report => report.event === 'service')
  check(reports.some(report => report.event === 'probe-loaded'), 'the probe loaded', line === undefined ? 'no probe line' : line.slice(0, 160))
  check(service?.present === true, 'the row published ctx.gisPostgis', JSON.stringify(service ?? {}))
  const byName = new Map((profiles?.profiles ?? []).map(entry => [entry.profile, entry]))
  check(byName.size === 2, 'both configured profiles are described', JSON.stringify(profiles?.profiles ?? []))
  check(byName.get('city')?.credentialState === 'configured', 'the credential the isolated file holds reads as configured', JSON.stringify(byName.get('city') ?? {}))
  check(byName.get('local')?.credentialState === 'not-required', 'a profile with no credential says so')
  check(byName.get('city')?.statementTimeoutMs === 15_000, 'the defaults reach the running service', JSON.stringify(byName.get('city') ?? {}))

  const logText = await readFile(instance.log, 'utf8')
  const log = logText
  // A start that failed would explain every other failure here, so assert it before the rest.
  check(!logText.includes('startup failed'), 'the harness started with every required plugin active')
  // The DoD, at instance level: the secret never lands in a log the user can see.
  check(!log.includes(SECRET), 'the secret appears nowhere in the instance log')
} finally {
  await instance.stop()
  // Keep the FIRST boot's log: the second boot reuses the same file name and
  // TRUNCATES it, which is how "no probe line" first hid its own evidence.
  await copyFile(instance.log, join(work, 'first.log')).catch(() => {})
}

// Second boot, its OWN work directory: one row carrying a plaintext password, and
// nothing else that could publish the service -- so "did this configuration load?"
// has one observable answer instead of two rows to tell apart.
const bad = await prepareWorkdir({
  prefix: 'gis-postgis-bad-',
  port: PORT + 1,
  extraPatch: [
    '- id: session-title-llm',
    '  disabled: true',
    '- insert:',
    '    - id: gis-postgis-bad',
    "      name: '" + slashes(join(REPO, 'packages', 'gis-postgis', 'lib', 'index.js')) + "'",
    '      config:',
    '        profiles:',
    '          city:',
    '            host: db.internal',
    '            database: gis',
    '            user: reader',
    '            password: ' + SECRET,
    '    - id: gis-t3-probe',
    "      name: '" + slashes(join(REPO, 'scripts', 'lib', 't3-postgis-probe.mjs')) + "'",
    '',
  ],
})
const badInstance = await bootInstance({ work: bad.work, patch: bad.patch, timeoutMs: 60_000 }).then(
  (started) => ({ started, log: started.log, booted: true }),
  async () => ({ started: undefined, log: join(bad.work, 'instance.log'), booted: false }),
)
// The probe reports SIX SECONDS after load, so stopping the instance as soon as it
// boots reads only "probe-loaded" and concludes nothing -- which is what the first
// version of this assertion did.
if (badInstance.booted) await waitForLine(badInstance.log, /"event":"service"/u, 30_000)
await badInstance.started?.stop()
const badLog = await readFile(badInstance.log, 'utf8').catch(() => '')
check(badInstance.booted, 'a bad GIS profile does not take the harness down', badLog.slice(-200))
const badReports = badLog.split(NL)
  .filter(candidate => candidate.includes('gis-t3-postgis-probe'))
  .map(candidate => JSON.parse(candidate.slice(candidate.indexOf('{'))))
check(badReports.some(report => report.event === 'probe-loaded'), 'the bad boot still ran its probe', badLog.slice(-200))
check(badReports.find(report => report.event === 'service')?.present === false, 'a plaintext password keeps the service from being published', JSON.stringify(badReports))
// Zod reports the unexpected KEY and not its value, which is the property that
// makes this schema safe to fail loudly with.
check(!badLog.includes(SECRET), 'the rejected value itself is not echoed into the log')

if (process.env.GIS_PG_KEEP !== '1') {
  await rm(work, { recursive: true, force: true }).catch(() => {})
  await rm(bad.work, { recursive: true, force: true }).catch(() => {})
} else console.log('kept work dirs: ' + work + ' , ' + bad.work)

console.log(failures.length === 0 ? NL + 'POSTGIS PROFILE CHECK PASSED' : NL + 'FAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
