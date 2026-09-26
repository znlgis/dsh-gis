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
/**
 * A minimal Mapbox Vector Tile reader, in the check rather than in a dependency.
 *
 * "The database returned some bytes" is not evidence that the bytes are a TILE.
 * This decodes the protobuf far enough to name the layer, count its features and
 * see a real geometry command, which is what makes the assertion about a vector
 * tile rather than about a byte array.
 * @param bytes - the tile.
 * @returns what the tile says about itself.
 */
function decodeMvt(bytes) {
  let at = 0
  /** Read one varint. */
  const varint = () => {
    let result = 0
    let shift = 0
    for (;;) {
      const byte = bytes[at]
      at += 1
      result += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return result
      shift += 7
    }
  }
  /** Read a length-delimited field's bytes. */
  const sized = () => {
    const length = varint()
    const slice = bytes.subarray(at, at + length)
    at += length
    return slice
  }
  const layers = []
  while (at < bytes.length) {
    const tag = varint()
    const field = tag >> 3
    const wire = tag & 7
    if (field === 3 && wire === 2) layers.push(decodeLayer(sized()))
    else if (wire === 2) sized()
    else if (wire === 0) varint()
    else if (wire === 5) at += 4
    else if (wire === 1) at += 8
    else break
  }
  return { layers }

  /** Decode one layer message. */
  function decodeLayer(slice) {
    let cursor = 0
    let name = ''
    let extent = 0
    let features = 0
    let firstType
    let firstGeometryCommands = 0
    const keys = []
    const read = () => {
      let result = 0
      let shift = 0
      for (;;) {
        const byte = slice[cursor]
        cursor += 1
        result += (byte & 0x7f) * 2 ** shift
        if ((byte & 0x80) === 0) return result
        shift += 7
      }
    }
    const take = () => {
      const length = read()
      const part = slice.subarray(cursor, cursor + length)
      cursor += length
      return part
    }
    while (cursor < slice.length) {
      const tag = read()
      const field = tag >> 3
      const wire = tag & 7
      if (field === 1 && wire === 2) name = Buffer.from(take()).toString('utf8')
      else if (field === 2 && wire === 2) {
        const feature = decodeFeature(take())
        if (features === 0) {
          firstType = feature.type
          firstGeometryCommands = feature.geometryCommands
        }
        features += 1
      } else if (field === 3 && wire === 2) keys.push(Buffer.from(take()).toString('utf8'))
      else if (field === 5 && wire === 0) extent = read()
      else if (wire === 2) take()
      else if (wire === 0) read()
      else if (wire === 5) cursor += 4
      else if (wire === 1) cursor += 8
      else break
    }
    return { name, extent, features, keys, firstType, firstGeometryCommands }
  }

  /** Decode one feature message, far enough to see its type and geometry. */
  function decodeFeature(slice) {
    let cursor = 0
    let type
    let geometryCommands = 0
    const read = () => {
      let result = 0
      let shift = 0
      for (;;) {
        const byte = slice[cursor]
        cursor += 1
        result += (byte & 0x7f) * 2 ** shift
        if ((byte & 0x80) === 0) return result
        shift += 7
      }
    }
    while (cursor < slice.length) {
      const tag = read()
      const field = tag >> 3
      const wire = tag & 7
      if (field === 3 && wire === 0) type = read()
      else if (field === 4 && wire === 2) geometryCommands = read()
      else if (wire === 2) { const length = read(); cursor += length }
      else if (wire === 0) read()
      else if (wire === 5) cursor += 4
      else if (wire === 1) cursor += 8
      else break
    }
    return { type, geometryCommands }
  }
}

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

  // ---- T3.3: pages --------------------------------------------------------------
  const { readPage } = pgis
  const first = await readPage(recorder, cities, { limit: 5 })
  check(first.features.length === 5, 'a page carries the requested number of features', String(first.features.length))
  check(first.orderBy === 'id', 'a table WITH a primary key is ordered by it', String(first.orderBy))
  check(first.hasMore === true, 'a full page says more may follow')
  const firstIds = first.features.map(feature => feature.properties.id)
  check(firstIds.every(id => typeof id === 'number'), 'attribute values cross as JSON-safe values', JSON.stringify(firstIds))
  const point = first.features[0]?.geometry
  check(point !== null && typeof point === 'object' && point.type === 'Point' && Array.isArray(point.coordinates), 'geometry crosses as GeoJSON, encoded by the DATABASE', JSON.stringify(point).slice(0, 120))
  const props = Object.keys(first.features[0]?.properties ?? {})
  check(!props.includes('geom'), 'the spatial column is not duplicated into the properties', JSON.stringify(props))
  check(!props.includes('__geometry'), 'the geometry carrier column does not leak into the properties', JSON.stringify(props))

  const second = await readPage(recorder, cities, { limit: 5, offset: 5 })
  const secondIds = second.features.map(feature => feature.properties.id)
  const overlap = secondIds.filter(id => firstIds.includes(id))
  check(overlap.length === 0, 'the second page does not repeat the first (the page is ORDERED)', JSON.stringify({ first: firstIds, second: secondIds }))

  const noPk = await readPage(recorder, parcels, { limit: 3 })
  check(noPk.orderBy === 'ctid', 'a table WITHOUT a primary key falls back to ctid and SAYS so', String(noPk.orderBy))
  check(noPk.features.length === 3, 'and it still pages', String(noPk.features.length))

  const geogPage = await readPage(recorder, geog, { limit: 2 })
  check(geogPage.features[0]?.geometry !== null && geogPage.features[0]?.geometry?.type === 'Polygon', 'a GEOGRAPHY column pages too (cast to geometry for encoding)', JSON.stringify(geogPage.features[0]?.geometry ?? null).slice(0, 120))

  const over = await readPage(recorder, cities, { limit: 5000 }).then(() => 'allowed', error => String(error.message))
  check(/at most 1000/u.test(over), 'an over-large page is REFUSED, not silently clamped', String(over).slice(0, 140))

  // ---- T3.3: the statement cap, on a REAL slow query ----------------------------
  const slowConfig = postgisConfigSchema.parse({
    profiles: { slow: { host: HOST, port: PORT, database: DATABASE, user: USER, credential: 'pg_live', statementTimeoutMs: 500 } },
  })
  const slowProfiles = new PostgisProfiles(slowConfig, () => ({
    resolve: async () => ({ value: PASSWORD }),
    describe: async () => ({ configured: true }),
  }))
  const slowConnections = new PostgisConnections(slowProfiles)
  const slowConnection = await slowConnections.forProfile('slow')
  const began = Date.now()
  const slow = await slowConnection.query('SELECT pg_sleep(3)').then(() => undefined, error => error)
  const elapsed = Date.now() - began
  check(slow?.code === 'SQL_TIMEOUT', 'a slow query is reported as SQL_TIMEOUT', slow?.code ?? String(slow))
  check(elapsed < 2500, 'and it was cut off by the SERVER, not waited out', String(elapsed) + ' ms')
  const slowWrite = await slowConnection.query('CREATE TABLE ' + SCHEMA + '.should_not_exist_either (id int)').then(() => 'allowed', error => String(error.message))
  check(/read-only|read only/iu.test(String(slowWrite)), 'the second profile is read-only too', String(slowWrite).slice(0, 120))
  await slowConnections.closeAll()


  // ---- T3.4: server-side tiles --------------------------------------------------
  const { readTile } = pgis
  // The fixture sits near 100E/30N; zoom 6 covers it in one tile.
  const tileX = Math.floor(((100.5 + 180) / 360) * 2 ** 6)
  const latRad = (30.5 * Math.PI) / 180
  const tileY = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** 6)
  const tile = await readTile(recorder, cities, { z: 6, x: tileX, y: tileY }, ['name'])
  check(tile.data.length > 0, 'the database produced a non-empty tile', String(tile.data.length) + ' bytes')
  const decoded = decodeMvt(tile.data)
  check(decoded.layers.length === 1, 'the tile contains exactly one layer', JSON.stringify(decoded.layers.map(layer => layer.name)))
  check(decoded.layers[0]?.name === 'dsh_gis_fixture.cities', 'the layer is named after its source', String(decoded.layers[0]?.name))
  check(decoded.layers[0]?.extent === 4096, 'the tile declares the extent we asked for', String(decoded.layers[0]?.extent))
  // The fixture spans 100.1..104 E, so THIS z=6 tile (95.6..101.25 E) holds only the
  // western part of it: asserting 40 would be asserting my arithmetic, not the tile.
  check((decoded.layers[0]?.features ?? 0) > 0, 'the tile carries features', String(decoded.layers[0]?.features))
  const coarse = decodeMvt((await readTile(recorder, cities, { z: 2, x: 3, y: 1 })).data)
  check(coarse.layers[0]?.features === 40, 'a coarser tile over the same data holds every feature', String(coarse.layers[0]?.features))
  check(decoded.layers[0]?.firstType === 1, 'the first feature is a POINT (type 1)', String(decoded.layers[0]?.firstType))
  check((decoded.layers[0]?.firstGeometryCommands ?? 0) >= 2, 'and it carries real geometry commands', String(decoded.layers[0]?.firstGeometryCommands))
  check(decoded.layers[0]?.keys.includes('name'), 'the requested attribute travelled into the tile', JSON.stringify(decoded.layers[0]?.keys))

  const empty = await readTile(recorder, cities, { z: 6, x: 0, y: 0 })
  check(empty.data.length === 0, 'a tile with nothing in it is EMPTY, not an error', String(empty.data.length))

  const noSrid = await readTile(recorder, { ...cities, srid: 0 }, { z: 6, x: tileX, y: tileY }).then(() => undefined, error => error)
  check(noSrid?.code === 'CRS_UNKNOWN', 'a layer with no SRID is refused rather than guessed at', String(noSrid?.code))

  const tiled = sent.filter(statement => /ST_AsMVT/iu.test(statement))
  check(tiled.length >= 1, 'tiles are built by the DATABASE (ST_AsMVT in the traffic)', String(tiled.length))

  await connections.closeAll()
} catch (error) {
  failures.push('the run threw')
  console.log('  FAIL  the run threw -- ' + String(error).split('\n').slice(0, 3).join(' | '))
} finally {
  await admin.end().catch(() => {})
}

console.log(failures.length === 0 ? '\nPOSTGIS LIVE CHECK PASSED' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
