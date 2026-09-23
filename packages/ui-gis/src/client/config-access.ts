/**
 * Bridge between `apply()` (which owns `ctx`) and React components (which do
 * not receive it).
 *
 * M0 SHORTCUT: a module-scoped holder is refreshed on every `apply`, so an HMR
 * reload installs the new context. Replace with the slot's own `inject` face
 * once the bundle has more than one settings surface.
 */
import type { ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'

let forms: ConfigForms | undefined

/** Publish the client context's config-forms service to component code. */
export function setConfigForms(next: ConfigForms | undefined): void {
  forms = next
}

/**
 * Resolve one Host entry's configuration form.
 * @param entryId - the Host plugin entry id (Loader row id), not the package name.
 * @returns the entry's form, or undefined before `apply` has run.
 */
export function entryForm(entryId: string) {
  return forms?.get<Record<string, unknown>>(entryId)
}
