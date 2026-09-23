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

/** Drain one piped stream to a string. */
async function collect(stream: unknown): Promise<string> {
  if (stream === null || stream === undefined) return ''
  const readable = stream as AsyncIterable<Uint8Array | string>
  const chunks: string[] = []
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
  }
  return chunks.join('')
}
