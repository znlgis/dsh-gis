/**
 * The document body for text GIS files (T2.8).
 *
 * It reuses the SHARED map component -- the same one the chat card draws with --
 * which is the point of the design's "one map, two surfaces" rule: a preview and
 * a card must not be two implementations that can disagree.
 *
 * The body is lazy (its chunk is fetched when a preview opens) and so is the map
 * inside it, so reading a .geojson file in the sidebar costs nothing until you
 * actually look at it.
 */
import { useMemo, type ReactNode } from 'react'
import css from './preview.module.css'
import { GisMap } from '../map/GisMap.tsx'
import { parseTextPreview } from './parse-text.ts'

/** The content shape the document owner hands a \`text-pages\` implementation. */
export interface TextContent {
  readonly kind: string
  readonly text?: string
}

/** Props this body reads; the rest of the owner's surface is unused here. */
export interface GisTextBodyProps {
  readonly content: TextContent
  /** The file's decoded path, used to pick the parser family and label the view. */
  readonly path?: string
  /** Translator for this plugin's copy, when the host passes one. */
  readonly t?: (key: string) => string
  /** Test seam: replaces the real MapLibre loader. */
  readonly load?: Parameters<typeof GisMap>[0]['load']
}

/** Render a text GIS file as a map, or say why it cannot be one. */
export function GisTextBody({ content, path, t, load }: GisTextBodyProps): ReactNode {
  const text = content.text ?? ''
  const parsed = useMemo(() => parseTextPreview(path ?? 'file.geojson', text), [path, text])

  if (parsed.kind !== 'map') {
    return (
      <div className={css.body} data-gis-preview={parsed.kind}>
        <p className={css.note}>{say(t, parsed.kind === 'unsupported' ? 'preview.unsupported' : 'preview.invalid', parsed.message)}</p>
        {/* The text itself is still worth reading, and hiding it would make a
            claimed file UNREADABLE -- worse than not claiming it. */}
        <pre className={css.text} data-gis-preview-text>{text.slice(0, 4000)}</pre>
      </div>
    )
  }
  return (
    <div className={css.body} data-gis-preview="map">
      <GisMap
        spec={parsed.spec}
        {...path === undefined ? {} : { label: path }}
        {...t === undefined ? {} : { t }}
        {...load === undefined ? {} : { load }}
      />
    </div>
  )
}

/** This plugin's copy, falling back to English when no translator was passed. */
function say(t: ((key: string) => string) | undefined, key: string, fallback: string): string {
  const translated = t?.(key)
  return translated === undefined || translated.length === 0 ? fallback : translated
}
