/**
 * The probe plugin injected by \`scripts/t2-exit-check.mjs\` (T2.11).
 *
 * It watches the REAL job registry and writes what it sees to a JSONL file:
 * registration, every progress line, and the settlement. That is the evidence
 * for "首次转换有进度" -- recorded as it happens, not reconstructed afterwards.
 *
 * It SUBSCRIBES with \`{ owners: 'all' }\` rather than polling \`list()\`, and that
 * distinction cost a debugging round: \`list(caller)\` returns
 * \`owner === undefined || owner.id === caller\`, so an unscoped caller sees
 * UNOWNED jobs only -- and our job is owned by the calling session. The probe
 * polled, saw nothing, and reported "no job" while the interface showed a
 * running one. An unscoped subscription, by contrast, receives every owner.
 *
 * It can also cancel: \`ctx.jobs.kill(id, owner, reason)\` with the job's OWN
 * owner as the caller, i.e. through the same authorized path the interface's
 * kill control uses (a job owned by a session refuses callers from another one).
 */
export const name = 'gis-t2-exit-probe'

export const inject = ['jobs']

const OUT = process.env.GIS_T2E_JOBS
const KILL_MS = process.env.GIS_T2E_KILL_MS === undefined ? undefined : Number(process.env.GIS_T2E_KILL_MS)
const started = Date.now()

/** Append one JSON line; every line is a fact about the registry. */
async function report(line) {
  const { appendFile } = await import('node:fs/promises')
  const text = JSON.stringify(line)
  await appendFile(OUT, text + '\n')
  process.stderr.write('gis-t2-exit-probe ' + text + '\n')
}

/** The caller a kill needs: the owning session's id, whatever shape it arrives in. */
function callerOf(owner) {
  if (owner === undefined || owner === null) return undefined
  return typeof owner === 'object' ? owner.id : owner
}

export function apply(ctx) {
  let killed = false
  // Proof of life: without this line, "the probe saw nothing" and "the probe
  // never loaded" look identical in the report.
  void report({ event: 'probe-ready', jobs: OUT })
  // The event stream is `ctx.jobs.events` -- a getter bound to the accessing
  // context. `ctx.jobs.subscribe` does not exist, and the failure is a startup
  // error, not a silent one (it took the whole instance down, which is how it
  // was found).
  ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
    void (async () => {
      try {
        const job = event.job
        if (event.type === 'registered') {
          await report({ event: 'registered', id: String(job.id), kind: job.kind, label: job.label, owner: callerOf(job.owner) ?? null })
        }
        if (event.type === 'progress') {
          await report({ event: 'progress', id: String(job.id), progress: job.progress ?? null, status: job.status })
        }
        if (event.type === 'settled') {
          await report({ event: 'settled', id: String(job.id), status: job.status, cause: event.cause ?? null })
        }
        if (!killed && KILL_MS !== undefined && job.kind === 'gis-cog' && job.status === 'running' && Date.now() - started > KILL_MS) {
          killed = true
          const outcome = ctx.jobs.kill(job.id, callerOf(job.owner), 'cancelled by the M2 exit check')
          await report({ event: 'kill-requested', id: String(job.id), outcome })
        }
      } catch (error) {
        await report({ event: 'probe-error', message: String(error?.message ?? error) })
      }
    })()
  })
}
