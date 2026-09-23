/**
 * A tiny software rasterizer for one map view.
 *
 * Deliberately plain: an equirectangular projection into a pixel grid, an
 * even-odd scanline polygon fill, and Bresenham lines. This is for a quick look
 * at data, not for cartographic production -- no reprojection, no label
 * placement, no anti-aliasing, and no tiles. The design puts real rendering in
 * the client and in QGIS; this exists so a model can produce a picture without
 * either.
 */
import type { Bbox } from '@znlgis/dsh-gis-core'
import type { GeoJsonGeometry, RawFeature } from '@znlgis/dsh-gis-formats'

/** An RGBA colour. */
type Rgba = readonly [number, number, number, number]

const BACKGROUND: Rgba = [250, 250, 248, 255]
const OUTLINE: Rgba = [40, 60, 90, 255]

/** Fill colours, cycled per feature so adjacent shapes stay distinguishable. */
const PALETTE: readonly Rgba[] = [
  [90, 140, 200, 170], [230, 150, 90, 170], [110, 180, 130, 170],
  [190, 120, 170, 170], [220, 200, 100, 170], [120, 170, 190, 170],
]

/** A pixel buffer with the projection it was drawn under. */
export interface Raster {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
  /** The extent actually drawn, after fitting to the image aspect ratio. */
  readonly bbox: Bbox
  /** How many features produced at least one visible pixel. */
  readonly drawn: number
}

/**
 * Expand an extent so it matches an image's aspect ratio.
 *
 * Without this the map would stretch, and a stretched map is a wrong map. The
 * centre is preserved and the smaller axis grows.
 * @param bbox - the requested extent.
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @returns the extent to actually render.
 */
export function fitBbox(bbox: Bbox, width: number, height: number): Bbox {
  const [west, south, east, north] = bbox
  const spanX = Math.max(east - west, 1e-9)
  const spanY = Math.max(north - south, 1e-9)
  const target = width / height
  const current = spanX / spanY
  const cx = (west + east) / 2
  const cy = (south + north) / 2
  if (current < target) {
    const half = (spanY * target) / 2
    return [cx - half, cy - spanY / 2, cx + half, cy + spanY / 2]
  }
  const half = spanX / target / 2
  return [cx - spanX / 2, cy - half, cx + spanX / 2, cy + half]
}

/**
 * Draw features into a fresh pixel buffer.
 * @param features - features whose geometry is in the bbox's own CRS.
 * @param options - image size and the extent to cover.
 * @returns the raster.
 */
export function rasterize(
  features: readonly RawFeature[],
  options: { readonly width: number; readonly height: number; readonly bbox: Bbox; readonly pointsOnly?: boolean },
): Raster {
  const { width, height } = options
  const bbox = fitBbox(options.bbox, width, height)
  const pixels = new Uint8Array(width * height * 4)
  fill(pixels, BACKGROUND)
  const project = projector(bbox, width, height)

  let drawn = 0
  features.forEach((feature, index) => {
    if (feature.geometry === undefined) return
    const colour = PALETTE[index % PALETTE.length] as Rgba
    if (drawGeometry(pixels, width, height, feature.geometry, project, colour, options.pointsOnly === true)) drawn += 1
  })

  return { width, height, pixels, bbox, drawn }
}

/** Build the world-to-pixel mapping. */
function projector(bbox: Bbox, width: number, height: number) {
  const [west, south, east, north] = bbox
  const spanX = east - west
  const spanY = north - south
  return (position: readonly number[]): [number, number] => [
    ((position[0] as number) - west) / spanX * width,
    (north - (position[1] as number)) / spanY * height,
  ]
}

/** Draw one geometry; returns whether anything landed inside the image. */
function drawGeometry(
  pixels: Uint8Array, width: number, height: number,
  geometry: GeoJsonGeometry, project: (p: readonly number[]) => [number, number],
  colour: Rgba, pointsOnly: boolean,
): boolean {
  const type = geometry.type
  if (type === 'GeometryCollection') {
    return ((geometry.geometries as GeoJsonGeometry[] | undefined) ?? [])
      .some(child => drawGeometry(pixels, width, height, child, project, colour, pointsOnly))
  }
  if (type === 'Point') { disc(pixels, width, height, project(geometry.coordinates as number[]), 3, OUTLINE); return true }
  if (type === 'MultiPoint') {
    for (const position of geometry.coordinates as number[][]) disc(pixels, width, height, project(position), 3, OUTLINE)
    return true
  }
  if (type === 'LineString') { stroke(pixels, width, height, (geometry.coordinates as number[][]).map(project), OUTLINE); return true }
  if (type === 'MultiLineString') {
    for (const line of geometry.coordinates as number[][][]) stroke(pixels, width, height, line.map(project), OUTLINE)
    return true
  }
  if (type === 'Polygon') { return paintPolygon(pixels, width, height, geometry.coordinates as number[][][], project, colour, pointsOnly) }
  if (type === 'MultiPolygon') {
    let any = false
    for (const polygon of geometry.coordinates as number[][][][]) {
      if (paintPolygon(pixels, width, height, polygon, project, colour, pointsOnly)) any = true
    }
    return any
  }
  return false
}

