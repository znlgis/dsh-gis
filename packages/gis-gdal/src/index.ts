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
// TYPE-ONLY: brings `ctx.jobs` into the program (runtime contract #6).
import type {} from '@deepseek-ai/dsh-jobs'

// Producer-defined job kind (the registry treats it as an opaque id namespace).
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'gis-cog': 'gis-cog'
  }
}
import { basename } from 'node:path'
// T3.5's gates and diagnostics. Exported from the package entry so they are part of
// the built artifact -- and so T3.6 can ask the same questions the settings card does.
export {
  GDB_MIN_READ,
  GDB_MIN_WRITE,
  listGdbLayers,
  meetsGate,
  parseGdalVersion,
  parseOgrInfo,
  probeGdbSupport,
  readDiagnostic,
  writeDiagnostic,
  type GdbDiagnostic,
  type GdbDiagnosticKey,
  type GdbEnvironment,
  type GdbLayer,
  type GdalRunner,
  type GdalVersion,
} from './gdb.ts'
import { delimiter } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { deriveCacheKey, deriveDatasetId, GisError, sourcePathOf, type Dataset } from '@znlgis/dsh-gis-core'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { runConfined, runStreaming, type RunRequest, type RunResult, type StreamRequest } from './exec.ts'
import { cogIdentity, convertToCog, estimateCogBytes, type CogOutcome } from './cog.ts'
import { createGdalHandler } from './handler.ts'
import { interpretProbe, PROBE_ARGV, type RuntimeReport, type ToolProbe } from './detect.ts'

/**
 * `gis_cog`'s output: one object, three shapes of answer.
 *
 * `cached` and `started` are successes, `refused` is the quota answer. All are
 * plain JSON (the tool contract persists this), and the prose below is what the
 * model reads.
 */
const COG_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', required: true },
      key: { type: 'string', required: true },
      path: { type: 'string' },
      bytes: { type: 'number' },
      jobId: { type: 'string' },
      estimatedBytes: { type: 'number' },
      code: { type: 'string' },
      message: { type: 'string' },
    },
  } as const,
  render: (_args: unknown, value: unknown): ContentBlock[] => {
    const answer = value as { kind?: unknown; key?: unknown; path?: unknown; bytes?: unknown; jobId?: unknown; estimatedBytes?: unknown; code?: unknown; message?: unknown }
    const megabytes = (bytes: unknown): string => (typeof bytes === 'number' ? (bytes / 1024 / 1024).toFixed(1) + ' MiB' : 'unknown size')
    if (answer.kind === 'cached') {
      return [{ type: 'text', text: 'already converted: ' + String(answer.path) + ' (' + megabytes(answer.bytes) + ', cache key ' + String(answer.key) + ')' }]
    }
    if (answer.kind === 'started') {
      return [{
        type: 'text',
        text: 'conversion started as job ' + String(answer.jobId) + ', reserving about ' + megabytes(answer.estimatedBytes)
          + '. It reports GDAL progress and can be cancelled; ask for the job to follow it.',
      }]
    }
    return [{
      type: 'text',
      text: 'refused before starting: [' + String(answer.code) + '] ' + String(answer.message)
        + ' -- the artifact would need about ' + megabytes(answer.estimatedBytes) + ', which the cache cannot hold right now.',
    }]
  },
}

