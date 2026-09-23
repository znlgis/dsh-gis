/**
 * COG generation (T2.4): a minute-long conversion, bounded, narrating, cancellable.
 *
 * Four requirements shape this file, and each one is a decision:
 *
 * 1. **Check the quota BEFORE spending minutes.** `cache.begin` reserves room and
 *    refuses outright when the artifact could never fit, so the caller gets
 *    `CACHE_QUOTA_EXCEEDED` before GDAL is ever spawned -- the "refuse first,
 *    fail later" rule from design 11.4.
 * 2. **A cache hit is the fast path.** The key is derived from the source's
 *    path, size and mtime plus the conversion parameters, so opening the same
 *    raster twice converts once.
 * 3. **Write to the staging path, commit by rename.** A cancelled or crashed
 *    conversion must never be mistaken for a cache hit.
 * 4. **The progress is GDAL's own.** The child writes `0...10...20...` to its
 *    standard output by default -- as ONE un-terminated line, so it is parsed
 *    from raw chunks rather than lines, and only forward motion is reported.
 *
 * The runner is a seam: production spawns `gdal_translate` under the sandbox,
 * and the tests drive the same orchestration against a real binary.
 */
import { deriveCacheKey, GisError, type CacheIdentity, type DerivedCache, type PendingArtifact } from '@znlgis/dsh-gis-core'
import { basename } from 'node:path'

/** What one conversion produced. */
export interface CogOutcome {
  /** Cache key of the artifact (content-derived). */
  readonly key: string
  /** Absolute path of the COG. */
  readonly path: string
  readonly bytes: number
  /** True when nothing was converted: the artifact was already cached. */
  readonly cached: boolean
}

/** What one `gdal_translate` run reported. */
export interface CogRunResult {
  readonly exitCode: number | null
  readonly stderr: string
  /** False when the child was killed (timeout, or the caller's cancellation). */
  readonly completed: boolean
}

/**
 * One progress report from a running conversion.
 *
 * TWO sources, because neither is sufficient alone:
 *
 * - `percent` comes from GDAL's own progress text -- exact, and what a user
 *   expects to see;
 * - `bytes` comes from the staging file, which grows as GDAL writes it -- and
 *   on Windows it is the ONLY source that moves during the run. GDAL's progress
 *   goes to stdout, a pipe is not a terminal, so the C runtime block-buffers it
 *   (4 KiB): a 41-second conversion of a 1.9 GiB raster delivered its entire
 *   ~60-byte progress line at EXIT. Measured, not assumed -- the M2 exit check
 *   recorded zero progress events while the interface was converting.
 */
export interface CogProgress {
  /** GDAL's own percentage, once its buffered text has arrived. */
  readonly percent?: number
  /** Bytes written to the staging file so far; the platform-independent signal. */
  readonly bytes: number
  /** What the quota was asked to reserve. */
  readonly estimatedBytes: number
}

/** How the conversion is executed; injectable so tests need no sandbox. */
export type CogRunner = (
  argv: readonly string[],
  signal: AbortSignal | undefined,
  /** Raw output text as it arrives; see {@link parseProgress}. */
  onOutputText: (text: string) => void,
) => Promise<CogRunResult>

/** Everything one conversion needs. */
export interface CogRequest {
  /** Absolute path of the source raster. */
  readonly source: string
  /** Source size in bytes; part of the cache key and of the quota estimate. */
  readonly sourceBytes: number
  /** Source mtime in ms; part of the cache key. */
  readonly sourceMtimeMs: number
  /** The `gdal_translate` executable to run. */
  readonly gdalBinary: string
  /** The derived cache that owns the artifact (T1a.10). */
  readonly cache: DerivedCache
  /**
   * An artifact the CALLER already reserved.
   *
   * The tool reserves room before it creates the job, so a request that cannot
   * fit is refused in the same turn instead of surfacing as a failed job
   * minutes later (T2.4: "refuse first, fail later"). When present, this is the
   * reservation the conversion writes into.
   */
  readonly pending?: PendingArtifact
  /** Cancellation, passed through to the child. */
  readonly signal?: AbortSignal
  /** Called as the conversion advances; see {@link CogProgress}. */
  readonly onProgress?: (progress: CogProgress) => void
  /** How often the staging file is measured, in ms. */
  readonly progressIntervalMs?: number
}

/** The cache identity of "the COG of this source". */
export function cogIdentity(request: Pick<CogRequest, 'source' | 'sourceBytes' | 'sourceMtimeMs'>): CacheIdentity {
  return {
    kind: 'cog',
    extension: 'tif',
    source: request.source,
    sourceSize: request.sourceBytes,
    sourceMtimeMs: request.sourceMtimeMs,
    params: { format: 'cog' },
  }
}

/**
 * The argv for one conversion.
 *
 * `-of COG` asks for the cloud-optimized layout; argv is never a shell string
 * (design 3.2).
 *
 * **No `-progress` flag, and that is the whole lesson.** The runbook says "use
 * `gdal_translate -of COG -progress`", but GDAL 3.13.3 REMOVED that flag and
 * answers it with `ERROR 1: Unknown argument: -progress` -- because progress on
 * stdout is now the default (only `-q` turns it off, and `--help` says so: "No
 * progress message is emitted on the standard output"). Copying the flag would
 * have made every conversion fail on a machine where the same command typed by
 * hand works. Verified against the real binary, not the documentation.
 * @param gdalBinary - resolved `gdal_translate` path.
 * @param source - absolute source path.
 * @param target - absolute output path (the cache's staging file).
 * @returns the argv to spawn.
 */
