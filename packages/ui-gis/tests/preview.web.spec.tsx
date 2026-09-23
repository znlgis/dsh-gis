/**
 * T2.8: the preview bodies, rendered for real.
 *
 * The document SHELL is the host's; what this plugin owns is the body, so these
 * tests render the real components in a DOM with the real fixtures and a fake
 * MapLibre loader (the same seam the card uses). They cover the paths a user can
 * actually land in: a map, a refusal in words, and a file we claim but cannot
 * draw yet.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { GisBinaryBody } from '../src/client/preview/GisBinaryBody.tsx'
import { GisTextBody } from '../src/client/preview/GisTextBody.tsx'
import { fakeMapLibre } from './fake-maplibre.ts'

// `process.cwd()` rather than `import.meta.url`: the jsdom environment gives this
// module an http(s) URL, and `fileURLToPath` refuses it.
const FIXTURES = join(process.cwd(), 'tests', 'fixtures')

/** A GeoJSON file's text, as the document owner would deliver it. */
const GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { name: 'a' }, geometry: { type: 'Point', coordinates: [113.26, 23.13] } }],
})

describe('the text body', () => {
  it('draws a GeoJSON file on the shared map', async () => {
    const fake = fakeMapLibre()
    const view = render(
      <GisTextBody content={{ kind: 'text', text: GEOJSON }} path="points.geojson" load={fake.environment.load} />,
    )
    await waitFor(() => { expect(view.container.querySelector('[data-gis-map]')).not.toBeNull() })
    expect(view.container.querySelector('[data-gis-preview="map"]')).not.toBeNull()
  })

  it('refuses a JSON file that is not GeoJSON, and still shows the text', async () => {
    const view = render(<GisTextBody content={{ kind: 'text', text: JSON.stringify({ layers: [] }) }} path="config.geojson" />)
    const note = await view.findByText(/not GeoJSON/u)
    expect(note).toBeTruthy()
    expect(view.container.querySelector('[data-gis-preview-text]')?.textContent).toContain('layers')
  })

  it('refuses a claimed format it cannot draw, in words', async () => {
    const view = render(<GisTextBody content={{ kind: 'text', text: 'POINT (1 2)' }} path="shape.wkt" />)
    expect(await view.findByText(/not implemented yet/u)).toBeTruthy()
  })
})

describe('the binary body', () => {
  it('draws a real FlatGeobuf fixture on the shared map', async () => {
    const bytes = new Uint8Array(await readFile(join(FIXTURES, 'points.fgb')))
    const fake = fakeMapLibre()
    const view = render(<GisBinaryBody content={{ kind: 'bytes', data: bytes }} path="points.fgb" load={fake.environment.load} />)
    await waitFor(() => { expect(view.container.querySelector('[data-gis-map]')).not.toBeNull() }, { timeout: 5000 })
    expect(view.container.querySelector('[data-gis-preview="map"]')).not.toBeNull()
  })

  it('says what to do with a format that has no browser preview', async () => {
    const view = render(<GisBinaryBody content={{ kind: 'bytes', data: new Uint8Array(8) }} path="transport.pmtiles" />)
    expect(await view.findByText(/GIS tools instead/u)).toBeTruthy()
    expect(view.container.querySelector('[data-gis-preview="unsupported"]')).not.toBeNull()
  })

  it('reports a raster it cannot decode instead of showing nothing', async () => {
    // Eight bytes that are not a TIFF: the failure has to be a sentence.
    const view = render(<GisBinaryBody content={{ kind: 'bytes', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }} path="broken.tif" />)
    await waitFor(() => { expect(view.container.querySelector('[data-gis-preview="invalid"]')).not.toBeNull() }, { timeout: 5000 })
  })
})
