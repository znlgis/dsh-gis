/**
 * The shared map component (T2.1 skeleton, T2.2 states and styling).
 *
 * A React shell around {@link createMapView}: it owns the container element and
 * turns status changes into render states. The map itself -- and the library --
 * live in the lazy chunk this module is part of, so importing it is what fetches
 * MapLibre, and unmounting is what releases it.
 *
 * An EMPTY view never reaches MapLibre at all: no layers means nothing to draw,
 * so the component answers immediately and the browser never pays for a 1.5 MB
 * library to show a sentence.
 *
 * Styles come with the chunk: the MapLibre stylesheet and this module's own are
 * both imported here, and neither is reachable from the eager graph (runtime
 * contract #10: an eager and a lazy graph must not share a module, or the
 * bundler hoists it into a chunk the entry then requires synchronously).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import 'maplibre-gl/dist/maplibre-gl.css'
import css from './map.module.css'
import { createMapView } from './controller.ts'
import { loadMapLibre, type MapLibreLoader } from './load-maplibre.ts'
import type { MapIssue } from './layer-model.ts'
import type { MapViewSpec } from './spec.ts'

/** What the component renders; `empty` never loads the library. */
export type MapSurfaceStatus = 'loading' | 'empty' | 'ready' | 'failed'

/** Props of the shared map. */
export interface GisMapProps {
  /** Normalized layers to draw; memoize it, since a new object remounts the map. */
  readonly spec: MapViewSpec
  /** Test seam: replaces the real MapLibre loader. */
  readonly load?: MapLibreLoader
  /** Optional caption rendered over the map. */
  readonly label?: string
  /** Translator for this component's own copy, when the host has one. */
  readonly t?: (key: string) => string
  /** Called for every non-fatal drawing issue, in addition to the on-screen list. */
  readonly onIssue?: (issue: MapIssue) => void
}

/** Render a map view, with its loading, empty, failure, and issue states. */
export function GisMap({ spec, load, label, t, onIssue }: GisMapProps): ReactNode {
  const holder = useRef<HTMLDivElement | null>(null)
  const empty = spec.layers.length === 0
  const [status, setStatus] = useState<MapSurfaceStatus>(empty ? 'empty' : 'loading')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [issues, setIssues] = useState<readonly string[]>([])

  useEffect(() => {
    setIssues([])
    setFailure(undefined)
    if (spec.layers.length === 0) {
      setStatus('empty')
      return
    }
    const container = holder.current
    if (container === null) return
    setStatus('loading')
    const view = createMapView({
      container,
      spec,
      environment: { load: load ?? loadMapLibre },
      onStatus: (next, detail) => {
        if (next === 'destroyed') return
        setStatus(next)
        setFailure(detail.error === undefined ? undefined : describe(detail.error))
      },
      onIssue: (issue) => {
        onIssue?.(issue)
        setIssues(previous => [...previous, issue.message])
      },
    })
    return () => { void view.destroy() }
  }, [spec, load, onIssue])

  return (
    <div className={css.map} data-gis-map={status}>
      <div ref={holder} className={css.canvas} data-gis-map-canvas />
      {label === undefined ? null : <span className={css.label}>{label}</span>}
      {status === 'loading' ? <span className={css.badge} data-gis-map-badge>{say(t, 'map.loading', 'loading map…')}</span> : null}
      {status === 'empty' ? <span className={css.badge} data-gis-map-empty>{say(t, 'map.empty', 'nothing to draw yet')}</span> : null}
      {status === 'failed'
        ? <span className={css.badge} data-gis-map-error>{failure ?? say(t, 'map.failed', 'the map could not start')}</span>
        : null}
      {issues.length === 0
        ? null
        : <ul className={css.issues} data-gis-map-issues>{issues.map(text => <li key={text}>{text}</li>)}</ul>}
    </div>
  )
}

/** This plugin's copy, falling back to English when no translator was passed. */
function say(t: ((key: string) => string) | undefined, key: string, fallback: string): string {
  const translated = t?.(key)
  return translated === undefined || translated.length === 0 ? fallback : translated
}

/** One line for a thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
