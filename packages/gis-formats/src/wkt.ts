/**
 * WKT / EWKT parsing and serialization, plus GeoJSON geometry conversion.
 *
 * WKT is this plugin's DEFAULT geometry exchange with the model (design 7.2):
 * it is far shorter than GeoJSON, and models read and write it well. The parser
 * is hand-written so the exact semantics stay under our control -- notably
 * that a bare WKT geometry carries NO coordinate reference system, which the
 * caller must supply or we must report as unknown. Never assume EPSG:4326.
 */

/** A GeoJSON geometry object, kept structural to avoid a dependency. */
export type GeoJsonGeometry = Readonly<Record<string, unknown>> & { readonly type: string }

/** Position tuples as they appear in GeoJSON. */
type Position = readonly number[]

/** One parsed WKT value. */
export interface ParsedWkt {
  /** GeoJSON geometry, WGS84-agnostic (coordinates are passed through). */
  readonly geometry: GeoJsonGeometry
  /** SRID from an EWKT prefix, when present. */
  readonly srid?: number
  /** Dimensionality as written: 2, 3 (Z), or 4 (ZM). */
  readonly dimensions: number
}

const GEOMETRY_TYPES = [
  'POINT', 'LINESTRING', 'POLYGON',
  'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON',
  'GEOMETRYCOLLECTION',
] as const

type GeometryType = (typeof GEOMETRY_TYPES)[number]

/**
 * Parse WKT or EWKT into a GeoJSON geometry.
 * @param text - the WKT text; a leading `SRID=<n>;` is accepted.
 * @returns the geometry plus what the text declared about SRID and dimensions.
 * @throws Error when the text is not valid WKT this parser supports.
 */
export function parseWkt(text: string): ParsedWkt {
  let rest = text.trim()
  let srid: number | undefined
  const sridMatch = /^SRID\s*=\s*(\d+)\s*;\s*/i.exec(rest)
  if (sridMatch !== null) {
    srid = Number(sridMatch[1])
    rest = rest.slice(sridMatch[0].length)
  }
  const parser = new Reader(rest)
  const parsed = parser.geometry()
  parser.expectEnd()
  return srid === undefined
    ? { geometry: parsed.geometry, dimensions: parsed.dimensions }
    : { geometry: parsed.geometry, srid, dimensions: parsed.dimensions }
}

/** Recursive-descent reader over a WKT string. */
class Reader {
  #at = 0

  /**
   * @param source - remaining WKT text.
   */
  constructor(private readonly source: string) {}

  /** Parse one geometry, recursing for collections. */
  geometry(): { geometry: GeoJsonGeometry; dimensions: number } {
    const type = this.word().toUpperCase()
    if (!(GEOMETRY_TYPES as readonly string[]).includes(type)) {
      throw new Error(`unsupported WKT geometry type: ${type}`)
    }
    let dimensions = 2
    const suffix = this.peekWord()
    if (suffix === 'Z' || suffix === 'M' || suffix === 'ZM') {
      this.word()
      dimensions = suffix === 'ZM' ? 4 : 3
    }
    if (this.peekWord() === 'EMPTY') {
      this.word()
      return { geometry: emptyGeometry(type as GeometryType), dimensions }
    }
    this.expect('(')
    const geometry = this.#body(type as GeometryType, dimensions)
    this.expect(')')
    return { geometry, dimensions }
  }

