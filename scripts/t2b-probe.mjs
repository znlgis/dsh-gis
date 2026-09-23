/**
 * The probe plugin injected by `scripts/t2-blob-route-check.mjs`.
 *
 * It registers one real dataset through the real `ctx.gis` and reports the id,
 * so the check can then fetch that id's BYTES through the plugin's own route --
 * registry, resolver, range handler, and the connection fence, together.
 *
 * Function form, so `export const inject` is the injected declaration (a class
 * plugin would need `static inject`; see docs/运行时契约.md #1).
 */
export const name = 'gis-t2b-probe'

export const inject = ['gis']

const OUT = process.env.GIS_T2B_OUT
const FIXTURE = process.env.GIS_T2B_FIXTURE

/** Append one JSON line to the report file (and to stderr, for humans). */
async function report(line) {
  const { appendFile, stat } = await import('node:fs/promises')
  const text = JSON.stringify(line)
  await appendFile(OUT, text + '\n')
  process.stderr.write('gis-t2b-probe ' + text + '\n')
}

/** Register the fixture and report what the route should serve. */
/**
 * Retry until a provider's opener claims the path.
 *
 * `ctx.gis` exists as soon as gis-core activates, which is BEFORE gis-purejs
 * registers its opener: a probe that opened the fixture immediately would report
 * "no opener handles ..." -- a false failure about the probe, not the plugin.
 * A tool call never races this (it happens long after boot).
 */
async function openWhenReady(ctx) {
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      return await ctx.gis.open(FIXTURE)
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
}

export async function apply(ctx) {
  try {
    const dataset = await openWhenReady(ctx)
    const { stat } = await import('node:fs/promises')
    const { size } = await stat(FIXTURE)
    await report({ id: dataset.id, size, kind: dataset.kind, persistence: ctx.gis.persistence })
  } catch (error) {
    await report({ error: String(error?.stack ?? error) })
  }
  await report({ done: true })
}