/** The `code` of a GIS error, read structurally (runtime contract #20). */
function codeOf(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** A throwable's message, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
const INJECT = ['sandbox', 'subprocess', 'gis', 'tools', 'jobs'] as const

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
    // A GeoTIFF is a RASTER the browser draws by range (T2.4's direct read), so
    // it is its own kind rather than a table. The id takes the BYTES into
    // account, so replacing the file yields a new id and the old one stops
    // resolving -- the same rule every other kind follows.
    ctx.effect(() => ctx.gis.registerOpener({
      name: 'gis-gdal-cog',
      canOpen: (path: string) => /\.tiff?$/iu.test(path),
      open: async (path: string): Promise<Dataset> => {
        const info = await stat(path)
        const title = basename(path)
        return {
          id: deriveDatasetId({ path, kind: 'cog', size: info.size, mtimeMs: info.mtimeMs }),
          kind: 'cog',
          title,
          path,
          layers: [{ name: title }],
        }
      },
    }), 'gis-gdal: cog opener')

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

    // `gis_cog` (T2.4). Registered with the doctor tool: both are "the GDAL
    // runtime, exposed", and both need the service's binary resolution.
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'gis_cog',
      description: [
        'Convert a raster file (GeoTIFF and friends) into a Cloud-Optimized GeoTIFF inside the derived cache, so it can be read by range instead of downloaded whole.',
        'The conversion runs as a background job: it reports GDAL progress and can be cancelled.',
        'Ask for the job to follow it. Calling this again for the same file returns the cached artifact instead of converting twice.',
      ].join(' '),
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute or workspace-relative path of the raster to convert.' },
      },
      output: COG_OUTPUT,
      async execute(args, exec) {
        const source = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path)
        if (!existsSync(source)) {
          throw new GisError('DATASET_NOT_FOUND', 'no file at ' + source, 'check the path; gis_catalog lists what is registered')
        }
        const info = await stat(source)
        if (!info.isFile()) {
          throw new GisError('UNSUPPORTED_FORMAT', source + ' is not a file', 'gis_cog converts one raster file')
        }

        const cache = ctx.gis.cache
        const identity = cogIdentity({ source, sourceBytes: info.size, sourceMtimeMs: info.mtimeMs })
        const key = deriveCacheKey(identity)

        // 1. A hit is the whole point of the cache: no job, no GDAL.
        const hit = await cache.resolve(key)
        if (hit !== undefined) {
          return { kind: 'cached', key, path: hit.path, bytes: hit.bytes, estimatedBytes: estimateCogBytes(info.size) }
        }

        // 2. Refuse BEFORE any work exists (T2.4). A refusal is a normal answer,
        //    not an exception: the model can report it and try something else.
        const estimatedBytes = estimateCogBytes(info.size)
        let pending
        try {
          pending = await cache.begin(identity, estimatedBytes)
        } catch (error) {
          if (codeOf(error) !== 'CACHE_QUOTA_EXCEEDED') throw error
          return {
            kind: 'refused',
            key,
            code: 'CACHE_QUOTA_EXCEEDED',
            message: messageOf(error),
            estimatedBytes,
          }
        }

        // 3. Now the job, writing into the reservation taken above.
        const reservation = pending
        const jobId = ctx.jobs.start({
          kind: 'gis-cog',
          label: 'COG ' + basename(source),
          ...exec.agent === undefined ? {} : { owner: exec.agent.id },
          run(handle) {
            const controller = new AbortController()
            const done = (async (): Promise<JobOutcome> => {
              try {
                const outcome = await service.cog({
                  source,
                  sourceBytes: info.size,
                  sourceMtimeMs: info.mtimeMs,
                  cache,
                  pending: reservation,
                  signal: controller.signal,
                  onProgress: (percent) => { handle.updateProgress(String(percent) + '%') },
                })
                handle.append('COG written: ' + outcome.path + ' (' + String(outcome.bytes) + ' bytes)\n')
                return { status: 'completed', detail: 'COG ready', result: outcome.path }
              } catch (error) {
                const message = messageOf(error)
                handle.append(message + '\n')
                return { status: controller.signal.aborted ? 'killed' : 'failed', detail: message }
              }
            })()
            // Synchronous, idempotent: the child is signalled, not merely flagged.
            return { cancel: () => { controller.abort() }, done }
          },
        })
        return { kind: 'started', key, jobId, estimatedBytes }
      },
    })), 'gis-gdal: cog tool')
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
   * Run one external tool with its output streaming, and cancellable.
   *
   * A minute-long conversion needs "what is it saying NOW" and a way to stop
   * it, which the waiting seam cannot provide (T2.4's progress and cancel).
   * @param request - argv, cwd, policy, and who to tell.
   * @returns the captured result.
   */
  runStreaming(request: Omit<StreamRequest, 'env' | 'timeoutMs'> & { readonly env?: StreamRequest['env'] }): Promise<RunResult> {
    return runStreaming(this.ctx, {
      ...request,
      env: request.env ?? this.buildEnv(process.env.PATH),
      timeoutMs: this.config.timeoutMs.get(),
    })
  }

  /**
   * Convert a raster into the derived cache, or return the cached conversion.
   * @param request - source facts, the cache, and the progress/cancel channels.
   * @returns the artifact's key, path and size.
   */
  async cog(request: {
    readonly source: string
    readonly sourceBytes: number
    readonly sourceMtimeMs: number
    readonly cache: import('@znlgis/dsh-gis-core').DerivedCache
    readonly signal?: AbortSignal
    readonly pending?: import('@znlgis/dsh-gis-core').PendingArtifact
    readonly onProgress?: (progress: import('./cog.ts').CogProgress) => void
  }): Promise<CogOutcome> {
    const gdalBinary = await this.resolveBinary('gdal_translate')
    return convertToCog(
      {
        source: request.source,
        sourceBytes: request.sourceBytes,
        sourceMtimeMs: request.sourceMtimeMs,
        gdalBinary,
        cache: request.cache,
        ...request.signal === undefined ? {} : { signal: request.signal },
        ...request.pending === undefined ? {} : { pending: request.pending },
        ...request.onProgress === undefined ? {} : { onProgress: request.onProgress },
      },
      (argv, signal, onOutputText) => this.runStreaming({
        argv,
        cwd: request.cache.root,
        // The artifact is the only thing this call may modify; the source is
        // read from wherever it lives.
        mode: 'workspace-write',
        workspaceRoot: request.cache.root,
        ...signal === undefined ? {} : { signal },
        // RAW chunks, not lines: GDAL's progress arrives as one un-terminated
        // line, and a line-based feed would report it only at the end.
        onOutputChunk: onOutputText,
      }),
    )
  }

  /**
   * Resolve one of this plugin's binaries, failing loud and specific.
   * @param program - e.g. `gdal_translate`.
   * @returns the executable name/path to spawn.
   */
  private async resolveBinary(program: string): Promise<string> {
    const dir = this.config.gdalBinDir.get().trim()
    if (dir.length === 0) return program
    const separator = dir.endsWith('/') || dir.endsWith('\\') ? '' : (process.platform === 'win32' ? '\\' : '/')
    return dir + separator + program + (process.platform === 'win32' ? '.exe' : '')
  }

  /**
   * Report a raster's extent and CRS, straight from GDAL.
   *
   * `gdalinfo -json` is the authority on what a raster IS -- its own
   * georeferencing, not our guess from the file name -- and its `wgs84Extent`
   * is already the EPSG:4326 framing a map needs.
   * @param dataset - the raster dataset.
   * @returns the bbox in EPSG:4326 and a printable CRS line.
   * @throws GisError DATASET_UNREADABLE when GDAL reports no usable extent.
   */
  async rasterInfo(dataset: Dataset): Promise<{ readonly bbox: [number, number, number, number]; readonly crs: string }> {
    const path = sourcePathOf(dataset)
    if (path === undefined) throw new GisError('DATASET_UNREADABLE', 'this dataset has no file to inspect')
    const gdalinfo = await this.resolveBinary('gdalinfo')
    const result = await this.run({
      argv: [gdalinfo, '-json', path],
      cwd: this.ctx.gis.cache.root,
      mode: 'read-only',
      workspaceRoot: this.ctx.gis.cache.root,
    })
    if (result.exitCode !== 0) {
      throw new GisError('DATASET_UNREADABLE', 'gdalinfo could not read ' + basename(path) + ': ' + result.stderr.trim().split('\n').slice(-1)[0])
    }
    const report = JSON.parse(result.stdout) as {
      readonly coordinateSystem?: { readonly wkt?: string }
      readonly wgs84Extent?: { readonly coordinates?: readonly (readonly (readonly number[])[])[] }
    }
    const ring = report.wgs84Extent?.coordinates?.[0] ?? []
    const xs = ring.map(point => point[0]).filter((value): value is number => typeof value === 'number')
    const ys = ring.map(point => point[1]).filter((value: number | undefined): value is number => typeof value === 'number')
    if (xs.length === 0 || ys.length === 0) {
      throw new GisError('CRS_UNKNOWN', 'GDAL reports no WGS84 extent for ' + basename(path), 'reproject it to a geographic CRS, or pass the data as GeoJSON')
    }
    const epsg = /ID\["EPSG",(\d+)\]/u.exec(report.coordinateSystem?.wkt ?? '')
    return {
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      crs: epsg === null ? 'unknown (GDAL gave no EPSG code)' : 'EPSG:' + epsg[1],
    }
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
