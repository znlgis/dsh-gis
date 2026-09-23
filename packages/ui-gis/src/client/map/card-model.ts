/**
 * The map card's state, as a PURE FUNCTION of one persisted tool call.
 *
 * T2.6's acceptance criterion is exactly this: a replay draws what the live run
 * drew. That is only true if the card reads nothing but the session log -- not
 * the host, not the clock, not a module-level cache, not the identity of the
 * objects it is handed. So the decision lives here, in one function over the
 * persisted block, and the React component below it merely renders the answer.
 *
 * The block type is STRUCTURAL on purpose: this module needs four fields of a
 * chat record, and depending on the chat package for them would drag a client
 * bundle into the map's lazy chunk for nothing.
 */
import { normalizeMapView, type MapIssue } from './layer-model.ts'
import type { MapViewSpec } from './spec.ts'

/** The fields of a tool call block this card reads. */
export interface CardBlock {
  /** `'tool-result'` on a settled call; a running call carries no kind. */
  readonly kind?: string
  readonly callId?: string
  readonly argsRaw?: string
  /** The call head, backfilled from the log; null when truncation left it outside. */
  readonly call?: { readonly name: string; readonly argsRaw: string } | null
  readonly isError?: boolean
  readonly error?: { readonly name?: string; readonly code?: string; readonly reason?: string }
  /** The persisted `presentationMeta` of the result. */
  readonly meta?: unknown
  readonly content?: readonly unknown[]
}

/** What the card renders. */
export type MapCardState =
  | { readonly status: 'running'; readonly label: string }
  | { readonly status: 'orphan'; readonly callId: string }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'unavailable'; readonly message: string }
  | {
    readonly status: 'ready'
    readonly spec: MapViewSpec
    readonly caption: string
    readonly issues: readonly MapIssue[]
  }

/**
 * Decide what to draw for one call block.
 *
 * Every branch reads only fields the session log persists, so the same log
 * always produces the same state -- including after a restart, and including
 * for a call whose result arrived while the page was elsewhere.
 * @param block - the running call or the settled result.
 * @returns the state to render.
 */
export function mapCardState(block: CardBlock): MapCardState {
  if (block.kind !== 'tool-result') {
    return { status: 'running', label: runningLabel(block.argsRaw) }
  }
  if (block.call === null) {
    // The window cut left the call outside: there is nothing to title the card
    // with, so it degrades to the identity the log still has.
    return { status: 'orphan', callId: block.callId ?? 'unknown call' }
  }
  if (block.isError === true) {
    return { status: 'failed', message: failureOf(block) }
  }
  if (block.meta === undefined || block.meta === null) {
    return {
      status: 'unavailable',
      message: 'this result carries no map description, so there is nothing to draw',
    }
  }
  const { spec, issues } = normalizeMapView(block.meta)
  return {
    status: 'ready',
    spec,
    caption: captionOf(block.meta, spec),
    issues,
  }
}

/** Whether the bytes a description points at are still there. */
export type LayerAvailability =
  | { readonly status: 'available' }
  | { readonly status: 'missing'; readonly layerIds: readonly string[] }

/** How the card asks whether a layer's bytes exist; injectable so tests need no network. */
export type LayerProbe = (url: string) => Promise<boolean>

/**
 * Ask each layer's route whether its bytes are still there.
 *
 * An id is content-derived, so a URL that resolves to 404 means the dataset was
 * moved, edited or dropped since the render was logged -- which is exactly the
 * replayed-session case T2.7 exists for. Checking BEFORE the map mounts is what
 * turns it into a sentence instead of a blank canvas with console noise.
 *
 * A probe that fails for any other reason (no network, a throwing fetch) is NOT
 * evidence that the data is gone: the card proceeds and lets the map report its
 * own failure.
 * @param layers - the normalized layers of the view.
 * @param probe - the checker; defaults to a HEAD request.
 * @returns which layers are missing, if any.
 */
export async function layerAvailability(
  layers: MapViewSpec['layers'],
  probe: LayerProbe = headProbe,
): Promise<LayerAvailability> {
  const missing: string[] = []
  for (const layer of layers) {
    let present = true
    try {
      present = await probe(layer.url)
    } catch {
      present = true
    }
    if (!present) missing.push(layer.id)
  }
  return missing.length === 0 ? { status: 'available' } : { status: 'missing', layerIds: missing }
}

/**
 * The default probe: a HEAD request that only treats "gone" as gone.
 *
 * `cache: 'no-store'` is load-bearing. The byte route answers with
 * `Cache-Control: private, immutable` (its URL is content-derived, so caching it
 * is right), and a plain fetch would then be answered BY THE BROWSER CACHE --
 * reporting a stale id as present. The question this probe asks is about the
 * ORIGIN: are the bytes behind this id still there?
 */
async function headProbe(url: string): Promise<boolean> {
  if (typeof fetch !== 'function') return true
  const response = await fetch(url, { method: 'HEAD', cache: 'no-store' })
  return response.status !== 404 && response.status !== 410
}

/** A running label from the call's own arguments, when they parse. */
function runningLabel(argsRaw: string | undefined): string {
  const size = sizeOf(argsRaw)
  return size === undefined ? 'rendering…' : 'rendering ' + size + '…'
}

/** "900×600" from a parsed `argsRaw`, when it states a size. */
function sizeOf(argsRaw: string | undefined): string | undefined {
  if (argsRaw === undefined || argsRaw.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const args = parsed as { width?: unknown; height?: unknown }
    const width = typeof args.width === 'number' ? args.width : 900
    const height = typeof args.height === 'number' ? args.height : 600
    return String(width) + '×' + String(height)
  } catch {
    // Model arguments are not guaranteed to be valid JSON on a truncated or
    // hand-edited log; a placeholder is the right answer, not a thrown card.
    return undefined
  }
}

/** One line of diagnosis for a failed call. */
function failureOf(block: CardBlock): string {
  const code = block.error?.code
  const reason = block.error?.reason ?? block.error?.name
  const text = textOf(block.content)
  const detail = text ?? reason ?? 'the render failed'
  return code === undefined ? detail : '[' + code + '] ' + detail
}

/** The first text block's content, when the result carries one. */
function textOf(content: readonly unknown[] | undefined): string | undefined {
  for (const block of content ?? []) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string' && candidate.text.length > 0) {
      return candidate.text.split('\n')[0] ?? undefined
    }
  }
  return undefined
}

/** The card's caption: whatever the description says it is. */
function captionOf(meta: unknown, spec: MapViewSpec): string {
  const mapId = (meta as { mapId?: unknown }).mapId
  if (typeof mapId === 'string' && mapId.length > 0) return mapId
  return String(spec.layers.length) + ' layer(s)'
}
