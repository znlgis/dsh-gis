/**
 * T1a.2: the dataset registry, durable and honest about it.
 *
 * These tests drive the REAL storage stack -- the published `dsh-storage` hub,
 * the `json` backend, and the `storage-domain` facility over a real temporary
 * directory -- because everything this task adds is addressing and lifecycle:
 * a domain name that may only be opened once, a close that has to free it, a
 * per-record document whose path is derived from the id. A hand-written fake
 * backend would have made all of that pass by construction (methodology note
 * in docs/运行时契约.md: structural decoupling, not mocks, is what replaces a
 * live instance).
 *
 * "Restart" is a fresh Context over the same storage root: the in-memory
 * catalog is gone, exactly as it is after a process restart, while the medium
 * is not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import GisService, {
  deriveDatasetId, GisError, GIS_DATASET_TABLE, GIS_DOMAIN_NAME, gisDatasetDomainSpec,
  parseStoredDataset, sourcePathOf, toDataset, toStoredDataset,
} from '../src/index.ts'
import type { Dataset, GisOpener } from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

/** A fresh storage root that is removed after the test. */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gis-registry-'))
  roots.push(root)
  return root
}

/** The real stack: hub, json backend at `root`, domain facility over it. */
async function storageContext(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(
    { name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig },
    { root },
  )
  await ctx.plugin(
    { name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig },
    { backend: 'json' },
  )
  return ctx
}

/** Load the GIS service and wait until its durable half is attached. */
async function gisContext(ctx: Context) {
  const fiber = await ctx.plugin(GisService)
  await vi.waitFor(() => { expect(ctx.gis.persistence).toBe('storage') })
  return fiber
}

/** One GeoJSON file on disk. */
async function geojsonFile(directory: string, content: string, name = 'points.geojson'): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, content, 'utf8')
  return path
}

const SMALL = JSON.stringify({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { name: 'one' }, geometry: { type: 'Point', coordinates: [1, 2] } }],
})

const BIGGER = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'one' }, geometry: { type: 'Point', coordinates: [1, 2] } },
    { type: 'Feature', properties: { name: 'two' }, geometry: { type: 'Point', coordinates: [3, 4] } },
  ],
})

/**
 * The opener a provider supplies, reduced to what the registry needs: a
 * content-derived id and a side-effect-free factory. The id derivation is the
 * shipping `deriveDatasetId`, so equality here means what it means in
 * production.
 */
function geojsonOpener(): GisOpener {
  return {
    name: 'test-purejs',
    canOpen: path => path.endsWith('.geojson'),
    async open(path: string): Promise<Dataset> {
      const info = await stat(path)
      return {
        id: deriveDatasetId({ path, kind: 'geojson', size: info.size, mtimeMs: info.mtimeMs }),
        kind: 'geojson',
        title: basename(path),
        path,
        layers: [{ name: basename(path, '.geojson') }],
      }
    },
  }
}

/** Where the registry stores one dataset's document. */
function recordPath(root: string, id: string): string {
  return join(root, GIS_DOMAIN_NAME, GIS_DATASET_TABLE, `${id}.json`)
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose().catch(() => {})))
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

describe('dataset ids are content-derived (design 6.6)', () => {
  it('rescanning unchanged data yields the same id, and a changed source a different one', async () => {
    const root = await temporaryRoot()
    const ctx = await storageContext(root)
    await gisContext(ctx)
    ctx.gis.registerOpener(geojsonOpener())
    const path = await geojsonFile(root, SMALL)

    const first = await ctx.gis.open(path)
    const second = await ctx.gis.open(path)
    expect(second.id).toBe(first.id)

    await writeFile(path, BIGGER, 'utf8')
    const third = await ctx.gis.open(path)
    expect(third.id).not.toBe(first.id)
  })
})

