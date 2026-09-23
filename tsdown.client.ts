/**
 * Client plugin bundle preset, replicated from DSH
 * `packages/client/tsdown.client.ts` (MIT) for use outside that repository.
 *
 * WHY THIS FILE EXISTS: the DSH preset is not published to npm, and it imports
 * four repository-internal modules. An out-of-repo plugin therefore has to
 * reproduce the artifact contract itself. See docs/方案设计.md 3.7.
 *
 * ARTIFACT CONTRACT REPLICATED HERE
 *  - classic script (NOT an ES module) registering a lazy-CJS factory:
 *      window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *  - externals are exactly the shell's frozen platform module table
 *      (`./platform.ts`), plus any `dsh.client.external` the package declares;
 *    everything else is inlined;
 *  - `import()` inside plugin source becomes `require.async('./client.<name>.js')`
 *    and therefore a separately fetched chunk;
 *  - CSS is compiled by lightningcss *inside* the bundle: `x.module.css` yields a
 *    hashed class map plus an injected `<style data-plugin data-plugin-css>` tag,
 *    plain `x.css` is injected as a plugin-owned tag, `x.css?inline` exports text;
 *  - build-time bundle purity gate: a cross-plugin `@deepseek-ai/*` *value* import
 *    is a build error (type-only imports are erased and never reach the gate).
 *
 * DELIBERATELY NOT REPLICATED (and the consequence)
 *  - the host/client two-face build system (`DSH_BUILD_FACE`) — this preset builds
 *    only the browser half, straight from `src/`; the node half uses a normal
 *    tsdown config per package;
 *  - `tscSourceMapPlugin()` sourcemap chaining through `lib/types` — irrelevant
 *    while the entry is `src/client/index.ts`; revisit if we switch to the
 *    lib/types entry used in-repo;
 *  - `clientInputIsolation()` and the pnpm-workspace manifest reader — repo-specific
 *    gates. Losing them means we lose two build-time guards, not correctness;
 *  - the `staticLinked()` channel — a third-party plugin must use the dynamic
 *    module-table channel only.
 */
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { Rolldown, type TsdownPlugin, type UserConfig } from 'tsdown'
import { transform } from 'lightningcss'
import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from './platform.ts'

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const INLINE_CSS_VIRTUAL_PREFIX = '\0dsh-inline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'

