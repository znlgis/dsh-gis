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
} catch (error) {
  failures.push('the run threw')
  console.log('  FAIL  the run threw -- ' + String(error).split('\n').slice(0, 3).join(' | '))
}

console.log(failures.length === 0 ? '\nGDB CHECK PASSED' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
