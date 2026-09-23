/**
 * ESRI shapefile (.shp) geometry reader.
 *
 * Hand-written for the same reason as the DBF reader: the shapefile family is
 * a core capability whose edge cases we must control. Supported shapes are the
 * ones real archives contain -- Null, Point, PolyLine, Polygon, MultiPoint and
 * their Z/M variants, where the XY prefix is read and the trailing Z/M arrays
 * are ignored.
 *
 * Polygon rings are grouped by the format's own orientation rule: exterior
 * rings are CLOCKWISE (negative shoelace area), holes counter-clockwise.
 */
import type { Bbox } from '@znlgis/dsh-gis-core'
import type { GeoJsonGeometry } from './wkt.ts'

const SHAPE_NULL = 0
const SHAPE_POINT = 1
const SHAPE_POLYLINE = 3
const SHAPE_POLYGON = 5
const SHAPE_MULTIPOINT = 8
const SHAPE_POINT_Z = 11
const SHAPE_POLYLINE_Z = 13
const SHAPE_POLYGON_Z = 15
const SHAPE_MULTIPOINT_Z = 18
const SHAPE_POINT_M = 21
const SHAPE_POLYLINE_M = 23
const SHAPE_POLYGON_M = 25
const SHAPE_MULTIPOINT_M = 28

/** One decoded shapefile. */
export interface ShpFile {
  /** Shape type declared in the header (record types must match). */
  readonly shapeType: number
  /** Extent recorded in the header. */
  readonly bbox?: Bbox
  /** One geometry per record, in record order; null shapes are undefined. */
  readonly geometries: readonly (GeoJsonGeometry | undefined)[]
}

/**
 * Read a .shp buffer.
 * @param buffer - the whole .shp file.
 * @returns the header facts and one geometry per record.
 * @throws Error when the file is too short or uses an unsupported shape type.
 */
export function readShp(buffer: Uint8Array): ShpFile {
  if (buffer.byteLength < 100) throw new Error('SHP file is shorter than its 100-byte header')
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const shapeType = view.getInt32(32, true)
  const bbox: Bbox = [view.getFloat64(36, true), view.getFloat64(44, true), view.getFloat64(52, true), view.getFloat64(60, true)]

  const geometries: (GeoJsonGeometry | undefined)[] = []
  let at = 100
  while (at + 8 <= buffer.byteLength) {
    const contentBytes = view.getInt32(at + 4, false) * 2
    const start = at + 8
    if (contentBytes <= 0 || start + contentBytes > buffer.byteLength) break
    const recordType = view.getInt32(start, true)
    geometries.push(decodeRecord(view, start, recordType))
    at = start + contentBytes
  }

  return { shapeType, bbox, geometries }
}

/** Decode one record body into a GeoJSON geometry. */
function decodeRecord(view: DataView, start: number, type: number): GeoJsonGeometry | undefined {
  switch (type) {
    case SHAPE_NULL: return undefined
    case SHAPE_POINT: return point(view, start + 4)
    case SHAPE_POINT_Z: case SHAPE_POINT_M: return point(view, start + 4)
    case SHAPE_MULTIPOINT: return multiPoint(view, start)
    case SHAPE_MULTIPOINT_Z: case SHAPE_MULTIPOINT_M: return multiPoint(view, start)
    case SHAPE_POLYLINE: return polyLine(view, start)
    case SHAPE_POLYLINE_Z: case SHAPE_POLYLINE_M: return polyLine(view, start)
    case SHAPE_POLYGON: return polygon(view, start)
    case SHAPE_POLYGON_Z: case SHAPE_POLYGON_M: return polygon(view, start)
    default: throw new Error(`unsupported shapefile shape type: ${String(type)}`)
  }
}

/** One Point record. */
function point(view: DataView, at: number): GeoJsonGeometry {
  return { type: 'Point', coordinates: [view.getFloat64(at, true), view.getFloat64(at + 8, true)] }
}

/** One MultiPoint record. */
function multiPoint(view: DataView, start: number): GeoJsonGeometry {
  const count = view.getInt32(start + 36, true)
  const coordinates: number[][] = []
  for (let i = 0; i < count; i += 1) {
    const at = start + 40 + i * 16
    coordinates.push([view.getFloat64(at, true), view.getFloat64(at + 8, true)])
  }
  return { type: 'MultiPoint', coordinates }
}

/** One PolyLine record: LineString when single-part, MultiLineString otherwise. */
function polyLine(view: DataView, start: number): GeoJsonGeometry {
  const { rings } = partsAndPoints(view, start)
  return rings.length === 1
    ? { type: 'LineString', coordinates: rings[0] }
    : { type: 'MultiLineString', coordinates: rings }
}

/** One Polygon record, grouping holes with their exterior ring. */
function polygon(view: DataView, start: number): GeoJsonGeometry {
  const { rings } = partsAndPoints(view, start)
  // polygons -> polygon -> ring -> position, one level deeper than it looks.
  const polygons: number[][][][] = []
  for (const ring of rings) {
    if (signedArea(ring) <= 0 || polygons.length === 0) polygons.push([ring])
    else (polygons[polygons.length - 1] as number[][][]).push(ring)
  }
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons }
}

/** Shared parts/points layout used by PolyLine and Polygon. */
function partsAndPoints(view: DataView, start: number): { rings: number[][][] } {
  const numParts = view.getInt32(start + 36, true)
  const numPoints = view.getInt32(start + 40, true)
  const partsAt = start + 44
  const pointsAt = partsAt + numParts * 4
  const rings: number[][][] = []
  for (let part = 0; part < numParts; part += 1) {
    const from = view.getInt32(partsAt + part * 4, true)
    const to = part + 1 < numParts ? view.getInt32(partsAt + (part + 1) * 4, true) : numPoints
    const ring: number[][] = []
    for (let index = from; index < to; index += 1) {
      const at = pointsAt + index * 16
      ring.push([view.getFloat64(at, true), view.getFloat64(at + 8, true)])
    }
    rings.push(ring)
  }
  return { rings }
}

/**
 * Shoelace signed area. Negative means clockwise, which is how a shapefile
 * marks an EXTERIOR ring.
 * @param ring - closed or unclosed ring of positions.
 * @returns twice the signed area.
 */
function signedArea(ring: readonly (readonly number[])[]): number {
  let sum = 0
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i] as readonly number[]
    const b = ring[(i + 1) % ring.length] as readonly number[]
    sum += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number)
  }
  return sum
}
