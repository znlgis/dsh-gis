/**
 * T2.1 + T2.2: the shared map's lifecycle and what it draws.
 *
 * Everything here is a failure mode that a browser would show as "the map is
 * blank" or "the tab gets slower every time you switch": the library arrives
 * after the container is gone, teardown runs twice, an observer outlives its
 * canvas, a status callback fires into an unmounted component, a re-draw leaves
 * the previous layers painting underneath. The controller is framework-free
 * exactly so these can be asserted in Node against a fake MapLibre module -- no
 * browser, no WebGL, no timing luck.
 */
import { describe, expect, it } from 'vitest'
import { createMapView, type MapViewStatus } from '../src/client/map/controller.ts'
import type { MapLibreModule } from '../src/client/map/load-maplibre.ts'
import type { MapLayerSpec, MapViewSpec } from '../src/client/map/spec.ts'
import { fakeMapLibre, TEST_TOKENS } from './fake-maplibre.ts'

/** Let every pending microtask run. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** A spec with one drawable layer. */
const oneLayer = (overrides: Partial<MapLayerSpec> = {}): MapViewSpec => ({
  bbox: [113, 22, 114, 23],
  layers: [{ id: 'roads', kind: 'geojson', url: '/api/gis/blob?id=ds_1', ...overrides }],
})

/** The container argument: only ever handed to MapLibre, never touched. */
const container = {} as HTMLElement

