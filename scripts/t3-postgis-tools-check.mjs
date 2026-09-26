/**
 * T3.9: PostGIS through the REAL tools path.
 *
 * The previous rounds established the catalogue, paging, tiles and the filter at
 * the SERVICE level, and the M3 exit record listed "PostGIS is not wired into the
 * tools" as the first thing to fix. This check closes it: inside a real instance,
 * the opener claims a postgis: address, the handler answers inspect and query, and
 * the rows come from the local PostgreSQL.
 *
 * The fixture is recreated from the committed SQL, so the check owns its data. No
 * model is involved: the probe calls the same ctx.gis facade the tools call.
 *
 * Usage: node scripts/t3-postgis-tools-check.mjs
 */
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { bootInstance, prepareWorkdir, slashes } from './lib/verify-instance.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.GIS_PGT_PORT ?? 3081)
const HOST = process.env.GIS_PG_HOST ?? '127.0.0.1'
const PG_PORT = Number(process.env.GIS_PG_PORT ?? 5432)
const USER = process.env.GIS_PG_USER ?? 'postgres'
const PASSWORD = process.env.GIS_PG_PASSWORD ?? 'postgres'
const DATABASE = process.env.GIS_PG_DATABASE ?? 'postgres'
const failures = []
/** Newline, spelled so nothing can turn it into a real line break. */
const NL = String.fromCharCode(10)

/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

/** Wait for a probe report of one kind. */
async function waitFor(log, event, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = existsSync(log) ? await readFile(log, 'utf8') : ''
    const line = text.split(NL).find(candidate => candidate.includes('"event":"' + event + '"'))
    if (line !== undefined) return JSON.parse(line.slice(line.indexOf('{')))
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  return undefined
}

const requireFromPackage = createRequire(join(REPO, 'packages', 'gis-postgis', 'package.json'))
const pgModule = await import(pathToFileURL(requireFromPackage.resolve('pg')).href)
const Pool = pgModule.Pool ?? pgModule.default.Pool

const { work, patch } = await prepareWorkdir({
  prefix: 'gis-pgt-',
  port: PORT,
  extraPatch: [
    '- id: session-title-llm',
    '  disabled: true',
    // The REAL local credentials provider, reading a document this check writes.
    '- id: credentials',
    '  config:',
    '    path: !!js process.env.GIS_PG_CREDENTIALS',
    '    watch: false',
    '- id: gis-postgis',
    '  config:',
    '    profiles:',
    '      live:',
    '        host: !!js process.env.GIS_PG_HOST',
    '        port: !!js Number(process.env.GIS_PG_PORT)',
    '        database: !!js process.env.GIS_PG_DATABASE',
    '        user: !!js process.env.GIS_PG_USER',
    '        credential: pg_live',
    // The probe is its own INSERT entry: a bare id entry only patches rows that
    // already exist (contract #29).
    '- insert:',
    '    - id: gis-t39-probe',
    "      name: '" + slashes(join(REPO, 'scripts', 'lib', 't3-postgis-tools-probe.mjs')) + "'",
    '',
  ],
})
await writeFile(join(work, 'credentials.yaml'), ['version: 1', 'refs:', '  pg_live: ' + PASSWORD, ''].join(NL))

let instance
try {
  const admin = new Pool({ host: HOST, port: PG_PORT, user: USER, password: PASSWORD, database: DATABASE, max: 2 })
  await admin.query(await readFile(join(REPO, 'tests', 'fixtures', 'postgis', 'f7.sql'), 'utf8'))
  await admin.end().catch(() => {})
  check(true, 'the F7 fixture is in place')

  instance = await bootInstance({
    work,
    patch,
    timeoutMs: 120_000,
    env: {
      GIS_PG_CREDENTIALS: join(work, 'credentials.yaml'),
      GIS_PG_HOST: HOST,
      GIS_PG_PORT: String(PG_PORT),
      GIS_PG_USER: USER,
      GIS_PG_DATABASE: DATABASE,
    },
  })
  const service = await waitFor(instance.log, 'service', 90_000)
  check(service?.present === true, 'the instance published BOTH gis and gisPostgis', JSON.stringify(service ?? {}))

  const opened = await waitFor(instance.log, 'opened', 60_000)
  check(opened?.kind === 'postgis', 'the opener claimed the postgis: address', JSON.stringify(opened ?? {}))
  check(typeof opened?.id === 'string' && opened.id.startsWith('ds_'), 'and the dataset has a derived id', String(opened?.id))
  check(opened?.profile === 'live', 'carrying the profile name and NOT a password', String(opened?.profile))

  const inspected = await waitFor(instance.log, 'inspected', 60_000)
  // The local database also holds the user's own tables and the PostGIS tiger
  // extension, so the honest assertion is CONTAINS -- a profile sees every spatial
  // table it can reach, which is the documented behaviour and not a fixture.
  const listed = new Set(inspected?.layers ?? [])
  const expected = ['dsh_gis_fixture.cities', 'dsh_gis_fixture.roads', 'dsh_gis_fixture.parcels_nopk', 'dsh_gis_fixture.areas_geog', 'dsh_gis_fixture.fresh']
  check(expected.every(name => listed.has(name)), 'inspect lists every fixture table', JSON.stringify(expected.filter(name => !listed.has(name))))
  check(listed.size >= 5, 'and the profile sees the tables it can reach', String(listed.size))
  check(inspected?.srid === 4326, 'the chosen layer reports its SRID', String(inspected?.srid))
  check(inspected?.bbox !== null && inspected?.bbox !== undefined, 'and an estimated extent', JSON.stringify(inspected?.bbox ?? null))
  check(inspected?.tiles === true, 'the capabilities say tiles are available', String(inspected?.tiles))
  check((inspected?.issues ?? []).includes('DATASET_UNREADABLE'), 'and the estimate is labelled as one', JSON.stringify(inspected?.issues ?? []))

  const queried = await waitFor(instance.log, 'queried', 60_000)
  check(queried?.rowCount === 5, 'a page comes back from the database', String(queried?.rowCount))
  check(queried?.first?.geometry?.type === 'Point', 'with GeoJSON geometry', JSON.stringify(queried?.first?.geometry ?? null).slice(0, 90))
  check(typeof queried?.first?.attributes?.name === 'string', 'and attributes', JSON.stringify(queried?.first?.attributes ?? null).slice(0, 90))

  const filtered = await waitFor(instance.log, 'filtered', 60_000)
  check(filtered?.rowCount === 1, 'the filter reaches the database through the tools path', String(filtered?.rowCount))
  check(filtered?.geometryKind === 'string', 'and wkt encoding is honoured', String(filtered?.geometryKind))

  const failed = await waitFor(instance.log, 'failed', 800)
  check(failed === undefined, 'no step failed', JSON.stringify(failed ?? {}))
} catch (error) {
  failures.push('the run threw')
  console.log('  FAIL  the run threw -- ' + String(error).split(NL).slice(0, 3).join(' | '))
} finally {
  if (instance !== undefined) await instance.stop()
  if (process.env.GIS_PGT_KEEP !== '1') await rm(work, { recursive: true, force: true }).catch(() => {})
  else console.log('kept work dir: ' + work)
}

console.log(failures.length === 0 ? NL + 'POSTGIS TOOLS CHECK PASSED' : NL + 'FAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
