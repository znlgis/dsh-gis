
/**
 * Generate the M1a fixtures.
 *
 * The shapefile family fixtures are written BY HAND because the readers under
 * test are hand-written too: generating them with GDAL would test our reader
 * against a different implementation's assumptions rather than against the
 * format. DBF text bytes for the GBK case are hardcoded and then DECODED here
 * for display, so a wrong byte sequence is visible immediately instead of
 * silently becoming the expected value in a test.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'tests', 'fixtures')
mkdirSync(OUT, { recursive: true })

// ---------- GeoJSON ----------
writeFileSync(join(OUT, 'points.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Alpha', rank: 1 }, geometry: { type: 'Point', coordinates: [116.4, 39.9] } },
    { type: 'Feature', properties: { name: 'Beta', rank: 2 }, geometry: { type: 'Point', coordinates: [121.47, 31.23] } },
    { type: 'Feature', properties: { name: 'Gamma', rank: 3 }, geometry: { type: 'Point', coordinates: [113.26, 23.13] } },
  ],
}, null, 2) + '\n')

// projected metres: passes the "out of degree range" heuristic, which is exactly
// the case that must be REPORTED rather than silently drawn.
writeFileSync(join(OUT, 'projected.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'P1' }, geometry: { type: 'Point', coordinates: [500000, 3400000] } },
    { type: 'Feature', properties: { name: 'P2' }, geometry: { type: 'Point', coordinates: [501000, 3401000] } },
  ],
}, null, 2) + '\n')

// ---------- NDJSON ----------
writeFileSync(join(OUT, 'events.ndjson'),
  [
    JSON.stringify({ type: 'Feature', properties: { id: 1, kind: 'survey' }, geometry: { type: 'Point', coordinates: [100, 10] } }),
    JSON.stringify({ type: 'Feature', properties: { id: 2, kind: 'survey' }, geometry: { type: 'Point', coordinates: [101, 11] } }),
    'not json at all',
    JSON.stringify({ type: 'Feature', properties: { id: 3, kind: 'inspection' }, geometry: { type: 'Point', coordinates: [102, 12] } }),
  ].join('\n') + '\n')

// ---------- shapefile writers ----------
const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
const AUTHORITY_PRJ = 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],UNIT["Meter",1.0],AUTHORITY["EPSG","3857"]]'

/** Point-type .shp: 100-byte header plus one 20-byte record body per point. */
function writeShp(points) {
  const n = points.length
  const fileBytes = 100 + n * 28 // 8-byte record header + 20-byte body
  const buf = Buffer.alloc(fileBytes)
  buf.writeInt32BE(9994, 0)
  buf.writeInt32BE(fileBytes / 2, 24)
  buf.writeInt32LE(1000, 28)
  buf.writeInt32LE(1, 32) // Point
  const xs = points.map(p => p[0]); const ys = points.map(p => p[1])
  buf.writeDoubleLE(Math.min(...xs), 36); buf.writeDoubleLE(Math.min(...ys), 44)
  buf.writeDoubleLE(Math.max(...xs), 52); buf.writeDoubleLE(Math.max(...ys), 60)
  points.forEach((p, i) => {
    const at = 100 + i * 28
    buf.writeInt32BE(i + 1, at)
    buf.writeInt32BE(10, at + 4) // 20 bytes = 10 words
    buf.writeInt32LE(1, at + 8)
    buf.writeDoubleLE(p[0], at + 12)
    buf.writeDoubleLE(p[1], at + 20)
  })
  return buf
}

/** Matching .shx index: same header, 8 bytes per record. */
function writeShx(points) {
  const buf = Buffer.alloc(100 + points.length * 8)
  buf.writeInt32BE(9994, 0)
  buf.writeInt32BE((100 + points.length * 8) / 2, 24)
  buf.writeInt32LE(1000, 28)
  buf.writeInt32LE(1, 32)
  points.forEach((_, i) => {
    buf.writeInt32BE(50 + i * 14, 100 + i * 8) // offset in words: 100/2 + i*28/2
    buf.writeInt32BE(10, 104 + i * 8)
  })
  return buf
}

/**
 * Minimal dBASE III table.
 * @param fields - [{ name, type, length }]
 * @param rows - arrays of already-ENCODED byte arrays (text) or numbers
 * @param ldid - language driver byte; 0 means "unset", the interesting case.
 */
