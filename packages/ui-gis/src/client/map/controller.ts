/**
 * The map lifecycle, with no React and no DOM in the way.
 *
 * Everything that can go wrong with a map is a LIFECYCLE problem: the library
 * arrives late, the container goes away first, a resize observer outlives the
 * canvas, a second mount races the first teardown. Keeping that logic in a
 * framework-free controller is what makes it testable in Node -- the React
 * wrapper above it is a thin shell, and the tests drive a fake MapLibre module
 * so they need no browser and no WebGL.
 *
 * WHAT IS DRAWN is not decided here: {@link describeLayers} in the layer model
 * turns normalized layers into MapLibre sources and layers, and this file only
 * adds and removes them in the right order.
 */
import type { StyleSpecification } from 'maplibre-gl'
import { DEFAULT_THEME, describeLayers, themeTokensOf, type MapIssue, type MapThemeTokens } from './layer-model.ts'
import type { MapLibreLoader, MapLibreModule } from './load-maplibre.ts'
import type { MapLayerSpec, MapViewSpec } from './spec.ts'

/** The MapLibre map instance type, taken from the library's own typings. */
export type MapInstance = InstanceType<MapLibreModule['Map']>

/** What the map is doing; the component renders one state per value. */
export type MapViewStatus = 'loading' | 'ready' | 'failed' | 'destroyed'

export type { MapIssue }

/** The seams this controller needs; a browser supplies the defaults. */
export interface MapViewEnvironment {
  /** Reaches MapLibre; returns the module. */
  readonly load: MapLibreLoader
  /**
   * Watches the container's size.
   * @returns a disposer, or undefined when the page cannot observe sizes.
   */
  readonly observeResize?: (target: Element, onResize: () => void) => (() => void) | undefined
  /**
   * Resolves the theme colors layer defaults are painted with.
   * @returns the tokens; defaults to reading the container's design tokens.
   */
  readonly theme?: (container: HTMLElement) => MapThemeTokens
  /**
   * Draws a layer whose picture does not exist until the browser has read and
   * decoded its bytes (a COG).
   *
   * A SEAM, not an inline call: the decoder pulls in a TIFF reader, and a
   * controller test must not need one. The default implementation dynamically
   * imports the real decoder, so the reader stays in its own chunk.
   * @param map - the live map.
   * @param layer - the layer to draw.
   * @returns a disposer that takes it off the map again.
   */
  readonly addRaster?: (map: MapInstance, layer: MapLayerSpec) => Promise<() => void>
}

/** Construction options. */
export interface CreateMapViewOptions {
  /** Element the canvas is created in. */
  readonly container: HTMLElement
  /** What to draw. */
  readonly spec: MapViewSpec
  /** Environment seams. */
  readonly environment: MapViewEnvironment
  /** Called on every status change except the final teardown. */
  readonly onStatus?: (status: MapViewStatus, detail: { readonly error?: unknown }) => void
  /** Called for every non-fatal drawing issue. */
  readonly onIssue?: (issue: MapIssue) => void
}

/** A live map handle. */
export interface MapView {
  /** Current status. */
  readonly status: MapViewStatus
  /**
   * Replace the drawn layers.
   * @param layers - the layers to draw from now on.
   */
  setLayers(layers: readonly MapLayerSpec[]): void
  /**
   * Remove the map and every observer attached to it. Idempotent, and safe to
   * call while the library is still loading.
   * @returns resolution once teardown finished.
   */
  destroy(): Promise<void>
}

/** An empty style: no basemap, no sources (design 6.3 `basemap: 'none'`). */
const EMPTY_STYLE: StyleSpecification = { version: 8, sources: {}, layers: [] }

/**
 * Create a map in a container and own its whole lifetime.
 * @param options - container, spec, seams, and callbacks.
 * @returns the handle; call {@link MapView.destroy} to tear everything down.
 */