/** Emit one plugin-owned style injector and an optional CSS Modules export. */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basenameFrom(fileId)}`)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** Basename without importing node:path twice. */
function basenameFrom(file: string): string {
  const at = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return at < 0 ? file : file.slice(at + 1)
}

/** Contract layers and pure folds a client bundle may inline (copied from DSH). */
export const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|deque|output-retention|typert-protocol|util-crypto|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-token-meter\/client$|@deepseek-ai\/dsh-native-command\/types$|@deepseek-ai\/dsh-host-open-in-app\/shared$|@deepseek-ai\/dsh-plugin-manager\/registry$|@deepseek-ai\/dsh-agent-preset-registry\/display$|@deepseek-ai\/dsh-spill-policy\/notice$)/

/** Vendored framework libraries: no cross-plugin runtime identity to share. */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/** Escape a package name for literal use inside a RegExp source. */
function escapeSpecifier(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Resolve a stylesheet import against its physical source file. */
function sourceAssetPath(source: string, importer: string): string {
  if (!source.startsWith('.') && !isAbsolute(source)) return createRequire(importer).resolve(source)
  return resolvePath(dirname(importer), source)
}

/**
 * Dependencies whose package exports prefer a NODE build over the browser one.
 *
 * `exports` conditions are matched in the ORDER THE PACKAGE LISTS THEM, not in
 * the order this preset asks for them -- and geotiff lists `import` before
 * `browser`, so a client bundle gets `dist-module/geotiff.js`, which reaches
 * `http` through `web-worker`. In a browser plugin that is fatal and LOUD but
 * cryptic:
 *
 *     client-modules: require("http") missed the module table — not a platform
 *     seed word, not a materialized module, and no registered package factory
 *
 * The package ships a self-contained UMD browser bundle next to it, so this
 * points the specifier at that file. Verified: the UMD has no `http` and no
 * worker references at all.
 *
 * Add an entry here only with the same evidence -- a resolution that actually
 * picked a Node build for a browser bundle.
 */
const BROWSER_BUILD_PREFERENCE: Readonly<Record<string, string>> = {
  geotiff: 'dist-browser/geotiff.js',
}

/** Replace a specifier with its package's browser build, when one is declared. */
function browserBuildRedirect(source: string): string | undefined {
  const relative = BROWSER_BUILD_PREFERENCE[source]
  if (relative === undefined) return undefined
  try {
    const resolved = createRequire(import.meta.url).resolve(source)
    const dir = resolved.replace(/[\\/]dist-[^\\/]+[\\/][^\\/]+$/u, '')
    const candidate = dir + '/' + relative
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

/** Render package-local dynamic imports through the loader's asynchronous operation. */
function asyncChunkRequirePlugin(): TsdownPlugin {
  return {
    name: 'dsh-client-async-chunk-require',
    renderChunk(code, chunk, outputOptions) {
      if (outputOptions.format !== 'cjs') return null
      const transformed = new Rolldown.RolldownMagicString(code)
      for (const dynamicImport of chunk.dynamicImports) {
        const fileName = dynamicImport.startsWith('./') ? dynamicImport.slice(2) : dynamicImport
        if (!/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(fileName)) continue
        const specifier = `./${fileName}`
        const call = new RegExp(
          `Promise\\.resolve\\(\\)\\.then\\(\\(\\)\\s*=>\\s*require\\((['"])${escapeSpecifier(specifier)}\\1\\)\\)`,
          'gu',
        )
        const matches = [...code.matchAll(call)]
        if (matches.length === 0) {
          throw new Error(`client bundle compiler: dynamic chunk ${JSON.stringify(specifier)} has no generated import expression`)
        }
        for (const match of matches) {
          transformed.overwrite(match.index, match.index + match[0].length, `require.async(${JSON.stringify(specifier)})`)
        }
      }
      return transformed.hasChanged() ? transformed : null
    },
  }
}

/** Options for {@link clientBundle}. */
export interface ClientBundleOptions {
  /** Client entry relative to the package root; defaults to `src/client/index.ts`. */
  readonly entry?: string
  /** Extra module-table requests beyond the platform baseline. */
  readonly externals?: readonly string[]
  /** Directory the package.json is read from; defaults to `process.cwd()`. */
  readonly dir?: string
  /**
   * tsc output for the node half, relative to the package root.
   * Defaults to `lib/types/index.js`; set `null` for a client-only package.
   */
  readonly libEntry?: string | null
}

/** Read the package's declared `dsh.client.external` requests. */
function declaredExternals(dir: string): readonly string[] {
  const manifest = JSON.parse(readFileSync(resolvePath(dir, 'package.json'), 'utf8')) as {
    dsh?: { client?: { external?: string[] } }
  }
  return manifest.dsh?.client?.external ?? []
}

/**
 * Build the tsdown config for one client plugin bundle.
 * @param id - plugin id (package name), stamped into the loader handoff and style tags.
 * @param options - entry, extra externals, and the package directory.
 * @returns the tsdown config for the browser half.
 */
