/**
 * T2.2: the layer model.
 *
 * The inputs here are TOOL RESULTS -- replayed, possibly truncated, possibly
 * written by an older version. So every test is really the same question: does a
 * defective map description produce a diagnosis and a partially drawn map, or a
 * blank card and a stack trace?
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME, describeLayers, normalizeMapView, resolveLayerStyle, themeTokensOf,
} from '../src/client/map/layer-model.ts'
import type { MapLayerSpec } from '../src/client/map/spec.ts'
import { TEST_TOKENS } from './fake-maplibre.ts'

/** A well-formed layer. */
const layer = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 'roads', kind: 'geojson', url: '/api/gis/blob?id=ds_1', ...overrides,
})

describe('normalizing wire data', () => {
  it('answers an empty view for a description with no layers, without complaining', () => {
    const { spec, issues } = normalizeMapView({})
    expect(spec.layers).toEqual([])
    expect(issues).toEqual([])
  })

  it('rejects a value that is not a map description at all', () => {
    for (const value of [undefined, null, 42, 'layers', ['layers']]) {
      const { spec, issues } = normalizeMapView(value)
      expect(spec.layers).toEqual([])
      expect(issues.map(issue => issue.code)).toEqual(['SPEC_INVALID'])
    }
  })

  it('reports a layers field that is not a list', () => {
    const { issues } = normalizeMapView({ layers: 'roads' })
    expect(issues.map(issue => issue.code)).toEqual(['SPEC_INVALID'])
  })

  it('keeps a well-formed three-origin description intact', () => {
    const { spec, issues } = normalizeMapView({
      mapId: 'm1',
      bbox: [113, 22, 114, 23],
      layers: [
        layer(),
        layer({ id: 'conn', kind: 'mvt', origin: 'connection', sourceLayer: 'roads' }),
        layer({ id: 'svc', kind: 'raster', origin: 'service' }),
      ],
    })
    expect(issues).toEqual([])
    expect(spec.mapId).toBe('m1')
    expect(spec.bbox).toEqual([113, 22, 114, 23])
    expect(spec.layers.map(entry => [entry.id, entry.kind, entry.origin])).toEqual([
      ['roads', 'geojson', undefined],
      ['conn', 'mvt', 'connection'],
      ['svc', 'raster', 'service'],
    ])
    expect(spec.layers[1]!.sourceLayer).toBe('roads')
  })

  it('skips the layers it cannot use, naming each defect', () => {
    const { spec, issues } = normalizeMapView({
      layers: [
        'not a layer',
        { kind: 'geojson', url: '/x' },
        { id: 'no-url', kind: 'geojson' },
        layer({ id: 'alien', kind: 'kml' }),
        layer({ id: 'ok' }),
      ],
    })
    expect(issues.map(issue => issue.code)).toEqual([
      'LAYER_INVALID', 'LAYER_ID_MISSING', 'LAYER_URL_MISSING', 'LAYER_KIND_UNKNOWN',
    ])
    expect(spec.layers.map(entry => entry.id)).toEqual(['ok'])
    // Every skipped layer is named, so an operator can find it in the tool result.
    expect(issues.find(issue => issue.code === 'LAYER_URL_MISSING')?.layerId).toBe('no-url')
  })

  it('keeps the first of two layers that claim one id, because MapLibre would throw', () => {
    const { spec, issues } = normalizeMapView({ layers: [layer({ url: '/first' }), layer({ url: '/second' })] })
    expect(spec.layers.map(entry => entry.url)).toEqual(['/first'])
    expect(issues.map(issue => issue.code)).toEqual(['LAYER_DUPLICATE_ID'])
  })

  it('drops an extent it cannot trust, and says why', () => {
    const cases: [unknown, string][] = [
      [[1, 2, 3], 'three numbers'],
      [[1, 2, 3, 'north'], 'a string'],
      [[1, 2, Number.NaN, 4], 'NaN'],
      [[114, 22, 113, 23], 'west > east'],
      [[113, 23, 114, 22], 'south > north'],
    ]
    for (const [bbox, label] of cases) {
      const { spec, issues } = normalizeMapView({ bbox, layers: [] })
      expect(issues.map(issue => issue.code), label).toEqual(['BBOX_INVALID'])
      expect(spec.bbox, label).toBeUndefined()
    }
  })

  it('repairs a style it cannot use instead of failing the layer', () => {
    const bad = normalizeMapView({ layers: [layer({ style: 'bold' })] })
    expect(bad.issues.map(issue => issue.code)).toEqual(['LAYER_STYLE_INVALID'])
    expect(bad.spec.layers[0]!.style).toBeUndefined()

    const alien = normalizeMapView({ layers: [layer({ style: { type: 'heatmap', paint: { 'x': 1 } } })] })
    expect(alien.issues.map(issue => issue.code)).toEqual(['LAYER_STYLE_INVALID'])
    // The unusable primitive is dropped, the paint the host did state is kept.
    expect(alien.spec.layers[0]!.style).toEqual({ paint: { x: 1 } })
  })

  it('copies what it normalizes: a frozen tool result survives, and the output is not an alias', () => {
    const frozen = deepFreeze({
      mapId: 'm1',
      bbox: [1, 2, 3, 4],
      layers: [layer({ style: { type: 'circle', paint: { 'circle-radius': 3 } } })],
    })
    // A mutation would throw in strict mode, so reaching the assertions proves
    // the wire value is only ever read.
    const { spec } = normalizeMapView(frozen)
    expect(spec).not.toBe(frozen)
    const paint = spec.layers[0]!.style?.paint as Record<string, unknown>
    paint['circle-radius'] = 99
    const source = (frozen as { layers: { style: { paint: Record<string, unknown> } }[] }).layers[0]!
    expect(source.style.paint['circle-radius']).toBe(3)
  })
})

