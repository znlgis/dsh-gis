/**
 * T2.6 host side: what one render hands to the browser card.
 *
 * The card is a pure function of the persisted description, so the description
 * IS the contract: bounded (a transcript must not grow with the data), byte-free
 * (no geometry), and honest about what cannot be drawn yet.
 */
import { describe, expect, it } from 'vitest'
import type { Dataset } from '@znlgis/dsh-gis-core'
import { mapDescriptionOf, mapLayersOf, renderProseOf, type RenderValue } from '../src/map-description.ts'

/** One render value, with overrides. */
const value = (overrides: Partial<RenderValue> = {}): RenderValue => ({
  mapId: 'map-ds_1',
  datasetId: 'ds_1',
  bbox: [113, 22, 114, 23],
  image: { path: '/tmp/gis-render-ds_1.png', width: 900, height: 600, drawn: 3, features: 3 },
  layers: [],
  crs: 'EPSG:4326',
  issues: [],
  ...overrides,
})

describe('what the browser can draw today', () => {
  it('hands a GeoJSON dataset its own byte route', () => {
    const dataset: Dataset = { id: 'ds_1', kind: 'geojson', title: 'points.geojson', path: 'C:/data/points.geojson', layers: [{ name: 'points' }] }
    const { layers, notes } = mapLayersOf(dataset)

    expect(notes).toEqual([])
    expect(layers).toEqual([{
      id: 'ds_1',
      kind: 'geojson',
      url: '/api/gis/blob?id=ds_1',
      origin: 'local',
      style: { type: 'circle', paint: { 'circle-radius': 5, 'circle-color': '#2f6feb', 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' } },
    }])
  })

  it('hands a COG to the browser to decode by range', () => {
    // No style: a raster is pixels, not a primitive to outline. The url is the
    // byte route, which is what makes the client's ranged read possible.
    const dataset: Dataset = { id: 'ds_cog', kind: 'cog', title: 'sample-cog.tif', path: 'C:/data/sample-cog.tif', layers: [{ name: 'sample-cog.tif' }] }
    expect(mapLayersOf(dataset)).toEqual({
      layers: [{ id: 'ds_cog', kind: 'cog', url: '/api/gis/blob?id=ds_cog', origin: 'local' }],
      notes: [],
    })
  })

  it('hands the self-indexed containers to the browser too', () => {
    // FlatGeobuf and PMTiles carry their own spatial indexes: the host serves the
    // bytes and the client reads only the parts it draws.
    for (const kind of ['flatgeobuf', 'pmtiles'] as const) {
      const dataset: Dataset = { id: 'ds_' + kind, kind, title: 'points.' + kind, path: 'C:/data/points.' + kind, layers: [{ name: 'points' }] }
      expect(mapLayersOf(dataset), kind).toEqual({
        layers: [{ id: 'ds_' + kind, kind, url: '/api/gis/blob?id=ds_' + kind, origin: 'local' }],
        notes: [],
      })
    }
  })

  it('says so when a raster has no server-side picture, instead of inventing one', () => {
    const prose = renderProseOf(value({ image: null, crs: 'EPSG:4326' }))
    expect(prose).toContain('decodes it in the browser')
    expect(prose).toContain('crs: EPSG:4326')
    expect(prose).not.toContain('rendered 0 of')
  })

  it('says what is missing for every kind the browser cannot read directly', () => {
    const cases: Dataset[] = [
      { id: 'ds_s', kind: 'shapefile', title: 'cities.shp', main: 'C:/d/cities.shp', siblings: ['C:/d/cities.shp'], layers: [{ name: 'cities' }] },
      { id: 'ds_g', kind: 'gdb', title: 'cities.gdb', dir: 'C:/d/cities.gdb', layers: [{ name: 'cities' }] },
      { id: 'ds_p', kind: 'postgis', title: 'public.roads', profile: 'warehouse', layers: [{ name: 'roads' }] },
      { id: 'ds_n', kind: 'ndjson', title: 'events.ndjson', path: 'C:/d/events.ndjson', layers: [{ name: 'events' }] },
    ]
    for (const dataset of cases) {
      const { layers, notes } = mapLayersOf(dataset)
      expect(layers, dataset.kind).toEqual([])
      expect(notes.map(note => note.code), dataset.kind).toEqual(['UNSUPPORTED_FORMAT'])
      // The note has to say WHY: an empty map with no explanation is the
      // failure mode this project treats as a bug.
      expect(notes[0]!.message.length, dataset.kind).toBeGreaterThan(30)
    }
  })
})

describe('the persisted description', () => {
  it('carries the map, not the data', () => {
    const description = mapDescriptionOf(value({ layers: mapLayersOf({ id: 'ds_1', kind: 'geojson', title: 'p.geojson', path: 'C:/d/p.geojson', layers: [{ name: 'p' }] }).layers }))
    expect(description).toMatchObject({ mapId: 'map-ds_1', bbox: [113, 22, 114, 23], basemap: 'none' })
    expect(description.layers).toHaveLength(1)
    expect(description.layers[0]).toMatchObject({ id: 'ds_1', kind: 'geojson', url: '/api/gis/blob?id=ds_1', origin: 'local' })
  })

  it('stays bounded: extra layers drop instead of growing the transcript', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      id: 'ds_' + String(index), kind: 'geojson' as const, url: '/api/gis/blob?id=ds_' + String(index), origin: 'local' as const,
    }))
    expect(mapDescriptionOf(value({ layers: many })).layers).toHaveLength(8)
  })
})

describe('the prose the model reads', () => {
  it('reports what was drawn, the extent, the CRS, and every issue', () => {
    const prose = renderProseOf(value({
      issues: [
        { code: 'CRS_UNKNOWN', message: 'no .prj beside this shapefile' },
        { code: 'UNSUPPORTED_FORMAT', message: 'this dataset is not drawn in the browser yet' },
      ],
    }))
    expect(prose).toContain('rendered 3 of 3 feature(s)')
    expect(prose).toContain('900x600 px')
    expect(prose).toContain('extent [113, 22, 114, 23]')
    expect(prose).toContain('crs: EPSG:4326')
    expect(prose).toContain('[CRS_UNKNOWN] no .prj beside this shapefile')
    expect(prose).toContain('[UNSUPPORTED_FORMAT] this dataset is not drawn')
    expect(prose).toContain('no scale bar')
  })

  it('says so when there is nothing to report', () => {
    expect(renderProseOf(value())).toContain('no data-quality issues reported')
  })
})
