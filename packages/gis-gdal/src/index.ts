/**
 * `@znlgis/dsh-gis-gdal` -- GDAL/QGIS integration and the settings that make
 * system environment variables unnecessary (requirement 7).
 *
 * The whole point of this package is that a user installs OSGeo4W or QGIS,
 * tells the plugin where it is, and never touches a system-wide PATH again.
 * Configured directories are PREPENDED to the child's PATH rather than
 * replacing it, so nothing that already worked stops working.
 */
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { delimiter } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { deriveDatasetId, type Dataset } from '@znlgis/dsh-gis-core'
import { runConfined, type RunRequest, type RunResult } from './exec.ts'
import { createGdalHandler } from './handler.ts'
import { interpretProbe, PROBE_ARGV, type RuntimeReport, type ToolProbe } from './detect.ts'

/** Configuration this bundle accepts from the active profile. */
export interface Config {
  /** Directory holding gdalinfo/ogrinfo/ogr2ogr, e.g. C:\\OSGeo4W\\bin. */
  gdalBinDir: Volatile<string>
  /** Directory holding qgis_process, e.g. C:\\Program Files\\QGIS 3.40.0\\bin. */
  qgisBinDir: Volatile<string>
  /**
   * Extra environment variables for child processes, one `KEY=VALUE` per line.
   *
   * This is what removes the need to set GDAL_DATA, PROJ_LIB, PYTHONHOME and
   * friends system-wide: they are handed to the child explicitly, per call.
   */
  extraEnv: Volatile<string>
  /** Milliseconds any single external tool may run. */
  timeoutMs: Volatile<number>
}

/** Configuration schema. No annotation: the inference must line up with `Volatile<T>`. */
export const Config = z.object({
  gdalBinDir: z.string().default('').volatile(),
  qgisBinDir: z.string().default('').volatile(),
  extraEnv: z.string().default('').volatile(),
  timeoutMs: z.number().default(30000).volatile(),
})

/** The sandbox and subprocess services must exist before `apply` runs. */
/**
 * Everything this plugin consumes.
 *
 * CRITICAL: this MUST be `static inject` on the class. For the CLASS form of a
 * plugin, Cordis reads the inject list from the class itself -- a module-level
 * `export const inject` is silently ignored, and the first access to an injected
 * service then throws `cannot get property \"x\" without inject`. It went
 * unnoticed until the constructor touched `ctx.gis`, because `ctx.sandbox` and
 * `ctx.subprocess` were only reached later, from methods.
 */
const INJECT = ['sandbox', 'subprocess', 'gis', 'tools'] as const

/**
 * The runtime facade: how to build an environment, and how to run a tool.
 *
 * Published as `ctx.gisRuntime` so a provider package can execute GDAL without
 * knowing anything about settings or sandboxing.
 */
export default class GisRuntimeService extends Service {
  /** Configuration schema, so the Loader validates the profile's values. */
  static readonly Config = Config

  /** Declared on the class, which is where the Loader looks for it. */
  static readonly inject = INJECT