export function buildCogArgv(gdalBinary: string, source: string, target: string): readonly string[] {
  return [gdalBinary, '-of', 'COG', source, target]
}

/**
 * The percentage in one line of GDAL's progress output, when it has one.
 *
 * GDAL writes `0...10...20...` and -- on this platform -- writes it WITHOUT
 * line terminators, flushing as it goes. So the caller feeds raw chunks, not
 * lines, and this answers "how far has it got NOW" for whatever has arrived.
 *
 * The SHAPE check comes first, and it is not decoration: the same stream also
 * carries `Input file size is 1, 1` and error codes, so a parser that took any
 * small number would report 1% progress for the file size and would move the bar
 * on a failure. Progress is numbers joined by `...`, or the final `100 - done.`.
 * @param text - whatever output text has arrived so far.
 * @returns the percentage, or undefined when this text holds no progress.
 */
export function parseProgress(text: string): number | undefined {
  if (!/\.\.\.|- done\./u.test(text)) return undefined
  let best: number | undefined
  for (const match of text.matchAll(/\d+/gu)) {
    const value = Number(match[0])
    if (Number.isFinite(value) && value >= 0 && value <= 100 && (best === undefined || value > best)) best = value
  }
  return best
}

/**
 * How much room to reserve before converting.
 *
 * A COG is a re-encoded GeoTIFF plus overviews, so it can exceed its source;
 * the estimate is therefore the source size with a floor, and `commit` checks
 * the REAL size afterwards. The point of the estimate is to refuse hopeless
 * requests before GDAL starts, not to predict bytes.
 * @param sourceBytes - size of the source raster.
 * @returns the bytes to reserve.
 */
export function estimateCogBytes(sourceBytes: number): number {
  return Math.max(sourceBytes, 4 * 1024 * 1024)
}

/**
 * Convert a raster into the derived cache, or return the cached conversion.
 * @param request - source, cache, and the cancellation/progress channels.
 * @param run - how to execute `gdal_translate` (the production runner confines it).
 * @returns the artifact's key, path and size.
 * @throws GisError `CACHE_QUOTA_EXCEEDED` before spawning when it cannot fit.
 * @throws GisError `DATASET_UNREADABLE` when the conversion fails.
 */
export async function convertToCog(request: CogRequest, run: CogRunner): Promise<CogOutcome> {
  const identity = cogIdentity(request)
  const key = deriveCacheKey(identity)

  const hit = await request.cache.resolve(key)
  if (hit !== undefined) return { key, path: hit.path, bytes: hit.bytes, cached: true }

  // Throws before any process starts: this is the "refuse first" half of T2.4.
  // A caller that already reserved (the tool does, before starting the job)
  // hands its reservation in instead of reserving twice.
  const pending = request.pending ?? await request.cache.begin(identity, estimateCogBytes(request.sourceBytes))

  // Report only FORWARD motion: GDAL's buffer re-sends its prefix with every
  // flush, so a naive parser would announce 10% three times and the interface
  // would look stuck while the conversion was fine.
  const estimatedBytes = estimateCogBytes(request.sourceBytes)
  let percent = -1
  let bytes = 0
  const report = (): void => { request.onProgress?.({ ...percent < 0 ? {} : { percent }, bytes, estimatedBytes }) }

  // The staging file is the signal that actually moves while the child runs (see
  // CogProgress). It is polled, not watched: one timestamp compare per tick is
  // cheaper than an fs.watch handle per conversion, and a missed tick costs one
  // progress line, never correctness.
  const poller = setInterval(() => {
    void sizeOf(pending.staging).then((size) => {
      if (size > bytes) {
        bytes = size
        report()
      }
    })
  }, request.progressIntervalMs ?? 1000)

  let result: CogRunResult
  try {
    result = await run(buildCogArgv(request.gdalBinary, request.source, pending.staging), request.signal, (text) => {
      const seen = parseProgress(text)
      if (seen !== undefined && seen > percent) {
        percent = seen
        report()
      }
    })
  } catch (error) {
    clearInterval(poller)
    // Whatever went wrong, the half-written artifact must not look cached.
    await request.cache.abort(identity)
    throw error
  }
  clearInterval(poller)

  if (result.exitCode !== 0 || !result.completed) {
    await request.cache.abort(identity)
    const reason = result.completed ? 'exit code ' + String(result.exitCode) : 'the conversion was stopped'
    throw new GisError(
      'DATASET_UNREADABLE',
      'converting ' + basename(request.source) + ' to COG failed (' + reason + '): ' + tailOf(result.stderr),
      'check gis_doctor for a usable GDAL, or read the raster through a vector path instead',
    )
  }

  const entry = await request.cache.commit(identity)
  return { key: entry.key, path: entry.path, bytes: entry.bytes, cached: false }
}

/** The size of a file, or zero while it does not exist yet. */
async function sizeOf(path: string): Promise<number> {
  const { stat } = await import('node:fs/promises')
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** The last non-empty line of a tool's stderr, for a one-line diagnosis. */
function tailOf(stderr: string): string {
  const lines = stderr.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0)
  return lines.length === 0 ? 'no output' : (lines[lines.length - 1] ?? 'no output')
}
