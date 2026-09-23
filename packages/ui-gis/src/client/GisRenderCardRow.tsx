/**
 * The eager shim that puts the map card behind a chunk boundary.
 *
 * The slot wants a component at registration time; the map card must not be in
 * the first-screen payload. So the registered component is this: it renders a
 * placeholder, pulls the real card in on mount, and hands over.
 *
 * It imports NOTHING from the map graph at runtime -- only types, which are
 * erased. A runtime import here would make rolldown hoist that module into a
 * chunk shared by the eager and lazy graphs, and the entry would then require a
 * chunk synchronously (runtime contract #24, which cost a debugging session).
 */
import { useEffect, useState, type ReactNode } from 'react'
import css from './card.module.css'
import type { CardBlock } from './map/card-model.ts'

type MapCard = (props: { block: CardBlock; t?: (key: string) => string }) => ReactNode

/** Props this shim needs from the tool view slot. */
export interface GisRenderCardRowProps {
  readonly block: CardBlock
  readonly t?: (key: string) => string
}

/** Show a placeholder, then the real card once its chunk arrives. */
export function GisRenderCardRow({ block, t }: GisRenderCardRowProps): ReactNode {
  const [card, setCard] = useState<MapCard | null>(null)
  useEffect(() => {
    let live = true
    void import('./map/GisRenderCard.tsx').then(
      (module) => { if (live) setCard(() => module.GisRenderCard) },
      () => { if (live) setCard(null) },
    )
    return () => { live = false }
  }, [])
  if (card === null) {
    return <p className={css.hint} data-gis-render-loading>loading the map card…</p>
  }
  const Card = card
  return <Card block={block} {...t === undefined ? {} : { t }} />
}
