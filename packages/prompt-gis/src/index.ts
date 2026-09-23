/**
 * `@znlgis/dsh-prompt-gis` -- what the model needs to know about spatial data.
 *
 * The tools alone are not enough. A model that never learns that an unknown CRS
 * invalidates measurement will happily report a distance in metres computed from
 * degrees, and the result will look perfectly plausible. This section exists to
 * make that failure mode impossible to reach by accident.
 */
import type { Context } from '@deepseek-ai/cordis'
// TYPE-ONLY: these bring `ctx.systemPrompt` and `ctx.skills` into the program.
// They are erased at build time; the services are injected at runtime.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-skill'

/** Stable Loader identity. */
export const name = 'prompt-gis'

/** The prompt and skill services must exist first. */
export const inject = ['systemPrompt', 'skills']

/** Order of our system-prompt section relative to other plugins'. */
const SECTION_ORDER = 60

/** The guidance text. Deliberately short: it competes for attention. */
const SECTION_TEXT = [
  '# Spatial data',
  '',
  'You have GIS tools. Three rules decide whether your answer is trustworthy:',
  '',
  '1. **Inspect before you compute.** `gis_inspect` reports the format, the coordinate reference system, and every data-quality issue. Run it first, every time.',
  '2. **An unknown CRS means no measurement.** If the inspection reports `CRS_UNKNOWN`, you do not know what the coordinates mean. Say so and ask which CRS applies, or use `gis_crs` to transform once you are told. Never compute a distance, area, or buffer from coordinates whose CRS is unknown -- degrees and metres are not interchangeable, and the wrong answer looks right.',
  '3. **Report issues, do not bury them.** If the inspection found problems -- an assumed encoding, coordinates outside the degree range, skipped lines -- state them alongside your answer. The user cannot see the raw data; you are the only one who can warn them.',
  '',
  'Geometry crosses the tool boundary as WKT by default: it is compact and you read it well. Ask for `geojson` only when you need the structure, and `none` when you only need attributes.',
  '',
  'When a dataset has no .prj, no .cpg, or coordinates that look projected, that is the NORMAL case for real-world files, not an exotic one. Handle it rather than working around it.',
].join('\n')

/** Inspect-first skill text. */
const INSPECT_SKILL = [
  '# Inspecting a spatial dataset',
  '',
  'Call `gis_inspect` with the path to the data file. It returns the format, layers, CRS, extent, attribute fields, and an ISSUES block.',
  '',
  '## What to do with the result',
  '',
  '- `CRS_UNKNOWN` -- the file has no .prj. Do not measure anything. Ask the user which CRS applies, then convert with `gis_crs` (action=transform).',
  '- `CRS_AMBIGUOUS` -- coordinates are outside the degree range, so they are probably projected, often in metres. The raw extent in the message tells you which. Same rule: no measurement until the CRS is known.',
  '- `ENCODING_UNDECIDED` -- attribute text has no declared encoding, so non-ASCII text may already be mojibake. Re-read with an explicit encoding if the user knows it.',
  '- `PARSE_FAILED` -- some records were skipped. Say how many; never present the remainder as complete.',
  '',
  'Report the issues with your answer. The user cannot see the file.',
].join('\n')

/** Query-patterns skill text. */
const QUERY_SKILL = [
  '# Querying spatial data',
  '',
  'Call `gis_query` with either `path` (open a file) or `id` (a dataset registered earlier this session; `gis_catalog` lists them).',
  '',
  '## Filtering',
  '',
  '`where` takes flat comparisons joined by AND / OR, for example: pop > 1000 AND name LIKE \'B%\'.',
  'Parentheses and other SQL are refused rather than approximated. If a filter is rejected, rewrite it as a flat list.',
  '',
  '`bbox` is a west,south,east,north window in EPSG:4326. It selects features whose extent INTERSECTS the window, not only those fully inside.',
  'A bbox is only meaningful when the dataset is in EPSG:4326. If `gis_inspect` reported anything else, transform first or expect a wrong window.',
  '',
  '## Paging',
  '',
  'Default limit is 20 (max 500). The reply states how many rows matched in total and whether more are available. Page with `offset` rather than raising limit past 500.',
  '',
  '## Geometry',
  '',
  'geometry=wkt (default) returns WKT text; geojson returns structured geometry; none drops geometry entirely, which is what you want for pure attribute questions.',
].join('\n')

/** Register the prompt section and the skills. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'gis',
    order: SECTION_ORDER,
    text: SECTION_TEXT,
  }), 'prompt-gis: guidance')

  ctx.effect(() => ctx.skills.register({
    name: 'gis-inspect-first',
    description: 'Check a spatial dataset before using it: format, CRS, extent, fields, and data-quality issues.',
    // Both faces on: the model may reach for it, and the user may invoke it by name.
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'runtime',
    content: INSPECT_SKILL,
  }), 'prompt-gis: inspect skill')

  ctx.effect(() => ctx.skills.register({
    name: 'gis-query-patterns',
    description: 'Read features from a spatial dataset: attribute filters, spatial windows, paging, and geometry encoding.',
    // Both faces on: the model may reach for it, and the user may invoke it by name.
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'runtime',
    content: QUERY_SKILL,
  }), 'prompt-gis: query skill')
}