/** Even-odd scanline fill across every ring, so holes stay holes. */
function paintPolygon(
  pixels: Uint8Array, width: number, height: number,
  rings: number[][][], project: (p: readonly number[]) => [number, number],
  colour: Rgba, outlineOnly: boolean,
): boolean {
  const projected = rings.map(ring => ring.map(project))
  const edges: [number, number, number, number][] = []
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const ring of projected) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i] as [number, number]
      const b = ring[(i + 1) % ring.length] as [number, number]
      edges.push([a[0], a[1], b[0], b[1]])
      minY = Math.min(minY, a[1]); maxY = Math.max(maxY, a[1])
    }
  }
  if (!Number.isFinite(minY)) return false

  if (!outlineOnly) {
    const from = Math.max(0, Math.ceil(minY))
    const to = Math.min(height - 1, Math.floor(maxY))
    for (let y = from; y <= to; y += 1) {
      const crossings: number[] = []
      for (const [x1, y1, x2, y2] of edges) {
        const centre = y + 0.5
        if ((centre >= y1 && centre < y2) || (centre >= y2 && centre < y1)) {
          crossings.push(x1 + (centre - y1) / (y2 - y1) * (x2 - x1))
        }
      }
      crossings.sort((a, b) => a - b)
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const startX = Math.max(0, Math.ceil(crossings[i] as number))
        const endX = Math.min(width - 1, Math.floor(crossings[i + 1] as number))
        for (let x = startX; x <= endX; x += 1) blend(pixels, width, height, x, y, colour)
      }
    }
  }
  for (const ring of projected) stroke(pixels, width, height, ring, OUTLINE)
  return true
}

/** Bresenham line through a projected ring. */
function stroke(pixels: Uint8Array, width: number, height: number, points: readonly [number, number][], colour: Rgba): void {
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [x0, y0] = points[i] as [number, number]
    const [x1, y1] = points[i + 1] as [number, number]
    let x = Math.round(x0); let y = Math.round(y0)
    const tx = Math.round(x1); const ty = Math.round(y1)
    const dx = Math.abs(tx - x); const dy = -Math.abs(ty - y)
    const sx = x < tx ? 1 : -1; const sy = y < ty ? 1 : -1
    let error = dx + dy
    for (;;) {
      blend(pixels, width, height, x, y, colour)
      if (x === tx && y === ty) break
      const doubled = 2 * error
      if (doubled >= dy) { error += dy; x += sx }
      if (doubled <= dx) { error += dx; y += sy }
    }
  }
}

/** A filled disc, for point features. */
function disc(pixels: Uint8Array, width: number, height: number, at: [number, number], radius: number, colour: Rgba): void {
  const cx = Math.round(at[0]); const cy = Math.round(at[1])
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy <= radius * radius) blend(pixels, width, height, cx + dx, cy + dy, colour)
    }
  }
}

/** Alpha-blend one pixel, ignoring anything off-canvas. */
function blend(pixels: Uint8Array, width: number, height: number, x: number, y: number, colour: Rgba): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  const at = (y * width + x) * 4
  const alpha = colour[3] / 255
  for (let channel = 0; channel < 3; channel += 1) {
    const under = pixels[at + channel] as number
    pixels[at + channel] = Math.round((colour[channel] as number) * alpha + under * (1 - alpha))
  }
  pixels[at + 3] = 255
}

/** Flood the buffer with one colour. */
function fill(pixels: Uint8Array, colour: Rgba): void {
  for (let at = 0; at < pixels.length; at += 4) {
    pixels[at] = colour[0]; pixels[at + 1] = colour[1]; pixels[at + 2] = colour[2]; pixels[at + 3] = colour[3]
  }
}
