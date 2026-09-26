/**
 * T3.5: the geodatabase gates, their message KEYS, and the promise that this build
 * never writes one.
 *
 * The plan's acceptance criterion says to assert the message KEY rather than a
 * finished sentence, so these tests never match user-facing wording -- they match
 * the contract a caller switches on. The version boundaries (1.11 read, 3.6 write)
 * are asserted ON the boundary, because a gate that is off by one is exactly the
 * kind of thing that only shows up on one user's machine.
 */
import { describe, expect, it } from 'vitest'
import {
  GDB_MIN_READ,
  GDB_MIN_WRITE,
  listGdbLayers,
  meetsGate,
  parseGdalVersion,
  parseOgrInfo,
  probeGdbSupport,
  readDiagnostic,
  writeDiagnostic,
  type GdalRunner,
} from '../src/gdb.ts'

const REAL_OUTPUT = 'GDAL 3.13.3 "Iowa City", released 2026/08/13'

/** A runner that answers from a script and records what it was asked. */
function scriptedRunner(answers: Record<string, { stdout: string; code: number }>) {
  const asked: string[] = []
  const run: GdalRunner = async (program, argv) => {
    const key = program + ' ' + argv.join(' ')
    asked.push(key)
    return answers[key] ?? { stdout: '', code: 1 }
  }
  return { run, asked }
}

describe('reading a version out of GDAL output', () => {
  it('parses the real string', () => {
    const version = parseGdalVersion(REAL_OUTPUT)
    expect(version).toMatchObject({ major: 3, minor: 13, patch: 3, development: false })
    expect(version?.text).toBe('3.13.3')
  })

  it('accepts a development build without pretending it is a release', () => {
    const version = parseGdalVersion('GDAL 3.11.0dev-abc1234, released 2025/01/01')
    expect(version).toMatchObject({ major: 3, minor: 11, patch: 0, development: true })
  })

  it('accepts a two-part version, and refuses nonsense', () => {
    expect(parseGdalVersion('GDAL 3.6')).toMatchObject({ major: 3, minor: 6, patch: 0 })
    expect(parseGdalVersion('no version here')).toBeUndefined()
  })
})

describe('the gates', () => {
  it('reads at exactly 1.11 and refuses 1.10', () => {
    expect(meetsGate({ major: 1, minor: 11, patch: 0, text: '1.11', development: false }, GDB_MIN_READ)).toBe(true)
    expect(meetsGate({ major: 1, minor: 10, patch: 9, text: '1.10.9', development: false }, GDB_MIN_READ)).toBe(false)
    // A newer MAJOR always passes, whatever the minor says.
    expect(meetsGate({ major: 2, minor: 0, patch: 0, text: '2.0', development: false }, GDB_MIN_READ)).toBe(true)
  })

  it('writes at exactly 3.6 and refuses 3.5', () => {
    expect(meetsGate({ major: 3, minor: 6, patch: 0, text: '3.6', development: false }, GDB_MIN_WRITE)).toBe(true)
    expect(meetsGate({ major: 3, minor: 5, patch: 3, text: '3.5.3', development: false }, GDB_MIN_WRITE)).toBe(false)
  })
})

describe('what the user is told', () => {
  it('answers with a KEY and the numbers, never a sentence', () => {
    const old = readDiagnostic({ driverPresent: true, version: parseGdalVersion('GDAL 1.10.0')! })
    expect(old.key).toBe('gdb.read.too-old')
    expect(old.ok).toBe(false)
    expect(old.detail).toEqual({ found: '1.10.0', need: '1.11' })

    const missing = readDiagnostic({ driverPresent: false })
    expect(missing.key).toBe('gdb.driver.missing')
    expect(missing.ok).toBe(false)

    const fine = readDiagnostic({ driverPresent: true, version: parseGdalVersion(REAL_OUTPUT) })
    expect(fine.key).toBe('gdb.read.ok')
    expect(fine.ok).toBe(true)
  })

  it('explains the READ-ONLY choice instead of leaving it a mystery', () => {
    // A GDAL new enough to write is reported as such -- with the build's own
    // read-only decision attached, because that is what the user is actually
    // experiencing.
    const canWrite = writeDiagnostic({ driverPresent: true, version: parseGdalVersion(REAL_OUTPUT) })
    expect(canWrite.key).toBe('gdb.write.available')
    expect(canWrite.detail.readOnly).toBe(true)

    const cannotWrite = writeDiagnostic({ driverPresent: true, version: parseGdalVersion('GDAL 3.5.3') })
    expect(cannotWrite.key).toBe('gdb.write.too-old')
    expect(cannotWrite.detail).toEqual({ found: '3.5.3', need: '3.6' })
  })
})

describe('the probe and the listing', () => {
  it('finds OpenFileGDB by asking GDAL, not by assuming', async () => {
    const { run, asked } = scriptedRunner({
      'ogrinfo --formats': { stdout: '  OpenFileGDB -vector- (rw+v): ESRI FileGDB', code: 0 },
      'gdalinfo --version': { stdout: REAL_OUTPUT, code: 0 },
    })
    const environment = await probeGdbSupport(run)
    expect(environment.driverPresent).toBe(true)
    expect(environment.version?.text).toBe('3.13.3')
    expect(asked.sort()).toEqual(['gdalinfo --version', 'ogrinfo --formats'])
  })

  it('does not run the binary when the gate already says no', async () => {
    const { run, asked } = scriptedRunner({})
    const refusal = await listGdbLayers('C:/data/x.gdb', run, {
      driverPresent: true,
      version: parseGdalVersion('GDAL 1.9.0')!,
    }).then(() => undefined, error => error)
    // The key travels in the message, so a caller can react without matching prose.
    expect(String(refusal?.message)).toContain('gdb.read.too-old')
    expect(asked).toEqual([])
  })

  it('reads the layer list GDAL actually produces', () => {
    // Captured from ogrinfo -json -so on the committed cities.gdb fixture.
    const layers = parseOgrInfo(JSON.stringify({
      layers: [
        { name: 'cities_gbk', geometryFields: [{ name: 'geom', geometryType: 'Point' }], featureCount: 12 },
        { name: 'no_geometry', geometryFields: [], featureCount: 3 },
      ],
    }))
    expect(layers).toEqual([
      { name: 'cities_gbk', geometryType: 'Point', featureCount: 12 },
      { name: 'no_geometry', geometryType: 'Unknown', featureCount: 3 },
    ])
  })

  it('refuses output that is not JSON instead of inventing layers', () => {
    expect(() => parseOgrInfo('ogrinfo: command not found')).toThrowError(/not JSON/u)
  })
})

describe('this build does not write geodatabases', () => {
  it('ships no write function at all', async () => {
    // The plan is explicit: reading only. The strongest form of that promise is a
    // module that offers nothing to call.
    const module = await import('../src/gdb.ts') as Record<string, unknown>
    // Only FUNCTIONS count: GDB_MIN_WRITE is a version constant, and
    // writeDiagnostic describes the capability rather than exercising it.
    const writers = Object.entries(module)
      .filter(([name, value]) => typeof value === 'function' && /write|create|update|delete|insert/iu.test(name))
      .map(([name]) => name)
    expect(writers).toEqual(['writeDiagnostic'])
  })
})
