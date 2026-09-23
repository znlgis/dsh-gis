/**
 * M0 component #1 (eager): renders inside a tool call row and reaches the M0
 * detail view through a dynamic import, which must become a separate
 * `client.<name>.js` chunk fetched through `require.async`.
 *
 * It used to carry a map button as well -- the T2.1 development surface, which
 * existed because the shared map component had no product surface yet. T2.6 gave
 * it one (the `gis_render` card), so the button is gone. Keeping it would have
 * left TWO importers of the map component (this eager dynamic import and the
 * card's static one), which is exactly how rolldown ends up hoisting a module
 * into a chunk that other chunks then require SYNCHRONOUSLY -- which the loader
 * protocol forbids, and which `pnpm check:bundle` now fails on.
 *
 * Nothing here may import the map graph at runtime, not even one pure function:
 * see the note on the type-only import below.
 */
import { useState, type ReactNode } from 'react'
import css from './card.module.css'
import './global.css'

/** Minimal stand-in for the slot runtime props; the real type is type-only. */
export interface ProbeRowProps {
  readonly block?: { readonly callId?: string }
  readonly t?: (key: string) => string
}

type DetailComponent = (props: { readonly label: string }) => ReactNode

/** Render the probe row; its heavy child arrives as a chunk on demand. */
export function GisProbeRow({ t }: ProbeRowProps): ReactNode {
  const [Detail, setDetail] = useState<DetailComponent | null>(null)
  const [loaded, setLoaded] = useState(false)

  return (
    <div className={`${css.card} gis-probe-root`} data-gis-probe-row>
      <span className={css.title}>{t ? t('probe.title') : 'dsh-gis probe'}</span>
      <button
        type="button"
        data-gis-load-detail
        onClick={() => {
          if (Detail !== null) return
          setLoaded(true)
          void import('./GisDetailRow.tsx').then((m) => { setDetail(() => m.GisDetailRow) })
        }}
      >
        {loaded ? 'loading detail…' : 'load detail (lazy chunk)'}
      </button>
      {Detail !== null ? <Detail label="chunk reached" /> : null}
    </div>
  )
}
