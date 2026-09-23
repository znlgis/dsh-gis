/**
 * The probe plugin injected by \`scripts/t2-mapstate-check.mjs\` (T2.9).
 *
 * It reports every change the \`gis/map\` projection publishes, which is the
 * evidence that the unit is REGISTERED in a real profile, that it folded a real
 * \`tool/result\` event, and that its client view left the host. Nothing else in
 * the check can prove those three at once -- a unit test proves the fold, and a
 * profile can be missing the row entirely.
 */
export const name = 'gis-t2-mapstate-probe'

export const inject = ['sessionProjections']

const OUT = process.env.GIS_T2M_OUT

/** Append one JSON line. */
async function report(line) {
  const { appendFile } = await import('node:fs/promises')
  const text = JSON.stringify(line)
  await appendFile(OUT, text + '\n')
  process.stderr.write('gis-t2-mapstate-probe ' + text + '\n')
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.sessionProjections.onChanged((session, key, value, seq) => {
      void report({ event: 'changed', key, value, seq: Number(seq), session: String(session.id) })
    }),
    'gis-t2-mapstate-probe: watch',
  )
  void report({ event: 'probe-ready' })
}
