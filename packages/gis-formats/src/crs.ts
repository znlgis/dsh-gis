/**
 * Coordinate reference system resolution without a projection database.
 *
 * A .prj sidecar holds a CRS WKT. Esri-authored files usually carry NO
 * AUTHORITY node, so resolving them properly needs the PROJ database, which a
 * pure-JS layer does not have. We therefore do the honest subset: take an
 * explicit EPSG authority when the WKT has one, recognise a short list of
 * very common CRSs by name, and otherwise report the CRS as named-but-
 * unresolved rather than inventing a code. The GDAL provider upgrades this.
 */
import type { CrsInfo } from '@znlgis/dsh-gis-core'

/** Name fragments whose EPSG code is unambiguous enough to assert. */
const BY_NAME: readonly (readonly [RegExp, number, string])[] = [
  [/WGS[_ ]?1984[_ ]?Web[_ ]?Mercator/i, 3857, 'WGS 84 / Pseudo-Mercator'],
  [/WGS[_ ]?84[_ ]?UTM[_ ]?zone[_ ]?(\d+)[_ ]?N/i, 32600, 'WGS 84 / UTM north'],
  [/CGCS2000|China[_ ]?Geodetic[_ ]?Coordinate[_ ]?System[_ ]?2000/i, 4490, 'CGCS2000'],
  [/Xian[_ ]?1980/i, 4610, 'Xian 1980'],
  [/Beijing[_ ]?1954/i, 4214, 'Beijing 1954'],
  [/\bWGS[_ ]?1984\b|\bWGS[_ ]?84\b/i, 4326, 'WGS 84'],
]

/**
 * Resolve a .prj WKT into what we can honestly say about it.
 * @param prj - the .prj file contents.
 * @returns the CRS facts, with `source: 'prj'` whenever a WKT was parsed.
 */
export function crsFromPrj(prj: string): CrsInfo {
  const text = prj.trim()
  if (text.length === 0) return { source: 'unknown' }

  const authority = /AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d+)"\s*\]/i.exec(text)
  const name = /^\s*(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS|LOCAL_CS)\s*\[\s*"([^"]+)"/i.exec(text)
  const label = name?.[1]

  if (authority !== null) {
    return { epsg: Number(authority[1]), source: 'prj', ...(label === undefined ? {} : { name: label }) }
  }

  for (const [pattern, epsg, canonical] of BY_NAME) {
    if (!pattern.test(text)) continue
    if (epsg === 32600) {
      const zone = /UTM[_ ]?zone[_ ]?(\d{1,2})[_ ]?N/i.exec(text)?.[1]
      if (zone !== undefined) return { epsg: 32600 + Number(zone), source: 'prj', name: `WGS 84 / UTM zone ${zone}N` }
    }
    return { epsg, source: 'prj', name: canonical }
  }

  const kind = /^\s*(?:PROJCS|PROJCRS)/i.test(text) ? 'projected' : 'geographic'
  return { source: 'prj', name: `${label ?? 'unnamed'} (${kind}; EPSG code not stated in the .prj)` }
}

/**
 * Whether a CRS is known well enough for CRS-dependent work.
 * @param crs - resolved CRS facts.
 * @returns true when an EPSG code is established.
 */
export function hasResolvedCrs(crs: CrsInfo): boolean {
  return crs.epsg !== undefined
}
