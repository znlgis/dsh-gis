/**
 * T2.9: the session-level map state, and the property it exists for.
 *
 * The DoD is "after a replay the layer state matches the live one". These tests
 * assert exactly that, in the strongest form available without a browser: fold
 * the log as it is appended, fold it again from a JSON round-trip of the same
 * log (which is what a replay reads), and demand the identical state.
 *
 * The events are typed literals rather than a hand-rolled \`{ type, data }\` blob:
 * the fold's contract is that it reads COMMITTED session events, so the test has
 * to speak that shape -- and DSH's own suites build tool/result events the same
 * way.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyGisMapEvent, EMPTY_GIS_MAP_STATE, gisMapProjection, type GisMapState } from '../src/index.ts'

/** A \`gis_render\` result event carrying one map description. */
function renderEvent(seq: number, layers: { id: string; kind: string }[], mapId = 'map-1'): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 1_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: { id: 'm' + String(seq), role: 'tool', toolCallId: 'c' + String(seq), isError: false, source: { kind: 'tool', callId: 'c' + String(seq) }, content: [] },
      meta: { mapId, bbox: [100, 30, 110, 40], layers: layers.map(layer => ({ ...layer, url: '/api/gis/blob?id=' + layer.id, origin: 'local' })), basemap: 'none' },
    },
  } as unknown as SessionEvent
}

/** A result from some other tool: no map description in it. */
function otherEvent(seq: number): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 2_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: { id: 'm' + String(seq), role: 'tool', toolCallId: 'c' + String(seq), isError: false, source: { kind: 'tool', callId: 'c' + String(seq) }, content: [] },
      meta: { kind: 'unrelated', rows: 3 },
    },
  } as unknown as SessionEvent
}

/** Fold a whole log. */
function fold(events: readonly SessionEvent[]): GisMapState {
  let state = gisMapProjection.init({} as never, 0 as never)
  for (const event of events) state = applyGisMapEvent(state, event)
  return state
}

describe('the map state is a fold over the log', () => {
  it('remembers the layers a render drew, and where they came from', () => {
    const state = fold([renderEvent(0, [{ id: 'ds_1', kind: 'geojson' }, { id: 'ds_2', kind: 'cog' }])])
    expect(state).toEqual({
      mapId: 'map-1',
      layers: [{ id: 'ds_1', kind: 'geojson', visible: true }, { id: 'ds_2', kind: 'cog', visible: true }],
      asOfSeq: 0,
    })
  })

  it('REPLACES the layer set on the next render instead of accumulating', () => {
    // The card draws exactly what the newest description says. Remembering a
    // layer from an earlier render would claim something is on the map that the
    // description no longer contains.
    const state = fold([
      renderEvent(0, [{ id: 'ds_1', kind: 'geojson' }]),
      renderEvent(4, [{ id: 'ds_9', kind: 'pmtiles' }], 'map-9'),
    ])
    expect(state.mapId).toBe('map-9')
    expect(state.layers.map(layer => layer.id)).toEqual(['ds_9'])
    expect(state.asOfSeq).toBe(4)
  })

  it('ignores everything that is not one of our map descriptions', () => {
    const events = [otherEvent(0), { type: 'turn/start', seq: 1, time: 3, data: {} } as unknown as SessionEvent]
    const state = fold(events)
    expect(state).toEqual(EMPTY_GIS_MAP_STATE)
    // And the fold is REFERENCE-preserving: unchanged state means zero downstream
    // work, which is what the projection machinery keys on.
    let current: GisMapState = EMPTY_GIS_MAP_STATE
    for (const event of events) {
      const next = applyGisMapEvent(current, event)
      expect(Object.is(next, current)).toBe(true)
      current = next
    }
  })

  it('refuses a meta that only looks like ours', () => {
    const hostile = [
      { mapId: 'map-x', basemap: 'osm', layers: [{ id: 'a', kind: 'geojson' }] },
      { mapId: 'map-x', basemap: 'none', layers: 'layers' },
      { basemap: 'none', layers: [] },
      null,
    ]
    for (const meta of hostile) {
      const event = { type: 'tool/result', seq: 0, time: 1, data: { turn: 1, step: 1, message: {}, meta } } as unknown as SessionEvent
      expect(applyGisMapEvent(EMPTY_GIS_MAP_STATE, event)).toEqual(EMPTY_GIS_MAP_STATE)
    }
  })
})

describe('replay', () => {
  it('folds a replayed log to the same state as the live one', () => {
    const log = [
      otherEvent(0),
      renderEvent(1, [{ id: 'ds_1', kind: 'geojson' }]),
      { type: 'turn/end', seq: 2, time: 4, data: {} } as unknown as SessionEvent,
      renderEvent(3, [{ id: 'ds_2', kind: 'flatgeobuf' }, { id: 'ds_3', kind: 'pmtiles' }]),
    ]
    const live = fold(log)
    // A replay reads JSON: keys, arrays and numbers the medium actually stores.
    const replayed = fold(JSON.parse(JSON.stringify(log)) as SessionEvent[])
    expect(replayed).toEqual(live)
  })

  it('answers the empty log with the empty state', () => {
    expect(gisMapProjection.init({} as never, 0 as never)).toEqual(EMPTY_GIS_MAP_STATE)
    // The declared version is part of the contract: a persisted checkpoint from
    // an older unit is discarded rather than forward-applied.
    expect(gisMapProjection.stateVersion).toBe(1)
    expect(gisMapProjection.key).toBe('gis/map')
  })
})