describe('the raster kind the client decodes', () => {
  it('keeps a cog layer, and describes NOTHING for it', () => {
    // A cog has no synchronous MapLibre description: its pixels do not exist
    // until the browser ranged-reads and decodes it. Describing it anyway made
    // the map fetch a GeoTIFF (or a 629 kB COG) as if it were GeoJSON, which
    // looked exactly like "the raster never loads".
    const { spec, issues } = normalizeMapView({ layers: [layer({ kind: 'cog' })] })
    expect(spec.layers.map(entry => entry.kind)).toEqual(['cog'])
    expect(issues).toEqual([])

    const described = describeLayers(spec.layers, TEST_TOKENS)
    expect(described.descriptions).toEqual([])
    expect(described.issues).toEqual([])
  })

  it('still draws the vector layers around a raster', () => {
    const { spec } = normalizeMapView({ layers: [layer({ kind: 'cog' }), layer({ id: 'points' })] })
    const described = describeLayers(spec.layers, TEST_TOKENS)
    expect(described.descriptions.map(entry => entry.id)).toEqual(['points'])
  })
})

describe('style resolution', () => {
  const base: MapLayerSpec = { id: 'l', kind: 'geojson', url: '/x' }

  it('keeps the style a host stated, verbatim', () => {
    const stated = { type: 'circle' as const, paint: { 'circle-radius': 12 } }
    expect(resolveLayerStyle({ ...base, style: stated }, TEST_TOKENS)).toEqual(stated)
  })

  it('paints a stated primitive with theme colors when no paint was given', () => {
    expect(resolveLayerStyle({ ...base, style: { type: 'line' } }, TEST_TOKENS).paint)
      .toEqual({ 'line-color': TEST_TOKENS.accent, 'line-width': 1.5 })
    expect(resolveLayerStyle({ ...base, style: { type: 'fill' } }, TEST_TOKENS).paint)
      .toEqual({ 'fill-color': TEST_TOKENS.accent, 'fill-opacity': 0.35, 'fill-outline-color': TEST_TOKENS.accent })
  })

  it('defaults a vector-tile layer to fill and a GeoJSON layer to circle', () => {
    expect(resolveLayerStyle(base, TEST_TOKENS).type).toBe('circle')
    expect(resolveLayerStyle({ ...base, kind: 'mvt', sourceLayer: 'roads' }, TEST_TOKENS).type).toBe('fill')
  })

  it('gives a raster layer no default paint, but keeps the raster paint a host stated', () => {
    expect(resolveLayerStyle({ ...base, kind: 'raster' }, TEST_TOKENS)).toEqual({})
    expect(resolveLayerStyle({ ...base, kind: 'raster', style: { paint: { 'raster-opacity': 0.5 } } }, TEST_TOKENS))
      .toEqual({ paint: { 'raster-opacity': 0.5 } })
  })
})

