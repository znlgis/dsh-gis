/**
 * The PMTiles reader, wrapped so the bundle's dynamic import stays ESM.
 *
 * Same reason as ./geotiff.ts and ./flatgeobuf.ts. `PMTiles` reads the archive
 * header and directories with RANGE requests, and `Protocol` is the MapLibre
 * protocol handler that serves individual tiles out of it -- both exported here
 * so the layer module holds no static dependency on the library.
 */
import { PMTiles, Protocol } from 'pmtiles'

export { PMTiles, Protocol }
