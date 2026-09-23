/**
 * A MapLibre stand-in for the client tests.
 *
 * It records every call the controller makes, so the assertions can be about
 * ORDER and IDENTITY (what was added, what was removed, in which order) rather
 * than about a screenshot. Not a spec file: vitest collects only %BT%*.spec.ts%BT%.
 */
import type { MapLibreModule } from '../src/client/map/load-maplibre.ts'
import type { MapThemeTokens } from '../src/client/map/layer-model.ts'

/** Theme tokens used by the tests, so default paint is deterministic. */
export const TEST_TOKENS: MapThemeTokens = {
  accent: '#111111',
  ink: '#222222',
  surface: '#333333',
  border: '#444444',
}

/** Everything the fake recorded. */
export interface FakeCalls {
  /** Constructor options of every map created. */
  readonly constructed: unknown[]
  /** [source id, source spec] in call order. */
  readonly sources: [string, Record<string, unknown>][]
  /** Layer specs in call order. */
  readonly layers: Record<string, unknown>[]
  /** fitBounds arguments. */
  readonly bounds: unknown[]
  /** Ids passed to removeLayer, in call order. */
  readonly removedLayers: string[]
  /** Ids passed to removeSource, in call order. */
  readonly removedSources: string[]
  removed: number
  resizes: number
  disconnected: number
  observers: number
}

/** One fake MapLibre module plus the handles the tests drive it with. */
export function fakeMapLibre() {
  const calls: FakeCalls = {
    constructed: [],
    sources: [],
    layers: [],
    bounds: [],
    removedLayers: [],
    removedSources: [],
    removed: 0,
    resizes: 0,
    disconnected: 0,
    observers: 0,
  }
  const liveSources = new Set<string>()
  const liveLayers = new Set<string>()
  // A LIST, not a single slot: a test may mount two maps (a live card and its
  // replayed twin), and a single slot would only ever fire the last one.
  const loadListeners: (() => void)[] = []
  const observers: (() => void)[] = []

  class FakeMap {
    constructor(options: unknown) {
      calls.constructed.push(options)
    }
    on(type: string, listener: () => void): void {
      if (type === 'load') loadListeners.push(listener)
    }
    remove(): void { calls.removed += 1 }
    resize(): void { calls.resizes += 1 }
    addSource(id: string, source: unknown): void {
      calls.sources.push([id, source as Record<string, unknown>])
      liveSources.add(id)
    }
    addLayer(layer: Record<string, unknown>): void {
      calls.layers.push(layer)
      liveLayers.add(String(layer['id']))
    }
    getSource(id: string): unknown { return liveSources.has(id) ? { id } : undefined }
    getLayer(id: string): unknown { return liveLayers.has(id) ? { id } : undefined }
    removeLayer(id: string): void {
      calls.removedLayers.push(id)
      liveLayers.delete(id)
    }
    removeSource(id: string): void {
      calls.removedSources.push(id)
      liveSources.delete(id)
    }
    fitBounds(bounds: unknown, options: unknown): void { calls.bounds.push([bounds, options]) }
  }

  return {
    module: { Map: FakeMap } as unknown as MapLibreModule,
    calls,
    /** Fire the 'load' event on every map created so far. */
    fireLoad: (): void => { for (const listener of loadListeners) listener() },
    /** Deliver a container resize to whichever observer was installed. */
    fireResize: (): void => { for (const observer of observers) observer() },
    environment: {
      load: () => Promise.resolve({ Map: FakeMap } as unknown as MapLibreModule),
      observeResize: (_target: Element, onResize: () => void) => {
        calls.observers += 1
        observers.push(onResize)
        return () => { calls.disconnected += 1 }
      },
      theme: () => TEST_TOKENS,
    },
  }
}
