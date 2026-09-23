/**
 * T2.4: the COG conversion -- its plan, its progress, and its three outcomes.
 *
 * The DoD is "the first conversion has progress and can be cancelled; when the
 * quota is short, REFUSE before failing". So the assertions are about ORDER and
 * about artifacts:
 *
 * - a refused request never spawns anything (the runner is never called);
 * - a cancelled conversion leaves no artifact that a later call could mistake
 *   for a cache hit;
 * - a hit does not run GDAL at all;
 * - and a real `gdal_translate` run produces a file GDAL itself reports as
 *   layout COG -- not "a file appeared".
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DerivedCache, GisError } from '@znlgis/dsh-gis-core'
import {
  buildCogArgv, cogIdentity, convertToCog, estimateCogBytes, parseProgress, type CogRunner,
} from '../src/cog.ts'

const GDAL_BIN = 'C:\\OSGeo4W\\bin'
const hasGdal = existsSync(GDAL_BIN + '\\gdal_translate.exe') && existsSync(GDAL_BIN + '\\gdal_create.exe')

const roots: string[] = []

/** A fresh directory, removed after the test. */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gis-cog-'))
  roots.push(root)
  return root
}

/** A cache with the given quota. */
async function cacheWith(quotaBytes: number): Promise<DerivedCache> {
  return new DerivedCache({ root: join(await temporaryRoot(), 'cache'), quotaBytes: () => quotaBytes })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('the conversion plan is data, not a shell string', () => {
  it('asks GDAL for the COG layout, and does NOT pass -progress', () => {
    // GDAL 3.13 removed the flag and errors on it; progress is the default.
    expect(buildCogArgv('gdal_translate', 'C:/data/in.tif', 'C:/cache/staging.tif'))
      .toEqual(['gdal_translate', '-of', 'COG', 'C:/data/in.tif', 'C:/cache/staging.tif'])
  })

  it('reads the percentage out of a stream that splits it anywhere', () => {
    expect(parseProgress('0...10...20...')).toBe(20)
    expect(parseProgress('20...30...40...')).toBe(40)
    expect(parseProgress('100 - done.')).toBe(100)
    expect(parseProgress('0...10')).toBe(10)
    // A diagnostic is not progress: guessing here would lie to the user.
    expect(parseProgress('ERROR 4: not recognized as a supported file format')).toBeUndefined()
    expect(parseProgress('Input file size is 1, 1')).toBeUndefined()
  })

  it('reserves the source size with a floor, and keys on the source facts', () => {
    expect(estimateCogBytes(1024)).toBe(4 * 1024 * 1024)
    expect(estimateCogBytes(10 * 1024 * 1024)).toBe(10 * 1024 * 1024)
    expect(cogIdentity({ source: 'C:/a.tif', sourceBytes: 1, sourceMtimeMs: 2 }))
      .toEqual({ kind: 'cog', extension: 'tif', source: 'C:/a.tif', sourceSize: 1, sourceMtimeMs: 2, params: { format: 'cog' } })
  })
})

describe('refuse first, fail later', () => {
  it('refuses a request that cannot fit WITHOUT running anything', async () => {
    const cache = await cacheWith(1024 * 1024)
    const source = join(await temporaryRoot(), 'big.tif')
    await writeFile(source, Buffer.alloc(8 * 1024 * 1024))

    let runs = 0
    const run: CogRunner = async () => { runs += 1; return { exitCode: 0, stderr: '', completed: true } }

    await expect(convertToCog({
      source, sourceBytes: 8 * 1024 * 1024, sourceMtimeMs: 1, gdalBinary: 'gdal_translate', cache,
    }, run)).rejects.toMatchObject({ code: 'CACHE_QUOTA_EXCEEDED' })
    expect(runs).toBe(0)
  })

  it('surfaces a failed conversion with the tool_s own last line, and caches nothing', async () => {
    const cache = await cacheWith(64 * 1024 * 1024)
    const source = join(await temporaryRoot(), 'broken.tif')
    await writeFile(source, 'not a raster at all')
    const info = await stat(source)

    const run: CogRunner = async () => ({ exitCode: 1, stderr: 'ERROR 4: not recognized\nmore noise\n', completed: true })
    await expect(convertToCog({
      source, sourceBytes: info.size, sourceMtimeMs: info.mtimeMs, gdalBinary: 'gdal_translate', cache,
    }, run)).rejects.toThrow(/more noise/u)

    expect(await cache.resolve(await keyOf(source, info.size, info.mtimeMs))).toBeUndefined()
  })
})

describe('progress and cancellation', () => {
  it('forwards every percentage GDAL reports', async () => {
    const cache = await cacheWith(64 * 1024 * 1024)
    const source = join(await temporaryRoot(), 'in.tif')
    await writeFile(source, 'x')
    const info = await stat(source)
    const seen: number[] = []

    const run: CogRunner = async (argv, _signal, onText) => {
      await writeFile(argv[argv.length - 1] as string, 'converted bytes')
      // GDAL writes progress WITHOUT line terminators and re-sends its prefix as
      // it flushes, so the runner feeds raw chunks and the converter must report
      // each step once, in order.
      onText('Input file size is 1, 1\n0...10...')
      onText('0...10...20...30...')
      onText('0...10...20...30...40...50...60...70...80...90...100 - done.\n')
      return { exitCode: 0, stderr: '0...10...20...30...40...50...60...70...80...90...100 - done.\n', completed: true }
    }
    const outcome = await convertToCog({
      source, sourceBytes: info.size, sourceMtimeMs: info.mtimeMs, gdalBinary: 'gdal_translate', cache,
      // Only the percentage reports: the byte poller may also fire, and its
      // reports carry no percent (see the dedicated test below).
      onProgress: progress => { if (progress.percent !== undefined) seen.push(progress.percent) },
    }, run)

    // Forward motion only: the size text carries no progress, the re-sent
    // prefixes do not repeat, and each flush reports its new high-water mark.
    expect(seen).toEqual([10, 30, 100])
    expect(outcome.cached).toBe(false)
    expect(await readFile(outcome.path, 'utf8')).toBe('converted bytes')
    expect(outcome.bytes).toBe('converted bytes'.length)
  })

  it('reports the bytes actually written, which is what moves on Windows', async () => {
    // GDAL's progress text is block-buffered by the C runtime when stdout is a
    // pipe, so it can arrive only at exit. The staging file cannot: it grows.
    const cache = await cacheWith(64 * 1024 * 1024)
    const source = join(await temporaryRoot(), 'in.tif')
    await writeFile(source, 'x')
    const info = await stat(source)
    const reports: { bytes: number; percent?: number }[] = []

    const run: CogRunner = async (argv) => {
      const target = argv[argv.length - 1] as string
      for (const size of [1024, 4096, 16384]) {
        await writeFile(target, Buffer.alloc(size, 3))
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      return { exitCode: 0, stderr: '', completed: true }
    }
    await convertToCog({
      source, sourceBytes: info.size, sourceMtimeMs: info.mtimeMs, gdalBinary: 'gdal_translate', cache,
      progressIntervalMs: 10,
      onProgress: progress => { reports.push({ bytes: progress.bytes, ...progress.percent === undefined ? {} : { percent: progress.percent } }) },
    }, run)

    const sizes = reports.map(report => report.bytes)
    expect(sizes.length).toBeGreaterThan(1)
    expect(sizes).toEqual([...sizes].sort((left, right) => left - right))
    expect(sizes.at(-1)).toBe(16384)
    // No fabricated percentage: nothing in this run reported progress text.
    expect(reports.every(report => report.percent === undefined)).toBe(true)
  })

  it('leaves nothing cached when the conversion is cancelled', async () => {
    const cache = await cacheWith(64 * 1024 * 1024)
    const source = join(await temporaryRoot(), 'in.tif')
    await writeFile(source, 'x')
    const info = await stat(source)
    const controller = new AbortController()

    const run: CogRunner = async (argv, signal) => {
      await writeFile(argv[argv.length - 1] as string, 'half written')
      expect(signal?.aborted).toBe(false)
      controller.abort()
      return { exitCode: null, stderr: '', completed: false }
    }
    await expect(convertToCog({
      source, sourceBytes: info.size, sourceMtimeMs: info.mtimeMs, gdalBinary: 'gdal_translate', cache, signal: controller.signal,
    }, run)).rejects.toThrow(/stopped/u)

    // The staging file must be gone: a half-written COG that later looked like a
    // hit would be a silent corruption.
    const pending = await cache.begin(await identityOf(source, info.size, info.mtimeMs), 1024)
    expect(existsSync(pending.staging)).toBe(false)
    await cache.abort(await identityOf(source, info.size, info.mtimeMs))
  })

  it('converts once: the second call is a hit that runs nothing', async () => {
    const cache = await cacheWith(64 * 1024 * 1024)
    const source = join(await temporaryRoot(), 'in.tif')
    await writeFile(source, 'x')
    const info = await stat(source)
    let runs = 0
    const run: CogRunner = async (argv) => {
      runs += 1
      await writeFile(argv[argv.length - 1] as string, 'cog')
      return { exitCode: 0, stderr: '', completed: true }
    }
    const request = { source, sourceBytes: info.size, sourceMtimeMs: info.mtimeMs, gdalBinary: 'gdal_translate', cache }

    const first = await convertToCog(request, run)
    const second = await convertToCog(request, run)
    expect(runs).toBe(1)
    expect(first.key).toBe(second.key)
    expect(second).toMatchObject({ cached: true, path: first.path, bytes: first.bytes })
  })
})

describe.skipIf(!hasGdal)('against the real GDAL', () => {
  it('produces a file GDAL itself reports as layout COG', async () => {
    const work = await temporaryRoot()
    const source = join(work, 'plain.tif')
    const created = spawnSync(join(GDAL_BIN, 'gdal_create.exe'), ['-of', 'GTiff', '-outsize', '32', '32', '-bands', '1', '-burn', '7', source],
      { encoding: 'utf8', env: { ...process.env, PATH: GDAL_BIN + ';' + (process.env.PATH ?? '') } })
    expect(created.status, created.stderr).toBe(0)

    const cache = await cacheWith(64 * 1024 * 1024)
    const info = await stat(source)
    const percents: number[] = []
    const run: CogRunner = async (argv, _signal, onLine) => {
      const result = spawnSync(argv[0] as string, argv.slice(1) as string[], {
        encoding: 'utf8',
        env: { ...process.env, PATH: GDAL_BIN + ';' + (process.env.PATH ?? '') },
      })
      // The real binary's own bytes, handed over exactly as a pipe would.
      onLine(String(result.stdout ?? ''))
      onLine(String(result.stderr ?? ''))
      return { exitCode: result.status, stderr: result.stderr ?? '', completed: result.status !== null }
    }

    const outcome = await convertToCog({
      source, sourceBytes: info.size, sourceMtimeMs: info.mtimeMs,
      gdalBinary: join(GDAL_BIN, 'gdal_translate.exe'), cache,
      onProgress: progress => { if (progress.percent !== undefined) percents.push(progress.percent) },
    }, run)

    expect(outcome.cached).toBe(false)
    expect(outcome.bytes).toBeGreaterThan(0)
    // The real conversion reports its own progress, and it ends at 100.
    expect(percents.at(-1)).toBe(100)
    const info_ = spawnSync(join(GDAL_BIN, 'gdalinfo.exe'), ['-json', outcome.path], {
      encoding: 'utf8', env: { ...process.env, PATH: GDAL_BIN + ';' + (process.env.PATH ?? '') },
    })
    const report = JSON.parse(info_.stdout) as { metadata?: { IMAGE_STRUCTURE?: { LAYOUT?: string } } }
    expect(report.metadata?.IMAGE_STRUCTURE?.LAYOUT).toBe('COG')
  })
})

/** The key a source's COG would live under. */
async function keyOf(source: string, sourceBytes: number, sourceMtimeMs: number): Promise<string> {
  const { deriveCacheKey } = await import('@znlgis/dsh-gis-core')
  return deriveCacheKey(cogIdentity({ source, sourceBytes, sourceMtimeMs }))
}

/** The identity a source's COG would have. */
async function identityOf(source: string, sourceBytes: number, sourceMtimeMs: number) {
  return cogIdentity({ source, sourceBytes, sourceMtimeMs })
}
