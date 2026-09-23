/**
 * Boot a throwaway DSH instance for verification.
 *
 * Every check in this directory needs the same thing: a real instance of the
 * real profile, on its own port, with EVERY piece of state (session store,
 * storage root, derived cache) redirected into a temporary directory, so a
 * verification run cannot touch the profile a user is working in. The instance
 * is returned with the tokenized URL it announces and a stop() that kills it.
 *
 * The page is behind a connection token (\`?token=...\`): the bare origin refuses
 * requests, and the token exists only in the line the instance prints, so the
 * URL is READ from the log rather than guessed.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** POSIX-style slashes: YAML accepts them on Windows. */
export const slashes = path => path.replace(/\\/g, '/')

/** Where the DSH entry point lives; override for another checkout. */
export const DSH_BIN = process.env.DSH_BIN ?? 'D:/self/code/deepseek-harness/apps/cli/lib/bin.js'

/**
 * Create the work directory and the isolation overlay.
 * @param options - profile, port, and any extra patch lines to append.
 * @returns the work directory and the patch path.
 */
export async function prepareWorkdir(options) {
  const work = await mkdtemp(join(tmpdir(), options.prefix ?? 'gis-verify-'))
  await mkdir(join(work, 'data'), { recursive: true })
  const lines = [
    '# Verification overlay: a second instance with all of its state redirected.',
    '- id: storage-json',
    '  config:',
    '    root: ' + slashes(join(work, 'storages')),
    '- id: session-persistence-jsonl',
    '  config:',
    '    root: ' + slashes(join(work, 'sessions')),
    '- id: gis-core',
    '  config:',
    '    cacheDir: ' + slashes(join(work, 'cache')),
    // Small by default: most checks want the quota to be visible and cheap. The
    // COG exit check raises it, because its estimate is the SOURCE size.
    '    cacheQuotaMb: ' + String(options.cacheQuotaMb ?? 64),
    '- id: webserver',
    '  config:',
    "    host: '127.0.0.1'",
    '    port: ' + String(options.port),
    ...options.extraPatch ?? [],
    '',
  ]
  const patch = join(work, 'patch.yml')
  await writeFile(patch, lines.join('\n'))
  return { work, patch }
}

/**
 * Boot the instance and wait for it to announce its URL.
 * @param options - work directory, patch, profile, and readiness timeout.
 * @returns the tokenized URL, the log path, and the child process.
 */
export async function bootInstance(options) {
  const log = join(options.work, 'instance.log')
  const stream = (await import('node:fs')).createWriteStream(log)
  const child = spawn(process.execPath, [
    DSH_BIN, '--profile', options.profile ?? 'gisweb',
    '--patch', options.patch,
    // Otherwise the instance launches the user's default browser at a page
    // nobody asked for.
    '--no-open',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...options.env ?? {} } })
  child.stdout.pipe(stream)
  child.stderr.pipe(stream)

  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  let url
  for (;;) {
    if (existsSync(log)) {
      const announced = /dsh web: (http:\/\/\S+)/.exec(await readFile(log, 'utf8'))
      if (announced !== null) {
        url = announced[1]
        break
      }
    }
    if (Date.now() > deadline) break
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return {
    url,
    log,
    child,
    /** Kill the instance and settle once its log is complete. */
    async stop() {
      child.kill()
      await new Promise(resolve => setTimeout(resolve, 500))
      stream.close()
    },
    /** The instance log so far, for diagnostics. */
    async tail(lines = 25) {
      if (!existsSync(log)) return ''
      return (await readFile(log, 'utf8')).split('\n').filter(Boolean).slice(-lines).join('\n')
    },
  }
}
