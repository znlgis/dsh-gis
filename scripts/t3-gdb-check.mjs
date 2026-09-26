/**
 * T3.5 against the REAL GDAL: is OpenFileGDB there, do the version gates pass, and
 * does the committed fixture enumerate its feature classes.
 *
 * The unit tests pin the boundaries with scripted versions. This runs the actual
 * binaries, because "the gate is right" and "this machine can read a geodatabase"
 * are two different claims -- and only the second is what a user experiences.
 *
 * The package bundles everything into one entry (lib/index.js), so that is where
 * the gates come from.
 *
 * Usage: node scripts/t3-gdb-check.mjs
 */
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const GDAL_BIN = process.env.GDAL_BIN ?? 'C:\\OSGeo4W\\bin'
const failures = []

/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

/** Run one GDAL program, the way the plugin's own runner does. */
function run(program, argv) {
  return new Promise((resolve) => {
    const child = spawn(join(GDAL_BIN, program + '.exe'), [...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { out += String(chunk) })
    child.on('error', () => { resolve({ stdout: '', code: 127 }) })
    child.on('close', code => { resolve({ stdout: out, code: code ?? 1 }) })
  })
}

const gates = await import(pathToFileURL(join(REPO, 'packages', 'gis-gdal', 'lib', 'index.js')).href)
const { GDB_MIN_READ, GDB_MIN_WRITE, listGdbLayers, parseGdalVersion, probeGdbSupport, readDiagnostic, writeDiagnostic } = gates

try {
  check(typeof probeGdbSupport === 'function', 'the gate module is exported from the built package')
  check(GDB_MIN_READ.join('.') === '1.11' && GDB_MIN_WRITE.join('.') === '3.6', 'the gates are the ones the plan names', GDB_MIN_READ.join('.') + ' / ' + GDB_MIN_WRITE.join('.'))

  const environment = await probeGdbSupport(run)
  check(environment.driverPresent, 'this GDAL build HAS the OpenFileGDB driver', JSON.stringify(environment))
  check(environment.version !== undefined, 'its version was parsed', JSON.stringify(environment.version ?? {}))
  check(environment.version?.major === 3, 'and it is a GDAL 3.x', String(environment.version?.text))

  const read = readDiagnostic(environment)
  check(read.key === 'gdb.read.ok' && read.ok, 'reading is allowed at this version', JSON.stringify(read))
  const write = writeDiagnostic(environment)
  // The build is read-only by product decision; the diagnostic says the CAPABILITY
  // exists and that this build does not use it.
  check(write.key === 'gdb.write.available' && write.detail.readOnly === true, 'writing is reported as available in GDAL but unused here', JSON.stringify(write))

  const dir = join(REPO, 'tests', 'fixtures', 'cities.gdb')
  check(existsSync(dir), 'the committed geodatabase fixture is present', dir)
  const layers = await listGdbLayers(dir, run, environment)
  check(layers.length >= 1, 'every feature class is enumerated', JSON.stringify(layers))
  check(layers.some(layer => layer.name === 'cities_gbk'), 'the fixture layer is among them', JSON.stringify(layers.map(layer => layer.name)))
  check(layers.every(layer => typeof layer.geometryType === 'string' && layer.geometryType.length > 0), 'each one reports a geometry type', JSON.stringify(layers))

  // A version that cannot read must be refused WITHOUT running the binary.
  const asked = []
  const refusingRun = async (program, argv) => { asked.push(program + ' ' + argv.join(' ')); return { stdout: '', code: 1 } }
  const refusal = await listGdbLayers(dir, refusingRun, { driverPresent: true, version: parseGdalVersion('GDAL 1.9.0') })
    .then(() => undefined, error => error)
  check(String(refusal?.message ?? '').includes('gdb.read.too-old'), 'an old GDAL is refused by KEY, not by a sentence', String(refusal?.message ?? '').slice(0, 100))
  check(asked.length === 0, 'and the binary was never invoked', JSON.stringify(asked))

  // ---- T3.6: every feature class is browsable ------------------------------------
  const { createGdalHandler } = gates
  check(typeof createGdalHandler === 'function', 'the GDAL handler is exported from the built package')

  // A real runtime: the same slice the service satisfies, backed by the same
  // binaries. The handler is exercised directly, so this is our code + real GDAL
  // with no host in between.
  const runtime = {
    run: async (request) => {
      const [program, ...argv] = request.argv
      const result = await run(program, argv)
      return { exitCode: result.code, stdout: result.stdout, stderr: '' }
    },
  }
  const handler = createGdalHandler(runtime)
  const multi = {
    id: 'ds_multi',
    kind: 'gdb',
    title: 'multi.gdb',
    dir: join(REPO, 'tests', 'fixtures', 'multi.gdb'),
    layers: [{ name: 'multi.gdb' }],
  }

  const all = await handler.inspect(multi)
  const names = all.layers.map(layer => layer.name).sort()
  check(names.length === 2, 'a multi-layer geodatabase reports EVERY feature class', JSON.stringify(names))
  check(JSON.stringify(names) === JSON.stringify(['cities', 'projected_areas']), 'and they are the fixture layers', JSON.stringify(names))
  check(all.issues.some(issue => issue.code === 'LAYER_AMBIGUOUS'), 'and it says that a layer must be chosen', JSON.stringify(all.issues.map(issue => issue.code)))

  for (const name of names) {
    const one = await handler.inspect(multi, name)
    check(one.layers.length === 1 && one.layers[0].name === name, 'layer ' + name + ' can be described on its own')
    const page = await handler.query(multi, { layer: name, limit: 3, offset: 0, geometry: 'geojson' })
    check(page.rows.length > 0, 'layer ' + name + ' can be READ (features came back)', String(page.rows.length))
    check(page.rows.every(row => row.geometry !== undefined && row.geometry !== null), 'layer ' + name + ' returns geometry', JSON.stringify(page.rows[0]?.geometry ?? null).slice(0, 80))
  }

  const missing = await handler.inspect(multi, 'no_such_layer').then(() => undefined, error => error)
  check(missing?.code === 'LAYER_NOT_FOUND', 'an unknown layer name is refused by CODE', String(missing?.code))

  // A container with several layers and no layer named is REFUSED rather than
  // guessed at: reading whichever layer happens to be first is the kind of answer
  // that looks right and is not.
  const ambiguous = await handler.query(multi, { limit: 1, offset: 0, geometry: 'geojson' }).then(() => undefined, error => error)
  check(ambiguous?.code === 'LAYER_AMBIGUOUS', 'a layer-less query on a container is refused by CODE', String(ambiguous?.code))

} catch (error) {
  failures.push('the run threw')
  console.log('  FAIL  the run threw -- ' + String(error).split('\n').slice(0, 3).join(' | '))
}

console.log(failures.length === 0 ? '\nGDB CHECK PASSED' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