  /** Read the parenthesized body for `type`. */
  #body(type: GeometryType, dimensions: number): GeoJsonGeometry {
    switch (type) {
      case 'POINT':
        return { type: 'Point', coordinates: this.position(dimensions) }
      case 'LINESTRING':
        return { type: 'LineString', coordinates: this.positionList(dimensions) }
      case 'POLYGON':
        return { type: 'Polygon', coordinates: this.ringList(dimensions) }
      case 'MULTIPOINT':
        return { type: 'MultiPoint', coordinates: this.multiPoint(dimensions) }
      case 'MULTILINESTRING':
        return { type: 'MultiLineString', coordinates: this.nestedPositionLists(dimensions) }
      case 'MULTIPOLYGON':
        return { type: 'MultiPolygon', coordinates: this.polygonList(dimensions) }
      case 'GEOMETRYCOLLECTION': {
        const geometries: GeoJsonGeometry[] = []
        do {
          geometries.push(this.geometry().geometry)
        } while (this.consume(','))
        return { type: 'GeometryCollection', geometries }
      }
    }
  }

  /** One coordinate tuple. */
  position(dimensions: number): Position {
    const values: number[] = []
    for (let i = 0; i < dimensions; i += 1) values.push(this.number())
    return values
  }

  /** Comma-separated positions. */
  positionList(dimensions: number): Position[] {
    const list: Position[] = []
    do { list.push(this.position(dimensions)) } while (this.consume(','))
    return list
  }

  /** Comma-separated parenthesized rings. */
  ringList(dimensions: number): Position[][] {
    const rings: Position[][] = []
    do {
      this.expect('(')
      rings.push(this.positionList(dimensions))
      this.expect(')')
    } while (this.consume(','))
    return rings
  }

  /** MULTIPOINT accepts both `(x y, x y)` and `((x y), (x y))`. */
  multiPoint(dimensions: number): Position[] {
    const points: Position[] = []
    do {
      if (this.consume('(')) {
        points.push(this.position(dimensions))
        this.expect(')')
      } else points.push(this.position(dimensions))
    } while (this.consume(','))
    return points
  }

  /** Comma-separated parenthesized line strings. */
  nestedPositionLists(dimensions: number): Position[][] {
    const lines: Position[][] = []
    do {
      this.expect('(')
      lines.push(this.positionList(dimensions))
      this.expect(')')
    } while (this.consume(','))
    return lines
  }

  /** Comma-separated parenthesized polygons. */
  polygonList(dimensions: number): Position[][][] {
    const polygons: Position[][][] = []
    do {
      this.expect('(')
      polygons.push(this.ringList(dimensions))
      this.expect(')')
    } while (this.consume(','))
    return polygons
  }

  /** Skip whitespace. */
  #skip(): void {
    while (this.#at < this.source.length && /\s/.test(this.source[this.#at] as string)) this.#at += 1
  }

  /** Consume one literal when present. */
  consume(token: string): boolean {
    this.#skip()
    if (this.source.startsWith(token, this.#at)) { this.#at += token.length; return true }
    return false
  }

  /** Require one literal. */
  expect(token: string): void {
    if (!this.consume(token)) {
      throw new Error(`expected '${token}' at offset ${String(this.#at)} in WKT`)
    }
  }

  /** Read one identifier-ish word. */
  word(): string {
    this.#skip()
    const start = this.#at
    while (this.#at < this.source.length && /[A-Za-z]/.test(this.source[this.#at] as string)) this.#at += 1
    if (this.#at === start) throw new Error(`expected a word at offset ${String(start)} in WKT`)
    return this.source.slice(start, this.#at)
  }

  /** Peek the next word without consuming it. */
  peekWord(): string {
    const mark = this.#at
    try { return this.word() } catch { return '' } finally { this.#at = mark }
  }

  /** Read one number. */
  number(): number {
    this.#skip()
    const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.#at))
    if (match === null) throw new Error(`expected a number at offset ${String(this.#at)} in WKT`)
    this.#at += match[0].length
    return Number(match[0])
  }

  /** Fail when trailing text remains. */
  expectEnd(): void {
    this.#skip()
    if (this.#at !== this.source.length) throw new Error(`unexpected trailing text in WKT at offset ${String(this.#at)}`)
  }
}

/** The empty geometry for one WKT type. */
function emptyGeometry(type: GeometryType): GeoJsonGeometry {
  if (type === 'GEOMETRYCOLLECTION') return { type: 'GeometryCollection', geometries: [] }
  if (type === 'POINT') return { type: 'Point', coordinates: [] }
  if (type === 'MULTIPOINT' || type === 'LINESTRING') return { type: type === 'MULTIPOINT' ? 'MultiPoint' : 'LineString', coordinates: [] }
  if (type === 'MULTILINESTRING') return { type: 'MultiLineString', coordinates: [] }
  return { type: type === 'MULTIPOLYGON' ? 'MultiPolygon' : 'Polygon', coordinates: [] }
}

/**
 * Serialize a GeoJSON geometry to WKT.
 * @param geometry - GeoJSON geometry.
 * @returns WKT text without any SRID prefix.
 */
export function toWkt(geometry: GeoJsonGeometry): string {
  return write(geometry)
}

/** Render one geometry recursively. */
function write(geometry: GeoJsonGeometry): string {
  const type = geometry.type
  const coordinates = geometry.coordinates as unknown[] | undefined
  switch (type) {
    case 'Point': return `POINT ${point(coordinates as Position)}`
    case 'LineString': return `LINESTRING ${positions(coordinates as Position[])}`
    case 'Polygon': return `POLYGON ${rings(coordinates as Position[][])}`
    // Each point is parenthesized AND the list is wrapped: MULTIPOINT ((1 2), (3 4)).
    // Emitting bare `(1 2), (3 4)` is invalid WKT -- caught by the round-trip test.
    case 'MultiPoint': return `MULTIPOINT (${(coordinates as Position[]).map(point).join(', ')})`
    // Every multi-geometry wraps its WHOLE member list in one extra pair of
    // parentheses -- MULTILINESTRING ((a, b), (c, d)), not (a, b), (c, d).
    case 'MultiLineString': return `MULTILINESTRING (${(coordinates as Position[][]).map(positions).join(', ')})`
    case 'MultiPolygon': return `MULTIPOLYGON (${(coordinates as Position[][][]).map(rings).join(', ')})`
    case 'GeometryCollection': {
      const parts = (geometry.geometries as GeoJsonGeometry[] | undefined) ?? []
      return `GEOMETRYCOLLECTION (${parts.map(write).join(', ')})`
    }
    default: throw new Error(`cannot serialize geometry type ${type} to WKT`)
  }
}

/** One coordinate tuple. */
function point(position: Position): string { return `(${position.join(' ')})` }

/** A parenthesized coordinate list. */
function positions(list: Position[]): string { return `(${list.map(p => p.join(' ')).join(', ')})` }

/** A parenthesized ring list. */
function rings(list: Position[][]): string { return `(${list.map(positions).join(', ')})` }
