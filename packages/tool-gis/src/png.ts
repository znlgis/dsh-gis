/**
 * A minimal PNG encoder.
 *
 * Hand-written over Node's built-in zlib rather than pulling a canvas or image
 * library: the plugin must install and run with no native dependency, and the
 * only thing we need to emit is one truecolour image. PNG is small enough that
 * owning it costs less than owning a dependency.
 */
import { deflateSync } from 'node:zlib'

/** The eight-byte PNG file signature. */
const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * CRC-32 of a byte run.
 * @param bytes - the bytes to checksum.
 * @returns the unsigned checksum.
 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, data, then CRC over type and data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map(character => character.charCodeAt(0)))
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  const crcInput = new Uint8Array(4 + data.length)
  crcInput.set(typeBytes, 0)
  crcInput.set(data, 4)
  view.setUint32(8 + data.length, crc32(crcInput))
  return out
}

/**
 * Encode RGBA pixels as a PNG.
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @param rgba - `width * height * 4` bytes, row-major, top row first.
 * @returns the complete PNG file bytes.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // colour type: truecolour with alpha
  ihdr[10] = 0  // compression: deflate
  ihdr[11] = 0  // filter method
  ihdr[12] = 0  // no interlacing

  // Every scanline is prefixed with its filter byte; 0 means no filtering.
  const stride = width * 4
  const raw = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}
