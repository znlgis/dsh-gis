/**
 * The PostGIS format handler: what makes a database readable through the tools.
 *
 * gis-core routes every read by dataset KIND, so registering this handler for
 * 'postgis' is what turns the catalogue, the paged read, the filter and the
 * estimated extents into something gis_inspect / gis_query can use.
 *
 * TWO THINGS IT IS CAREFUL ABOUT:
 *
 * 1. **A layer name is a NAME, not an identifier pasted into SQL.** The catalogue is
 *    the whitelist: a layer that is not in it is refused with LAYER_NOT_FOUND, and a
 *    table that is in it contributes its OWN schema and table names to the query.
 * 2. **Row counts are ESTIMATES, and the result says so.** PostgreSQL's reltuples
 *    is an estimate; reporting it as a fact would put a wrong number in front of a
 *    user with no way to tell. Every inspect carries an issue saying so.
 */
import {
  GisError,
  type Dataset,
  type Feature,
  type GisFormatHandler,
  type GisIssue,
  type InspectResult,
  type QueryRequest,
  type QueryResult,
} from '@znlgis/dsh-gis-core'
// The WKT encoder the other two handlers use, so all three encode identically.
import { toWkt, type GeoJsonGeometry } from '@znlgis/dsh-gis-formats'
import { readCatalog, readLayerMetadata, type CatalogLayer } from './catalog.ts'
import { readColumnNames } from './query.ts'
import type { Queryable } from './connect.ts'
import { toFeature } from './query.ts'
import { readPage } from './query.ts'

/** What the handler needs from the plugin: a connection per profile. */
export interface PostgisDataSource {
  /**
   * @param profile - the connection profile name.
   * @returns a queryable connection.
   */
  forProfile(profile: string): Promise<Queryable>
}

/** The name a catalogue layer is addressed by, in the tools and in the catalogue. */
export function layerNameOf(layer: CatalogLayer): string {
  return layer.schema + '.' + layer.table
}

/**
 * Build the handler.
 * @param source - the connection source.
 * @returns a handler for postgis datasets.
 */
export function createPostgisHandler(source: PostgisDataSource): GisFormatHandler {
  /** The profile behind a dataset, refusing anything else. */
  function profileOf(dataset: Dataset): string {
    if (dataset.kind !== 'postgis') {
      throw new GisError('UNSUPPORTED_FORMAT', 'the postgis handler was given a ' + dataset.kind + ' dataset')
    }
    return dataset.profile
  }

  /** The catalogue entry the request names, or the only one there is. */
  function choose(layers: readonly CatalogLayer[], name: string | undefined, dataset: Dataset): CatalogLayer {
    if (name !== undefined) {
      const found = layers.find(layer => layerNameOf(layer) === name || layer.table === name)
      if (found === undefined) {
        throw new GisError('LAYER_NOT_FOUND', 'dataset ' + dataset.id + ' has no layer named ' + name)
      }
      return found
    }
    if (layers.length === 0) throw new GisError('DATASET_UNREADABLE', 'this profile reports no spatial table at all')
    if (layers.length > 1) {
      throw new GisError('LAYER_AMBIGUOUS', 'this profile holds ' + String(layers.length) + ' spatial tables; name one with layer (the first is ' + layerNameOf(layers[0] as CatalogLayer) + ')')
    }
    return layers[0] as CatalogLayer
  }

  return {
    name: 'gis-postgis',
    kinds: ['postgis'],

    async inspect(dataset, layer) {
      const profile = profileOf(dataset)
      const client = await source.forProfile(profile)
      const layers = await readCatalog(client)
      const issues: GisIssue[] = []
      if (layers.length === 0) {
        issues.push({ code: 'LAYER_NOT_FOUND', message: 'this profile has no table with a spatial column; create one, or check the geometry_columns view' })
      }
      if (layers.length > 1 && layer === undefined) {
        issues.push({ code: 'LAYER_AMBIGUOUS', message: 'this profile holds ' + String(layers.length) + ' spatial tables; pass layer to read one specifically', count: layers.length })
      }
      const names = layer === undefined ? layers : layers.filter(one => layerNameOf(one) === layer || one.table === layer)
      if (layer !== undefined && names.length === 0) {
        throw new GisError('LAYER_NOT_FOUND', 'dataset ' + dataset.id + ' has no layer named ' + layer)
      }
      const chosen = names[0]
      const metadata = chosen === undefined ? undefined : await readLayerMetadata(client, chosen)
      const columns = chosen === undefined ? [] : await readColumnNames(client, chosen)
      if (metadata !== undefined && metadata.extent === undefined) {
        issues.push({ code: 'DATASET_UNREADABLE', message: String(metadata.extentUnknownReason ?? 'no estimated extent is available') })
      }
      // The estimate is labelled as one: a row count nobody can distinguish from a
      // real count is worse than no count at all.
      issues.push({ code: 'DATASET_UNREADABLE', message: 'row counts and extents here are ESTIMATES from the table statistics, not exact values' })
      return {
        datasetId: dataset.id,
        kind: dataset.kind,
        layers: names.map(one => ({
          name: layerNameOf(one),
          geometryType: one.geometryType,
          srid: one.srid,
          ...one.rowsKnown ? { featureCount: one.estimatedRows } : {},
        })),
        crs: chosen === undefined || chosen.srid <= 0 ? { source: 'unknown' } : { epsg: chosen.srid, source: 'native', name: 'declared by the table' },
        fields: columns.map((name: string) => ({ name, type: '' })),
        ...chosen === undefined || chosen.srid <= 0 ? {} : { srid: chosen.srid },
        ...metadata?.extent === undefined ? {} : { bbox: [metadata.extent.minX, metadata.extent.minY, metadata.extent.maxX, metadata.extent.maxY] },
        ...chosen === undefined || !chosen.rowsKnown ? {} : { featureCount: chosen.estimatedRows },
        // Tiles are true for PostGIS and NOT because this handler makes them: the
        // database does (ST_AsMVT), which is what T3.4 established.
        capabilities: { read: true, write: false, tiles: true },
        issues,
      } satisfies InspectResult
    },

    async query(dataset, request: QueryRequest): Promise<QueryResult> {
      const profile = profileOf(dataset)
      const client = await source.forProfile(profile)
      const layers = await readCatalog(client)
      const layer = choose(layers, request.layer, dataset)
      const columns = await readColumnNames(client, layer)
      const page = await readPage(client, layer, {
        limit: request.limit,
        offset: request.offset,
        ...request.where === undefined ? {} : { where: request.where },
        ...request.fields === undefined ? {} : { columns: request.fields.filter(name => columns.includes(name)) },
      })
      const rows: Feature[] = page.features.map(feature => ({
        attributes: feature.properties as Feature['attributes'],
        ...request.geometry === 'none' || feature.geometry === null
          ? {}
          : { geometry: request.geometry === 'wkt' ? toWkt(feature.geometry as GeoJsonGeometry) : feature.geometry as Readonly<Record<string, unknown>> },
      }))
      return {
        columns: request.fields ?? columns,
        rows,
        rowCount: rows.length,
        // A full page means more MAY follow; that is not the same as knowing how
        // many, and pg_class only holds an estimate.
        truncated: page.hasMore,
      }
    },
  }
}
