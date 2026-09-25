/**
 * Build the browser half of dsh-ui-projects.
 *
 * The dsh Web client loads a plugin's `./client` export as a *lazy CJS* module:
 * a script that registers one factory, whose `require` resolves only against the
 * shell's frozen module table. That means the client half must ship as a single
 * pre-built bundle with no bare imports left unresolved.
 *
 * This script is the whole build:
 *
 *   src/client/**\/*.js   →  one CommonJS module graph  →  lib/client.js
 *   src/client/**\/*.css  →  `module.exports = "<css text>"` inside that graph
 *
 * No bundler, no transpiler, no network: the source is written in the same plain
 * JavaScript the browser will run, and the only transformation is
 * ESM → CommonJS plus the module registration wrapper. `verify.mjs` re-loads the
 * emitted bundle through a faithful `__ModuleLoader__` facade, so a broken bundle
 * fails the test rather than the browser.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientRoot = join(packageRoot, 'src', 'client')
const hostEntry = join(packageRoot, 'src', 'host', 'index.js')
const outFile = join(packageRoot, 'lib', 'client.js')
const outHost = join(packageRoot, 'lib', 'index.js')

/**
 * The bundle's entry module id, and the source file it comes from.
 *
 * Deliberately not `index`: ids collapse directory index modules, so an id
 * literally named `index` would be indistinguishable from the collapse of an
 * `index.js` in some directory. Renaming the entry is what lets the builder and
 * the bundle resolve every relative request exactly, with no guessing.
 */
const ENTRY_ID = 'entry'
const ENTRY_FILE = 'index.js'

/**
 * The module order this bundle is built from (order affects readability only).
 *
 * Every file under `src/client` must appear here. The entry point of a module graph
 * is hard to see by eye, so a file that is present but unreachable is a mistyped
 * import far more often than it is deliberate — which is why the build fails loudly
 * on one. A module listed here that nothing imports yet is simply never
 * materialised: registering a factory costs a line of code, not runtime work.
 */
const MODULE_ORDER = [
  'project-constants.js',
  'scope-css.js',
  'registry.js',
  'persist.js',
  'runtime.js',
  'store.js',
  'diagnostics.js',
  'locale.js',
  'panel.js',
  'styles/core.css',
  'projects/liquid-glass/tokens.css',
  'projects/liquid-glass/glass.css',
  'projects/liquid-glass/skin.js',
  ENTRY_FILE,
]

/**
 * Map a source file path to its module id.
 *
 * The extension is dropped, a directory index module collapses to its directory
 * (`projects/liquid-glass/index.js` → `projects/liquid-glass`), and the package
 * entry becomes {@link ENTRY_ID}.
 * @param {string} posix
 */
function toId(posix) {
  if (posix === ENTRY_FILE) return ENTRY_ID
  return posix.replace(/\.m?js$/, '').replace(/\/index$/, '')
}

/** The ordered module ids this bundle is built from. */
const ORDERED_IDS = MODULE_ORDER.map(toId)

/**
 * The directory a relative request resolves against, for one module id.
 *
 * A relative specifier is relative to the directory CONTAINING the importing
 * file. Because ids collapse a directory index module (`projects/liquid-glass` is
 * the id of `projects/liquid-glass/index.js`), that containing directory is the
 * id itself — unless the id names a plain module, in which case it is the id's
 * parent. `projects/liquid-glass` and `projects/liquid-glass/index` therefore
 * behave identically, which is the whole point of collapsing them.
 *
 * The browser bundle runs the identical rule against its own registry. When the
 * build knows the importing file's real directory it passes that instead of
 * relying on this inference (see `transform`).
 * @param {string} id @param {(candidate: string) => boolean} hasModule
 * @returns {string}
 */
function directoryOf(id, hasModule) {
  if (id === ENTRY_ID) return ''
  if (hasModule(id)) {
    return id.endsWith('/index') ? id.slice(0, id.lastIndexOf('/')) : id
  }
  return id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : ''
}

