/**
 * M0 component #1 (eager): renders inside a tool call row and lazily pulls in
 * component #2 through a dynamic import, which must become a separate
 * `client.<name>.js` chunk reached through `require.async`.
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

/** Render the probe row and load the detail view on demand. */
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