describe('theme tokens', () => {
  it('reads the host design tokens, and falls back when the page has none', () => {
    const tokens = {
      '--dsw-alias-brand-primary': 'rgb(1, 2, 3)',
      '--dsw-alias-label-primary': 'rgb(4, 5, 6)',
      '--dsw-alias-bg-base': 'rgb(7, 8, 9)',
      '--dsw-alias-border-l2': 'rgb(10, 11, 12)',
    }
    expect(themeTokensOf(undefined, name => tokens[name as keyof typeof tokens]))
      .toEqual({ accent: 'rgb(1, 2, 3)', ink: 'rgb(4, 5, 6)', surface: 'rgb(7, 8, 9)', border: 'rgb(10, 11, 12)' })
    expect(themeTokensOf(undefined, () => undefined)).toEqual(DEFAULT_THEME)
    // An element with no tokens at all lands on the fallbacks too.
    expect(themeTokensOf(undefined)).toEqual(DEFAULT_THEME)
  })
})

describe('drawable descriptions', () => {
  const of = (overrides: Partial<MapLayerSpec>): MapLayerSpec => ({
    id: 'roads', kind: 'geojson', url: '/api/gis/blob?id=ds_1', ...overrides,
  })

  it('builds one source and one layer per kind', () => {
    const { descriptions, issues } = describeLayers([
      of({}),
      of({ id: 'tiles', kind: 'mvt', sourceLayer: 'roads_layer', style: { type: 'line' } }),
      of({ id: 'pixels', kind: 'raster' }),
    ], TEST_TOKENS)

    expect(issues).toEqual([])
    expect(descriptions.map(entry => entry.source)).toEqual([
      { type: 'geojson', data: '/api/gis/blob?id=ds_1' },
      { type: 'vector', tiles: ['/api/gis/blob?id=ds_1'] },
      { type: 'raster', tiles: ['/api/gis/blob?id=ds_1'], tileSize: 256 },
    ])
    expect(descriptions.map(entry => entry.layer['type'])).toEqual(['circle', 'line', 'raster'])
    expect(descriptions[1]!.layer['source-layer']).toBe('roads_layer')
  })

  it('refuses a vector-tile layer that names no source layer', () => {
    const { descriptions, issues } = describeLayers([of({ kind: 'mvt' })], TEST_TOKENS)
    expect(descriptions).toEqual([])
    expect(issues.map(issue => issue.code)).toEqual(['LAYER_SOURCE_LAYER_MISSING'])
  })

  it('describes the three origins identically: the renderer is origin-blind', () => {
    const shape = { id: 'x', kind: 'geojson' as const, url: '/api/gis/blob?id=ds_1', style: { type: 'line' as const } }
    const descriptions = (['local', 'connection', 'service'] as const)
      .map(origin => describeLayers([{ ...shape, origin }], TEST_TOKENS).descriptions[0]!)
    expect(descriptions[1]).toEqual(descriptions[0])
    expect(descriptions[2]).toEqual(descriptions[0])
    // The origin is a label, not a rendering input -- it never reaches MapLibre.
    expect(JSON.stringify(descriptions[0])).not.toContain('connection')
  })
})

/** Freeze a value deeply, so any mutation throws instead of passing silently. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
