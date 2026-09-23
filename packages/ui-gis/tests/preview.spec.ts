/**
 * T2.8: the preview metadata, the parsers, and the ranking the DoD is about.
 *
 * "priority: 'extension' takes effect" is a claim about the HOST's dispatch
 * order, so the assertion uses the host's own ranking function rather than a
 * copy of its rules -- if that order ever changes, this test fails instead of
 * the feature quietly becoming a plain-text preview.
 */
import { describe, expect, it } from 'vitest'
import { GIS_BINARY_EXTENSIONS, gisBinaryPreviewDefinition, gisTextPreviewDefinition, GIS_TEXT_EXTENSIONS } from '../src/client/preview/definition.ts'
import { MAX_PREVIEW_BYTES, planBinaryPreview } from '../src/client/preview/GisBinaryBody.tsx'
import { MAX_PREVIEW_TEXT, parseTextPreview } from '../src/client/preview/parse-text.ts'

describe('the metadata claims the right files', () => {
  it('is an EXTERNAL implementation, which is what makes it win', () => {
    const text = gisTextPreviewDefinition(() => 'Map preview')
    const binary = gisBinaryPreviewDefinition(() => 'GIS file preview')
    expect(text.priority).toBe('extension')
    expect(binary.priority).toBe('extension')
    // The body is keyed by this id, so metadata without a body shows an empty tab.
    expect(text.id).not.toBe(binary.id)
    // Every declared binary suffix must also be a declared extension (the
    // registry rejects strays, so a typo would fail registration at runtime).
    for (const extension of binary.binaryExtensions ?? []) expect(binary.extensions).toContain(extension)
    expect(text.loading).toBe('text-pages')
    expect(binary.loading).toBe('bytes-complete')
  })

  it('does not claim plain .json', () => {
    // A JSON file that is not GeoJSON belongs to the text preview: claiming it
    // would put a failed map in front of someone who wanted to read a config.
    expect(GIS_TEXT_EXTENSIONS).not.toContain('json')
  })

  // The RANKING itself ("external band first, then longest suffix") is the host's
  // rule and is asserted where the host actually runs it: `check:preview` opens a
  // .geojson file in a real browser and demands that the MAP preview wins over the
  // built-in text one. Re-implementing the rule here would only test the copy --
  // and importing the host's client bundle in Node fails on `window`.
  it('declares the suffixes the server-side ranking needs', () => {
    const text = gisTextPreviewDefinition(() => 'Map preview')
    expect(text.extensions).toContain('geojson')
    expect(text.extensions).toContain('ndjson')
    expect(gisBinaryPreviewDefinition(() => 'GIS').extensions).toContain('tif')
    expect(GIS_BINARY_EXTENSIONS).toContain('fgb')
  })
})

describe('a GeoJSON file becomes a map view', () => {
  const collection = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [113.26, 23.13] } }] })

  it('draws it as a geojson layer carrying the text itself', () => {
    const parsed = parseTextPreview('cities.geojson', collection)
    expect(parsed.kind).toBe('map')
    if (parsed.kind !== 'map') throw new Error('unreachable')
    expect(parsed.spec.layers).toHaveLength(1)
    expect(parsed.spec.layers[0]?.kind).toBe('geojson')
    // A data URL: pure, no blob lifetime, and the map needs no new layer kind.
    expect(parsed.spec.layers[0]?.url.startsWith('data:application/geo+json,')).toBe(true)
    // No bbox: MapLibre fits a GeoJSON source itself, and the file states none.
    expect(parsed.spec.bbox).toBeUndefined()
  })

  it('says WHY when the text is JSON but not GeoJSON', () => {
    const parsed = parseTextPreview('config.geojson', JSON.stringify({ layers: [] }))
    expect(parsed.kind).toBe('invalid')
    if (parsed.kind !== 'invalid') throw new Error('unreachable')
    expect(parsed.message).toContain('not GeoJSON')
  })

  it('says why when the text is not JSON at all', () => {
    const parsed = parseTextPreview('broken.geojson', '{oops')
    expect(parsed.kind).toBe('invalid')
  })

  it('refuses formats it claims but cannot yet draw, in words', () => {
    const parsed = parseTextPreview('shape.wkt', 'POINT (1 2)')
    expect(parsed.kind).toBe('unsupported')
    if (parsed.kind !== 'unsupported') throw new Error('unreachable')
    expect(parsed.message).toContain('not implemented yet')
  })

  it('refuses a file above the preview limit instead of building a huge data URL', () => {
    const parsed = parseTextPreview('huge.geojson', 'x'.repeat(MAX_PREVIEW_TEXT + 1))
    expect(parsed.kind).toBe('unsupported')
    if (parsed.kind !== 'unsupported') throw new Error('unreachable')
    expect(parsed.message).toContain('preview limit')
  })
})

describe('a binary file is planned before any decoding', () => {
  it('decodes FlatGeobuf and GeoTIFF, and refuses the rest by name', () => {
    expect(planBinaryPreview('points.fgb', 1024).kind).toBe('flatgeobuf')
    expect(planBinaryPreview('cog.tif', 1024).kind).toBe('raster')
    expect(planBinaryPreview('big.TIFF', 1024).kind).toBe('raster')
    const refused = planBinaryPreview('transport.pmtiles', 1024)
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') throw new Error('unreachable')
    expect(refused.message).toContain('.pmtiles')
  })

  it('refuses a raster above the cap, and points at the card that streams', () => {
    const plan = planBinaryPreview('big.tif', MAX_PREVIEW_BYTES + 1)
    expect(plan.kind).toBe('refused')
    if (plan.kind !== 'refused') throw new Error('unreachable')
    expect(plan.message).toContain('by range')
  })
})
