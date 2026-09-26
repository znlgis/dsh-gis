/**
 * Exercises the whole PostGIS path from inside a real instance (T3.9).
 *
 * The service, the opener, the handler and the database are all involved; nothing
 * here reaches into internals. It reports in STEPS on purpose -- "did the row
 * load", "did the opener claim the address", "what came back" -- because a single
 * report cannot tell a missing row from a broken query (contract #42).
 *
 * A separate file from the T3.1 probe: that one answers "is the profile
 * configured", this one answers "can a dataset be read", and one file serving both
 * would make each check depend on the other's assertions.
 */
export const name = 'gis-t39-postgis-probe'

/** Write one JSON line to the instance log. */
function say(payload) {
  process.stderr.write('gis-t39-probe ' + JSON.stringify(payload) + '\n')
}

export function apply(ctx) {
  say({ event: 'probe-loaded' })
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const gis = ctx.get('gis')
        say({ event: 'service', present: gis !== undefined && ctx.get('gisPostgis') !== undefined })
        if (gis === undefined) return

        // A PATH goes through open(), which consults the registered openers and
        // registers what they return; resolve() only accepts an id that is already
        // registered. The tools make the same distinction, so the probe follows it.
        const dataset = await gis.open('postgis:live/dsh_gis_fixture.cities')
        say({ event: 'opened', id: dataset.id, kind: dataset.kind, profile: dataset.profile, title: dataset.title })

        const inspected = await gis.inspect(dataset.id)
        say({
          event: 'inspected',
          layers: inspected.layers.map(layer => layer.name).sort(),
          srid: inspected.srid ?? null,
          bbox: inspected.bbox ?? null,
          fields: inspected.fields.map(field => field.name).slice(0, 8),
          tiles: inspected.capabilities.tiles,
          issues: inspected.issues.map(issue => issue.code),
        })

        const page = await gis.query(dataset.id, { layer: 'dsh_gis_fixture.cities', limit: 5, offset: 0, geometry: 'geojson' })
        say({
          event: 'queried',
          rowCount: page.rowCount,
          first: { attributes: page.rows[0]?.attributes ?? null, geometry: page.rows[0]?.geometry ?? null },
        })

        const filtered = await gis.query(dataset.id, { layer: 'dsh_gis_fixture.cities', where: 'population > 39000', limit: 50, offset: 0, geometry: 'wkt' })
        say({ event: 'filtered', rowCount: filtered.rowCount, geometryKind: typeof filtered.rows[0]?.geometry })
      } catch (error) {
        say({ event: 'failed', message: String(error && error.message ? error.message : error) })
      }
    })()
  }, 6000)
  ctx.effect(() => () => { clearTimeout(timer) }, 'gis-t39-probe: timer')
}
