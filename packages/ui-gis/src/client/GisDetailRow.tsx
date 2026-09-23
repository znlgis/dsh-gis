/**
 * M0 component #2 (lazy): lives in its own chunk and must never be part of the
 * first-screen payload.
 *
 * It imports its OWN stylesheet on purpose — see detail.module.css.
 */
import type { ReactNode } from 'react'
import css from './detail.module.css'

/** Render the lazily loaded detail view. */
export function GisDetailRow({ label }: { readonly label: string }): ReactNode {
  return (
    <span className={css.detail} data-gis-detail-row>
      {label}: lazy chunk loaded
    </span>
  )
}
