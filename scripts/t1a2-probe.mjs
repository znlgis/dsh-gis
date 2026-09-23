/**
 * The probe plugin injected by `scripts/t1a2-real-instance.mjs`.
 *
 * It runs INSIDE a real `dsh --profile gisweb` process, with the real Cordis
 * Loader and the real `dsh-base` storage stack mounted below it. It reads its
 * task from the environment and reports to a file, so the result does not
 * depend on how boot logs are routed.
 *
 * Function form, so `export const inject` is the injected declaration (a class
 * plugin would need `static inject`; see docs/运行时契约.md #1).
 *
 * Every phase WAITS for the plugin's asynchronous startup instead of assuming
 * it: `gis` becomes available when `gis-core` activates, which is before
 * `gis-purejs` registers its opener and before the storage domain finishes
 * opening. A tool call never races this (it happens long after boot); a probe
 * that ran at activation time would, and would report a false failure.
 */
export const name = 'gis-t1a2-probe'

export const inject = ['gis']

const OUT = process.env.GIS_T1A2_OUT
const PHASE = process.env.GIS_T1A2_PHASE
const FIXTURE = process.env.GIS_T1A2_FIXTURE
const EXPECT = process.env.GIS_T1A2_EXPECT_ID
const DEADLINE_MS = 60_000
const POLL_MS = 200

/** Append one JSON line to the report file (and to stderr, for humans). */
async function report(line) {
  const { appendFile } = await import('node:fs/promises')
  const text = JSON.stringify(line)
  await appendFile(OUT, text + '\n')
  process.stderr.write('gis-t1a2-probe ' + text + '\n')
}

/** Retry `attempt` until it returns, or fail loudly at the deadline. */
async function waitFor(label, attempt) {
  const deadline = Date.now() + DEADLINE_MS
  for (;;) {
    try {
      return await attempt()
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`${label} never became ready: ${String(error)}`)
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
  }
}

/** The durable half is attached asynchronously; every phase needs it. */
function durable(ctx) {
  return waitFor('the storage-backed registry', async () => {
    if (ctx.gis.persistence !== 'storage') throw new Error(`persistence is ${ctx.gis.persistence}`)
    return true
  })
}

/** `ctx.gis.open` until some provider's opener claims the path. */
function openFixture(ctx) {
  return waitFor('an opener for the fixture', () => ctx.gis.open(FIXTURE))
}

/** Run the phase named by the environment. */
export async function apply(ctx) {
  try {
    await durable(ctx)
    if (PHASE === 'open') {
      const dataset = await openFixture(ctx)
      await report({
        phase: PHASE, id: dataset.id, kind: dataset.kind,
        title: dataset.title, persistence: ctx.gis.persistence,
      })
    } else if (PHASE === 'resolve') {
      const dataset = await waitFor('the stored id', () => Promise.resolve(ctx.gis.resolve(EXPECT)))
      const fresh = await ctx.gis.resolveFresh(EXPECT)
      await report({
        phase: PHASE, resolved: dataset.title, fresh: fresh.id === EXPECT,
        persistence: ctx.gis.persistence, listed: ctx.gis.list().map(entry => entry.id),
      })
    } else if (PHASE === 'stale') {
      // Re-opening the edited file proves an opener is loaded AND that a changed
      // source yields a new id; only then is the old id's 404 meaningful.
      const reopened = await openFixture(ctx)
      let code = 'NO-ERROR'
      try {
        await ctx.gis.resolveFresh(EXPECT)
      } catch (error) {
        code = error?.code ?? String(error)
      }
      await report({
        phase: PHASE, code, newId: reopened.id, changed: reopened.id !== EXPECT,
        listed: ctx.gis.list().map(entry => entry.id),
      })
    } else {
      await report({ phase: PHASE, error: 'unknown phase' })
    }
  } catch (error) {
    await report({ phase: PHASE, error: String(error?.stack ?? error) })
  }
  await report({ phase: PHASE, done: true })
}
