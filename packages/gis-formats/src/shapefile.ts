/**
 * Shapefile FAMILY reading.
 *
 * A shapefile is never one file: .shp and .dbf always travel together, .shx
 * indexes them, and .prj / .cpg decide the two things that silently ruin
 * results -- the CRS and the attribute encoding. This module takes the family
 * as already-read sources so it stays pure and testable.
 */
import type { GisIssue } from '@znlgis/dsh-gis-core'
import { readDbf } from './dbf.ts'
import { readShp } from './shp.ts'
import { crsFromPrj } from './crs.ts'
import { extendBbox, type RawFeature, type ReadResult } from './shared.ts'

/** Every member of one shapefile family, already read from disk. */
export interface ShapefileSources {
  readonly shp: Uint8Array
  /** Absent when the family is missing its attribute table. */
  readonly dbf?: Uint8Array
  /** .prj contents, when the sidecar exists. */
  readonly prj?: string
  /** .cpg contents, when the sidecar exists. */
  readonly cpg?: string
}

/** Caller-supplied overrides. */
export interface ShapefileOptions {
  /** Explicit attribute encoding, overriding any .cpg. */
  readonly encoding?: string
}

/** Human name for a shapefile shape type. */
const SHAPE_TYPE_NAMES: Record<number, string> = {
  0: 'Null', 1: 'Point', 3: 'PolyLine', 5: 'Polygon', 8: 'MultiPoint',
  11: 'PointZ', 13: 'PolyLineZ', 15: 'PolygonZ', 18: 'MultiPointZ',
  21: 'PointM', 23: 'PolyLineM', 25: 'PolygonM', 28: 'MultiPointM',
}

/** GeoJSON geometry type implied by a shapefile shape type. */
const GEOJSON_OF_SHAPE: Record<number, string> = {
  1: 'Point', 11: 'Point', 21: 'Point',
  3: 'LineString', 13: 'LineString', 23: 'LineString',
  5: 'Polygon', 15: 'Polygon', 25: 'Polygon',
  8: 'MultiPoint', 18: 'MultiPoint', 28: 'MultiPoint',
}

/**
 * Read one shapefile family.
 * @param sources - the family members that exist.
 * @param options - caller overrides.
 * @returns features, metadata, and issues.
 * @throws Error when the .shp is unreadable.
 */
export function readShapefile(sources: ShapefileSources, options: ShapefileOptions = {}): ReadResult {
  const issues: GisIssue[] = []
  const shp = readShp(sources.shp)

  const crs = sources.prj === undefined ? { source: 'unknown' as const } : crsFromPrj(sources.prj)
  if (sources.prj === undefined) {
    issues.push({
      code: 'CRS_UNKNOWN',
      message: 'this shapefile has no .prj sidecar, so its coordinate reference system is unknown; measurements and overlays are refused until you supply one',
    })
  } else if (crs.epsg === undefined) {
    issues.push({
      code: 'CRS_UNSUPPORTED',
      message: `the .prj names a CRS but states no EPSG code (${crs.name ?? 'unnamed'}), so measurements may be wrong; pass an explicit CRS to convert`,
    })
  }

  const table = sources.dbf === undefined ? undefined : readDbf(sources.dbf, {
    ...(sources.cpg === undefined ? {} : { cpg: sources.cpg }),
    ...(options.encoding === undefined ? {} : { requested: options.encoding, requestedSource: 'user' as const }),
  })

  if (table === undefined) {
    issues.push({ code: 'DATASET_UNREADABLE', message: 'this shapefile has no .dbf, so features carry no attributes' })
  } else if (table.encodingSource === 'unknown') {
    issues.push({
      code: 'ENCODING_UNDECIDED',
      message: 'attribute text has no declared encoding (.cpg missing and no language driver byte), so non-ASCII text may be wrong; pass an explicit encoding to re-read',
    })
  }

  const features: RawFeature[] = []
  let bbox = shp.bbox
  for (let index = 0; index < shp.geometries.length; index += 1) {
    const geometry = shp.geometries[index]
    const attributes = table?.records[index] ?? {}
    features.push(geometry === undefined ? { attributes } : { attributes, geometry })
    if (geometry !== undefined) bbox = extendBbox(bbox, geometry)
  }

  const shapeName = SHAPE_TYPE_NAMES[shp.shapeType] ?? `type ${String(shp.shapeType)}`
  return {
    features,
    fields: (table?.fields ?? []).map(field => ({ name: field.name, type: field.type })),
    crs,
    ...(table === undefined ? {} : { encoding: { used: table.encoding, source: table.encodingSource } }),
    geometryType: GEOJSON_OF_SHAPE[shp.shapeType] ?? shapeName,
    ...(bbox === undefined ? {} : { bbox }),
    issues,
    totalCount: features.length,
  }
}
