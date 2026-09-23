/**
 * Flatten cross-chunk SYNCHRONOUS requires out of the client bundles.
 *
 * WHY THIS EXISTS
 *
 * The client module loader resolves `require(spec)` against the platform seed
 * table and the modules it has ALREADY materialized. A chunk that synchronously
 * requires a SIBLING CHUNK therefore only works if that sibling happens to be
 * loaded first -- and nothing guarantees the order. Rolldown emits exactly that
 * shape whenever two or more dynamic chunks share a module: the shared module
 * becomes its own chunk and each user requires it synchronously.
 *
 * What that looks like in production (measured, not theorized): our MapLibre
 * chunk began with
 *
 *     const require_rolldown_runtime = require("./client.rolldown-runtime.js");
 *
 * and the loader answered
 *
 *     client-modules: require("./client.rolldown-runtime.js") missed the module
 *     table — not a platform seed word, not a materialized module, and no
 *     registered package factory
 *
 * so the map chunk threw while loading and the card showed that sentence. It was
 * invisible until the kernel moved (0.1.7-rc.1) and the shell stopped providing
 * that chunk out of band.
 *
 * WHAT IT DOES
 *
 * For every chunk that some other chunk synchronously requires, it inlines that
 * chunk's factory body into each requirer, replacing the require with the
 * inlined module object, then deletes the chunk IF nothing else needs it as a
 * file (a chunk that is also fetched with `require.async` stays: that path is
 * legitimate and the loader handles it).
 *
 * The result is the property the loader actually requires: **no chunk requires
 * another chunk synchronously**. `scripts/check-client-bundle.mjs` asserts it.
 *
 * Run after every client build: `node scripts/flatten-client-chunks.mjs`.
 */
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'packages')

/** The factory body of a chunk file, without its registration banner/footer. */
function factoryBodyOf(text) {
  const start = text.indexOf('factory: (require) => {')
  if (start < 0) return undefined
  const bodyStart = start + 'factory: (require) => {'.length
  const end = text.lastIndexOf('return module.exports;')
  if (end < 0 || end < bodyStart) return undefined
  return text.slice(bodyStart, end)
}

/** Every sibling chunk this file requires synchronously. */
function syncTargets(text) {
  return [...new Set([...text.matchAll(/require\("(\.\/client\.[^"]+\.js)"\)/gu)].map(match => match[1].slice(2)))]
}

/** Every sibling chunk this file loads asynchronously (those must stay files). */
function asyncTargets(text) {
  return new Set([...text.matchAll(/require\.async\("(\.\/client\.[^"]+\.js)"\)/gu)].map(match => match[1].slice(2)))
}

let inlinedTotal = 0
let deletedTotal = 0

for (const entry of await readdir(ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const lib = join(ROOT, entry.name, 'lib')
  let files
  try {
    // The ENTRY is `client.js` (no dot-name) and it MUST be scanned: it is the
    // file that async-loads the card chunk, so leaving it out made the flattener
    // treat the card as unreferenced and DELETE it -- the entry then asked for a
    // chunk that no longer existed. `check:bundle` caught it as "every chunk is
    // reachable from the entry".
    files = (await readdir(lib)).filter(name => /^client(?:\..*)?\.js$/u.test(name) && !name.endsWith('.map'))
  } catch {
    continue
  }
  const text = new Map()
  for (const file of files) text.set(file, await readFile(join(lib, file), 'utf8'))

  // Which files are synchronously required anywhere, and by whom.
  const requiredBy = new Map()
  for (const [file, code] of text) {
    for (const target of syncTargets(code)) {
      if (!text.has(target)) continue
      const list = requiredBy.get(target) ?? new Set()
      list.add(file)
      requiredBy.set(target, list)
    }
  }
  if (requiredBy.size === 0) continue

  // A chunk that is ALSO fetched with require.async keeps its file: that path is
  // legitimate, and the loader resolves it by name.
  const fetchedByName = new Set()
  for (const code of text.values()) for (const target of asyncTargets(code)) fetchedByName.add(target)

  /**
   * A chunk that loads other chunks is a DISPATCHER, not a leaf.
   *
   * Inlining one duplicates a whole dynamic graph into its requirer (and can
   * graft a self-reference), so only leaves are inlined -- the shared runtime
   * helpers, a decoder base class, an inflate library. Dispatch chunks keep
   * their files, exactly like `require.async` targets.
   */
  const isDispatcher = (file) => {
    const code = text.get(file) ?? ''
    return /require\.async\("/u.test(code)
  }

  // Inline in dependency order: a target may itself require other targets, and
  // its own body must be flattened first.
  const resolved = new Map()
  const resolving = new Set()
  /** The inlined initializer expression for one chunk file. */
  const initializerFor = (file) => {
    const cached = resolved.get(file)
    if (cached !== undefined) return cached
    if (resolving.has(file)) return undefined
    resolving.add(file)
    let body = factoryBodyOf(text.get(file) ?? '')
    if (body === undefined) {
      resolving.delete(file)
      return undefined
    }
    // Flatten the target's own synchronous requires first.
    for (const dependency of syncTargets(body)) {
      const nested = initializerFor(dependency)
      if (nested === undefined) continue
      body = body.split('require("' + './' + dependency + '")').join(nested.name)
    }
    resolving.delete(file)
    const name = '__inlined_' + file.replace(/[^A-Za-z0-9]/gu, '_')
    const expression = '(() => { var module = { exports: {} }; var exports = module.exports;'
      + body + '; return module.exports; })()'
    const entryValue = { name, declaration: 'const ' + name + ' = ' + expression + ';' }
    resolved.set(file, entryValue)
    return entryValue
  }

  for (const [file, requesters] of requiredBy) {
    if (isDispatcher(file)) continue
    const initializer = initializerFor(file)
    if (initializer === undefined) continue
    let inlinedInto = 0
    for (const requester of requesters) {
      let code = text.get(requester) ?? ''
      const spec = 'require("' + './' + file + '")'
      if (!code.includes(spec)) continue
      code = code.split(spec).join(initializer.name)
      // The declaration goes right after the factory opens, before any use.
      const marker = 'factory: (require) => {'
      const at = code.indexOf(marker)
      if (at < 0) continue
      code = code.slice(0, at + marker.length) + '\n' + initializer.declaration + code.slice(at + marker.length)
      text.set(requester, code)
      inlinedInto += 1
    }
    inlinedTotal += inlinedInto
    // Delete the file only when nothing needs it as a file any more.
    if (inlinedInto > 0 && !fetchedByName.has(file)) {
      const stillReferenced = [...text.entries()].some(([other, code]) => other !== file && syncTargets(code).includes(file))
      if (!stillReferenced) {
        await rm(join(lib, file), { force: true })
        await rm(join(lib, file + '.map'), { force: true })
        text.delete(file)
        deletedTotal += 1
      }
    }
  }

  // Write what changed.
  for (const [file, code] of text) await writeFile(join(lib, file), code)
}

console.log('flattened ' + String(inlinedTotal) + ' cross-chunk require(s); removed ' + String(deletedTotal) + ' chunk file(s)')
