/** Filesystem access and dataset identity for the pure-JS provider. */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { deriveDatasetId, type Dataset, type DatasetKind } from '@znlgis/dsh-gis-core'

/** Extensions this provider can open, mapped to a dataset kind. */
const KIND_BY_EXTENSION: Record<string, DatasetKind> = {
  '.geojson': 'geojson', '.json': 'geojson',
  '.ndjson': 'ndjson', '.geojsonl': 'ndjson', '.jsonl': 'ndjson',
  '.wkt': 'wkt',
  '.shp': 'shapefile',
}

/** Members of a shapefile family, in the order we look for them. */
const FAMILY_EXTENSIONS = ['.shp', '.shx', '.dbf', '.prj', '.cpg'] as const

/** One existing family member, with the stat that makes it part of the id. */
interface Member {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

/**
 * Resolve a caller-supplied path against the session working directory.
 * @param path - absolute or relative path.
 * @param cwd - directory a relative path is resolved against.
 * @returns an absolute path.
 */
export function absolutePath(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

/**
 * Classify a path by extension.
 * @param path - absolute path.
 * @returns the dataset kind, or undefined when unsupported.
 */
export function kindOf(path: string): DatasetKind | undefined {
  return KIND_BY_EXTENSION[extname(path).toLowerCase()]
}

/**
 * Build the dataset record for a path, including the shapefile family.
 * @param path - absolute path the caller named.
 * @returns the dataset, ready to register.
 * @throws Error when the path does not exist or its kind is unsupported.
 */
export async function describeDataset(path: string): Promise<Dataset> {
  const kind = kindOf(path)
  if (kind === undefined) throw new Error(`unsupported extension: ${extname(path)}`)
  const info = await stat(path)
  const title = basename(path)

  if (kind !== 'shapefile') {
    return {
      id: deriveDatasetId({ path, kind, size: info.size, mtimeMs: info.mtimeMs }),
      kind: kind as 'geojson' | 'ndjson' | 'wkt',
      title,
      path,
      layers: [{ name: basename(path, extname(path)) }],
    }
  }

  const stem = path.slice(0, -4)
  const examined = await Promise.all(FAMILY_EXTENSIONS.map(async (extension) => {
    const candidate = stem + extension
    try {
      const member = await stat(candidate)
      return { path: candidate, size: member.size, mtimeMs: member.mtimeMs }
    } catch { return undefined }
  }))
  const present = examined.filter((value): value is Member => value !== undefined)

  return {
    // Every family member contributes its SIZE AND MTIME, not just its name:
    // the .dbf holds the attributes, the .prj holds the CRS and the .cpg holds
    // the encoding, so an edit to any of them changes what this dataset IS
    // while the .shp itself sits untouched. Hashing bare names would hand back
    // the same id for different data -- a silent error of the worst kind, since
    // a stable id is exactly what makes a replayed card trust the bytes.
    id: deriveDatasetId({
      path,
      kind,
      size: info.size,
      mtimeMs: info.mtimeMs,
      members: present.map(member => `${basename(member.path)}@${member.size}:${member.mtimeMs}`),
    }),
    kind: 'shapefile',
    title,
    main: path,
    siblings: present.map(member => member.path),
    layers: [{ name: basename(path, extname(path)) }],
  }
}

/**
 * Read one file as bytes.
 * @param path - absolute path.
 * @returns the bytes.
 */
export async function readBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}

/**
 * Read one file as UTF-8 text.
 * @param path - absolute path.
 * @returns the text.
 */
export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
