/**
 * The document body for binary GIS files (T2.8).
 *
 * Two formats are actually drawn, each with the reader the map card already uses
 * -- one implementation, two surfaces:
 *
 * - **FlatGeobuf** is decoded into GeoJSON and handed to a map source;
 * - **GeoTIFF / COG** is decoded by the range-aware reader into a canvas.
 *
 * The rest are CLAIMED by the metadata so the tab exists, and refused HERE in
 * words. That is deliberate: a tab that shows nothing leaves a user unable to
 * tell "not supported" from "broken".
 *
 * The size cap is the other deliberate limit. The document owner hands COMPLETE
 * bytes, so a 2 GB raster would arrive in the tab's memory whole; above the cap
 * this refuses and points at the map card, which streams by range instead.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import css from './preview.module.css'
import { GisMap } from '../map/GisMap.tsx'
import type { MapViewSpec } from '../map/spec.ts'

/** Complete bytes as the document owner delivers them. */
export interface BytesContent {
  readonly kind: string
  readonly data?: Uint8Array
}

/** Props this body reads. */
export interface GisBinaryBodyProps {
  readonly content: BytesContent
  readonly path?: string
  readonly t?: (key: string) => string
  readonly load?: Parameters<typeof GisMap>[0]['load']
}

/** Above this, the tab would hold the whole file; the card streams instead. */
export const MAX_PREVIEW_BYTES = 48 * 1024 * 1024

/** What the body decided to do, before any decoding. */
type Plan =
  | { readonly kind: 'flatgeobuf' }
  | { readonly kind: 'raster' }
  | { readonly kind: 'refused'; readonly message: string }

/**
 * Decide from the suffix and the size.
 * @param path - the file's decoded path.
 * @param bytes - how many bytes arrived.
 * @returns what to do with them.
 */
export function planBinaryPreview(path: string, bytes: number): Plan {
  const suffix = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (bytes > MAX_PREVIEW_BYTES) {
    return { kind: 'refused', message: 'this file is ' + (bytes / 1024 / 1024).toFixed(1) + ' MB, above the ' + String(MAX_PREVIEW_BYTES / 1024 / 1024) + ' MB preview limit; draw it with the map card, which reads it by range' }
  }
  if (suffix === 'fgb') return { kind: 'flatgeobuf' }
  if (suffix === 'tif' || suffix === 'tiff' || suffix === 'cog') return { kind: 'raster' }
  return { kind: 'refused', message: 'a .' + suffix + ' file has no browser preview yet; open it with the GIS tools instead' }
}

/** Render a binary GIS file, or say why it cannot be one. */
export function GisBinaryBody({ content, path, t, load }: GisBinaryBodyProps): ReactNode {
  const bytes = content.data ?? new Uint8Array(0)
  const plan = useMemo(() => planBinaryPreview(path ?? 'file.fgb', bytes.byteLength), [path, bytes.byteLength])
  const [spec, setSpec] = useState<MapViewSpec | null>(null)
  const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (bytes.byteLength === 0 || plan.kind === 'refused') return
    let live = true
    setFailure(null)
    setSpec(null)
    setImage(null)
    void (async () => {
      try {
        if (plan.kind === 'flatgeobuf') {
          const { readFlatGeobuf } = await import('../map/flatgeobuf-layer.ts')
          const { features } = await readFlatGeobuf(bytes)
          if (!live) return
          setSpec({
            mapId: 'preview:' + (path ?? ''),
            layers: [{
              id: 'preview',
              kind: 'geojson',
              url: 'data:application/geo+json,' + encodeURIComponent(JSON.stringify({ type: 'FeatureCollection', features })),
              origin: 'local',
              style: { type: 'circle', paint: { 'circle-radius': 5, 'circle-color': '#2f6feb', 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' } },
            }],
          })
          return
        }
        const { readCogImage } = await import('../map/cog-layer.ts')
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const decoded = await readCogImage(buffer)
        if (!live) return
        const canvas = document.createElement('canvas')
        canvas.width = decoded.width
        canvas.height = decoded.height
        const context = canvas.getContext('2d')
        if (context === null) throw new Error('this page has no 2D canvas context')
        context.putImageData(new ImageData(decoded.rgba, decoded.width, decoded.height), 0, 0)
        setImage({ url: canvas.toDataURL('image/png'), width: decoded.width, height: decoded.height })
      } catch (error) {
        if (live) setFailure(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { live = false }
  }, [plan.kind, bytes, path])

  if (plan.kind === 'refused') {
    return (
      <div className={css.body} data-gis-preview="unsupported">
        <p className={css.note}>{say(t, 'preview.unsupported', plan.message)}</p>
      </div>
    )
  }
  if (failure !== null) {
    return (
      <div className={css.body} data-gis-preview="invalid">
        <p className={css.note}>{say(t, 'preview.invalid', failure)}</p>
      </div>
    )
  }
  if (plan.kind === 'flatgeobuf') {
    return spec === null
      ? <div className={css.body} data-gis-preview="decoding"><p className={css.note} data-gis-preview-loading>{say(t, 'preview.decoding', 'reading the features…')}</p></div>
      : (
        <div className={css.body} data-gis-preview="map">
          <GisMap
            spec={spec}
            {...path === undefined ? {} : { label: path }}
            {...t === undefined ? {} : { t }}
            {...load === undefined ? {} : { load }}
          />
        </div>
      )
  }
  return (
    <div className={css.body} data-gis-preview="raster">
      {image === null
        ? <p className={css.note} data-gis-preview-loading>{say(t, 'preview.decoding', 'decoding the raster…')}</p>
        : <img className={css.image} src={image.url} width={image.width} height={image.height} alt={path ?? 'raster'} data-gis-preview-image />}
    </div>
  )
}

/** This plugin's copy, falling back to English when no translator was passed. */
function say(t: ((key: string) => string) | undefined, key: string, fallback: string): string {
  const translated = t?.(key)
  return translated === undefined || translated.length === 0 ? fallback : translated
}
