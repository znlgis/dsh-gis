/**
 * Finding the external tools.
 *
 * Detection NEVER throws and never blocks startup: a machine without GDAL is a
 * supported configuration, not an error. What matters is that the ABSENCE is
 * reported with enough detail that the operator can fix it, and that a tool
 * which exists but is unrunnable is distinguished from one that is missing.
 */

/** One probed tool. */
export interface ToolProbe {
  /** Executable name, e.g. `gdalinfo`. */
  readonly name: string
  /** Whether the probe produced a version. */
  readonly available: boolean
  /** Version line as the tool reported it. */
  readonly version?: string
  /** Directory the executable was found in, when known. */
  readonly directory?: string
  /** Why it is unavailable, or how the probe failed. */
  readonly detail?: string
}

/** Everything the runtime discovered. */
export interface RuntimeReport {
  readonly gdal: ToolProbe
  readonly qgis: ToolProbe
  /** The PATH the probe searched, for the operator to compare against. */
  readonly searchedPath: string
}

/**
 * Interpret one probe's output.
 * @param name - executable name.
 * @param directory - configured directory, when one was set.
 * @param result - what the run produced.
 * @returns the probe.
 */
export function interpretProbe(
  name: string,
  directory: string | undefined,
  result: { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly completed: boolean },
): ToolProbe {
  const base = directory === undefined ? { name } : { name, directory }
  if (!result.completed) return { ...base, available: false, detail: 'the probe timed out' }
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map(s => s.trim()).find(s => s.length > 0)
  if (result.exitCode !== 0) {
    return { ...base, available: false, detail: line ?? `exited with code ${String(result.exitCode)}` }
  }
  if (line === undefined) return { ...base, available: false, detail: 'the tool ran but printed no version' }
  return { ...base, available: true, version: line }
}

/** The argv each probe runs. */
export const PROBE_ARGV: Readonly<Record<'gdal' | 'qgis', readonly string[]>> = {
  gdal: ['gdalinfo', '--version'],
  qgis: ['qgis_process', '--version'],
}
