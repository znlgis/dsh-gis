/**
 * dBASE (.dbf) attribute reader with explicit code-page control.
 *
 * Encoding is the single most common cause of mojibake in Chinese shapefiles,
 * so it is a first-class input here rather than something inferred and hoped
 * for. Resolution order follows GDAL: an explicit caller choice, then the .cpg
 * sidecar, then the DBF language-driver byte; with none of those we report
 * `unknown` and let the tool refuse to guess (design 7.3).
 */
import type { AttributeRow } from '@znlgis/dsh-gis-core'

/** One DBF field descriptor. */
export interface DbfField {
  readonly name: string
  /** dBASE type character: C, N, F, D, L, M, ... */
  readonly type: string
  readonly length: number
  readonly decimals: number
}

/** A parsed attribute table. */
export interface DbfTable {
  readonly fields: readonly DbfField[]
  readonly records: readonly AttributeRow[]
  /** The label actually handed to TextDecoder. */
  readonly encoding: string
  readonly encodingSource: 'cpg' | 'ldid' | 'user' | 'assumed' | 'unknown'
  /** Raw language-driver byte, when the header has one. */
  readonly languageDriverId?: number
}

/**
 * Map a dBASE language-driver byte to a TextDecoder label.
 * Only the values that change real-world decoding are listed; the rest fall
 * back to the caller's choice.
 * @param ldid - byte 29 of the DBF header.
 * @returns a TextDecoder label, or undefined when unmapped.
 */
export function languageDriverEncoding(ldid: number): string | undefined {
  const table: Record<number, string> = {
    0x01: 'cp437', 0x02: 'cp850', 0x03: 'windows-1252',
    0x4d: 'windows-1252', 0x4e: 'windows-1252', 0x4f: 'windows-1252',
    0x57: 'windows-1252', 0x58: 'windows-1252', 0x59: 'windows-1252',
    0x64: 'cp852', 0x65: 'cp866', 0x66: 'cp865', 0x67: 'cp861',
    0x6a: 'cp737', 0x6b: 'cp857', 0x78: 'big5',   // 950, traditional Chinese
    0x79: 'euc-kr', 0x7a: 'gbk',                  // 936, simplified Chinese
    0x7b: 'shift_jis', 0x7c: 'windows-874', 0x7d: 'windows-1255',
    0x7e: 'windows-1256', 0xc8: 'windows-1250', 0xc9: 'windows-1251',
    0xca: 'windows-1254', 0xcb: 'windows-1253', 0xcc: 'windows-1257',
  }
  return table[ldid]
}

/**
 * Read a DBF buffer.
 * @param buffer - the whole .dbf file.
 * @param options - explicit encoding and its provenance.
 * @returns the parsed table.
 * @throws Error when the header is not a dBASE table we can read.
 */
export function readDbf(
  buffer: Uint8Array,
  options: { readonly cpg?: string; readonly requested?: string; readonly requestedSource?: 'cpg' | 'user' } = {},
): DbfTable {
  if (buffer.byteLength < 32) throw new Error('DBF file is shorter than its header')
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const recordCount = view.getUint32(4, true)
  const headerSize = view.getUint16(8, true)
  const recordSize = view.getUint16(10, true)
  const ldid = view.getUint8(29)

  const fields: DbfField[] = []
  for (let at = 32; at + 32 <= headerSize; at += 32) {
    if (view.getUint8(at) === 0x0d) break
    fields.push({
      name: latin1(buffer.subarray(at, at + 11)).replace(/\u0000.*$/, '').trim(),
      type: String.fromCharCode(view.getUint8(at + 11)),
      length: view.getUint8(at + 16),
      decimals: view.getUint8(at + 17),
    })
  }

  const resolved = resolveEncoding(options, ldid)
  const decoder = resolved.label === undefined ? undefined : new TextDecoder(resolved.label)

  const records: AttributeRow[] = []
  for (let index = 0; index < recordCount; index += 1) {
    const base = headerSize + index * recordSize
    if (base + recordSize > buffer.byteLength) break
    const flag = view.getUint8(base)
    if (flag === 0x2a) continue // deleted
    const row: Record<string, string | number | boolean | null> = {}
    let offset = base + 1
    for (const field of fields) {
      const raw = buffer.subarray(offset, offset + field.length)
      offset += field.length
      row[field.name] = convert(field, raw, decoder)
    }
    records.push(row)
  }

  return {
    fields,
    records,
    encoding: resolved.label ?? 'unknown',
    encodingSource: resolved.source,
    ...(ldid === 0 ? {} : { languageDriverId: ldid }),
  }
}

/** Resolve the effective encoding from the caller, the .cpg, or the LDID byte. */
function resolveEncoding(
  options: { readonly cpg?: string; readonly requested?: string; readonly requestedSource?: 'cpg' | 'user' },
  ldid: number,
): { label?: string; source: DbfTable['encodingSource'] } {
  if (options.requested !== undefined && options.requested.length > 0) {
    return { label: normalizeEncoding(options.requested), source: options.requestedSource ?? 'user' }
  }
  if (options.cpg !== undefined && options.cpg.trim().length > 0) {
    return { label: normalizeEncoding(options.cpg), source: 'cpg' }
  }
  const fromLdid = languageDriverEncoding(ldid)
  if (fromLdid !== undefined) return { label: fromLdid, source: 'ldid' }
  return { source: 'unknown' }
}

/**
 * Map a .cpg / user encoding label onto a TextDecoder label.
 * .cpg files in the wild carry bare code-page numbers ('936') as often as
 * names ('GBK'), so both are accepted.
 * @param raw - the label as written.
 * @returns a TextDecoder label.
 */
export function normalizeEncoding(raw: string): string {
  const value = raw.trim().replace(/^["']|["']$/g, '')
  const numeric: Record<string, string> = {
    '936': 'gbk', '950': 'big5', '932': 'shift_jis', '949': 'euc-kr',
    '65001': 'utf-8', '1252': 'windows-1252', '874': 'windows-874',
  }
  if (numeric[value] !== undefined) return numeric[value] as string
  const upper = value.toUpperCase()
  if (upper === 'GB2312' || upper === 'GBK' || upper === 'CP936') return 'gbk'
  if (upper === 'GB18030') return 'gb18030'
  if (upper === 'UTF8' || upper === 'UTF-8') return 'utf-8'
  return value.toLowerCase()
}

/** Convert one raw field value into a JSON-safe attribute. */
function convert(field: DbfField, raw: Uint8Array, decoder: TextDecoder | undefined): string | number | boolean | null {
  const ascii = latin1(raw).trim()
  switch (field.type) {
    case 'N': case 'F': {
      if (ascii.length === 0) return null
      const value = Number(ascii)
      return Number.isFinite(value) ? value : ascii
    }
    case 'L': {
      const c = ascii.toUpperCase()
      if (c === 'T' || c === 'Y') return true
      if (c === 'F' || c === 'N') return false
      return null
    }
    case 'D': return ascii.length === 0 ? null : ascii
    default: {
      const text = decoder === undefined ? latin1(raw) : decoder.decode(raw)
      return text.replace(/\u0000/g, '').trim()
    }
  }
}

/** Latin-1 view, safe for pure-ASCII regions such as numeric fields. */
function latin1(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}
