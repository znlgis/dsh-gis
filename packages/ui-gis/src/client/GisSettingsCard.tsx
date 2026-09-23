/**
 * M0 settings card for T0.7.
 *
 * Registered into `plugins.bundle.config` keyed by the bundle's package name.
 * That is the seat the slot catalog reserves for a bundle's own configuration;
 * `plugins.item` is the Official group and would be a false claim for a
 * third-party bundle (design 3.3 / 11.4).
 *
 * IMPORTANT (found in M0): the Plugins page renders this slot with
 * `{ view: 'page' }` ALONE -- it does NOT pass `form`. Only `plugins.row.config`
 * receives a form from the page (`PluginManagerPage.tsx:500` vs `:584`). A
 * bundle-config card must therefore obtain its own form from `ctx.configForms`
 * using the HOST ENTRY ID (the Loader row id), not the package name.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import css from './card.module.css'
import { entryForm } from './config-access.ts'

/** The Loader row id whose configuration this card edits. */
const ENTRY_ID = 'dsh-gis'

/** Render the bundle's configuration page. */
export function GisSettingsCard({ view }: PluginConfigViewProps): ReactNode {
  const form = entryForm(ENTRY_ID)
  const [snapshot, setSnapshot] = useState(() => form?.getSnapshot())
  const [draft, setDraft] = useState<string | null>(null)

  useEffect(() => {
    if (form === undefined) return undefined
    setSnapshot(form.getSnapshot())
    return form.subscribe(() => { setSnapshot(form.getSnapshot()) })
  }, [form])

  if (view !== 'page') return <span data-gis-settings-summary>GIS bundle settings</span>

  const accepted = (snapshot?.value ?? {}) as { probeLabel?: string }
  const value = draft ?? accepted.probeLabel ?? ''
  const canSave = snapshot?.writable === true && draft !== null

  return (
    <div className={css.card} data-gis-settings-card>
      <span className={css.title}>dsh-gis</span>
      <label>
        <span>probeLabel</span>
        <input
          data-gis-settings-input
          value={value}
          onChange={(event) => { setDraft(event.target.value) }}
        />
      </label>
      <button
        type="button"
        data-gis-settings-save
        disabled={!canSave}
        onClick={() => {
          void form?.mutate([{ op: 'set', path: ['probeLabel'], value }], snapshot?.revision)
            .then(() => { setDraft(null) })
        }}
      >
        Save
      </button>
      <span data-gis-settings-status>{snapshot?.status ?? 'no-form'}</span>
    </div>
  )
}