describe('the registry is durable', () => {
  it('writes one per-record document per dataset, keyed by the id', async () => {
    const root = await temporaryRoot()
    const ctx = await storageContext(root)
    await gisContext(ctx)
    ctx.gis.registerOpener(geojsonOpener())
    const dataset = await ctx.gis.open(await geojsonFile(root, SMALL))

    const document = JSON.parse(await readFile(recordPath(root, dataset.id), 'utf8')) as unknown
    expect(document).toEqual({ version: gisDatasetDomainSpec.version, record: toStoredDataset(dataset) })
  })

  it('resolves an id after a restart, from storage alone', async () => {
    const root = await temporaryRoot()
    const first = await storageContext(root)
    await gisContext(first)
    first.gis.registerOpener(geojsonOpener())
    const path = await geojsonFile(root, SMALL)
    const dataset = await first.gis.open(path)
    await first.fiber.dispose()

    // A new process: new Context, new service instance, same medium.
    const second = await storageContext(root)
    await gisContext(second)
    second.gis.registerOpener(geojsonOpener())

    expect(second.gis.list().map(entry => entry.id)).toEqual([dataset.id])
    expect(second.gis.resolve(dataset.id)).toEqual(dataset)
    // And the id is stable across the restart, which is what replay needs.
    expect((await second.gis.open(path)).id).toBe(dataset.id)
  })

  it('drops an id whose source changed, with the structured 404', async () => {
    const root = await temporaryRoot()
    const first = await storageContext(root)
    await gisContext(first)
    first.gis.registerOpener(geojsonOpener())
    const path = await geojsonFile(root, SMALL)
    const dataset = await first.gis.open(path)
    const changed = await first.gis.resolveFresh(dataset.id)
    expect(changed.id).toBe(dataset.id)
    await first.fiber.dispose()

    await writeFile(path, BIGGER, 'utf8')

    const second = await storageContext(root)
    await gisContext(second)
    second.gis.registerOpener(geojsonOpener())
    // The stored record is still there -- nothing scanned the file yet.
    expect(second.gis.resolve(dataset.id).id).toBe(dataset.id)

    const stale = await second.gis.resolveFresh(dataset.id).catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(GisError)
    expect((stale as GisError).code).toBe('DATASET_NOT_FOUND')
    // Dropped from memory AND from the medium: the id is not coming back.
    expect(second.gis.list()).toEqual([])
    await expect(readFile(recordPath(root, dataset.id), 'utf8')).rejects.toThrow()
  })

  it('answers an unknown id with the same structured 404', async () => {
    const root = await temporaryRoot()
    const ctx = await storageContext(root)
    await gisContext(ctx)

    const error = (() => { try { ctx.gis.resolve('ds_0000000000000000'); return undefined } catch (thrown: unknown) { return thrown } })()
    expect(error).toBeInstanceOf(GisError)
    expect(error).toMatchObject({ code: 'DATASET_NOT_FOUND' })
    expect((error as GisError).hint).toBeDefined()

    await expect(ctx.gis.resolveFresh('ds_0000000000000000')).rejects.toMatchObject({ code: 'DATASET_NOT_FOUND' })
  })

  it('drops an id whose source is positively gone', async () => {
    const root = await temporaryRoot()
    const ctx = await storageContext(root)
    await gisContext(ctx)
    ctx.gis.registerOpener(geojsonOpener())
    const path = await geojsonFile(root, SMALL)
    const dataset = await ctx.gis.open(path)

    await rm(path, { force: true })
    await expect(ctx.gis.resolveFresh(dataset.id)).rejects.toMatchObject({ code: 'DATASET_NOT_FOUND' })
    expect(ctx.gis.list()).toEqual([])
  })

  it('keeps an id when the source cannot be re-read for a transient reason', async () => {
    const root = await temporaryRoot()
    const ctx = await storageContext(root)
    await gisContext(ctx)
    const path = await geojsonFile(root, SMALL, 'locked.geojson')
    const dataset: Dataset = {
      id: 'ds_locked000000000',
      kind: 'geojson',
      title: 'locked.geojson',
      path,
      layers: [{ name: 'locked' }],
    }
    await ctx.gis.registerDataset(dataset)
    ctx.gis.registerOpener({
      name: 'flaky',
      canOpen: candidate => candidate.endsWith('.geojson'),
      async open(): Promise<Dataset> {
        throw Object.assign(new Error('the file is locked by another process'), { code: 'EBUSY' })
      },
    })

    // A locked or unreachable file is not proof that the bytes moved on, so the
    // id stays and the read fails loudly on its own terms -- dropping the
    // registration here would silently lose a perfectly good dataset.
    expect((await ctx.gis.resolveFresh(dataset.id)).id).toBe(dataset.id)
    expect(ctx.gis.list().map(entry => entry.id)).toEqual([dataset.id])
  })
})

