/**
 * The durable dataset registry domain (design 6.6).
 *
 * An id is content-derived, so it only keeps pointing at the same data while
 * the registry that maps it survives. A process-local Map makes every id die
 * with the process: a replayed session, an M2 route, or a card `meta` would
 * resolve to nothing. So the registry is written into `ctx.storageDomain`.
 *
 * Shape decisions:
 *  - domain `gis`, table `datasets`, one record per dataset, keyed by id;
 *  - `per-record` layout: datasets are large, sparse and individually
 *    disposable -- one bad document must not brick the catalog, and deleting
 *    one dataset must not rewrite the whole file. Record keys become path
 *    segments, and a derived id (`ds_<hex>`) is already path-safe;
 *  - `backup-and-skip`: a stored record that fails the schema is moved aside
 *    and logged instead of failing the whole open. Rescanning rebuilds it.
 *
 * The stored record is validated by the domain on every open, so the schema
 * here is the durable boundary: it mirrors `Dataset` exactly, and the two
 * mappers below are the only places that know both shapes.
 */
import z from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Bbox, Dataset, LayerRef } from './types.ts'

/** Domain name; `gis` because design 6.6 keeps datasets and (M4) services together. */
export const GIS_DOMAIN_NAME = 'gis'

/** Table holding one record per registered dataset. */
export const GIS_DATASET_TABLE = 'datasets'

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

const storedLayerSchema = z.object({
  name: z.string(),
  geometryType: z.string().optional(),
  featureCount: z.number().optional(),
  bbox: bboxSchema.optional(),
  srid: z.number().optional(),
})

const storedBase = {
  id: z.string(),
  title: z.string(),
  layers: z.array(storedLayerSchema),
}

const storedDatasetSchema = z.discriminatedUnion('kind', [
  z.object({ ...storedBase, kind: z.literal('geojson'), path: z.string() }),
  z.object({ ...storedBase, kind: z.literal('ndjson'), path: z.string() }),
  z.object({ ...storedBase, kind: z.literal('wkt'), path: z.string() }),
  // A COG is one file, like the text formats: the same shape, its own kind.
  z.object({ ...storedBase, kind: z.literal('cog'), path: z.string() }),
  z.object({ ...storedBase, kind: z.literal('shapefile'), main: z.string(), siblings: z.array(z.string()) }),
  z.object({ ...storedBase, kind: z.literal('gdb'), dir: z.string() }),
  z.object({ ...storedBase, kind: z.literal('postgis'), profile: z.string() }),
])

/** One dataset as it lives on the medium. */
export type StoredDataset = z.infer<typeof storedDatasetSchema>

/** One layer as it lives on the medium. */
export type StoredLayer = z.infer<typeof storedLayerSchema>

/**
 * The registry domain. Version is the DOMAIN format version, not the dataset
 * format: bump it when this declaration changes incompatibly, and list the
 * older versions whose records the current schemas still accept (design 11.5).
 */
export const gisDatasetDomainSpec = defineDomain({
  name: GIS_DOMAIN_NAME,
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { [GIS_DATASET_TABLE]: domainTable<string, StoredDataset>(storedDatasetSchema) },
})

/**
 * Project a registered dataset onto its durable record.
 * @param dataset - the in-process dataset.
 * @returns a plain, JSON-safe record.
 */
export function toStoredDataset(dataset: Dataset): StoredDataset {
  const base = { id: dataset.id, title: dataset.title, layers: dataset.layers.map(toStoredLayer) }
  switch (dataset.kind) {
    case 'geojson':
    case 'ndjson':
    case 'wkt':
    case 'cog':
      return { ...base, kind: dataset.kind, path: dataset.path }
    case 'shapefile':
      return { ...base, kind: 'shapefile', main: dataset.main, siblings: [...dataset.siblings] }
    case 'gdb':
      return { ...base, kind: 'gdb', dir: dataset.dir }
    case 'postgis':
      return { ...base, kind: 'postgis', profile: dataset.profile }
  }
}

/**
 * Rebuild a dataset from its durable record.
 *
 * Optional fields are re-attached one by one rather than spread wholesale:
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined", and a record that round-trips to `{ geometryType: undefined }`
 * is a different object from the one that was stored.
 * @param record - a schema-validated record.
 * @returns the dataset.
 */
export function toDataset(record: StoredDataset): Dataset {
  const base = { id: record.id, title: record.title, layers: record.layers.map(toLayerRef) }
  switch (record.kind) {
    case 'geojson':
    case 'ndjson':
    case 'wkt':
    case 'cog':
      return { ...base, kind: record.kind, path: record.path }
    case 'shapefile':
      return { ...base, kind: 'shapefile', main: record.main, siblings: [...record.siblings] }
    case 'gdb':
      return { ...base, kind: 'gdb', dir: record.dir }
    case 'postgis':
      return { ...base, kind: 'postgis', profile: record.profile }
  }
}

/** Project one layer onto its durable record. */
function toStoredLayer(layer: LayerRef): StoredLayer {
  return {
    name: layer.name,
    ...layer.geometryType === undefined ? {} : { geometryType: layer.geometryType },
    ...layer.featureCount === undefined ? {} : { featureCount: layer.featureCount },
    ...layer.bbox === undefined ? {} : { bbox: tupleOf(layer.bbox) },
    ...layer.srid === undefined ? {} : { srid: layer.srid },
  }
}

/** Rebuild one layer from its durable record. */
function toLayerRef(layer: StoredLayer): LayerRef {
  return {
    name: layer.name,
    ...layer.geometryType === undefined ? {} : { geometryType: layer.geometryType },
    ...layer.featureCount === undefined ? {} : { featureCount: layer.featureCount },
    ...layer.bbox === undefined ? {} : { bbox: tupleOf(layer.bbox) },
    ...layer.srid === undefined ? {} : { srid: layer.srid },
  }
}

/**
 * Copy a four-number bbox into a fresh, mutable tuple.
 *
 * `Bbox` is readonly (nothing downstream may poke at it) while the stored
 * record's tuple is not; both directions go through here so neither side has
 * to cast.
 */
function tupleOf(bbox: Bbox): [number, number, number, number] {
  return [bbox[0], bbox[1], bbox[2], bbox[3]]
}

/** Validate one record against the durable schema; exported for the registry and its tests. */
export const parseStoredDataset = (value: unknown): StoredDataset => storedDatasetSchema.parse(value)