  /**
   * @param ctx - owning context; published as `ctx.gisRuntime`.
   * @param config - resolved settings for this row.
   */
  constructor(ctx: Context, public readonly config: Config) {
    super(ctx, 'gisRuntime')

    // Registered unconditionally: these kinds can only be reached through the
    // opener below, which is the thing that actually needs GDAL present.
    ctx.effect(() => ctx.gis.registerHandler(createGdalHandler(this)), 'gis-gdal: handler')
    ctx.effect(() => ctx.gis.registerOpener({
      name: 'gis-gdal',
      canOpen: (path: string) => path.toLowerCase().endsWith('.gdb'),
      open: async (path: string): Promise<Dataset> => ({
        id: deriveDatasetId({ path, kind: 'gdb' }),
        kind: 'gdb',
        title: path.replace(/.*[\\/]/, ''),
        dir: path,
        layers: [{ name: path.replace(/.*[\\/]/, '') }],
      }),
    }), 'gis-gdal: opener')

    // `execute` is a method on the options object, so `this` there is NOT the
    // service; capture it explicitly.
    const service = this
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'gis_doctor',
      description: [
        'Report which GIS tools this machine can actually run: GDAL and QGIS versions, or the reason each is unavailable.',
        'Call this when a GIS operation fails unexpectedly, or before telling the user that something is not installed.',
      ].join(' '),
      parameters: {},
      output: {
        schema: { type: 'array', items: { type: 'json' } } as const,
        render: (_args: unknown, value: readonly unknown[]) => value as ContentBlock[],
      },
      async execute() {
        const report = await service.detect()
        const line = (label: string, probe: { available: boolean; version?: string; detail?: string; directory?: string }): string =>
          `${label}: ${probe.available ? (probe.version ?? 'available') : `NOT AVAILABLE -- ${probe.detail ?? 'unknown reason'}`}${probe.directory === undefined ? '' : ` (configured: ${probe.directory})`}`
        return [{
          type: 'text' as const,
          text: [
            line('GDAL', report.gdal),
            line('QGIS', report.qgis),
            '',
            `PATH handed to child processes: ${report.searchedPath}`,
            'Configured directories come first; the ambient PATH is kept after them.',
            'Set these paths on the dsh-gis GDAL row in the Plugins page; no system environment variable is needed.',
          ].join('\n'),
        }]
      },
    })), 'gis-gdal: doctor tool')
  }

  /**
   * The child environment this configuration implies.
   *
   * Configured directories come FIRST so they win over an ambient install, and
   * the ambient PATH is retained after them so ordinary system tools keep
   * working. Every `extraEnv` line is applied last, and may override anything.
   * @param ambient - the ambient PATH to append, usually `process.env.PATH`.
   * @returns an env object for `subprocess.spawn`.
   */
  buildEnv(ambient: string | undefined): Record<string, string | undefined> {
    const dirs = [this.config.gdalBinDir.get(), this.config.qgisBinDir.get()]
      .map(dir => dir.trim())
      .filter(dir => dir.length > 0)
    const path = [...dirs, ambient ?? ''].filter(part => part.length > 0).join(delimiter)

    const env: Record<string, string | undefined> = {}
    if (path.length > 0) env.PATH = path
    for (const raw of this.config.extraEnv.get().split(/\r?\n/)) {
      const line = raw.trim()
      if (line.length === 0 || line.startsWith('#')) continue
      const at = line.indexOf('=')
      if (at <= 0) continue
      env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
    return env
  }

  /**
   * Run one external tool under this configuration.
   * @param request - argv, cwd and policy; the environment is supplied here.
   * @returns the captured result.
   */
  run(request: Omit<RunRequest, 'env' | 'timeoutMs'> & { readonly env?: RunRequest['env'] }): Promise<RunResult> {
    return runConfined(this.ctx, {
      ...request,
      env: request.env ?? this.buildEnv(process.env.PATH),
      timeoutMs: this.config.timeoutMs.get(),
    })
  }

  /**
   * Probe for GDAL and QGIS without throwing.
   * @returns what was found, and the PATH that was searched.
   */
  async detect(): Promise<RuntimeReport> {
    const env = this.buildEnv(process.env.PATH)
    const searchedPath = env.PATH ?? ''
    const probe = async (which: 'gdal' | 'qgis', dir: string): Promise<ToolProbe> => {
      const [program, ...rest] = PROBE_ARGV[which]
      const configured = dir.trim()
      try {
        const result = await this.run({
          argv: [program as string, ...rest],
          cwd: process.cwd(),
          mode: 'read-only',
          workspaceRoot: process.cwd(),
        })
        return interpretProbe(program as string, configured.length === 0 ? undefined : configured, result)
      } catch (error) {
        return {
          name: program as string,
          available: false,
          ...(configured.length === 0 ? {} : { directory: configured }),
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const [gdal, qgis] = await Promise.all([
      probe('gdal', this.config.gdalBinDir.get()),
      probe('qgis', this.config.qgisBinDir.get()),
    ])
    return { gdal, qgis, searchedPath }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The GDAL/QGIS runtime facade. */
    gisRuntime: GisRuntimeService
  }
}
