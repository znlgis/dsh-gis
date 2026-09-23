/**
 * The session-level map state (design 6.5, T2.9).
 *
 * One map, one owner. The chat card and the workbench must see the SAME layers,
 * or "I hid that layer in the card" stops being true on the other surface -- and,
 * worse, a replayed session draws something the live one did not.
 *
 * So the state is a FOLD over the session log rather than a client-side store:
 * the log already carries every map description (a \`tool/result\` event's \`meta\`,
 * which is exactly what the card replays from), and folding it means replay and
 * live agree BY CONSTRUCTION rather than by two implementations agreeing.
 *
 * WHY THERE IS NO \`gis/layer\` EVENT
 *
 * Design 6.5 sketches \`session.append('gis/layer', ...)\`, and this unit started
 * that way. It cannot work from an out-of-repo plugin: the persistence read path
 * refuses an event type outside its generated vocabulary unless the event carries
 * the envelope's \`ignorable\` marker, and \`Session.append\` does not expose that
 * marker. A plugin-appended \`gis/layer\` would therefore make its own session log
 * unreadable by a build that does not know the type.
 *
 * Folding the EXISTING \`tool/result\` events needs no new vocabulary and no
 * marker, and it keeps the single-source-of-truth property the design is after:
 * the state is a pure function of the log, so a replay cannot disagree with the
 * live run. The meta is recognized structurally (our own schema: a \`mapId\`,
 * \`layers\`, and \`basemap: 'none'\`), which is what makes a result from another
 * tool unable to masquerade as one of ours.
 */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session-projection' {
  /** The host fold state, keyed by this unit. */
  interface SessionProjectionStateMap {
    'gis/map': {
      // `| undefined` is load-bearing under `exactOptionalPropertyTypes`: the zod
      // inference produces it, and an optional-without-undefined declaration is a
      // DIFFERENT type that the schema then refuses to satisfy.
      readonly mapId?: string | undefined
      readonly layers: readonly { readonly id: string; readonly kind: string; readonly visible: boolean }[]
      readonly asOfSeq: number
    }
  }
  /** The client-visible view of the same state. */
  interface SessionProjectionMap {
    'gis/map': {
      readonly mapId?: string | undefined
      readonly layers: readonly { readonly id: string; readonly kind: string; readonly visible: boolean }[]
      readonly asOfSeq: number
    }
  }
}

/** One layer as the session remembers it. */
export const gisMapLayerSchema = z.object({
  /** Stable layer id: the dataset id it was drawn from. */
  id: z.string(),
  /** How its bytes are addressed; see the client's layer model. */
  kind: z.string(),
  /** Whether it is currently drawn; a hidden layer still exists. */
  visible: z.boolean(),
})

/** The session's map state. */
export const gisMapStateSchema = z.object({
  /** The map this state belongs to, when the last render named one. */
  mapId: z.string().optional(),
  /** Layers in paint order; the last render's set replaces the previous one. */
  layers: z.array(gisMapLayerSchema),
  /** Sequence of the event this state was folded from; -1 before any render. */
  asOfSeq: z.number(),
})

/** One remembered layer. */
export type GisMapLayer = z.infer<typeof gisMapLayerSchema>
/** The remembered map state. */
export type GisMapState = z.infer<typeof gisMapStateSchema>

/**
 * The map description a \`gis_render\` result carries.
 *
 * Deliberately structural and minimal: only the fields that must be present for
 * a value to BE one of our map descriptions. \`basemap: 'none'\` is the marker --
 * it is part of the contract (design 6.3) and no other tool writes it.
 */
const renderMetaSchema = z.object({
  mapId: z.string(),
  basemap: z.literal('none'),
  layers: z.array(z.object({ id: z.string(), kind: z.string() }).passthrough()),
})

/** The state before any map exists. */
export const EMPTY_GIS_MAP_STATE: GisMapState = { layers: [], asOfSeq: -1 }

/**
 * Fold one committed session event into the map state.
 *
 * Pure and reference-preserving: an event that is not a map description returns
 * the SAME state object, which is what tells the projection machinery that
 * nothing changed.
 * @param state - the state covering all prior events.
 * @param event - the next committed event.
 * @returns the next state, or the same reference.
 */
export function applyGisMapEvent(state: GisMapState, event: SessionEvent): GisMapState {
  if (event.type !== 'tool/result') return state
  const meta = (event.data as { readonly meta?: unknown }).meta
  const parsed = renderMetaSchema.safeParse(meta)
  if (!parsed.success) return state
  // A render REPLACES the layer set: the card draws exactly what its description
  // says, so remembering anything from an earlier render would claim a layer is
  // on the map that the newest description does not contain.
  return {
    mapId: parsed.data.mapId,
    layers: parsed.data.layers.map(layer => ({ id: layer.id, kind: layer.kind, visible: true })),
    asOfSeq: event.seq,
  }
}

/**
 * The \`gis/map\` projection unit.
 *
 * \`stateVersion\` is 1 and must be bumped whenever the folded fields or the fold's
 * semantics change: a persisted checkpoint from an older unit is discarded
 * rather than forward-applied into garbage.
 */
export const gisMapProjection = {
  key: 'gis/map',
  stateSchema: gisMapStateSchema,
  init: () => EMPTY_GIS_MAP_STATE,
  apply: applyGisMapEvent,
  wire: { viewSchema: gisMapStateSchema, view: (state: GisMapState) => state },
  stateVersion: 1,
  // `satisfies`, not a type annotation: the registry's client-visible overload
  // requires `wire` to be PRESENT, and annotating with ProjectionDefinition
  // widens it to optional -- which then matches only the host-only overload.
} satisfies ProjectionDefinition<'gis/map', GisMapState> & { wire: unknown }
