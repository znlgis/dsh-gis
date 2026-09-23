/**
 * The eager shims that put the preview bodies behind chunk boundaries.
 *
 * The slot wants a component at registration time; the bodies (and the map, and
 * MapLibre under it) must not be in the first-screen payload. So what gets
 * registered is this: a placeholder that pulls the real body in on mount.
 *
 * It imports NOTHING from the map graph at runtime -- only types, which are
 * erased. A runtime import here would make those modules shared with the card's
 * graph, and the bundler would hoist them into a chunk other chunks then require
 * synchronously, which the plugin loader cannot resolve (runtime contracts
 * #24 and #31).
 */
import { useEffect, useState, type ReactNode } from 'react'
import css from '../card.module.css'
import type { GisBinaryBodyProps } from './GisBinaryBody.tsx'
import type { GisTextBodyProps } from './GisTextBody.tsx'

type TextBody = (props: GisTextBodyProps) => ReactNode
type BinaryBody = (props: GisBinaryBodyProps) => ReactNode

/** Props the document owner hands a body; declared structurally (see types.ts). */
export interface PreviewBodyProps {
  readonly content: { readonly kind: string; readonly text?: string; readonly data?: Uint8Array }
  readonly resourceAddress?: string
  readonly t?: (key: string) => string
}

/** The file's decoded path, taken from the resource address the owner supplies. */
function pathOf(props: PreviewBodyProps): string | undefined {
  const address = props.resourceAddress
  if (address === undefined) return undefined
  const name = address.slice(address.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/** The text body, loaded on demand. */
export function GisTextPreviewRow(props: PreviewBodyProps): ReactNode {
  const [body, setBody] = useState<TextBody | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    void import('./GisTextBody.tsx').then(
      (module) => { if (live) setBody(() => module.GisTextBody) },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [])
  if (failed) return <p className={css.hint} data-gis-preview="failed">the GIS preview could not be loaded</p>
  if (body === null) return <p className={css.hint} data-gis-preview="loading">loading the map preview…</p>
  const Body = body
  return <Body content={props.content} {...pathOf(props) === undefined ? {} : { path: pathOf(props)! }} {...props.t === undefined ? {} : { t: props.t }} />
}

/** The binary body, loaded on demand. */
export function GisBinaryPreviewRow(props: PreviewBodyProps): ReactNode {
  const [body, setBody] = useState<BinaryBody | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    void import('./GisBinaryBody.tsx').then(
      (module) => { if (live) setBody(() => module.GisBinaryBody) },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [])
  if (failed) return <p className={css.hint} data-gis-preview="failed">the GIS preview could not be loaded</p>
  if (body === null) return <p className={css.hint} data-gis-preview="loading">loading the GIS preview…</p>
  const Body = body
  return <Body content={props.content} {...pathOf(props) === undefined ? {} : { path: pathOf(props)! }} {...props.t === undefined ? {} : { t: props.t }} />
}
