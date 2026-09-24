/**
 * Reports the PostGIS profiles a real profile resolves (T3.1).
 *
 * It prints the SAFE summary only -- the point of T3.1 is that a surface can show
 * connection state without ever holding the secret, so the check greps the
 * instance log afterwards and asserts the secret is absent.
 *
 * It reports in THREE steps on purpose: "loaded", "is the service there at all",
 * and "here are the profiles". A single report cannot tell a probe that never
 * loaded from a service that was never published, and that ambiguity cost a
 * debugging round (runtime contract #42).
 */
export const name = 'gis-t3-postgis-probe'

/** Write one JSON line to the instance log. */
function say(payload) {
  process.stderr.write('gis-t3-postgis-probe ' + JSON.stringify(payload) + '\n')
}

export function apply(ctx) {
  say({ event: 'probe-loaded' })
  const timer = setTimeout(() => {
    let present = false
    try {
      present = ctx.get('gisPostgis') !== undefined
    } catch (error) {
      say({ event: 'probe-error', message: String(error) })
    }
    say({ event: 'service', present })
    if (present) {
      void ctx.get('gisPostgis').describeAll().then(
        (profiles) => { say({ event: 'profiles', profiles: JSON.parse(JSON.stringify(profiles)) }) },
        (error) => { say({ event: 'failed', message: String(error) }) },
      )
    }
  }, 6000)
  ctx.effect(() => () => { clearTimeout(timer) }, 'gis-t3-postgis-probe: timer')
}
