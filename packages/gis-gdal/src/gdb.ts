/**
 * ESRI file geodatabases (T3.5): can this GDAL read one, and what do we say when
 * it cannot.
 *
 * TWO THINGS THIS FILE IS CAREFUL ABOUT.
 *
 * 1. **The version gates are about DIAGNOSIS, not about gating execution.** GDAL
 *    gained read support for file geodatabases in 1.11 and write support in 3.6.
 *    This build is READ-ONLY (a product decision the plan states plainly), so the
 *    write gate exists to explain WHY -- a user with GDAL 3.4 should be told that
 *    their GDAL cannot write, not left wondering why the UI offers no edit.
 * 2. **The answer is a message KEY plus its numbers, never a finished sentence.**
 *    A sentence built here cannot be translated, and asserting on one in a test
 *    makes the test fail every time the wording improves. Callers get
 *    \`{ key, detail }\` and render it in the user's language.
 */
import { GisError } from '@znlgis/dsh-gis-core'

/** The oldest GDAL that can READ a file geodatabase. */
export const GDB_MIN_READ: readonly [number, number] = [1, 11]

/** The oldest GDAL that can WRITE a file geodatabase. */
export const GDB_MIN_WRITE: readonly [number, number] = [3, 6]

/** Every diagnostic this module can produce. */
export type GdbDiagnosticKey =
  /** The OpenFileGDB driver is available and the version can read. */
  | 'gdb.read.ok'
  /** GDAL is older than the read gate. */
  | 'gdb.read.too-old'
  /** This GDAL build has no OpenFileGDB driver at all. */
  | 'gdb.driver.missing'
  /** Readable, and new enough to write -- which this build still does not do. */
  | 'gdb.write.available'
  /** Readable, but older than the write gate. */
  | 'gdb.write.too-old'

/** What a caller does with a diagnostic: look up {@link GdbDiagnosticKey} and fill in the numbers. */
export interface GdbDiagnostic {
  /** The message key. */
  readonly key: GdbDiagnosticKey
  /** Whether the operation in question can proceed. */
  readonly ok: boolean
  /** Numbers and names the message needs. */
  readonly detail: Readonly<Record<string, string | number | boolean>>
}

/** A parsed GDAL version. */
export interface GdalVersion {
  /** Major. */
  readonly major: number
  /** Minor. */
  readonly minor: number
  /** Patch, when the build reports one. */
  readonly patch: number
  /** The version as reported, for display. */
  readonly text: string
  /** Whether this is a development build (\`dev-<hash>\`), whose features do not follow the release numbering. */
  readonly development: boolean
}

/**
 * Parse the version out of \`gdalinfo --version\` output.
 *
 * The real strings look like \`GDAL 3.13.3 "Iowa City", released 2026/08/13\`, but
 * development builds report \`GDAL 3.11.0dev-abc1234\`, so the parser accepts a
 * missing patch and records that it is a development build rather than guessing.
 * @param text - the command's output.
 * @returns the version, or undefined when nothing parseable is in it.
 */
export function parseGdalVersion(text: string): GdalVersion | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?([^\s,]*)/u.exec(text)
  if (match === null) return undefined
  const rest = match[4] ?? ''
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    text: match[0],
    development: /dev/iu.test(rest),
  }
}

/**
 * Compare a version against a gate.
 * @param version - the parsed version.
 * @param gate - \`[major, minor]\`.
 * @returns whether the version is at least the gate.
 */
export function meetsGate(version: GdalVersion, gate: readonly [number, number]): boolean {
  return version.major > gate[0] || (version.major === gate[0] && version.minor >= gate[1])
}

/** What is known about this environment's GDB support. */
export interface GdbEnvironment {
  /** Whether the OpenFileGDB driver is present. */
  readonly driverPresent: boolean
  /** The GDAL version, when it could be read. */
  readonly version?: GdalVersion
}

/**
 * Decide what to tell the user about reading.
 * @param environment - the probe result.
 * @returns the diagnostic; \`ok\` is false only when reading cannot work.
 */
export function readDiagnostic(environment: GdbEnvironment): GdbDiagnostic {
  if (!environment.driverPresent) {
    return { key: 'gdb.driver.missing', ok: false, detail: { driver: 'OpenFileGDB' } }
  }
  const version = environment.version
  if (version === undefined) {
    // A driver without a version is odd but not fatal: GDAL answered, so reading
    // is attempted and a failure will say so.
    return { key: 'gdb.read.ok', ok: true, detail: { version: 'unknown' } }
  }
  if (!meetsGate(version, GDB_MIN_READ)) {
    return { key: 'gdb.read.too-old', ok: false, detail: { found: version.text, need: GDB_MIN_READ.join('.') } }
  }
  return { key: 'gdb.read.ok', ok: true, detail: { version: version.text } }
}

