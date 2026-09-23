/**
 * A shapefile's id covers its whole family, not just the `.shp`.
 *
 * The `.dbf` holds the attributes, the `.prj` the CRS and the `.cpg` the
 * encoding: editing any of them changes WHAT the dataset is while the `.shp`
 * sits untouched. An id derived from bare member names would stay the same and
 * a replay would trust the old id for new bytes -- so this test edits one
 * sibling and demands a new id.
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describeDataset } from '../src/io.ts'

const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url))
const FAMILY = ['shp', 'shx', 'dbf', 'prj', 'cpg'] as const

/** Lay the GBK fixture family down under one stem in a temporary directory. */
async function familyIn(directory: string, stem: string): Promise<string> {
  for (const extension of FAMILY) {
    await copyFile(`${FIXTURES}cities-gbk.${extension}`, join(directory, `${stem}.${extension}`))
  }
  return join(directory, `${stem}.shp`)
}

describe('shapefile family identity', () => {
  it('is stable for unchanged bytes and changes when only the .dbf is edited', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gis-family-'))
    try {
      const main = await familyIn(directory, 'cities')
      const before = await describeDataset(main)
      expect((await describeDataset(main)).id).toBe(before.id)

      const attributes = join(directory, 'cities.dbf')
      const bytes = await readFile(attributes)
      await writeFile(attributes, Buffer.concat([bytes, Buffer.from([0])]))

      const after = await describeDataset(main)
      // Same members, same names: only the stats of one sibling moved, and that
      // alone has to be enough.
      expect(after.siblings).toEqual(before.siblings)
      expect(after.id).not.toBe(before.id)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