export function createMapView(options: CreateMapViewOptions): MapView {
  let status: MapViewStatus = 'loading'
  let destroyed = false
  let map: MapInstance | undefined
  let disconnect: (() => void) | undefined
  let layers = options.spec.layers
  /** Ids this controller put on the map, so a re-draw can take them off again. */
  const drawn: string[] = []
  /** Disposers for asynchronously drawn layers (rasters decoded in the browser). */
  let rasterRemovers: (() => void)[] = []

  /** Report a status change, unless the view is already torn down. */
  const setStatus = (next: MapViewStatus, detail: { readonly error?: unknown } = {}): void => {
    if (destroyed) return
    status = next
    options.onStatus?.(next, detail)
  }

  /** Replace everything this controller drew with the given layers. */
  const draw = (target: MapInstance, next: readonly MapLayerSpec[]): void => {
    // Remove first: MapLibre throws on a duplicate source id, and a leftover
    // layer would keep painting underneath the new view.
    for (const id of drawn.splice(0)) {
      if (target.getLayer(id) !== undefined) target.removeLayer(id)
      if (target.getSource(id) !== undefined) target.removeSource(id)
    }
    for (const remove of rasterRemovers.splice(0)) remove()
    const tokens = (options.environment.theme ?? themeTokensOf)(options.container)
    const { descriptions, issues } = describeLayers(next, tokens)
    for (const issue of issues) options.onIssue?.(issue)
    for (const description of descriptions) {
      target.addSource(description.id, description.source)
      target.addLayer(description.layer)
      drawn.push(description.id)
    }
    // Rasters come last and asynchronously: their pixels do not exist until the
    // bytes have been ranged-read and decoded. A failure is an ISSUE, so the
    // vector layers around it still draw -- a blank map with no explanation is
    // the outcome this project treats as a bug.
    const addRaster = options.environment.addRaster ?? defaultAddRaster
    for (const layer of next.filter(candidate => candidate.kind === 'cog')) {
      void addRaster(target, layer).then(
        (remove) => {
          if (destroyed) remove()
          else rasterRemovers.push(remove)
        },
        (error: unknown) => {
          options.onIssue?.({
            code: 'LAYER_DRAW_FAILED',
            layerId: layer.id,
            message: 'could not draw ' + layer.id + ': ' + (error instanceof Error ? error.message : String(error)),
          })
        },
      )
    }
  }

  // The load is asynchronous and the teardown may win the race: every step after
  // the await re-checks `destroyed`, and the handle below awaits this promise so
  // a caller that destroyed the view never leaves a map behind.
  const started = options.environment.load().then(
    (maplibre) => {
      if (destroyed) return
      const created = new maplibre.Map({
        container: options.container,
        style: EMPTY_STYLE,
        attributionControl: false,
      })
      map = created
      created.on('load', () => {
        if (destroyed) return
        if (options.spec.bbox !== undefined) {
          const [west, south, east, north] = options.spec.bbox
          created.fitBounds([[west, south], [east, north]], { padding: 24, duration: 0 })
        }
        draw(created, layers)
        const observe = options.environment.observeResize ?? observeWithResizeObserver
        disconnect = observe(options.container, () => {
          if (!destroyed) created.resize()
        })
        setStatus('ready')
      })
    },
    (error: unknown) => {
      setStatus('failed', { error })
    },
  )

  return {
    get status(): MapViewStatus {
      return status
    },
    setLayers(next: readonly MapLayerSpec[]): void {
      layers = next
      if (map === undefined || destroyed || status !== 'ready') return
      draw(map, next)
    },
    async destroy(): Promise<void> {
      if (destroyed) {
        await started
        return
      }
      destroyed = true
      status = 'destroyed'
      disconnect?.()
      disconnect = undefined
      for (const remove of rasterRemovers.splice(0)) remove()
      await started
      // `remove` detaches MapLibre's own listeners, animation frame, and WebGL
      // context; without it a remount leaks a whole GL context per mount.
      map?.remove()
      map = undefined
      drawn.splice(0)
    },
  }
}

/**
 * The default raster drawer: the real COG decoder, behind a dynamic import.
 *
 * The import is the point. It keeps a TIFF reader (and its inflate tables) out
 * of the chunk that draws vectors, so a GeoJSON card never downloads it -- and
 * it is the reason this is a function rather than a top-level import (runtime
 * contract #24: a module reachable from two graphs is hoisted into a chunk other
 * chunks then require synchronously).
 * @param map - the live map.
 * @param layer - the raster layer.
 * @returns a disposer.
 */
async function defaultAddRaster(map: MapInstance, layer: MapLayerSpec): Promise<() => void> {
  const { addCogLayer } = await import('./cog-layer.ts')
  return addCogLayer(map, layer)
}

/** Default resize watching: the page's own ResizeObserver, when it has one. */
function observeWithResizeObserver(target: Element, onResize: () => void): (() => void) | undefined {
  if (typeof ResizeObserver === 'undefined') return undefined
  const observer = new ResizeObserver(() => { onResize() })
  observer.observe(target)
  return () => { observer.disconnect() }
}

/** Re-exported so a host can build its own default tokens. */
export { DEFAULT_THEME }
