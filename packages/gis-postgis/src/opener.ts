/**
 * Opening a PostGIS dataset (T3.8+): the seam that makes a database reachable
 * from the tools.
 *
 * A database has no path, so the caller names it the way the connection is
 * addressed -- by PROFILE, which is a name in configuration and never a secret:
 *
 *   postgis:<profile>                     the whole profile (every spatial table)
 *   postgis:<profile>/<schema>.<table>    one table, when the profile holds many
 *
 * `open` stays a PURE FACTORY, as gis-core's contract requires: it parses the
 * address and describes the dataset without connecting. The layer list it returns
 * is therefore a PLACEHOLDER derived from the address; the truth comes from
 * `inspect`, which is allowed to talk to the database.
 */
import { deriveDatasetId, type Dataset, type GisOpener } from '@znlgis/dsh-gis-core'

/** The scheme this opener claims. */
export const POSTGIS_SCHEME = 'postgis:'

/** One parsed database address. */
export interface PostgisAddress {
  /** The connection profile name. */
  readonly profile: string
  /** The table, as schema.table, when the address named one. */
  readonly table?: string
}

/**
 * Parse a postgis address.
 * @param path - the caller's path.
 * @returns the profile and optional table, or undefined when unparseable.
 */
export function parsePostgisAddress(path: string): PostgisAddress | undefined {
  if (!path.toLowerCase().startsWith(POSTGIS_SCHEME)) return undefined
  const rest = path.slice(POSTGIS_SCHEME.length).replace(/^\/\//u, '')
  const [profile, table] = rest.split('/', 2)
  const name = (profile ?? '').trim()
  if (name.length === 0) return undefined
  const chosen = (table ?? '').trim()
  return { profile: name, ...chosen.length === 0 ? {} : { table: chosen } }
}

/** The opener gis-core routes postgis addresses to. */
export const postgisOpener: GisOpener = {
  name: 'gis-postgis',
  canOpen: (path: string) => parsePostgisAddress(path) !== undefined,
  async open(path: string): Promise<Dataset> {
    const address = parsePostgisAddress(path)
    if (address === undefined) {
      throw new Error('not a postgis address: ' + path)
    }
    const title = address.table === undefined ? address.profile : address.profile + '/' + address.table
    return {
      id: deriveDatasetId({ path, kind: 'postgis' }),
      kind: 'postgis',
      title,
      profile: address.profile,
      // A PLACEHOLDER: the real feature classes are whatever the catalogue says,
      // and only the database can answer that. inspect() reports them.
      layers: [{ name: address.table ?? address.profile }],
    }
  },
}
