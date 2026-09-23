/**
 * T2.6: the map card is a pure function of the persisted call.
 *
 * The acceptance criterion for this task is "a replay draws what the live run
 * drew". That is a property of the DECISION function, not of the drawing: as
 * long as the state depends only on fields the session log persists, the same
 * log always yields the same card. So these tests freeze the input, round-trip
 * it through JSON, and demand the identical answer.
 */
import { describe, expect, it } from 'vitest'
import { mapCardState, type CardBlock } from '../src/client/map/card-model.ts'

/** A well-formed map description, exactly what the host persists. */
const META = {
  mapId: 'map-ds_1',
  bbox: [113, 22, 114, 23],
  layers: [{
    id: 'ds_1',
    kind: 'geojson',
    url: '/api/gis/blob?id=ds_1',
    origin: 'local',
    style: { type: 'circle', paint: { 'circle-radius': 5 } },
  }],
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

/** What a replay hands the card: plain data, no live object identity. */
const replay = (block: CardBlock): CardBlock => deepFreeze(JSON.parse(JSON.stringify(block)) as CardBlock)

/** Freeze a value deeply: any write attempt throws instead of passing silently. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

describe('the card is a pure function of the call', () => {
  it('answers the same state for a live block and for its replayed copy', () => {
    for (const block of [
      { kind: 'running', callId: 'call_0', argsRaw: '{"width":1200,"height":800}' } as unknown as CardBlock,
      { callId: 'call_r', argsRaw: '{}' } as unknown as CardBlock,
      settled(),
      settled({ isError: true, error: { name: 'GisError', code: 'DATASET_NOT_FOUND' }, content: [{ type: 'text', text: 'dataset ds_1 is not registered' }] }),
      settled({ call: null }),
      settled({ meta: undefined }),
      settled({ meta: { layers: 'nope' } }),
    ]) {
      expect(mapCardState(replay(block))).toEqual(mapCardState(block))
    }
  })

  it('reads only the log: a frozen block survives, and repeats are identical', () => {
    const frozen = replay(settled())
    expect(mapCardState(frozen)).toEqual(mapCardState(frozen))
    expect(mapCardState(frozen)).toEqual(mapCardState(settled()))
  })
})

describe('the states a card can be in', () => {
  it('shows the requested size while the render is still running', () => {
    expect(mapCardState({ callId: 'c', argsRaw: '{"width":1200,"height":800}' })).toEqual({ status: 'running', label: 'rendering 1200×800…' })
    expect(mapCardState({ callId: 'c', argsRaw: '{not json' })).toEqual({ status: 'running', label: 'rendering…' })
    expect(mapCardState({ callId: 'c' })).toEqual({ status: 'running', label: 'rendering…' })
  })

  it('degrades to the call id when the window cut left the call outside', () => {
    expect(mapCardState(settled({ call: null }))).toEqual({ status: 'orphan', callId: 'call_1' })
  })

  it('reports a failure with its code and the first line of diagnosis', () => {
    const state = mapCardState(settled({
      isError: true,
      error: { name: 'GisError', code: 'DATASET_NOT_FOUND' },
      content: [{ type: 'text', text: 'dataset ds_9 is not registered\nhint: rescan' }],
    }))
    expect(state).toEqual({ status: 'failed', message: '[DATASET_NOT_FOUND] dataset ds_9 is not registered' })
  })

  it('says so when a result carries no map description at all', () => {
    const state = mapCardState(settled({ meta: undefined }))
    expect(state.status).toBe('unavailable')
    expect(state.status === 'unavailable' ? state.message : '').toContain('map description')
  })

  it('draws a normalized view when the description is usable', () => {
    const state = mapCardState(settled())
    expect(state.status).toBe('ready')
    if (state.status !== 'ready') throw new Error('unreachable')
    expect(state.spec.layers.map(layer => layer.id)).toEqual(['ds_1'])
    expect(state.spec.bbox).toEqual([113, 22, 114, 23])
    expect(state.caption).toBe('map-ds_1')
    expect(state.issues).toEqual([])
  })

  it('keeps a defective description drawable, with the defects named', () => {
    const state = mapCardState(settled({ meta: { mapId: 'm', layers: [{ id: 'x', kind: 'kml', url: '/x' }, { id: 'ok', kind: 'geojson', url: '/ok' }] } }))
    expect(state.status).toBe('ready')
    if (state.status !== 'ready') throw new Error('unreachable')
    expect(state.spec.layers.map(layer => layer.id)).toEqual(['ok'])
    expect(state.issues.map(issue => issue.code)).toEqual(['LAYER_KIND_UNKNOWN'])
    expect(state.caption).toBe('m')
  })
})
