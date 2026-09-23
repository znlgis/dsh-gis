/**
 * Remove client chunks from a previous build.
 *
 * The client preset runs with `clean: false` on purpose (a default clean would
 * wipe the node half that tsc just wrote into the same directory), so a chunk
 * whose module left the graph -- a module that stopped being shared, a renamed
 * component -- would otherwise stay in `lib/` forever, be served by the loader,
 * and be published by `files: ['lib/client.*.js']`.
 *
 * Run before every client build: `node scripts/clean-client-chunks.mjs`.
 */
import { readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'packages')

let removed = 0
for (const entry of await readdir(ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const lib = join(ROOT, entry.name, 'lib')
  let files
  try {
    files = await readdir(lib)
  } catch {
    continue
  }
  for (const file of files) {
    if (!/^client\..*\.js(\.map)?$/.test(file)) continue
    await rm(join(lib, file), { force: true })
    removed += 1
  }
}
console.log('removed ' + String(removed) + ' stale client chunk file(s)')
