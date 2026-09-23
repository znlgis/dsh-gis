/**
 * Client-bundle contract check (T0.4 artifact contract, extended by T2.1).
 *
 * The client half is a classic script with a lazy-chunk protocol, and NOTHING
 * in it fails loudly at runtime: a static require of a chunk, a library that
 * leaks into the first screen, a stylesheet hoisted across the eager/lazy
 * boundary -- all of them look fine in a build log and break only in a browser.
 * So they are asserted here, against the built artifacts.
 *
 * Run after `pnpm build`: `node scripts/check-client-bundle.mjs`.
 * (It reads `lib/`, which is a build output, so it is deliberately not part of
 * `pnpm test` on a clean checkout.)
 */
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'packages', 'ui-gis', 'lib')
const failures = []

/** Record one assertion. */
function check(condition, message, detail = '') {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + message + (condition || detail === '' ? '' : ' -- ' + detail))
  if (!condition) failures.push(message)
}

/** Every `client*.js` the build emitted, keyed by file name. */
async function readChunks() {
  const names = (await readdir(LIB)).filter(name => name === 'client.js' || /^client\..*\.js$/.test(name))
  const chunks = new Map()
  for (const name of names) chunks.set(name, await readFile(join(LIB, name), 'utf8'))
  return chunks
}

/** Synchronous requires of a sibling chunk: the protocol forbids all of them. */
const staticChunkRequires = (code) => [...code.matchAll(/require\((['"])(\.\/client\.[^'"]*)\1\)/g)].map(m => m[2])

/** Asynchronous chunk fetches, i.e. what the preset rewrote `import()` into. */
const asyncChunkRequires = (code) => [...code.matchAll(/require\.async\((['"])(\.\/client\.[^'"]*)\1\)/g)].map(m => m[2])

const chunks = await readChunks()
const entry = chunks.get('client.js')

console.log('chunks: ' + [...chunks.entries()].map(([name, code]) => name + ' (' + String(code.length) + 'B)').join(', '))

check(entry !== undefined, 'the entry chunk lib/client.js exists')
if (entry === undefined) {
  console.log('\nFAILED: ' + String(failures.length))
  process.exit(1)
}

// 1. The loader handshake: a classic script registering a lazy CJS factory.
check(/__ModuleLoader__\.load\(/.test(entry), 'the entry registers through window.__ModuleLoader__.load')
check(/id:\s*['"]@znlgis\/dsh-ui-gis['"]/.test(entry), 'the entry declares its module id')
check(/factory:/.test(entry), 'the entry hands the loader a factory')

// 2. No chunk may be required synchronously -- from the entry or from any chunk.
for (const [name, code] of chunks) {
  const offenders = staticChunkRequires(code)
  check(offenders.length === 0, name + ' has no synchronous require of a chunk', offenders.join(', '))
}

// 3. The eager graph must not carry MapLibre. These two markers only exist in
//    the library (the blob-worker bootstrap and its banner), so their presence
//    in the entry means a static import crept into the first screen.
const MAPLIBRE_MARKERS = ['setWorkerUrl', 'createObjectURL(new Blob']
const entryMarkers = MAPLIBRE_MARKERS.filter(marker => entry.includes(marker))
check(entryMarkers.length === 0, 'the entry chunk carries no MapLibre code', entryMarkers.join(', '))

// 4. The lazy surfaces are reached through require.async.
const entryAsync = asyncChunkRequires(entry)
check(entryAsync.includes('./client.GisRenderCard.js'), 'the map card chunk is reached with require.async from the entry', entryAsync.join(', '))
check(entryAsync.includes('./client.GisDetailRow.js'), 'the M0 detail chunk is still reached with require.async')

// 5. The card chunk carries the card, the shared map component and the layer
//    model, and reaches the LIBRARY through require.async in turn (two lazy
//    hops, one per concern: the card's code, then a 1.5 MB dependency).
const cardChunk = chunks.get('client.GisRenderCard.js')
check(cardChunk !== undefined, 'the map card chunk lib/client.GisRenderCard.js exists')
if (cardChunk !== undefined) {
  const cardAsync = asyncChunkRequires(cardChunk)
  check(cardAsync.includes('./client.maplibre.js'), 'the card chunk reaches MapLibre with require.async', cardAsync.join(', '))
  check(cardChunk.includes('data-gis-render-card'), 'the card chunk contains the gis_render card')
  check(cardChunk.includes('data-gis-map'), 'the card chunk contains the shared map component')
  check(cardChunk.includes('data-plugin-css'), 'the card chunk injects its own stylesheets (own <style data-plugin-css>)')
  check(/maplibregl-|\.maplibregl/.test(cardChunk), 'the MapLibre stylesheet travels with the card chunk')
}

// 5b. No ORPHAN chunks. The client build runs with `clean: false` (a default
//     clean would wipe the node half sharing `lib/`), so a chunk whose module
//     left the graph would linger in lib/, be published, and be servable by the
//     loader. Reachability from the entry is the property that matters.
const reachable = new Set(['client.js'])
const queue = ['client.js']
while (queue.length > 0) {
  const name = queue.pop()
  for (const target of asyncChunkRequires(chunks.get(name) ?? '')) {
    const file = target.slice(2)
    if (!reachable.has(file)) {
      reachable.add(file)
      queue.push(file)
    }
  }
}
const orphans = [...chunks.keys()].filter(name => !reachable.has(name))
check(orphans.length === 0, 'every chunk is reachable from the entry', orphans.join(', '))

// 6. The library chunk is the self-contained 5.x build: it inlines its worker as
//    a blob instead of fetching a sibling file (runtime contract #22 -- this is
//    the whole reason the dependency is pinned to 5.x).
const library = chunks.get('client.maplibre.js')
check(library !== undefined, 'the MapLibre chunk lib/client.maplibre.js exists')
if (library !== undefined) {
  check(library.includes('setWorkerUrl'), 'the MapLibre build installs its own worker URL')
  check(library.includes('createObjectURL(new Blob'), 'the worker is inlined as a blob object URL')
  check(!library.includes('maplibre-gl-worker.mjs'), 'the build does not fetch a sibling worker file')
  check(library.length > 500_000, 'the library really is in this chunk (' + String(library.length) + 'B)')
}

console.log(failures.length === 0 ? '\nCLIENT BUNDLE CONTRACT OK' : '\nFAILED: ' + String(failures.length))
process.exit(failures.length === 0 ? 0 : 1)
