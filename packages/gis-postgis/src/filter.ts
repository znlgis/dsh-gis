/**
 * The `where` filter for PostGIS (T3.7), compiled to SQL with BOUND values.
 *
 * The pure-JS provider evaluates a filter in JavaScript and can afford to be
 * casual. Here the same expression text becomes SQL, which changes what a mistake
 * costs, so two rules are absolute:
 *
 * 1. **No value is ever interpolated.** Every literal becomes $n and travels as a
 *    bound parameter. A value containing a quote, a semicolon, or the word DROP is
 *    therefore just a value -- the database never parses it.
 * 2. **No identifier is used unless the CALLER's whitelist has it.** A column name
 *    cannot be bound (SQL has no placeholder for one), so the only safe treatment is
 *    to require it to be a column of the layer being read. An unknown name is
 *    refused BY NAME, never silently dropped and never passed on.
 *
 * The grammar is deliberately the one the pure-JS provider accepts -- field OP
 * literal joined by AND/OR, with parentheses refused -- so a filter that works on a
 * GeoJSON file means the same thing on a PostGIS table.
 */
import { GisError } from '@znlgis/dsh-gis-core'

/** How many comparisons one filter may carry. */
export const MAX_TERMS = 50

/** The comparison operators this dialect accepts, longest first. */
const OPERATORS = ['>=', '<=', '!=', '<>', '=', '>', '<'] as const

/** A filter compiled into SQL and its bound values. */
export interface CompiledFilter {
  /** SQL text using $1-style placeholders, or an empty string when there is no filter. */
  readonly sql: string
  /** Values for the placeholders, in order. */
  readonly values: readonly (string | number | boolean)[]
  /** How many comparisons it carries. */
  readonly terms: number
}

/**
 * Compile a where expression.
 * @param where - the expression text; empty means no filter.
 * @param columns - the ONLY identifiers that may appear.
 * @returns the SQL fragment and its values.
 * @throws GisError PARSE_FAILED for anything this dialect refuses.
 */
export function compileFilter(where: string, columns: readonly string[]): CompiledFilter {
  const text = where.trim()
  if (text.length === 0) return { sql: '', values: [], terms: 0 }
  if (/[()]/u.test(text)) {
    throw new GisError('PARSE_FAILED', 'parentheses are not supported in where; use a flat list of comparisons joined by AND/OR')
  }

  const allowed = new Set(columns)
  const values: (string | number | boolean)[] = []
  const orGroups = splitTop(text, /\s+OR\s+/iu)
  if (orGroups.length === 0) throw new GisError('PARSE_FAILED', 'the where expression is empty')

  let terms = 0
  const compiled = orGroups.map(group => {
    const parts = splitTop(group, /\s+AND\s+/iu).map(part => compileComparison(part, allowed, values))
    terms += parts.length
    if (terms > MAX_TERMS) {
      throw new GisError('PARSE_FAILED', 'this filter has more than ' + String(MAX_TERMS) + ' comparisons; split it into several reads')
    }
    return '(' + parts.join(' AND ') + ')'
  })
  return { sql: compiled.join(' OR '), values, terms }
}

/** Split on a separator; this dialect has no nesting, so a plain split is correct. */
function splitTop(text: string, separator: RegExp): string[] {
  return text.split(separator).map(part => part.trim()).filter(part => part.length > 0)
}

/**
 * Compile one field OP literal comparison.
 * @param text - the comparison.
 * @param allowed - permitted identifiers.
 * @param values - the accumulator for bound values.
 * @returns SQL for this comparison.
 */
function compileComparison(text: string, allowed: ReadonlySet<string>, values: (string | number | boolean)[]): string {
  const like = /^([A-Za-z_][A-Za-z0-9_]*)\s+(NOT\s+)?LIKE\s+(.+)$/iu.exec(text)
  if (like !== null) {
    const field = like[1] as string
    requireAllowed(field, allowed)
    const negated = like[2] !== undefined
    const pattern = parseLiteral((like[3] as string).trim(), field)
    values.push(pattern as string)
    return quoteColumn(field) + (negated ? ' NOT LIKE ' : ' LIKE ') + '$' + String(values.length)
  }

  for (const operator of OPERATORS) {
    const at = text.indexOf(operator)
    if (at <= 0) continue
    const field = text.slice(0, at).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(field)) {
      throw new GisError('PARSE_FAILED', 'the left side of "' + text + '" is not a plain column name')
    }
    requireAllowed(field, allowed)
    const literal = parseLiteral(text.slice(at + operator.length).trim(), field)
    // SQL's three-valued logic makes x = NULL never true, so the NULL spellings get
    // the meaning a reader expects rather than a silently empty result.
    if (literal === null) {
      return quoteColumn(field) + (operator === '=' ? ' IS NULL' : ' IS NOT NULL')
    }
    values.push(literal)
    return quoteColumn(field) + ' ' + (operator === '<>' ? '!=' : operator) + ' $' + String(values.length)
  }

  throw new GisError('PARSE_FAILED', 'unsupported where expression: ' + text + " (expected field = value, joined by AND/OR, or field LIKE 'pattern')")
}

/** Refuse an identifier the caller did not allow. */
function requireAllowed(field: string, allowed: ReadonlySet<string>): void {
  if (allowed.has(field)) return
  const known = [...allowed].slice(0, 12).join(', ')
  // Refused BY NAME, and the message says what exists: a filter that quietly
  // ignores an unknown column returns rows the caller did not ask for.
  throw new GisError('PARSE_FAILED', 'the field "' + field + '" is not a column of this layer' + (known.length === 0 ? '' : ' (available: ' + known + ')'))
}

/** Quote an identifier that has already been whitelisted. */
function quoteColumn(field: string): string {
  return '"' + field.split('"').join('""') + '"'
}

/**
 * Parse one SQL-ish literal.
 *
 * A quoted string is taken as a WHOLE: text after the closing quote is not ignored,
 * it becomes part of the value -- which is what makes
 * name = 'a'' OR ''1''=''1' a comparison against a strange string rather than an
 * injected condition.
 * @param raw - the literal text.
 * @param field - the field, for the error message.
 * @returns the value to bind.
 */
function parseLiteral(raw: string, field: string): string | number | boolean {
  const quoted = /^'(.*)'$/su.exec(raw)
  if (quoted !== null) return (quoted[1] as string).replace(/''/gu, "'")
  if (/^true$/iu.test(raw)) return true
  if (/^false$/iu.test(raw)) return false
  if (/^null$/iu.test(raw)) return null as never
  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && raw.length > 0) return asNumber
  // Unquoted text is a syntax error here, unlike the JS evaluator which treats it as
  // a string: in SQL an unquoted token is an IDENTIFIER, and binding it as a string
  // would hide that the caller wrote something this dialect does not mean.
  throw new GisError('PARSE_FAILED', 'the value for "' + field + '" must be quoted, numeric, boolean or null, got: ' + raw)
}
