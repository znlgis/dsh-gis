/**
 * The gis_render card (T2.6), and its degradations (T2.7).
 *
 * The card is a pure function of the persisted call: {@link mapCardState}
 * decides, this file renders. It lives in the lazy map chunk, so opening a
 * session with a render in it is what fetches MapLibre -- a transcript full of
 * old renders costs nothing until one is on screen.
 *
 * T2.7 adds the one thing the log cannot answer: whether the bytes an old
 * description points at are STILL there. That is a runtime question, asked
 * before the map mounts, and its answer is a sentence -- never an exception and
 * never a blank canvas.
 */
import { useEffect, useState, type ReactNode } from 'react'
import css from './map.module.css'
import { layerAvailability, mapCardState, type CardBlock, type LayerProbe } from './card-model.ts'
import { GisMap } from './GisMap.tsx'
import type { MapIssue } from './layer-model.ts'
import type { MapViewSpec } from './spec.ts'

/** Props this card needs from the tool view slot. */
export interface GisRenderCardProps {
  /** The running call or the settled result. */
  readonly block: CardBlock
  /** Translator for this plugin's copy, when the host passes one. */
  readonly t?: (key: string) => string
  /** Test seam: replaces the real MapLibre loader. */
  readonly load?: Parameters<typeof GisMap>[0]['load']
  /** Test seam: replaces the availability probe. */
  readonly probe?: LayerProbe
}

/** Render one map card. */
export function GisRenderCard({ block, t, load, probe }: GisRenderCardProps): ReactNode {
  const state = mapCardState(block)
  const spec = state.status === 'ready' ? state.spec : undefined
  const missing = useAvailability(spec?.layers ?? [], probe)
  // The controller's own issues (a raster that failed to decode, a layer the map
  // refused) are as important as the normalization ones: a card that draws
  // nothing must say why. Dropping them here is how a silent blank map happens.
  const [drawIssues, setDrawIssues] = useState<readonly MapIssue[]>([])
  useEffect(() => { setDrawIssues([]) }, [block])
  const issues: readonly MapIssue[] = [
    ...(state.status === 'ready' ? state.issues : []),
    ...drawIssues,
  ]

  // The availability answer only ever REFINES a ready card; a failed or
  // orphaned one keeps its own state (asking about bytes there would have
  // overwritten the reason it is on screen in the first place).
  const shown = state.status === 'ready' && missing !== undefined && missing.layerIds.length > 0
    ? 'data-unavailable'
    : state.status

  return (
    <div className={css.card} data-gis-render-card={shown}>
      {renderBody()}
      {issues.length === 0
        ? null
        : (
            <ul className={css.cardIssues} data-gis-render-issues>
              {issues.map(issue => <li key={issue.code + ':' + String(issue.layerId)}>{issue.message}</li>)}
            </ul>
          )}
    </div>
  )

  /** The card's body: the map, or one line saying why there is none. */
  function renderBody(): ReactNode {
    if (state.status !== 'ready') {
      return <p className={css.note} data-gis-render-note>{noteOf(state, t)}</p>
    }
    if (missing === undefined) {
      return <p className={css.note} data-gis-render-checking>{say(t, 'render.checking', 'checking the data…')}</p>
    }
    if (missing.layerIds.length > 0) {
      // The layer ids stay OUTSIDE the translated phrase: a dictionary cannot
      // carry runtime values, and which id went missing is the actionable part.
      return (
        <p className={css.note} data-gis-render-missing>
          {say(t, 'render.missing', 'this data is no longer available') + ' (' + missing.layerIds.join(', ') + ')'}
        </p>
      )
    }
    return (
      <GisMap
        spec={state.spec}
        label={state.caption}
        onIssue={(issue) => { setDrawIssues(previous => previous.some(seen => seen.code === issue.code && seen.layerId === issue.layerId) ? previous : [...previous, issue]) }}
        {...t === undefined ? {} : { t }}
        {...load === undefined ? {} : { load }}
      />
    )
  }
}

/** Resolve whether the description's bytes are still there, once per layer set. */
function useAvailability(layers: MapViewSpec['layers'], probe: LayerProbe | undefined) {
  const [missing, setMissing] = useState<{ readonly layerIds: readonly string[] } | undefined>(undefined)
  const key = layers.map(layer => layer.id + '@' + layer.url).join('|')
  useEffect(() => {
    let live = true
    setMissing(undefined)
    if (layers.length === 0) {
      setMissing({ layerIds: [] })
      return () => { live = false }
    }
    void layerAvailability(layers, probe).then(
      (result) => { if (live) setMissing(result.status === 'missing' ? { layerIds: result.layerIds } : { layerIds: [] }) },
      // A probe that throws must not take the card down: the map reports its
      // own failure, and the card stays on screen.
      () => { if (live) setMissing({ layerIds: [] }) },
    )
    return () => { live = false }
    // The key is the layer set's identity: a re-render with the same layers
    // must not re-ask.
  }, [key, probe])
  return missing
}

/** One line for every non-ready state. */
function noteOf(state: ReturnType<typeof mapCardState>, t: ((key: string) => string) | undefined): string {
  if (state.status === 'running') return say(t, 'render.running', state.label)
  if (state.status === 'orphan') return say(t, 'render.orphan', 'result for ' + state.callId + ' (its call is outside this window)')
  // The phrase is translated; the DIAGNOSIS is not part of the dictionary. A
  // failed card that shows only "the render failed" tells the user nothing they
  // can act on -- found by a browser check that could see the card fail but not
  // why.
  if (state.status === 'failed') return say(t, 'render.failed', 'the render failed') + ': ' + state.message
  if (state.status === 'unavailable') return say(t, 'render.unavailable', state.message)
  return ''
}

/** This plugin's copy, falling back to English when no translator was passed. */
function say(t: ((key: string) => string) | undefined, key: string, fallback: string): string {
  const translated = t?.(key)
  return translated === undefined || translated.length === 0 ? fallback : translated
}
