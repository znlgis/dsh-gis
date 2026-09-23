/**
 * The two self-indexed containers, against REAL fixtures.
 *
 * `points.fgb` and `points.pmtiles` are written by GDAL
 * (`node scripts/make-fixtures.mjs`), so these tests read bytes the reference
 * implementation produced -- not bytes we invented. Each one asserts CONTENT:
 * the features that came out, the layer names the archive declares.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readFlatGeobuf } from '../src/client/map/flatgeobuf-layer.ts'
import { vectorLayersOf } from '../src/client/map/pmtiles-layer.ts'

const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url))

/** The fixture's bytes. */
async function bytesOf(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(FIXTURES + name))
}

describe('FlatGeobuf', () => {
  it('asks the R-tree for the view, not for the file', async () => {
    // The rectangle is what makes FlatGeobuf cheap: the reader walks the packed
    // Hilbert R-tree for the nodes covering it. A rect far away therefore returns
    // NOTHING -- which is the proof that the index was consulted at all.
    const bytes = await bytesOf('points.fgb')
    const everything = await readFlatGeobuf(bytes, { rect: { minX: -180, minY: -90, maxX: 180, maxY: 90 } })
    expect(everything.features).toHaveLength(3)
    const elsewhere = await readFlatGeobuf(bytes, { rect: { minX: 0, minY: 0, maxX: 1, maxY: 1 } })
    expect(elsewhere.features).toHaveLength(0)
  })

  it('reads exactly what the source GeoJSON holds', async () => {
    const { features, truncated } = await readFlatGeobuf(await bytesOf('points.fgb'))
    expect(truncated).toBe(false)
    // Asserted AGAINST THE SOURCE the fixture was built from, not against
    // numbers copied into this file: a round trip that dropped a coordinate or
    // reordered the features has to fail here.
    const source = JSON.parse(new TextDecoder().decode(await bytesOf('points.geojson'))) as {
      features: { geometry: unknown; properties: unknown }[]
    }
    expect(features).toHaveLength(source.features.length)
    // Compared as a SET, because FlatGeobuf stores features in the order of its
    // packed Hilbert R-tree -- reading one back in source order is not something
    // the format promises. What it must preserve is every feature, byte for byte.
    const asSet = (values: unknown[]): string[] => values.map(value => JSON.stringify(value)).sort()
    expect(asSet(features.map(feature => (feature as { geometry?: unknown }).geometry)))
      .toEqual(asSet(source.features.map(feature => feature.geometry)))
    expect(asSet(features.map(feature => (feature as { properties?: unknown }).properties)))
      .toEqual(asSet(source.features.map(feature => feature.properties)))
  })

  it('stops at the cap instead of filling the tab', async () => {
    const { features, truncated } = await readFlatGeobuf(await bytesOf('points.fgb'), { maxFeatures: 2 })
    expect(features).toHaveLength(2)
    expect(truncated).toBe(true)
  })
})

describe('PMTiles', () => {
  it('names the vector layer the archive declares', async () => {
    const { FileSource, PMTiles } = await import('pmtiles')
    const bytes = await bytesOf('points.pmtiles')
    // A Blob, not an ArrayBuffer: FileSource slices and calls arrayBuffer() on it.
    const archive = new PMTiles(new FileSource(new Blob([bytes])))
    const names = vectorLayersOf(await archive.getMetadata())
    // The name comes from the archive, not from the file name: a vector source
    // with the wrong source-layer draws nothing and MapLibre does not say why.
    expect(names).toEqual(['points'])
  })

  it('ignores metadata that declares nothing usable', () => {
    expect(vectorLayersOf(undefined)).toEqual([])
    expect(vectorLayersOf('layers')).toEqual([])
    expect(vectorLayersOf({ vector_layers: 'points' })).toEqual([])
    expect(vectorLayersOf({ vector_layers: [{ id: 'roads' }, { noId: true }, { id: 7 }] })).toEqual(['roads'])
  })
})
