/**
 * Settings card for the GDAL/QGIS runtime (requirement 7).
 *
 * This is the user-visible half of "you do not have to set system environment
 * variables": the paths and the extra variables are entered here, land in the
 * active profile's Cordis patch, and survive a restart.
 *
 * Two contract facts, both learned the hard way in M0:
 * - The Plugins page renders `plugins.bundle.config` with `{ view: 'page' }`
 *   ALONE -- it never passes `form`. A bundle-config card must fetch its own.
 * - `ctx.configForms.get()` is keyed by the HOST ENTRY ID (the Loader row id),
 *   not by the package name.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import css from './card.module.css'
import { entryForm } from './config-access.ts'

/** The Loader row id whose configuration this card edits. */
/**
 * Every id this row might be addressed by, probed in order.
 *
 * Three differ and NONE is documented. `getSnapshot().status` is the only
 * honest oracle: `ctx.configForms.get()` always hands back a form object, so a
 * wrong namespace is indistinguishable from a right one except by its status
 * ('unavailable' means the host serves no such namespace).
 */
const CANDIDATES = ['include:gis-gdal', 'gis-gdal', '@znlgis/dsh-gis#gis-gdal'] as const

/** A single-line field on the form. */
interface FieldSpec {
  readonly key: string
  readonly label: string
  readonly hint: string
}

/** Everything except the multi-line environment box. */
const FIELDS: readonly FieldSpec[] = [
  { key: 'gdalBinDir', label: 'GDAL bin directory', hint: 'e.g. C:\\OSGeo4W\\bin' },
  { key: 'qgisBinDir', label: 'QGIS bin directory', hint: 'e.g. C:\\Program Files\\QGIS 3.40.0\\bin' },
  { key: 'timeoutMs', label: 'Timeout (ms)', hint: 'per external tool call' },
]

/** Render the GDAL/QGIS configuration page. */
export function GisGdalCard({ view }: PluginConfigViewProps): ReactNode {
  // Pick the first candidate the HOST actually serves. A wrong namespace returns
  // a live-looking form whose status is 'unavailable' and whose writes are all
  // refused, which is exactly the silent failure this probe exists to end.
  const resolved = CANDIDATES
    .map(id => ({ id, form: entryForm(id) }))
    .find(candidate => candidate.form?.getSnapshot().status === 'ready')
  const form = resolved?.form ?? entryForm(CANDIDATES[0])
  const resolvedId = resolved?.id ?? 'none'
  const [snapshot, setSnapshot] = useState(() => form?.getSnapshot())
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [saved, setSaved] = useState<'idle' | 'busy' | 'ok' | 'failed'>('idle')

  useEffect(() => {
    if (form === undefined) return undefined
    setSnapshot(form.getSnapshot())
    return form.subscribe(() => { setSnapshot(form.getSnapshot()) })
  }, [form])

  if (view !== 'page') return <span data-gis-gdal-summary>GDAL / QGIS paths and environment</span>

  const accepted = (snapshot?.value ?? {}) as Record<string, unknown>
  const text = (key: string): string => draft?.[key] ?? stringify(accepted[key])
  const editable = snapshot?.writable === true
  const dirty = draft !== null

  /** Save only the fields the user actually changed. */
  const save = (): void => {
    if (draft === null || form === undefined) return
    const ops = Object.entries(draft)
      .filter(([key, value]) => value !== stringify(accepted[key]))
      .map(([key, value]) => ({ op: 'set' as const, path: [key], value: coerce(key, value) }))
    if (ops.length === 0) { setDraft(null); return }
    setSaved('busy')
    void form.mutate(ops, snapshot?.revision).then(
      ok => { setSaved(ok ? 'ok' : 'failed'); setDraft(null) },
      () => { setSaved('failed') },
    )
  }

  return (
    // The diagnostics are rendered, not just logged: a wrong namespace or a
    // non-writable host view fails SILENTLY, and this is the only way to see
    // which of the three ids the form actually resolved against.
    <div
      className={css.card}
      data-gis-gdal-card
      data-gis-rev={snapshot?.revision === undefined ? 'undefined' : String(snapshot.revision)}
      data-gis-writable={String(snapshot?.writable ?? false)}
      data-gis-mode={snapshot?.mode ?? 'none'}
      data-gis-status={snapshot?.status ?? 'none'}
      data-gis-user={snapshot?.user === undefined ? 'none' : JSON.stringify(snapshot.user).slice(0, 120)}
      data-gis-ns={resolvedId}
    >
      <span className={css.title}>dsh-gis: GDAL / QGIS</span>
      <p className={css.hint}>
        Point these at your installs and the plugin passes them to every external tool it runs.
        You do not need to set PATH, GDAL_DATA or PROJ_LIB system-wide.
      </p>

      {FIELDS.map(field => (
        <label key={field.key} className={css.row}>
          <span className={css.label}>{field.label}</span>
          <input
            data-gis-field={field.key}
            value={text(field.key)}
            placeholder={field.hint}
            onChange={(event) => { setDraft({ ...(draft ?? {}), [field.key]: event.target.value }) }}
          />
        </label>
      ))}

      <label className={css.row}>
        <span className={css.label}>Extra environment variables</span>
        <textarea
          data-gis-field="extraEnv"
          rows={4}
          value={text('extraEnv')}
          placeholder={'one KEY=VALUE per line, e.g.\nGDAL_DATA=C:\\OSGeo4W\\share\\gdal'}
          onChange={(event) => { setDraft({ ...(draft ?? {}), extraEnv: event.target.value }) }}
        />
      </label>

      <div className={css.actions}>
        <button
          type="button"
          data-gis-save
          disabled={!editable || !dirty || saved === 'busy'}
          onClick={save}
        >
          Save
        </button>
        <span data-gis-status>
          {saved === 'ok' ? 'saved; restart to apply to new runs'
            : saved === 'failed' ? 'the host refused the change'
            : saved === 'busy' ? 'saving...'
            : !editable ? `host is not accepting writes (${snapshot?.status ?? 'no form'})`
            : dirty ? 'unsaved changes' : 'in sync'}
        </span>
      </div>
    </div>
  )
}

/** Render a config value as the text an input shows. */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/** Turn the input's text back into the type the schema expects. */
function coerce(key: string, value: string): unknown {
  if (key === 'timeoutMs') {
    const asNumber = Number(value)
    return Number.isFinite(asNumber) ? asNumber : 30000
  }
  return value
}