/**
 * Resolve a relative request to a module id.
 *
 * Which module a request names is decided by looking at the ids the bundle
 * actually contains, never by guessing from the specifier's text: the direct
 * candidate wins, then its directory-index collapse.
 * @param {string} id @param {string} spec
 * @param {(candidate: string) => boolean} hasModule
 * @param {string} [containingDirectory] the importing file's real directory
 * @returns {string}
 */
function resolveRequest(id, spec, hasModule, containingDirectory) {
  if (!spec.startsWith('.')) return spec
  const directory = containingDirectory ?? directoryOf(id, hasModule)
  // Join FIRST, then normalize the whole path: `..` must be able to consume
  // segments contributed by the base directory, which is what
  // `projects/liquid-glass` + `../registry.js` depends on.
  const joined = directory === '' ? spec : `${directory}/${spec}`
  /** @type {string[]} */
  const parts = []
  for (const segment of joined.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  const raw = parts.join('/').replace(/\.[cm]?js$/, '')
  for (const candidate of [raw, raw.replace(/\/index$/, '')]) {
    if (candidate !== '' && hasModule(candidate)) return candidate
  }
  return raw
}
/**
 * Rewrite one ESM module body as a CommonJS module body — or normalize a module
 * already written as CommonJS.
 *
 * Supported, and deliberately nothing else:
 *   - `import default`, `import { a, b as c }`, `import * as ns` from a literal specifier
 *   - `require('<relative path>')` anywhere in the body (rewritten to the bundle's
 *     own resolver, so local requires work exactly like imports)
 *   - `require('<bare specifier>')` resolved through the factory's request
 *     function, which answers from the shell's frozen module table
 *   - `export default <expression>`, `export { … }`, and `export` on a declaration
 *
 * A module that mixes `export` with `module.exports` is rejected: it has no single
 * meaning once bundled, and a build error is far cheaper than a broken browser.
 *
 * @param {string} id
 * @param {string} source
 * @param {{ hasModule: (candidate: string) => boolean, directory: string }} context
 * @returns {{ code: string, externals: string[] }}
 */
export function transform(id, source, context = { hasModule: () => false, directory: '' }) {
  const { hasModule, directory } = context
  let code = source
  /** @type {string[]} */
  const externals = []

  if (/^[ \t]*export\s/m.test(code) && /(^|[^.\w])module\.exports\b/.test(code)) {
    throw new Error(`[build] ${id} mixes ESM exports with module.exports`)
  }

  // Imports are hoisted in ESM, so collecting them first preserves evaluation
  // order even when a module imports a sibling defined later in the graph.
  /** @type {Array<{ clause: string, spec: string }>} */
  const imports = []
  code = code.replace(
    /^[ \t]*import\s+([^;]+?)\s+from\s+(['"])([^'"]+)\2[ \t]*;?[ \t]*$/gm,
    (_match, clause, _quote, spec) => {
      imports.push({ clause: clause.trim(), spec })
      if (!spec.startsWith('.')) externals.push(spec)
      return ''
    },
  )

  // Every require becomes a request through the bundle's own resolver, so a
  // relative path is an internal module and a bare specifier is an external
  // answered by the shell's frozen module table.
  code = code.replace(/require\(\s*(['"])([^'"]+)\1\s*\)/g, (_match, _quote, spec) => {
    if (!spec.startsWith('.')) {
      externals.push(spec)
      return `__require(${JSON.stringify(spec)})`
    }
    return `__require(${JSON.stringify(resolveRequest(id, spec, hasModule, directory))})`
  })

  if (/^\s*import\s/m.test(code)) {
    throw new Error(`[build] unsupported import syntax in ${id}`)
  }

  /** @type {Map<string, string[]>} exported name → local names */
  const exported = new Map()
  /** @type {string[]} */
  const localExports = []

  code = code.replace(/^[ \t]*export\s+default\s+/gm, () => {
    const local = `__default_${Math.random().toString(36).slice(2, 8)}`
    localExports.push(local)
    exported.set('default', [`${local}::assignment`])
    return `const ${local} = `
  })

  code = code.replace(/^[ \t]*export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm, (_m, kind, name) => {
    exported.set(name, [name])
    return `${kind} ${name}`
  })

  code = code.replace(/^[ \t]*export\s*\{([^}]*)\}[ \t]*;?[ \t]*$/gm, (_m, list) => {
    for (const entry of String(list).split(',')) {
      const trimmed = entry.trim()
      if (trimmed.length === 0) continue
      const [local, alias] = trimmed.split(/\s+as\s+/).map((part) => part.trim())
      exported.set(alias ?? local, [local])
    }
    return ''
  })

  code = code.replace(/^[ \t]*export\s*\{[^}]*\}\s*from\s*(['"])[^'"]+\1[ \t]*;?[ \t]*$/gm, '')
  if (/^[ \t]*export\s/m.test(code)) {
    throw new Error(`[build] unsupported export syntax in ${id}`)
  }

  const header = []
  for (const { clause, spec } of imports) {
    const request = resolveRequest(id, spec, hasModule, directory)
    if (clause.startsWith('{')) {
      const names = clause
        .slice(1, -1)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [imported, local] = entry.split(/\s+as\s+/).map((part) => part.trim())
          return { imported, local: local ?? imported }
        })
      const bindings = names.map(({ local }) => local).join(', ')
      if (bindings.length === 0) continue
      header.push(`var { ${bindings} } = __require(${JSON.stringify(request)});`)
    } else if (clause.startsWith('*')) {
      const local = clause.replace(/^\*\s*as\s*/, '').trim()
      header.push(`var ${local} = __require(${JSON.stringify(request)});`)
    } else {
      // A default import binds the module's `default` export. React is published
      // as CommonJS without one, so the module itself is the default — fall back
      // rather than binding undefined.
      header.push(
        `var ${clause} = __require(${JSON.stringify(request)});` +
          `\nif (${clause} !== null && typeof ${clause} === 'object' && 'default' in ${clause}) {` +
          `\n  ${clause} = ${clause}.default;` +
          `\n}`,
      )
    }
  }

  const footer = []
  for (const [name, locals] of exported) {
    for (const local of locals) {
      const assignment = local.endsWith('::assignment') ? local.slice(0, -'::assignment'.length) : local
      footer.push(`exports[${JSON.stringify(name)}] = ${assignment};`)
    }
  }
  footer.push('return module.exports;')

  return { code: `${header.join('\n')}\n${code}\n${footer.join('\n')}`, externals }
}

/**
 * Wrap a transformed module body as a factory. `module` and `exports` are
 * parameters rather than declarations on purpose: the shell's loader defines
 * them in its own scope, and a bundle that re-declared them would look like
 * CommonJS to a host that sniffs `require`/`module` at load time (Node's
 * ambiguous-module-syntax error, hit by `verify.mjs` before this change).
 * @param {string} code
 * @returns {string}
 */
function wrapModule(code) {
  return `function (__require, module, exports) {\n${code}\n}`
}

/** @param {string} id @param {string} text @returns {string} */
function cssModule(id, text) {
  void id
  return `module.exports = ${JSON.stringify(text)};\nreturn module.exports;\n`
}

/** @param {string} dir @returns {Promise<string[]>} */
async function listFiles(dir) {
  const { readdir } = await import('node:fs/promises')
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await listFiles(path)))
    else found.push(path)
  }
  return found
}

/**
 * Every bare import in the host half must resolve from this package.
 *
 * A missing host dependency is uniquely nasty: the client bundle is fine, every
 * Node test that imports the bundle is fine, and the failure appears only when dsh
 * boots — as a refused loader entry that takes the whole GUI with it. That is
 * exactly what happened when the host half grew an import of a package that was not
 * declared, so the check is part of the build now rather than something a user
 * discovers by restarting.
 * @param {string} source
 */
function assertHostImportsResolvable(source) {
  const require = createRequire(join(packageRoot, 'package.json'))
  /** @type {string[]} */
  const unresolved = []
  for (const match of String(source).matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
    const specifier = match[1]
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    try {
      require.resolve(specifier)
    } catch {
      unresolved.push(specifier)
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `[build] the host half imports package(s) this package cannot resolve: ${unresolved.join(', ')}\n` +
        '[build] add them to "dependencies" and install, or the dsh loader entry will fail at boot.',
    )
  }
}

async function build() {
  const files = await listFiles(clientRoot)
  /** Every module id in this bundle, so path resolution consults reality. */
  const knownIds = new Set(
    files.filter((file) => file.endsWith('.js') || file.endsWith('.css')).map((file) => toId(relative(clientRoot, file).split(sep).join('/'))),
  )
  const hasModule = (/** @type {string} */ candidate) => knownIds.has(candidate)

  /** @type {Map<string, { id: string, code: string, externals: string[] }>} */
  const modules = new Map()

  for (const file of files) {
    const posix = relative(clientRoot, file).split(sep).join('/')
    if (posix.endsWith('.css')) {
      const id = toId(posix)
      modules.set(id, { id, code: cssModule(id, await readFile(file, 'utf8')), externals: [] })
      continue
    }
    if (!posix.endsWith('.js')) continue
    const id = toId(posix)
    // The importing file's real directory, so relative requests never depend on
    // how the id was collapsed.
    const directory = posix.includes('/') ? posix.slice(0, posix.lastIndexOf('/')) : ''
    const { code, externals } = transform(id, await readFile(file, 'utf8'), { hasModule, directory })
    modules.set(id, { id, code, externals, directory })
    if (process.env.DSH_UI_PROJECTS_DEBUG === '1') {
      const requests = [...code.matchAll(/__require\("([^"]+)"\)/g)].map((match) => match[1])
      process.stderr.write(`[build] ${id} (dir=${JSON.stringify(directory)}) → ${requests.join(', ')}\n`)
    }
  }

  const ordered = ORDERED_IDS.filter((id) => modules.has(id))
  const missing = ORDERED_IDS.filter((id) => !modules.has(id))
  if (missing.length > 0) {
    // A module the bundle is declared to contain and does not: the graph is broken
    // and the bundle would fail at runtime with "internal module not found". Fatal.
    throw new Error(`[build] declared module(s) not found: ${missing.join(', ')}`)
  }
  /*
   * A file present but not declared is only a warning, not an error.
   *
   * The check exists because a mistyped import is invisible otherwise — a module can
   * sit in the tree, never be reachable, and silently do nothing. But the same
   * condition is what work-in-progress looks like: another contributor (or another
   * agent, or a parallel branch) adds files before wiring them up. Failing the build
   * there would block whoever is building the *stable* part of the graph, and the
   * files in question are simply not bundled. So: say so, loudly, and carry on.
   */
  const undeclared = [...modules.keys()].filter((id) => !ORDERED_IDS.includes(id))
  if (undeclared.length > 0) {
    process.stderr.write(
      `[build] warning: ${undeclared.length} file(s) under src/client are not in MODULE_ORDER and will NOT be bundled:\n` +
        undeclared.map((id) => `[build]   ${id}`).join('\n') +
        '\n[build]   Add them to MODULE_ORDER once something imports them.\n',
    )
  }

  /** @type {Set<string>} */
  const externals = new Set()
  for (const id of ordered) {
    for (const spec of modules.get(id).externals) externals.add(spec)
  }
  const body = ordered
    .map((id) => {
      const module = modules.get(id)
      const directory = module.directory ?? ''
      return `__register(${JSON.stringify(module.id)}, ${JSON.stringify(directory)}, ${wrapModule(module.code)});`
    })
    .join('\n\n')

  // The whole bundle is wrapped in a function so it is unambiguously a script:
  // a host that evaluates it (the browser, or `verify.mjs` inside `vm`) must
  // never have to guess a module format from the surrounding file.
  const bundle = `/**
 * dsh-ui-projects — browser half (generated by scripts/build.mjs; do not edit).
 *
 * Externals resolved from the shell's frozen module table: ${[...externals].sort().join(', ') || '(none)'}
 * Modules in this bundle: ${ordered.map(toId).join(', ')}
 */
;(function () {
  'use strict';

  var MODULES = {};
  var DIRECTORIES = {};
  var CACHE = {};
  /**
   * @param {string} id module id
   * @param {string} directory the directory its relative requests resolve
   *   against — recorded explicitly by the builder, so resolution never has to
   *   infer whether an id names a module or a directory.
   * @param {Function} factory
   */
  function __register(id, directory, factory) {
    MODULES[id] = factory;
    DIRECTORIES[id] = directory;
  }
  /**
   * @param {string} id
   * @param {(spec: string) => unknown} external Answers requests outside this
   *   bundle from the shell's frozen module table.
   */
  function __require(id, external) {
    if (Object.prototype.hasOwnProperty.call(CACHE, id)) {
      return CACHE[id].exports;
    }
    var factory = MODULES[id];
    if (factory === undefined) {
      if (external === undefined) {
        throw new Error('[dsh-ui-projects] internal module not found: ' + id);
      }
      return external(id);
    }
    var record = { exports: {} };
    CACHE[id] = record;
    Object.defineProperty(record.exports, Symbol.toStringTag, { value: 'Module' });
    factory(function (spec) { return __require(__resolve(id, spec), external); }, record, record.exports);
    return record.exports;
  }
  /* Relative requests resolve against the directory the builder recorded for the
     importing module, so no rule about file-vs-directory ids is needed here. */
  function __resolve(from, spec) {
    if (spec.charAt(0) !== '.') {
      return spec;
    }
    var directory = Object.prototype.hasOwnProperty.call(DIRECTORIES, from) ? DIRECTORIES[from] : '';
    /* Join first, then normalize: a '..' must be able to consume segments that
       came from the base directory. */
    var joined = directory === '' ? spec : directory + '/' + spec;
    var parts = [];
    var raw = joined.split('/');
    for (var i = 0; i < raw.length; i += 1) {
      var segment = raw[i];
      if (segment === '.' || segment === '') continue;
      if (segment === '..') { parts.pop(); continue; }
      parts.push(segment);
    }
    var path = parts.join('/').replace(/\\.m?js$/, '');
    var candidates = [path, path.replace(/\\/index$/, '')];
    for (var c = 0; c < candidates.length; c += 1) {
      if (candidates[c] !== '' && Object.prototype.hasOwnProperty.call(MODULES, candidates[c])) {
        return candidates[c];
      }
    }
    return path;
  }

${body}

  window.__ModuleLoader__.load({
    id: 'dsh-ui-projects',
    name: 'ui-projects',
    factory: function (require) {
      return __require('${ENTRY_ID}', require);
    },
  });})();
`

  await mkdir(dirname(outFile), { recursive: true })
  await writeFile(outFile, bundle, 'utf8')
  // The host half needs no transformation (it is plain ESM), but it does need to
  // exist at the path `package.json` `main` names, so copy it — after checking that
  // every package it imports can actually be resolved.
  const hostSource = await readFile(hostEntry, 'utf8')
  assertHostImportsResolvable(hostSource)
  await writeFile(outHost, hostSource, 'utf8')

  const digest = createHash('sha256').update(bundle).digest('hex').slice(0, 12)
  const size = Buffer.byteLength(bundle, 'utf8')
  process.stdout.write(
    `[build] lib/client.js ← ${ordered.length} modules, ${size} bytes, sha256:${digest}\n` +
      `[build] lib/index.js  ← host half (${Buffer.byteLength(hostSource, 'utf8')} bytes)\n` +
      `[build] externals: ${[...externals].sort().join(', ') || '(none)'}\n`,
  )
}

if (!existsSync(clientRoot)) {
  throw new Error(`[build] missing ${clientRoot}`)
}
if (!existsSync(hostEntry)) {
  throw new Error(`[build] missing ${hostEntry}`)
}

await build()