/**
 * Decide what to tell the user about WRITING.
 *
 * This build never writes a geodatabase; the answer exists so the absence can be
 * explained rather than merely enforced.
 * @param environment - the probe result.
 * @returns the diagnostic; \`ok\` describes the GDAL capability, not this build's.
 */
export function writeDiagnostic(environment: GdbEnvironment): GdbDiagnostic {
  const version = environment.version
  if (version === undefined) {
    return { key: 'gdb.write.too-old', ok: false, detail: { found: 'unknown', need: GDB_MIN_WRITE.join('.') } }
  }
  if (!meetsGate(version, GDB_MIN_WRITE)) {
    return { key: 'gdb.write.too-old', ok: false, detail: { found: version.text, need: GDB_MIN_WRITE.join('.') } }
  }
  return { key: 'gdb.write.available', ok: true, detail: { version: version.text, readOnly: true } }
}

/** One feature class inside a geodatabase. */
export interface GdbLayer {
  /** Layer name. */
  readonly name: string
  /** Geometry type as GDAL reports it (\`Point\`, \`MultiPolygon\`, ...). */
  readonly geometryType: string
  /** Feature count, when GDAL reported one. */
  readonly featureCount?: number
  /** Spatial reference as reported, for display only. */
  readonly srs?: string
}

/** The driver's \`ogrinfo -json\` shape, narrowed without trusting it. */
interface OgrInfoJson {
  readonly layers?: readonly {
    readonly name?: unknown
    readonly geometryFields?: readonly { readonly geometryType?: unknown; readonly name?: unknown }[]
    readonly featureCount?: unknown
    readonly geometryType?: unknown
  }[]
}

/**
 * Turn \`ogrinfo -json\` output into layers.
 *
 * Pure, so the shape GDAL actually produces can be pinned in a test: the geometry
 * type lives under a \`geometryFields\` array, and older or newer builds have put a
 * top-level \`geometryType\` beside it.
 * @param text - the command's stdout.
 * @returns the layers, in the order GDAL listed them.
 * @throws GisError \`DATASET_UNREADABLE\` when the output is not the expected JSON.
 */
export function parseOgrInfo(text: string): readonly GdbLayer[] {
  let parsed: OgrInfoJson
  try {
    parsed = JSON.parse(text) as OgrInfoJson
  } catch {
    throw new GisError('DATASET_UNREADABLE', 'the layer listing was not JSON: ' + text.slice(0, 200))
  }
  const layers = parsed.layers ?? []
  return layers.map(layer => {
    const field = layer.geometryFields?.[0]
    const geometryType = String(field?.geometryType ?? layer.geometryType ?? 'Unknown')
    const count = Number(layer.featureCount as number | undefined)
    return {
      name: String(layer.name ?? 'unnamed'),
      geometryType,
      ...Number.isFinite(count) && count >= 0 ? { featureCount: count } : {},
    }
  })
}

/** Runs one GDAL program; injectable so the gate tests need no binaries. */
export type GdalRunner = (program: string, argv: readonly string[]) => Promise<{ readonly stdout: string; readonly code: number }>

/**
 * Ask GDAL which drivers it has, and whether a file geodatabase is among them.
 * @param run - the runner to use.
 * @returns the probe result.
 */
export async function probeGdbSupport(run: GdalRunner): Promise<GdbEnvironment> {
  const [formats, version] = await Promise.all([
    run('ogrinfo', ['--formats']).catch(() => ({ stdout: '', code: 1 })),
    run('gdalinfo', ['--version']).catch(() => ({ stdout: '', code: 1 })),
  ])
  return {
    driverPresent: /OpenFileGDB/iu.test(formats.stdout),
    ...parseGdalVersion(version.stdout) === undefined ? {} : { version: parseGdalVersion(version.stdout) as GdalVersion },
  }
}

/**
 * List the feature classes in a file geodatabase.
 * @param dir - the \`.gdb\` directory.
 * @param run - the runner to use.
 * @param environment - the probe result; reading is refused when it says it cannot work.
 * @returns the layers.
 * @throws GisError carrying the diagnostic KEY when reading is not possible.
 */
export async function listGdbLayers(dir: string, run: GdalRunner, environment: GdbEnvironment): Promise<readonly GdbLayer[]> {
  const diagnostic = readDiagnostic(environment)
  if (!diagnostic.ok) {
    // The KEY travels in the message so a caller (and a test) can react to it
    // without matching a sentence.
    throw new GisError('GDB_DRIVER_MISSING', diagnostic.key + ' ' + JSON.stringify(diagnostic.detail))
  }
  const result = await run('ogrinfo', ['-json', '-so', dir])
  if (result.code !== 0) {
    throw new GisError('DATASET_UNREADABLE', 'ogrinfo could not read ' + dir + ': ' + result.stdout.slice(0, 200))
  }
  return parseOgrInfo(result.stdout)
}
