/**
 * T3.7: the filter compiles user text into SQL that cannot be steered.
 *
 * Every case here is an ATTACK or a mistake a user will make, and the assertions
 * are about what reaches the database: a bound parameter instead of a value, a
 * refusal instead of a silent drop, and a semicolon that stays inside a string.
 */
import { describe, expect, it } from 'vitest'
import { compileFilter, MAX_TERMS } from '../src/filter.ts'

const COLUMNS = ['id', 'name', 'population', 'geom']

describe('values are bound, never interpolated', () => {
  it('turns a literal into a placeholder', () => {
    const compiled = compileFilter("name = 'Beijing'", COLUMNS)
    expect(compiled.sql).toBe('("name" = $1)')
    expect(compiled.values).toEqual(['Beijing'])
    // The value itself must not appear in the SQL text.
    expect(compiled.sql).not.toContain('Beijing')
  })

  it('REFUSES a tautology smuggled through a quoted string', () => {
    // The splitter that finds AND/OR is quote-blind -- deliberately, because it is
    // the same one the pure-JS provider uses, so both paths agree on what the text
    // means. The consequence for this attempt is a REFUSAL rather than a bound
    // value: the second half is not a comparison, so nothing can be smuggled in.
    expect(() => compileFilter("name = 'x'' OR ''1''=''1'", COLUMNS)).toThrowError(/not a plain column name/u)
  })

  it('binds a quoted value that legitimately contains a quote', () => {
    const compiled = compileFilter("name = 'O''Brien'", COLUMNS)
    expect(compiled.sql).toBe('("name" = $1)')
    expect(compiled.values).toEqual(["O'Brien"])
  })

  it('keeps a statement terminator inside the parameter too', () => {
    const compiled = compileFilter("name = 'a'; DROP TABLE cities; --'", COLUMNS)
    expect(compiled.sql).toBe('("name" = $1)')
    expect(compiled.values).toEqual(['a\'; DROP TABLE cities; --'])
    expect(compiled.sql).not.toContain('DROP')
  })

  it('binds numbers, booleans and LIKE patterns', () => {
    expect(compileFilter('population > 1000 AND id <= 5', COLUMNS).values).toEqual([1000, 5])
    expect(compileFilter('id = true', COLUMNS).values).toEqual([true])
    const like = compileFilter("name LIKE 'city-%'", COLUMNS)
    expect(like.sql).toBe('("name" LIKE $1)')
    expect(like.values).toEqual(['city-%'])
  })
})

describe('identifiers come from a whitelist', () => {
  it('refuses a column the layer does not have, BY NAME', () => {
    const refusal = (() => { try { compileFilter('secret = 1', COLUMNS); return undefined } catch (error) { return error } })()
    expect(String(refusal?.message)).toContain('secret')
    expect(String(refusal?.message)).toContain('not a column')
    // …and it says what IS available, because a silent drop would return rows the
    // caller did not ask for.
    expect(String(refusal?.message)).toContain('id')
  })

  it('refuses anything that is not a plain column name on the left', () => {
    for (const attempt of ['1 = 1', 'id; -- = 1', 'pg_sleep(1) = null', 'name || id = 1']) {
      expect(() => compileFilter(attempt, COLUMNS), attempt).toThrowError(/PARSE_FAILED|not a plain column|unsupported|parentheses/u)
    }
  })

  it('refuses an unquoted value, which SQL would read as an identifier', () => {
    expect(() => compileFilter('name = Beijing', COLUMNS)).toThrowError(/must be quoted/u)
  })

  it('refuses parentheses and reports where the limit is', () => {
    expect(() => compileFilter('(id = 1)', COLUMNS)).toThrowError(/parentheses/u)
  })

  it('caps the number of comparisons', () => {
    const many = Array.from({ length: MAX_TERMS + 1 }, () => 'id = 1').join(' AND ')
    expect(() => compileFilter(many, COLUMNS)).toThrowError(/more than/u)
  })
})

describe('SQL semantics a reader expects', () => {
  it('spells NULL comparisons the way SQL means them', () => {
    // \`x = NULL\` is never true in SQL; returning an empty page for it would look
    // like "no rows match" rather than "you wrote something that cannot match".
    expect(compileFilter('name = NULL', COLUMNS).sql).toBe('("name" IS NULL)')
    expect(compileFilter('name != NULL', COLUMNS).sql).toBe('("name" IS NOT NULL)')
  })

  it('groups AND tighter than OR, like the JS evaluator does', () => {
    const compiled = compileFilter('id = 1 OR id = 2 AND name = \'a\'', COLUMNS)
    expect(compiled.sql).toBe('("id" = $1) OR ("id" = $2 AND "name" = $3)')
    expect(compiled.values).toEqual([1, 2, 'a'])
  })

  it('returns no filter for an empty expression', () => {
    expect(compileFilter('   ', COLUMNS)).toEqual({ sql: '', values: [], terms: 0 })
  })
})
