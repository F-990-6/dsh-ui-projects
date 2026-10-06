/**
 * Build the browser half of dsh-ui-projects.
 *
 * The bundle rules themselves live in `./bundle-client.mjs` — one copy of the ESM→CJS rewrite
 * and the module-registry wrapper, shared with every UI project package's own build. What is
 * specific to this package is what is below: which files are in the graph.
 *
 *   src/client/**\/*.js   →  lib/client.js   (one lazy-CJS bundle)
 *   src/client/**\/*.css  →  `module.exports = "<css text>"` inside that graph
 *   src/host/**\/*.js     →  lib/**\/*.js    (plain ESM, copied verbatim)
 *
 * There is no fourth row any more, and that is step 8c: this package used to derive its own
 * `src/host/boot.css` into a `lib/boot-css.js` module, because it shipped a skin whose first frame
 * it had to serve. A first-paint sheet belongs to the package that owns the stylesheet, and the
 * derivation tool (`scripts/derive-boot-css.mjs`), the predicate it shares with a package's build
 * (`scripts/boot-css-rules.mjs`) and the skin's own stylesheets all moved to
 * `@xjl-resources/dsh-plugin-liquid-glass` — the predicate and the sheet in step 8c, the tool in step
 * 56h-5, which is when it left the workspace's `tools/`. A framework with no CSS has nothing to derive.
 *
 * No bundler, no transpiler, no network: the source is written in the same plain JavaScript the
 * browser will run. `verify.mjs` re-loads the emitted bundle through a faithful
 * `__ModuleLoader__` facade, so a broken bundle fails the test rather than the browser.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listFiles, renderBundle } from './bundle-client.mjs'

export { transform } from './bundle-client.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientRoot = join(packageRoot, 'src', 'client')
const hostRoot = join(packageRoot, 'src', 'host')
const hostEntry = join(hostRoot, 'index.js')
const outFile = join(packageRoot, 'lib', 'client.js')
const outHost = join(packageRoot, 'lib', 'index.js')

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
  'css-filter.js',
  'perf.js',
  'registry.js',
  'persist.js',
  'settings-controller.js',
  'slot-registration.js',
  /*
   * BEFORE `channels.js`, which imports it: the order is a dependency order, and a client module missing
   * from this list is bundled nowhere — measured 2026-09-30, where `checklist-items.js` was added to the
   * client half and this list was not, so `verify` and `load-check` both died on "no such shell module"
   * while `build` only warned.
   */
  'checklist-items.js',
  /* Also before `panel-plugins.js`, which reads the six categories from it (separate bundles, mirrored). */
  'changelog-categories.js',
  /* Before `panel-plugins.js`, which builds the copyable diagnostics from it. NOTE: this is NOT the
   * existing `diagnostics.js` — that one is the instrumentation toggle and is untouched. */
  'plugin-diagnostics.js',
  /*
   * THE CLIPBOARD, OUT OF THE COLUMN THAT IS GOING AWAY (2026-09-30). `copyCommandText` used to live inside
   * `panel-plugins.js`; the copy button survives that removal (uninstall, view CHANGELOG, copy diagnostics),
   * so the function moved into a module of its own and this list has to know about it.
   *
   * Placed here rather than beside the panels: `panel.js` and `panel-plugins.js` are listed later in this
   * array, so this position satisfies "before both", and it keeps the dependency order the whole list is.
   */
  'clipboard.js',
  'channels.js',
  'boot-presence.js',
  'service.js',
  'installed.js',
  'runtime.js',
  'store.js',
  'diagnostics.js',
  'locale.js',
  'preview.js',
  'panel.js',
  'styles/core.css',
  /*
   * THE BUILT-IN SKIN, and the order inside it is its own dependency order: both stylesheets are
   * required by `skin.js`, which is required by `index.js`'s registration, and `overlay.js` is required
   * by that registration too. The CSS entries have to be here for the same reason the skin package lists
   * them in its own build — a file under `src/client` that is not in this list is bundled nowhere, and
   * the failure it produces ("no such shell module") is a runtime one.
   */
  'skins/liquid-glass/tokens.css',
  'skins/liquid-glass/glass.css',
  'skins/liquid-glass/skin.js',
  'skins/liquid-glass/overlay.js',
  'skins/liquid-glass/manifest.js',
  'skins/index.js',
  'index.js',
]

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
  const { code: bundle, ordered, externals, undeclared } = await renderBundle({
    packageRoot,
    clientRoot,
    moduleOrder: MODULE_ORDER,
    loaderId: 'dsh-ui-projects',
    loaderName: 'ui-projects',
    generator: 'scripts/build.mjs',
  })
  if (undeclared.length > 0) {
    // Warnings only: see `bundle-client.mjs` for why a present-but-undeclared file must not fail
    // the build for whoever is working on the stable part of the graph.
  }

  await mkdir(dirname(outFile), { recursive: true })
  await writeFile(outFile, bundle, 'utf8')

  // The host half needs no transformation (it is plain ESM), but it does need to
  // exist at the path `package.json` `main` names — and it is no longer a single
  // file: `service.js` owns the first-paint contract and the loader row imports it.
  // So the whole `src/host` tree is copied verbatim, preserving structure, with
  // every bare import in every file checked as it goes.
  //
  // There used to be a guard here refusing a `src/host/boot-css.js`, because the copy would have
  // overwritten the generated `lib/boot-css.js`. It is gone with the generation rather than moved
  // sideways: the collision it prevented cannot happen now, and a file of that name in `lib/` is a
  // leftover from a build before step 8c that nothing imports.
  const hostSource = await readFile(hostEntry, 'utf8')
  const hostFiles = (await listFiles(hostRoot)).filter((file) => file.endsWith('.js'))
  for (const file of hostFiles) {
    const rel = relative(hostRoot, file).split(sep).join('/')
    const source = rel === 'index.js' ? hostSource : await readFile(file, 'utf8')
    assertHostImportsResolvable(source)
    const destination = rel === 'index.js' ? outHost : join(packageRoot, 'lib', rel)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, source, 'utf8')
  }

  const digest = createHash('sha256').update(bundle).digest('hex').slice(0, 12)
  const size = Buffer.byteLength(bundle, 'utf8')
  process.stdout.write(
    `[build] lib/client.js ← ${ordered.length} modules, ${size} bytes, sha256:${digest}\n` +
      `[build] lib/index.js  ← host half (${Buffer.byteLength(hostSource, 'utf8')} bytes) + ${hostFiles.length - 1} host module(s)\n` +
      `[build] externals: ${[...externals].sort().join(', ') || '(none)'}\n`,
  )
}

if (!existsSync(clientRoot)) {
  throw new Error(`[build] missing ${clientRoot}`)
}
if (!existsSync(hostEntry)) {
  throw new Error(`[build] missing ${hostEntry}`)
}

/*
 * Run only when this file is the entry point.
 *
 * A sibling UI project package's build imports from `./bundle-client.mjs`, and this file is not a
 * library — so importing it must stay free of the side effect of rebuilding a package. The
 * `transform` re-export above is kept for the same reason the guard was written: tooling outside
 * this repository has reached for it here. Nothing in the tree does any more (`load-check.mjs`
 * imports it from `bundle-client.mjs`, where it lives), so it is a pass-through with no in-tree
 * consumer rather than a used seam.
 */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build()
}