function browserHalf(id: string, options: ClientBundleOptions = {}): UserConfig {
  const dir = options.dir ?? process.cwd()
  const externals = new Set<string>([
    ...PLATFORM_MODULES,
    ...PRELOADED_CLIENT_EXTERNALS,
    ...(options.externals ?? declaredExternals(dir)),
  ])
  const isRequested = (specifier: string): boolean => externals.has(specifier)
  const entry = options.entry ?? 'src/client/index.ts'

  if (!isAbsolute(entry) && !existsSync(resolvePath(dir, entry))) {
    throw new Error(`clientBundle: entry ${entry} not found under ${dir}`)
  }

  return {
    name: `${id}/client`,
    entry: { client: entry },
    cwd: dir,
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    inputOptions: {
      resolve: {
        conditionNames: [
          (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
          'browser', 'import', 'module', 'default',
        ],
      },
    },
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [
      {
        name: 'dsh-client-browser-build',
        resolveId(source: string) {
          return browserBuildRedirect(source) ?? null
        },
      },
      {
        name: 'dsh-client-bundle-purity',
        resolveId(source: string) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (isRequested(source)) return null
          if (VENDORED_LIBRARY.test(source)) return null
          if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
          throw new Error(
            `client bundle purity: "${source}" is not in the default client externals or ${id}'s dsh.client.external, an inline-safe wire layer, or a generated /remote contribution — `
            + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
            + '(type-only imports are erased and never reach this gate)',
          )
        },
      },
      asyncChunkRequirePlugin(),
      {
        name: 'dsh-css-modules-inline',
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith('.module.css')) return null
          const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
          return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
        },
        async load(virtualId: string) {
          if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
          const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
          this.addWatchFile(fileId)
          const source = await readFile(fileId)
          const { code, exports: cssExports } = transform({
            filename: fileId, code: source, cssModules: { pattern: '[hash]_[local]' }, minify: true,
          })
          const classMap: Record<string, string> = {}
          const exportEntries = Object.entries(cssExports ?? {})
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          for (const [local, exp] of exportEntries) classMap[local] = exp.name
          return styleInjectionModule(id, fileId, code.toString(), classMap)
        },
      },
      {
        name: 'dsh-css-text-inline',
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
          const stylesheet = source.slice(0, -INLINE_CSS_QUERY.length)
          const abs = importer !== undefined ? sourceAssetPath(stylesheet, importer) : stylesheet
          return INLINE_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
        },
        async load(virtualId: string) {
          if (!virtualId.startsWith(INLINE_CSS_VIRTUAL_PREFIX)) return null
          const fileId = virtualId.slice(INLINE_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
          this.addWatchFile(fileId)
          const source = await readFile(fileId)
          const { code } = transform({ filename: fileId, code: source, minify: true })
          return `export default ${JSON.stringify(code.toString())};`
        },
      },
      {
        name: 'dsh-css-global-inline',
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
          const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
          return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
        },
        async load(virtualId: string) {
          if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
          const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
          this.addWatchFile(fileId)
          const source = await readFile(fileId)
          const { code } = transform({ filename: fileId, code: source, minify: true })
          return styleInjectionModule(id, fileId, code.toString())
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      chunkFileNames: 'client.[name].js',
      sourcemapExcludeSources: false,
      banner: (chunk) => {
        const registration = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`
        return registration
      },
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/**
 * The node half. DSH's `clientBundle()` emits both halves because the Loader
 * row for a client package resolves its bare name to `lib/index.js` -- a
 * package whose host half is never built fails to import at activation
 * (observed in M0). An empty host `apply` still needs a real artifact.
 * @param id - plugin id, used for diagnostics only.
 * @param options - package directory and tsc entry.
 * @returns the tsdown config for the node half.
 */
function nodeHalf(id: string, options: ClientBundleOptions): UserConfig {
  const dir = options.dir ?? process.cwd()
  const entry = options.libEntry ?? 'lib/types/index.js'
  return {
    name: `${id}/node`,
    entry: [entry],
    cwd: dir,
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: false,
    // The entry lives under lib/types, which tsc just emitted: a default clean
    // would delete it before rolldown reads it.
    clean: false,
    // package.json main is lib/index.js; tsdown's ESM default is .mjs.
    outExtensions: () => ({ js: '.js' }),
  }
}

/**
 * Build the tsdown configs for one client plugin package: the node half the
 * Loader imports, plus the browser half the module system serves.
 * @param id - plugin id (package name).
 * @param options - entry, externals, package directory, and node-half entry.
 * @returns both tsdown configs, node first.
 */
export function clientBundle(id: string, options: ClientBundleOptions = {}): UserConfig[] {
  const halves: UserConfig[] = []
  if (options.libEntry !== null) halves.push(nodeHalf(id, options))
  halves.push(browserHalf(id, options))
  return halves
}