describe('storage is optional', () => {
  it('activates and works with no storage hub mounted at all', async () => {
    const root = await temporaryRoot()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(GisService)
    await vi.waitFor(() => { expect(ctx.gis.persistence).toBe('memory') })
    ctx.gis.registerOpener(geojsonOpener())
    const path = await geojsonFile(root, SMALL)

    const dataset = await ctx.gis.open(path)
    expect(ctx.gis.resolve(dataset.id)).toEqual(dataset)
    // Nothing was written anywhere: there is no medium.
    await expect(readFile(recordPath(root, dataset.id), 'utf8')).rejects.toThrow()
  })

  it('survives an HMR reload: the domain name is freed, and storage is re-attached', async () => {
    const root = await temporaryRoot()
    const ctx = await storageContext(root)
    const facility = ctx.get('storageDomain')
    expect(facility).toBeDefined()
    const first = await gisContext(ctx)
    ctx.gis.registerOpener(geojsonOpener())
    const path = await geojsonFile(root, SMALL)
    const dataset = await ctx.gis.open(path)

    await first.dispose()
    // The teardown ran to completion: the name is free for the next incarnation.
    expect(facility?.get(GIS_DOMAIN_NAME)).toBeUndefined()

    await gisContext(ctx)
    ctx.gis.registerOpener(geojsonOpener())
    expect(ctx.gis.resolve(dataset.id)).toEqual(dataset)
    expect((await ctx.gis.open(path)).id).toBe(dataset.id)
  })
})

describe('the durable shape', () => {
  const shapes: readonly Dataset[] = [
    { id: 'ds_a', kind: 'geojson', title: 'a.geojson', path: 'C:/data/a.geojson', layers: [{ name: 'a' }] },
    {
      id: 'ds_b', kind: 'shapefile', title: 'b.shp', main: 'C:/data/b.shp',
      siblings: ['b.shp', 'b.dbf'], layers: [{ name: 'b', geometryType: 'Point', featureCount: 3, bbox: [1, 2, 3, 4], srid: 4326 }],
    },
    { id: 'ds_c', kind: 'gdb', title: 'c.gdb', dir: 'C:/data/c.gdb', layers: [{ name: 'roads' }, { name: 'rivers' }] },
    { id: 'ds_d', kind: 'postgis', title: 'public.roads', profile: 'warehouse', layers: [{ name: 'roads', srid: 3857 }] },
  ]

  it('round-trips every dataset shape through the medium form', () => {
    for (const dataset of shapes) {
      expect(toDataset(toStoredDataset(dataset))).toEqual(dataset)
      expect(parseStoredDataset(toStoredDataset(dataset))).toEqual(toStoredDataset(dataset))
    }
  })

  it('rejects a record that is not a dataset', () => {
    expect(() => parseStoredDataset({ kind: 'shapefile', id: 'ds_x', title: 'x' })).toThrow()
    expect(() => parseStoredDataset({ kind: 'kml', id: 'ds_x', title: 'x', layers: [] })).toThrow()
  })

  it('addresses a source by kind, never by the display title', () => {
    expect(sourcePathOf(shapes[0] as Dataset)).toBe('C:/data/a.geojson')
    expect(sourcePathOf(shapes[1] as Dataset)).toBe('C:/data/b.shp')
    expect(sourcePathOf(shapes[2] as Dataset)).toBe('C:/data/c.gdb')
    // A connection is addressed by profile name; there is no path to hand out.
    expect(sourcePathOf(shapes[3] as Dataset)).toBeUndefined()
  })
})
