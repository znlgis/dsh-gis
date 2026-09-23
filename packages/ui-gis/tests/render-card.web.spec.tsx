/**
 * T2.7: the card's degradations, rendered for real.
 *
 * The DoD is "three degradations, each asserted end to end, none of them
 * throwing". So these tests render the ACTUAL card component in a DOM (jsdom),
 * with a fake MapLibre module and a fake availability probe, and assert what a
 * user would see: a sentence, never a blank canvas, never an exception.
 *
 * They also settle T2.6's own criterion one level lower than the unit tests
 * could: a replayed block must produce the same DOM as the live one.
 */
import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { GisRenderCard } from '../src/client/map/GisRenderCard.tsx'
import type { CardBlock } from '../src/client/map/card-model.ts'
import { fakeMapLibre } from './fake-maplibre.ts'

/** A well-formed persisted map description. */
const META = {
  mapId: 'map-ds_1',
  bbox: [113, 22, 114, 23],
  layers: [{ id: 'ds_1', kind: 'geojson', url: '/api/gis/blob?id=ds_1', origin: 'local', style: { type: 'circle' } }],
  basemap: 'none',
}

/** A settled result block. */
const settled = (overrides: Partial<CardBlock> = {}): CardBlock => ({
  kind: 'tool-result',
  callId: 'call_1',
  call: { name: 'gis_render', argsRaw: '{"id":"ds_1"}' },
  isError: false,
  content: [{ type: 'text', text: 'rendered 3 of 3 feature(s)' }],
  meta: META,
  ...overrides,
})

/** What a replay hands the card: plain data with no live identity. */
const replay = (block: CardBlock): CardBlock => JSON.parse(JSON.stringify(block)) as CardBlock

/** A probe that says every layer is still there. */
const present = async () => true
/** A probe that says the bytes are gone (the replayed-after-deletion case). */
const gone = async () => false

describe('the three degradations', () => {
  it('shows a failed render as a diagnosis, with its code', async () => {
    const view = render(
      <GisRenderCard
        block={settled({
          isError: true,
          error: { name: 'GisError', code: 'DATASET_NOT_FOUND' },
          content: [{ type: 'text', text: 'dataset ds_9 is not registered\nhint: rescan' }],
        })}
      />,
    )
    const card = await view.findByText(/DATASET_NOT_FOUND/)
    expect(card.textContent).toContain('dataset ds_9 is not registered')
    expect(view.container.querySelector('[data-gis-render-card]')?.getAttribute('data-gis-render-card')).toBe('failed')
  })

  it('degrades a result whose call is outside the window to its call id', async () => {
    const view = render(<GisRenderCard block={settled({ call: null })} />)
    const note = await view.findByText(/call_1/)
    expect(note.getAttribute('data-gis-render-note')).not.toBeNull()
    expect(view.container.querySelector('[data-gis-render-card]')?.getAttribute('data-gis-render-card')).toBe('orphan')
  })

  it('says the data is no longer available when the bytes are gone, and mounts no map', async () => {
    const fake = fakeMapLibre()
    const view = render(<GisRenderCard block={settled()} probe={gone} load={fake.environment.load} />)
    const note = await view.findByText(/no longer available/)
    expect(note.textContent).toContain('ds_1')
    expect(view.container.querySelector('[data-gis-render-card]')?.getAttribute('data-gis-render-card')).toBe('data-unavailable')
    // Nothing was mounted: the degradation is not a map with an empty patch.
    expect(view.container.querySelector('[data-gis-map]')).toBeNull()
    expect(fake.calls.constructed).toEqual([])
  })

  it('renders the map when the data is there, and still renders when the probe throws', async () => {
    const fake = fakeMapLibre()
    const view = render(<GisRenderCard block={settled()} probe={present} load={fake.environment.load} />)
    await waitFor(() => { expect(view.container.querySelector('[data-gis-map]')).not.toBeNull() })
    await waitFor(() => { expect(fake.calls.constructed).toHaveLength(1) })
    fake.fireLoad()
    await waitFor(() => { expect(fake.calls.layers).toHaveLength(1) })

    const throwing = fakeMapLibre()
    const second = render(
      <GisRenderCard
        block={settled()}
        probe={async () => { throw new Error('the probe itself broke') }}
        load={throwing.environment.load}
      />,
    )
    await waitFor(() => { expect(second.container.querySelector('[data-gis-map]')).not.toBeNull() })
  })
})

describe('replay fidelity', () => {
  it('produces the same DOM for a replayed block as for the live one', async () => {
    const fake = fakeMapLibre()
    const block = settled()
    const live = render(<GisRenderCard block={block} probe={present} load={fake.environment.load} />)
    const replayed = render(<GisRenderCard block={replay(block)} probe={present} load={fake.environment.load} />)

    // Both maps must exist before the style "loads", exactly as they would in a
    // browser: the fake fires every registered listener.
    await waitFor(() => { expect(fake.calls.constructed).toHaveLength(2) })
    fake.fireLoad()
    await waitFor(() => { expect(live.container.querySelector('[data-gis-map="ready"]')).not.toBeNull() })
    await waitFor(() => { expect(replayed.container.querySelector('[data-gis-map="ready"]')).not.toBeNull() })
    expect(replayed.container.innerHTML).toBe(live.container.innerHTML)
  })

  it('produces the same DOM for a replayed FAILURE as for the live one', async () => {
    const block = settled({ isError: true, error: { name: 'GisError', code: 'PARSE_FAILED' }, content: [{ type: 'text', text: 'bad geometry' }] })
    const live = render(<GisRenderCard block={block} />)
    const replayed = render(<GisRenderCard block={replay(block)} />)
    expect(replayed.container.innerHTML).toBe(live.container.innerHTML)
  })
})

describe('nothing throws', () => {
  it('survives every malformed input a log can carry', () => {
    const fake = fakeMapLibre()
    const blocks: CardBlock[] = [
      {},
      { kind: 'tool-result' },
      { kind: 'tool-result', call: null },
      { kind: 'tool-result', call: { name: 'gis_render', argsRaw: '{}' }, meta: 'not an object' },
      { kind: 'tool-result', call: { name: 'gis_render', argsRaw: '{}' }, meta: { layers: 'nope' } },
      { kind: 'tool-result', call: { name: 'gis_render', argsRaw: '{}' }, meta: { layers: [{ id: 'x' }] } },
      { kind: 'tool-result', call: { name: 'gis_render', argsRaw: '{}' }, isError: true },
      { callId: 'c', argsRaw: '{not json' },
    ]
    for (const block of blocks) {
      expect(() => render(<GisRenderCard block={block} probe={present} load={fake.environment.load} />), JSON.stringify(block)).not.toThrow()
    }
  })
})