describe('the map lifecycle', () => {
  it('creates the map in the container, in a basemap-free style', async () => {
    const fake = fakeMapLibre()
    const statuses: MapViewStatus[] = []
    const view = createMapView({
      container,
      spec: oneLayer(),
      environment: fake.environment,
      onStatus: status => statuses.push(status),
    })
    await flush()
    expect(fake.calls.constructed).toHaveLength(1)
    expect(fake.calls.constructed[0]).toMatchObject({ container, attributionControl: false })

    fake.fireLoad()
    expect(statuses).toEqual(['ready'])
    expect(view.status).toBe('ready')
  })

  it('draws each layer from its URL, with theme-driven defaults, and frames the extent', async () => {
    const fake = fakeMapLibre()
    createMapView({ container, spec: oneLayer(), environment: fake.environment })
    await flush()
    fake.fireLoad()

    expect(fake.calls.sources).toEqual([['roads', { type: 'geojson', data: '/api/gis/blob?id=ds_1' }]])
    expect(fake.calls.layers).toHaveLength(1)
    expect(fake.calls.layers[0]).toMatchObject({
      id: 'roads',
      type: 'circle',
      source: 'roads',
      paint: { 'circle-radius': 5, 'circle-color': TEST_TOKENS.accent, 'circle-stroke-color': TEST_TOKENS.surface },
    })
    expect(fake.calls.bounds).toEqual([[[[113, 22], [114, 23]], { padding: 24, duration: 0 }]])
  })

  it('reports a layer it cannot draw instead of drawing nothing silently', async () => {
    const fake = fakeMapLibre()
    const issues: string[] = []
    createMapView({
      container,
      spec: { layers: [{ id: 'tiles', kind: 'mvt', url: '/api/gis/tiles?id=ds_1&z={z}&x={x}&y={y}' }] },
      environment: fake.environment,
      onIssue: issue => issues.push(issue.code + ':' + String(issue.layerId)),
    })
    await flush()
    fake.fireLoad()

    expect(issues).toEqual(['LAYER_SOURCE_LAYER_MISSING:tiles'])
    expect(fake.calls.sources).toEqual([])
  })

  it('resizes with the container while it is alive', async () => {
    const fake = fakeMapLibre()
    createMapView({ container, spec: oneLayer(), environment: fake.environment })
    await flush()
    fake.fireLoad()

    expect(fake.calls.observers).toBe(1)
    fake.fireResize()
    expect(fake.calls.resizes).toBe(1)
  })

  it('tears down the map and the observer exactly once, however often it is asked', async () => {
    const fake = fakeMapLibre()
    const view = createMapView({ container, spec: oneLayer(), environment: fake.environment })
    await flush()
    fake.fireLoad()

    fake.fireResize()
    expect(fake.calls.resizes).toBe(1)

    await view.destroy()
    await view.destroy()
    expect(fake.calls.removed).toBe(1)
    expect(fake.calls.disconnected).toBe(1)
    expect(view.status).toBe('destroyed')

    // A resize after teardown must not touch a removed map.
    fake.fireResize()
    expect(fake.calls.resizes).toBe(1)
  })

  it('creates nothing when the library arrives after the teardown', async () => {
    let deliver: ((module: MapLibreModule) => void) | undefined
    const fake = fakeMapLibre()
    const view = createMapView({
      container,
      spec: oneLayer(),
      environment: {
        load: () => new Promise<MapLibreModule>(resolve => { deliver = resolve }),
        observeResize: fake.environment.observeResize,
      },
    })

    const gone = view.destroy()
    deliver?.(fake.module)
    await gone

    expect(fake.calls.constructed).toEqual([])
    expect(fake.calls.observers).toBe(0)
    expect(fake.calls.removed).toBe(0)
  })

  it('stops reporting status once it is torn down', async () => {
    const fake = fakeMapLibre()
    const statuses: MapViewStatus[] = []
    const view = createMapView({
      container,
      spec: oneLayer(),
      environment: fake.environment,
      onStatus: status => statuses.push(status),
    })
    await flush()
    await view.destroy()
    fake.fireLoad()

    expect(statuses).toEqual([])
  })

  it('reports a library that never loads, instead of staying silently empty', async () => {
    const failure = new Error('webgl is not available')
    const statuses: MapViewStatus[] = []
    let detail: string | undefined
    createMapView({
      container,
      spec: oneLayer(),
      environment: { load: () => Promise.reject(failure) },
      onStatus: (status, info) => {
        statuses.push(status)
        detail = info.error instanceof Error ? info.error.message : undefined
      },
    })
    await flush()

    expect(statuses).toEqual(['failed'])
    expect(detail).toBe('webgl is not available')
  })

  it('takes the previous layers off the map before drawing the new ones', async () => {
    const fake = fakeMapLibre()
    const view = createMapView({ container, spec: oneLayer(), environment: fake.environment })
    await flush()
    fake.fireLoad()

    view.setLayers([{ id: 'rivers', kind: 'geojson', url: '/api/gis/blob?id=ds_2', style: { type: 'line' } }])
    // MapLibre throws on a duplicate source id, and a leftover layer keeps
    // painting: the old one must be gone before the new one is added.
    expect(fake.calls.removedLayers).toEqual(['roads'])
    expect(fake.calls.removedSources).toEqual(['roads'])
    expect(fake.calls.layers[1]).toMatchObject({ id: 'rivers', type: 'line' })
  })

  it('draws all three layer origins through the same path', async () => {
    const fake = fakeMapLibre()
    // A local file, a PostGIS connection, an OGC service: the component has no
    // branch that can tell them apart, because the seam is the URL.
    const spec: MapViewSpec = {
      layers: [
        { id: 'local', kind: 'geojson', origin: 'local', url: '/api/gis/blob?id=ds_1' },
        { id: 'connection', kind: 'mvt', origin: 'connection', url: '/api/gis/tiles?id=ds_2&z={z}&x={x}&y={y}', sourceLayer: 'roads', style: { type: 'line' } },
        { id: 'service', kind: 'raster', origin: 'service', url: '/api/gis/wms?layer=x&z={z}&x={x}&y={y}' },
      ],
    }
    const issues: string[] = []
    createMapView({ container, spec, environment: fake.environment, onIssue: issue => issues.push(issue.code) })
    await flush()
    fake.fireLoad()

    expect(issues).toEqual([])
    expect(fake.calls.sources).toEqual([
      ['local', { type: 'geojson', data: '/api/gis/blob?id=ds_1' }],
      ['connection', { type: 'vector', tiles: ['/api/gis/tiles?id=ds_2&z={z}&x={x}&y={y}'] }],
      ['service', { type: 'raster', tiles: ['/api/gis/wms?layer=x&z={z}&x={x}&y={y}'], tileSize: 256 }],
    ])
    expect(fake.calls.layers.map(layer => layer['type'])).toEqual(['circle', 'line', 'raster'])
    expect(fake.calls.layers[1]!['source-layer']).toBe('roads')
  })
})
