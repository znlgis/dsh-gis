/**
 * The probe plugin injected by `scripts/t1a10-real-instance.mjs`.
 *
 * It runs INSIDE a real `dsh --profile gisweb` process and exercises the
 * derived cache through the real `ctx.gis`, with the row config the overlay
 * sets. The cache identities are fabricated on purpose: what is under test is
 * the cache itself (config plumbing, quota, LRU, cross-process durability), not
 * any particular conversion.
 *
 * Function form, so `export const inject` is the injected declaration (a class
 * plugin would need `static inject`; see docs/运行时契约.md #1).
 */
export const name = 'gis-t1a10-probe'

export const inject = ['gis']

const OUT = process.env.GIS_T1A10_OUT
const PHASE = process.env.GIS_T1A10_PHASE
const KEY_ALPHA = process.env.GIS_T1A10_KEY_ALPHA
const KEY_BETA = process.env.GIS_T1A10_KEY_BETA

/** One artifact identity; the source is a name, never opened. */
function identity(n) {
  return { kind: 'probe', extension: 'bin', source: 'C:/fixtures/big.tif', sourceSize: 4096, sourceMtimeMs: 111, params: { n } }
}

/** 600 KiB: two of them exceed a 1 MiB quota, one fits. */
const HALF = new Uint8Array(600 * 1024).fill(9)

/** Append one JSON line to the report file (and to stderr, for humans). */
async function report(line) {
  const { appendFile } = await import('node:fs/promises')
  const text = JSON.stringify(line)
  await appendFile(OUT, text + '\n')
  process.stderr.write('gis-t1a10-probe ' + text + '\n')
}

/** Run the phase named by the environment. */
export async function apply(ctx) {
  const cache = ctx.gis.cache
  try {
    if (PHASE === 'put') {
      const alpha = await cache.put(identity(1), HALF)
      const beta = await cache.put(identity(2), HALF)
      const alphaAfter = await cache.resolve(alpha.key)
      const betaAfter = await cache.resolve(beta.key)
      let refusal = 'NO-ERROR'
      try {
        await cache.put(identity(3), new Uint8Array(2 * 1024 * 1024).fill(1))
      } catch (error) {
        refusal = error?.code ?? String(error)
      }
      await report({
        phase: PHASE, root: cache.root, quotaBytes: cache.stats().quotaBytes,
        alpha: alpha.key, beta: beta.key,
        alphaBytes: alphaAfter?.bytes ?? null, betaBytes: betaAfter?.bytes ?? null,
        refusal, stats: cache.stats(),
      })
    } else if (PHASE === 'resolve') {
      const alpha = await cache.resolve(KEY_ALPHA)
      const beta = await cache.resolve(KEY_BETA)
      const gamma = await cache.put(identity(4), HALF)
      const betaAfterGamma = await cache.resolve(KEY_BETA)
      await report({
        phase: PHASE, alphaPresent: alpha !== undefined, betaPresent: beta !== undefined,
        betaBytes: beta?.bytes ?? null, gamma: gamma.key, betaAfterGamma: betaAfterGamma !== undefined,
        stats: cache.stats(),
      })
    } else if (PHASE === 'clear') {
      const freed = await cache.clear()
      await report({ phase: PHASE, freed, stats: cache.stats() })
    } else {
      await report({ phase: PHASE, error: 'unknown phase' })
    }
  } catch (error) {
    await report({ phase: PHASE, error: String(error?.stack ?? error) })
  }
  await report({ phase: PHASE, done: true })
}
