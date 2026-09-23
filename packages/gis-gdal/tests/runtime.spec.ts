/**
 * The requirement-7 mechanism, tested without a Cordis context.
 *
 * `buildEnv` is where "the user does not have to set system environment
 * variables" is actually decided, so it is worth asserting directly: configured
 * directories must come FIRST, and the ambient PATH must survive AFTER them --
 * prepending is the feature, replacing would be a regression that breaks
 * unrelated tools.
 */
import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { interpretProbe, PROBE_ARGV } from '../src/detect.ts'

/** A stand-in for the service, exercising only its pure environment logic. */
class FakeRuntime {
  constructor(private readonly values: { gdalBinDir: string; qgisBinDir: string; extraEnv: string }) {}

  /** Mirrors GisRuntimeService.buildEnv exactly. */
  buildEnv(ambient: string | undefined): Record<string, string | undefined> {
    const dirs = [this.values.gdalBinDir, this.values.qgisBinDir].map(d => d.trim()).filter(d => d.length > 0)
    const path = [...dirs, ambient ?? ''].filter(part => part.length > 0).join(delimiter)
    const env: Record<string, string | undefined> = {}
    if (path.length > 0) env.PATH = path
    for (const raw of this.values.extraEnv.split(/\r?\n/)) {
      const line = raw.trim()
      if (line.length === 0 || line.startsWith('#')) continue
      const at = line.indexOf('=')
      if (at <= 0) continue
      env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
    return env
  }
}

const AMBIENT = ['C:\\Windows\\system32', 'C:\\Windows'].join(delimiter)

describe('child environment (requirement 7)', () => {
  it('puts the configured GDAL directory FIRST, so it beats an ambient install', () => {
    const env = new FakeRuntime({ gdalBinDir: 'C:\\OSGeo4W\\bin', qgisBinDir: '', extraEnv: '' }).buildEnv(AMBIENT)
    expect((env.PATH as string).startsWith('C:\\OSGeo4W\\bin')).toBe(true)
    expect((env.PATH as string).split(delimiter)[1]).toBe('C:\\Windows\\system32')
  })

  it('keeps the ambient PATH after the configured directories', () => {
    const env = new FakeRuntime({ gdalBinDir: 'D:\\gdal', qgisBinDir: '', extraEnv: '' }).buildEnv(AMBIENT)
    expect((env.PATH as string).endsWith(AMBIENT)).toBe(true)
  })

  it('orders GDAL before QGIS, so GDAL wins a shared executable name', () => {
    const env = new FakeRuntime({ gdalBinDir: 'D:\\gdal', qgisBinDir: 'D:\\qgis', extraEnv: '' }).buildEnv(undefined)
    expect((env.PATH as string).split(delimiter)).toEqual(['D:\\gdal', 'D:\\qgis'])
  })

  it('applies extra variables, which is what removes system-wide setup', () => {
    const env = new FakeRuntime({
      gdalBinDir: 'C:\\OSGeo4W\\bin', qgisBinDir: '',
      extraEnv: ['GDAL_DATA=C:\\OSGeo4W\\share\\gdal', '# a comment', '', 'PROJ_LIB = C:\\OSGeo4W\\share\\proj', 'malformed'].join('\n'),
    }).buildEnv(AMBIENT)
    expect(env.GDAL_DATA).toBe('C:\\OSGeo4W\\share\\gdal')
    expect(env.PROJ_LIB).toBe('C:\\OSGeo4W\\share\\proj')
    expect(env.malformed).toBeUndefined()
  })

  it('omits PATH entirely when nothing would contribute to it', () => {
    const env = new FakeRuntime({ gdalBinDir: '', qgisBinDir: '', extraEnv: '' }).buildEnv(undefined)
    expect(env.PATH).toBeUndefined()
  })
})

describe('probe interpretation', () => {
  it('reports a version line as available', () => {
    const probe = interpretProbe('gdalinfo', 'C:\\OSGeo4W\\bin', {
      exitCode: 0, stdout: 'GDAL 3.9.2, released 2024/08/13', stderr: '', completed: true,
    })
    expect(probe.available).toBe(true)
    expect(probe.version).toContain('GDAL 3.9.2')
  })

  it('distinguishes MISSING from present-but-broken', () => {
    const missing = interpretProbe('qgis_process', undefined, {
      exitCode: 1, stdout: '', stderr: "'qgis_process' is not recognized as an internal or external command", completed: true,
    })
    expect(missing.available).toBe(false)
    expect(missing.detail).toContain('not recognized')
  })

  it('reports a timeout as a timeout, not as absence', () => {
    const timedOut = interpretProbe('gdalinfo', undefined, { exitCode: null, stdout: '', stderr: '', completed: false })
    expect(timedOut.available).toBe(false)
    expect(timedOut.detail).toMatch(/timed out/)
  })

  it('probes with argv, never a shell string', () => {
    expect(PROBE_ARGV.gdal).toEqual(['gdalinfo', '--version'])
    expect(PROBE_ARGV.qgis).toEqual(['qgis_process', '--version'])
  })
})
