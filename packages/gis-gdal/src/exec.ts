/**
 * Running an external GIS tool.
 *
 * Two rules, both learned the hard way:
 *
 * 1. argv is NEVER shell-interpreted. A path with a space or a quote is a path,
 *    not syntax. (This is why the design uses `spawn` and not `ctx.shell`.)
 * 2. `cwd` is ALWAYS passed. Omitting it makes `subprocess.spawn` throw
 *    `TypeError: Cannot read properties of undefined (reading 'includes')` from
 *    a null-byte check that runs before anything useful -- an error message that
 *    says nothing about the real mistake (M0 finding).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConfinedSandboxMode } from '@deepseek-ai/dsh-sandbox'
// TYPE-ONLY: brings `ctx.subprocess` into the program; erased at build time.
import type {} from '@deepseek-ai/dsh-subprocess'

/** One execution request. */
export interface RunRequest {
  /** Program plus arguments; never a shell string. */
  readonly argv: readonly string[]
  /** Absolute working directory; required. */
  readonly cwd: string
  /**
   * The child environment, already resolved by the caller.
   *
   * A string is a deliberate value that survives the credential scrub;
   * `undefined` is a TOMBSTONE that removes an ambient entry. Both semantics
   * are verified behaviour, not guesses.
   */
  readonly env: Readonly<Record<string, string | undefined>>
  /** How long the child may run before it is killed. */
  readonly timeoutMs: number
  /** File-effect mode for this call. */
  readonly mode: ConfinedSandboxMode
  /** Absolute root `workspace-write` may write under. */
  readonly workspaceRoot: string
}

/** What one execution produced. */
export interface RunResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  /** False when the child hit the timeout. */
  readonly completed: boolean
  /** How completely the backend enforces the policy's file effects. */
  readonly enforcement: string
}

/**
 * Run one external tool under the sandbox.
 * @param ctx - context carrying `sandbox` and `subprocess`.
 * @param request - what to run and under what policy.
 * @returns the captured result.
 */
export async function runConfined(ctx: Context, request: RunRequest): Promise<RunResult> {
  const confined = await ctx.sandbox.confine(request.argv, {
    mode: request.mode,
    workspaceRoot: request.workspaceRoot,
  })

  const child = ctx.subprocess.spawn({
    argv: confined.argv,
    cwd: request.cwd,
    env: request.env,
    // This seam applies NO defaults: every stream must be stated.
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: request.timeoutMs,
  })

  const [stdout, stderr] = await Promise.all([collect(child.stdout), collect(child.stderr)])
  // `done` resolves with the spawned command's exit facts; piped streams are
  // ours to drain, which is why collection above runs concurrently.
  const outcome = await child.done
  return {
    exitCode: outcome.exitCode ?? null,
    stdout,
    stderr,
    completed: outcome.signal === null || outcome.signal === undefined,
    enforcement: confined.enforcement,
  }
}

/** One execution request that can be cancelled and narrates itself. */
export interface StreamRequest extends RunRequest {
  /**
   * Cancellation. Passed straight to the subprocess seam, which escalates from
   * a polite signal to a forced kill over its managed range -- so a cancelled
   * conversion really stops converting (T2.4's `取消`).
   */
  readonly signal?: AbortSignal
  /** Called once per complete stderr line, as it arrives. */
  readonly onStderrLine?: (line: string) => void
  /** Called once per complete stdout line, as it arrives. */
  readonly onStdoutLine?: (line: string) => void
  /**
   * Called with raw output TEXT as it arrives, before any line splitting.
   *
   * This is what a progress parser needs, and the reason is GDAL: it writes
   * `0...10...20...30...` WITHOUT line terminators, flushing as it goes. A
   * line-based consumer sees one line at the end -- so the interface shows 0%
   * then 100% and nothing in between, which is not "progress" at all (found by
   * the M2 exit check, whose probe recorded exactly one progress event).
   */
  readonly onOutputChunk?: (text: string) => void
}

/**
 * Run one external tool, streaming its output as it arrives.
 *
 * `runConfined` answers "what did the tool say"; a minute-long conversion needs
 * "what is it saying NOW" plus a way to stop it, which is this function. Lines
 * are delivered as they are produced (the progress parser is the caller's),
 * and the same drained strings are returned so the final diagnostics survive.
 * @param ctx - context carrying `sandbox` and `subprocess`.
 * @param request - what to run, under what policy, and who to tell.
 * @returns the captured result.
 */
export async function runStreaming(ctx: Context, request: StreamRequest): Promise<RunResult> {
  const confined = await ctx.sandbox.confine(request.argv, {
    mode: request.mode,
    workspaceRoot: request.workspaceRoot,
  })

  const child = ctx.subprocess.spawn({
    argv: confined.argv,
    cwd: request.cwd,
    env: request.env,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: request.timeoutMs,
    ...request.signal === undefined ? {} : { signal: request.signal },
  })

  // Both pipes must be drained while the child runs: with 'pipe' the streams are
  // ours, and a full pipe would deadlock the child before `done` ever settles.
  const [stdout, stderr] = await Promise.all([
    collect(child.stdout, request.onStdoutLine, request.onOutputChunk),
    collect(child.stderr, request.onStderrLine, request.onOutputChunk),
  ])
  const outcome = await child.done
  return {
    exitCode: outcome.exitCode ?? null,
    stdout,
    stderr,
    completed: outcome.signal === null || outcome.signal === undefined,
    enforcement: confined.enforcement,
  }
}

/**
 * Drain one piped stream to a string, optionally handing out complete lines.
 *
 * "Complete" is the point: GDAL's `-progress` writes `0...10...20...` without
 * newlines, and a parser fed half a number reports a wrong percentage. The
 * remainder stays buffered until the stream ends.
 * @param stream - the piped stream, or nothing.
 * @param onLine - receiver for each complete line, without its terminator.
 * @param onChunk - receiver for the raw text, before it is split into lines.
 * @returns everything the stream produced.
 */
async function collect(stream: unknown, onLine?: (line: string) => void, onChunk?: (text: string) => void): Promise<string> {
  if (stream === null || stream === undefined) return ''
  const readable = stream as AsyncIterable<Uint8Array | string>
  const chunks: string[] = []
  let pending = ''
  for await (const chunk of readable) {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    chunks.push(text)
    onChunk?.(text)
    if (onLine === undefined) continue
    pending += text
    let at = pending.search(/\r|\n/u)
    while (at >= 0) {
      const line = pending.slice(0, at)
      pending = pending.slice(at + (pending[at] === '\r' && pending[at + 1] === '\n' ? 2 : 1))
      if (line.length > 0) onLine(line)
      at = pending.search(/\r|\n/u)
    }
  }
  if (onLine !== undefined && pending.length > 0) onLine(pending)
  return chunks.join('')
}
