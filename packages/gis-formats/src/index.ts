/**
 * Pure-JS GIS format layer.
 *
 * Everything here is a pure function over bytes or text: no filesystem, no
 * services. The provider package does the I/O and hands sources in, which
 * keeps this layer exhaustively testable from fixtures.
 */
export { parseWkt, toWkt, type GeoJsonGeometry, type ParsedWkt } from './wkt.ts'
export { readGeoJson, readNdjson } from './geojson.ts'
export { readDbf, languageDriverEncoding, normalizeEncoding, type DbfField, type DbfTable } from './dbf.ts'
export { readShp, type ShpFile } from './shp.ts'
export { readShapefile, type ShapefileOptions, type ShapefileSources } from './shapefile.ts'
export { crsFromPrj, hasResolvedCrs } from './crs.ts'
export { extendBbox, visit, type RawFeature, type ReadResult } from './shared.ts'
