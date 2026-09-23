/** Rendering helpers: what the model actually reads. */
import type { InspectResult, QueryResult } from '@znlgis/dsh-gis-core'

/** One text content block. */
export function text(value: string) { return [{ type: 'text' as const, text: value }] }

/**
 * Render an inspection as a compact report.
 *
 * Issues come BEFORE the happy-path facts: if the CRS is unknown, that changes
 * how every later number must be read, so it must not be buried.
 * @param result - the inspection.
 * @returns the report text.
 */
export function renderInspect(result: InspectResult): string {
  const lines: string[] = []
  lines.push(`dataset ${result.datasetId} (${result.kind})`)
  if (result.issues.length > 0) {
    lines.push('', 'ISSUES -- read these before trusting anything below:')
    for (const issue of result.issues) {
      lines.push(`  [${issue.code}] ${issue.message}${issue.count === undefined ? '' : ` (${String(issue.count)})`}`)
    }
  }
  const crs = result.crs
  const crsText = crs.epsg === undefined
    ? `${crs.name ?? 'unknown'} (source: ${crs.source})`
    : `EPSG:${String(crs.epsg)}${crs.name === undefined ? '' : ` -- ${crs.name}`} (source: ${crs.source})`
  lines.push('', `crs: ${crsText}`)
  if (result.encoding !== undefined) lines.push(`encoding: ${result.encoding.used ?? 'undecided'} (source: ${result.encoding.source})`)
  lines.push(`features: ${String(result.featureCount ?? 'unknown')}`)
  if (result.bbox !== undefined) {
    const [w, s, e, n] = result.bbox
    lines.push(`extent: [${w}, ${s}, ${e}, ${n}]${crs.epsg === 4326 ? ' (EPSG:4326)' : ' (in the source CRS)'}`)
  }
  lines.push('', 'layers:', ...result.layers.map(l => `  ${l.name}${l.geometryType === undefined ? '' : ` -- ${l.geometryType}`}${l.featureCount === undefined ? '' : `, ${String(l.featureCount)} features`}`))
  if (result.fields.length > 0) {
    lines.push('', 'fields:', ...result.fields.map(f => `  ${f.name}: ${f.type}`))
  }
  const caps = result.capabilities
  lines.push('', `capabilities: read=${String(caps.read)} write=${String(caps.write)} tiles=${String(caps.tiles)}${caps.reason === undefined ? '' : ` (${caps.reason})`}`)
  return lines.join('\n')
}

/**
 * Render a query page.
 * @param result - the page.
 * @returns the report text.
 */
export function renderQuery(result: QueryResult): string {
  const header = `${String(result.rowCount)} row(s) returned${result.totalCount === undefined ? '' : ` of ${String(result.totalCount)} matching`}${result.truncated ? ' (more available; raise limit or offset)' : ''}`
  const body = result.rows.map(row => JSON.stringify(row)).join('\n')
  return [header, `columns: ${result.columns.join(', ')}`, '', body].join('\n')
}