function writeDbf(fields, rows, ldid) {
  const headerSize = 32 + fields.length * 32 + 1
  const recordSize = 1 + fields.reduce((sum, f) => sum + f.length, 0)
  const buf = Buffer.alloc(headerSize + rows.length * recordSize + 1)
  buf.writeUInt8(0x03, 0)
  buf.writeUInt8(124, 1); buf.writeUInt8(1, 2); buf.writeUInt8(1, 3) // 2024-01-01
  buf.writeUInt32LE(rows.length, 4)
  buf.writeUInt16LE(headerSize, 8)
  buf.writeUInt16LE(recordSize, 10)
  buf.writeUInt8(ldid, 29)
  let at = 32
  for (const f of fields) {
    buf.write(f.name.slice(0, 10), at, 'latin1')
    buf.writeUInt8(f.type.charCodeAt(0), at + 11)
    buf.writeUInt8(f.length, at + 16)
    buf.writeUInt8(0, at + 17)
    at += 32
  }
  buf.writeUInt8(0x0d, at)
  rows.forEach((row, index) => {
    let cursor = headerSize + index * recordSize
    buf.writeUInt8(0x20, cursor); cursor += 1
    row.forEach((value, fieldIndex) => {
      const f = fields[fieldIndex]
      const slice = buf.subarray(cursor, cursor + f.length).fill(0x20)
      if (Buffer.isBuffer(value)) value.copy(slice)
      else slice.write(String(value), 0, 'latin1')
      cursor += f.length
    })
  })
  buf.writeUInt8(0x1a, headerSize + rows.length * recordSize)
  return buf
}

// ---------- F3: shapefile WITHOUT .prj (the CRS_UNKNOWN case) ----------
const noPrjPoints = [[116.4, 39.9], [121.47, 31.23], [113.26, 23.13]]
writeFileSync(join(OUT, 'cities-noprj.shp'), writeShp(noPrjPoints))
writeFileSync(join(OUT, 'cities-noprj.shx'), writeShx(noPrjPoints))
writeFileSync(join(OUT, 'cities-noprj.dbf'), writeDbf(
  [{ name: 'NAME', type: 'C', length: 16 }, { name: 'POP', type: 'N', length: 10 }],
  [['Beijing', '2189'], ['Shanghai', '2487'], ['Guangzhou', '1868']],
  0, // no language driver byte -> encoding undecided
))

// ---------- F4: shapefile WITH .prj and GBK-encoded attributes ----------
// Hardcoded GBK bytes. Printed below so a wrong sequence is obvious.
const GBK = {
  beijing:   Buffer.from([0xb1, 0xb1, 0xbe, 0xa9]),
  shanghai:  Buffer.from([0xc9, 0xcf, 0xba, 0xa3]),
  guangzhou: Buffer.from([0xb9, 0xe3, 0xd6, 0xdd]),
}
const decoder = new TextDecoder('gbk')
console.log('GBK fixture self-check:')
for (const [key, bytes] of Object.entries(GBK)) console.log('  ' + key + ' -> ' + decoder.decode(bytes))

writeFileSync(join(OUT, 'cities-gbk.shp'), writeShp(noPrjPoints))
writeFileSync(join(OUT, 'cities-gbk.shx'), writeShx(noPrjPoints))
writeFileSync(join(OUT, 'cities-gbk.dbf'), writeDbf(
  [{ name: 'NAME', type: 'C', length: 20 }, { name: 'POP', type: 'N', length: 10 }],
  [[GBK.beijing, '2189'], [GBK.shanghai, '2487'], [GBK.guangzhou, '1868']],
  0x7a, // LDID 0x7a == 936 == GBK
))
writeFileSync(join(OUT, 'cities-gbk.prj'), WGS84_PRJ)
writeFileSync(join(OUT, 'cities-gbk.cpg'), 'GBK\n')

// ---------- a .prj that states an EPSG authority ----------
writeFileSync(join(OUT, 'webmercator.prj'), AUTHORITY_PRJ)

console.log('\nfixtures written to tests/fixtures:')
for (const name of ['points.geojson', 'projected.geojson', 'events.ndjson', 'cities-noprj.shp', 'cities-noprj.dbf', 'cities-gbk.shp', 'cities-gbk.dbf', 'cities-gbk.prj', 'cities-gbk.cpg']) {
  const { statSync } = await import('node:fs')
  console.log('  ' + name + '  ' + statSync(join(OUT, name)).size + ' bytes')
}
