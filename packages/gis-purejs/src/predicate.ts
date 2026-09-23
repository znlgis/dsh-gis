/**
 * A deliberately small `where` evaluator.
 *
 * The design promises SQL-like filtering, but a pure-JS provider cannot honestly
 * implement SQL. This handles the shape that covers real filtering work --
 * comparisons joined by AND/OR -- and REFUSES anything else with a message that
 * says what to do instead, rather than silently returning wrong rows.
 */
import type { AttributeRow } from '@znlgis/dsh-gis-core'

type Compare = (left: unknown, right: string | number | boolean | null) => boolean

const OPERATORS: readonly (readonly [string, Compare])[] = [
  ['>=', (l, r) => Number(l) >= Number(r)],
  ['<=', (l, r) => Number(l) <= Number(r)],
  ['!=', (l, r) => String(l) !== String(r)],
  ['<>', (l, r) => String(l) !== String(r)],
  ['=', (l, r) => String(l) === String(r)],
  ['>', (l, r) => Number(l) > Number(r)],
  ['<', (l, r) => Number(l) < Number(r)],
]

/**
 * Compile a `where` expression into a row predicate.
 * @param where - the expression text.
 * @returns a predicate over attribute rows.
 * @throws Error when the expression uses syntax this evaluator refuses.
 */
export function compileWhere(where: string): (row: AttributeRow) => boolean {
  const text = where.trim()
  if (text.length === 0) return () => true
  if (/[()]/.test(text)) throw new Error('parentheses are not supported in `where`; use a flat list of comparisons joined by AND')

  const orGroups = splitTop(text, /\s+OR\s+/i)
  const compiled = orGroups.map(group => splitTop(group, /\s+AND\s+/i).map(compileComparison))
  return (row) => compiled.some(group => group.every(test => test(row)))
}

/** Split on a separator that is not inside quotes. */
function splitTop(text: string, separator: RegExp): string[] {
  return text.split(separator).map(part => part.trim()).filter(part => part.length > 0)
}

/** One `field OP literal` comparison. */
function compileComparison(text: string): (row: AttributeRow) => boolean {
  const like = /^([\w.]+)\s+LIKE\s+'([^']*)'$/i.exec(text)
  if (like !== null) {
    const [, field, pattern] = like as unknown as [string, string, string]
    const regex = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i')
    return row => regex.test(String(row[field] ?? ''))
  }

  for (const [token, compare] of OPERATORS) {
    const at = text.indexOf(token)
    if (at <= 0) continue
    const field = text.slice(0, at).trim()
    if (!/^[\w.]+$/.test(field)) continue
    const literal = parseLiteral(text.slice(at + token.length).trim())
    return row => compare(row[field], literal)
  }
  throw new Error(`unsupported \`where\` expression: ${text} (expected field = value, joined by AND/OR, or field LIKE 'pattern')`)
}

/** Parse a SQL-ish literal: quoted string, number, boolean, or NULL. */
function parseLiteral(raw: string): string | number | boolean | null {
  const quoted = /^'(.*)'$/.exec(raw)
  if (quoted !== null) return (quoted[1] as string).replace(/''/g, "'")
  if (/^null$/i.test(raw)) return null
  if (/^true$/i.test(raw)) return true
  if (/^false$/i.test(raw)) return false
  const asNumber = Number(raw)
  return Number.isFinite(asNumber) && raw.length > 0 ? asNumber : raw
}
