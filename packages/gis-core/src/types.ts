/**
 * The GIS data model. Mirrors design appendix C.
 *
 * Two invariants hold everywhere: a dataset id is OPAQUE to clients (a real
 * path never crosses the wire), and every coordinate that leaves this layer is
 * EPSG:4326 lon/lat unless a type says otherwise.
 */

/** A bounding box in EPSG:4326, ordered [west, south, east, north]. */
export type Bbox = readonly [number, number, number, number]

/** Where a coordinate reference system came from; never guess silently. */
export type CrsSource =
  | 'prj'            // read from a .prj sidecar
  | 'native'         // declared by the container itself
  | 'assumed-rfc7946'// GeoJSON: assumed WGS84 by spec
  | 'user'           // supplied explicitly by the caller
  | 'unknown'

/** What is known about a dataset's CRS. */
export interface CrsInfo {
  /** EPSG code when it could be resolved. */
  readonly epsg?: number
  /** Name as reported by the source, when available. */
  readonly name?: string
  /** How this CRS was determined. */
  readonly source: CrsSource
}

/** One attribute field. */
export interface FieldInfo {
  readonly name: string
  /** Source field type as reported by the driver (e.g. 'String', 'Integer'). */
  readonly type: string
}

/** What a dataset or one of its layers can do. */
export interface Capabilities {
  readonly read: boolean
  readonly write: boolean
  readonly tiles: boolean
  /** Why a capability is false, in the model's language. */
  readonly reason?: string
}

/** One layer inside a dataset. A single-file dataset has exactly one. */
export interface LayerRef {
  readonly name: string
  readonly geometryType?: string
  readonly featureCount?: number
  readonly bbox?: Bbox
  readonly srid?: number
}

/** Byte encoding actually used for attribute text, and where it came from. */
export interface EncodingInfo {
  readonly used?: string
  readonly source: 'cpg' | 'ldid' | 'user' | 'assumed' | 'unknown'
}

/** One structured problem found while reading a dataset. */
export interface GisIssue {
  /** Stable machine code; see errors.ts for the taxonomy. */
  readonly code: string
  /** One line the model can act on. */
  readonly message: string
  /** How many records exhibited it, when countable. */
  readonly count?: number
}

/** Dataset container kinds this plugin understands. */
export type DatasetKind = 'geojson' | 'ndjson' | 'wkt' | 'shapefile' | 'gdb' | 'postgis'

/** Fields common to every dataset shape. */
export interface DatasetBase {
  /** Opaque, content-derived id. Clients never see a path. */
  readonly id: string
  /** Human-facing title, usually the file or layer name. */
  readonly title: string
  readonly layers: readonly LayerRef[]
}

/** A dataset held in exactly one file. */
export interface FileDataset extends DatasetBase {
  readonly kind: 'geojson' | 'ndjson' | 'wkt'
  readonly path: string
}

/**
 * A dataset spread over a family of sibling files. A shapefile is the
 * canonical case: .shp + .shx + .dbf always travel together, and .prj / .cpg
 * decide CRS and attribute encoding.
 */
export interface FamilyDataset extends DatasetBase {
  readonly kind: 'shapefile'
  readonly main: string
  readonly siblings: readonly string[]
}

/** A dataset that is a directory container, such as an ESRI file geodatabase. */
export interface ContainerDataset extends DatasetBase {
  readonly kind: 'gdb'
  readonly dir: string
}

/** A dataset reached over a network connection; carries no secret. */
export interface ConnectionDataset extends DatasetBase {
  readonly kind: 'postgis'
  readonly profile: string
}

/** A registered dataset: exactly one of the four container shapes. */
export type Dataset = FileDataset | FamilyDataset | ContainerDataset | ConnectionDataset

/** One attribute row, values already JSON-safe. */
export type AttributeRow = Readonly<Record<string, string | number | boolean | null>>

/** One feature as it crosses the model boundary. */
export type GeometryEncoding = 'none' | 'wkt' | 'geojson'

/** A canonical feature: attributes plus geometry in the requested encoding. */
export interface Feature {
  readonly attributes: AttributeRow
  /** WKT text, a GeoJSON geometry object, or absent when geometry was not requested. */
  readonly geometry?: string | Readonly<Record<string, unknown>>
}

/** Result of inspecting a dataset. */
export interface InspectResult {
  readonly datasetId: string
  readonly kind: DatasetKind
  readonly layers: readonly LayerRef[]
  readonly crs: CrsInfo
  readonly encoding?: EncodingInfo
  readonly fields: readonly FieldInfo[]
  readonly bbox?: Bbox
  readonly featureCount?: number
  readonly capabilities: Capabilities
  readonly issues: readonly GisIssue[]
}

/** A paged read request. `bbox` is EPSG:4326. */
export interface QueryRequest {
  readonly layer?: string
  readonly where?: string
  readonly bbox?: Bbox
  readonly limit: number
  readonly offset: number
  readonly geometry: GeometryEncoding
  /** Attribute names to return; absent means all. */
  readonly fields?: readonly string[]
}

/** Result of a paged read. */
export interface QueryResult {
  readonly columns: readonly string[]
  readonly rows: readonly Feature[]
  /** Rows returned by this page. */
  readonly rowCount: number
  /** Total matching rows when the source can count them cheaply. */
  readonly totalCount?: number
  /** True when more rows match than this page returned. */
  readonly truncated: boolean
}
