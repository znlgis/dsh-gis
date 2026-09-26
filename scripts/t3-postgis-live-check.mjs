/**
 * T3.2 against a REAL PostGIS: the catalogue, its estimates, and the promise that
 * listing layers never counts rows.
 *
 * Everything here runs against the local server named by GIS_PG_* (defaults:
 * 127.0.0.1:5432, postgres/postgres). The fixture is created in its OWN schema
 * (dsh_gis_fixture, dropped and recreated) so nothing else on that server is
 * touched.
 *
 * The load-bearing assertions:
 *
 * 1. every spatial column is found -- INCLUDING the geography one, which lives in
 *    a different catalogue view and is silently missing from a viewer that reads
 *    only geometry_columns;
 * 2. row counts are ESTIMATES: present for analyzed tables, "unknown" for the one
 *    that was never analyzed, with a reason -- not a zero, and not an error;
 * 3. the extents come from the statistics, with a reason when there are none;
 * 4. **NO count(*) is ever sent**. The statements are recorded on their way to the
 *    server, so this is asserted on the actual traffic rather than on intent;
 * 5. the session really is read-only and really is capped.
 *
 * Usage: node scripts/t3-postgis-live-check.mjs
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const HOST = process.env.GIS_PG_HOST ?? '127.0.0.1'
const PORT = Number(process.env.GIS_PG_PORT ?? 5432)
const USER = process.env.GIS_PG_USER ?? 'postgres'
const PASSWORD = process.env.GIS_PG_PASSWORD ?? 'postgres'
const DATABASE = process.env.GIS_PG_DATABASE ?? 'postgres'
const SCHEMA = 'dsh_gis_fixture'
const failures = []

/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

// `pg` is a dependency of the PACKAGE, not of the repository root, and pnpm's
// strict layout means the root cannot see it. Resolving it from the package that
// declares it is the honest way to load the same driver the plugin loads.
const requireFromPackage = createRequire(join(REPO, 'packages', 'gis-postgis', 'package.json'))
const pgModule = await import(pathToFileURL(requireFromPackage.resolve('pg')).href)
const Pool = pgModule.Pool ?? pgModule.default.Pool
const pgis = await import(pathToFileURL(join(REPO, 'packages', 'gis-postgis', 'lib', 'index.js')).href)
const { CATALOG_SQL, PostgisProfiles, PostgisConnections, postgisConfigSchema, readCatalog } = pgis

const admin = new Pool({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE, max: 2 })
try {
  // ---- fixture -----------------------------------------------------------------
  await admin.query(await readFile(join(REPO, 'tests', 'fixtures', 'postgis', 'f7.sql'), 'utf8'))
  check(true, 'the F7 fixture was (re)created in ' + SCHEMA)

  // ---- the catalogue through OUR code -------------------------------------------
  const config = postgisConfigSchema.parse({
    profiles: { live: { host: HOST, port: PORT, database: DATABASE, user: USER, credential: 'pg_live' } },
  })
  const profiles = new PostgisProfiles(config, () => ({
    resolve: async () => ({ value: PASSWORD }),
    describe: async () => ({ configured: true }),
  }))
  const connections = new PostgisConnections(profiles)
  const connection = await connections.forProfile('live')

  // Recording wrapper: the assertions below are about the TRAFFIC, so the traffic
  // is captured rather than inferred from the code that produces it.
  const sent = []
  const recorder = {
    query: async (text, values) => {
      sent.push(text)
      return await connection.query(text, values)
    },
  }

  const layers = await readCatalog(recorder)
  const ours = layers.filter(layer => layer.schema === SCHEMA)
  const names = ours.map(layer => layer.table).sort()
  check(names.length === 5, 'every table with a spatial column is listed', JSON.stringify(names))
  check(JSON.stringify(names) === JSON.stringify(['areas_geog', 'cities', 'fresh', 'parcels_nopk', 'roads']), 'the expected five are there', JSON.stringify(names))

  const geog = ours.find(layer => layer.table === 'areas_geog')
  check(geog?.spatialKind === 'geography', 'the GEOGRAPHY column is found (it is absent from geometry_columns)', JSON.stringify(geog ?? {}))
  check(geog?.geometryType === 'Polygon', 'its declared type comes through', String(geog?.geometryType))

  const cities = ours.find(layer => layer.table === 'cities')
  check(cities?.srid === 4326 && cities.geometryType === 'Point', 'a geometry column carries its SRID and type', JSON.stringify(cities ?? {}))
  check((cities?.estimatedRows ?? 0) >= 1 && cities.rowsKnown, 'an ANALYZEd table reports an estimate', JSON.stringify({ rows: cities?.estimatedRows, known: cities?.rowsKnown }))

  const parcels = ours.find(layer => layer.table === 'parcels_nopk')
  check(parcels !== undefined, 'a table with NO PRIMARY KEY is still listed', JSON.stringify(parcels ?? {}))

  const fresh = ours.find(layer => layer.table === 'fresh')
  check(fresh?.rowsKnown === false && fresh.estimatedRows === -1, 'a never-analyzed table reports UNKNOWN rows, not zero', JSON.stringify({ rows: fresh?.estimatedRows, known: fresh?.rowsKnown }))

  // ---- metadata: extents from statistics ---------------------------------------
  const { readLayerMetadata } = pgis
  const citiesMetaResult = await readLayerMetadata(recorder, cities)
  check(citiesMetaResult.extent !== undefined, 'an ANALYZEd table has an estimated extent', JSON.stringify(citiesMetaResult.extent ?? citiesMetaResult.extentUnknownReason))
  const extent = citiesMetaResult.extent
  check(extent !== undefined && extent.minX > 99 && extent.minX < 102 && extent.maxY > 29 && extent.maxY < 33, 'the extent is in the data\'s own range', JSON.stringify(extent ?? {}))

  const freshMeta = await readLayerMetadata(recorder, fresh)
  check(freshMeta.extent === undefined && typeof freshMeta.extentUnknownReason === 'string', 'a table without statistics says WHY the extent is unknown', String(freshMeta.extentUnknownReason))
  check(/ANALYZE/u.test(String(freshMeta.extentUnknownReason)), 'and the reason is actionable', String(freshMeta.extentUnknownReason))

  // ---- the promise: no count(*) -------------------------------------------------
  const counts = sent.filter(statement => /count\s*\(/iu.test(statement))
  check(counts.length === 0, 'NO count(*) was ever sent to the server', JSON.stringify(counts))
  const catalogCalls = sent.filter(statement => statement === CATALOG_SQL)
  check(catalogCalls.length === 1, 'the catalogue is ONE round trip, not one query per layer', String(catalogCalls.length))
  check(!/reltuples/iu.test(sent.filter(s => s !== CATALOG_SQL).join(' ')), 'estimates come from the catalogue query, not from extra lookups')

  // ---- session properties -------------------------------------------------------
  const ro = await connection.query('SHOW default_transaction_read_only')
  check(String(ro.rows[0]?.default_transaction_read_only) === 'on', 'the session is READ-ONLY by default', JSON.stringify(ro.rows[0]))
  const write = await connection.query('CREATE TABLE ' + SCHEMA + '.should_not_exist (id int)').then(() => 'allowed', error => String(error.message))
  check(/read-only|read only/iu.test(String(write)), 'a write is refused by the DATABASE, not by a code path', String(write).slice(0, 160))
  const timeout = await connection.query('SHOW statement_timeout')
  check(String(timeout.rows[0]?.statement_timeout) === '15s', 'the statement cap from the profile is in force', JSON.stringify(timeout.rows[0]))

  await connections.closeAll()
} catch (error) {
  failures.push('the run threw')
  console.log('  FAIL  the run threw -- ' + String(error).split('\n').slice(0, 3).join(' | '))
} finally {
  await admin.end().catch(() => {})
}

console.log(failures.length === 0 ? '\nPOSTGIS LIVE CHECK PASSED' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
