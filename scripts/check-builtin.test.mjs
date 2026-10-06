/**
 * The framework's built-in project, checked as a COMPOSITION.
 *
 * WHAT THIS FILE IS FOR, and what it deliberately is not. `scripts/verify.mjs` boots the built client
 * bundle against a fake DOM; that is where a claim about the PANEL or the RUNTIME belongs. This file
 * proves the claims that need neither a DOM nor a bundle:
 *
 *   the shipped manifest is one the service ACCEPTS, and it says what the repository thinks it says;
 *   the framework's project and the published package's project COEXIST, because their ids differ;
 *   the one-skin policy -- not any precedence rule -- is what keeps two skins from being on together;
 *   and the runtime overlay is installed by the project being ON, not by the plugin being loaded.
 *
 * WHY IT CAN BE A PLAIN MODULE. `src/client/service.js` and `src/client/registry.js` are ES modules, so
 * they are imported directly, and the REAL Cordis (the same one `scripts/load-check.mjs` discovers)
 * supplies the context. That matters more than it looks: `register` is bound to the CALLER's fiber
 * through Cordis's tracker, so a hand-made `{ effect }` stub proves nothing about the one thing this
 * file is checking. (`scripts/verify.mjs`'s plain-object probe is exactly such a stub, and the built-in
 * registration is refused there for that reason -- see the note beside it.)
 *
 * THE MANIFEST IS EVALUATED, NOT IMPORTED. The client sources are written for the bundler (plain
 * CommonJS), and this package is `"type": "module"`, so `import()` on one of them fails with "module is
 * not defined". The manifest is data with no requires, so four lines of CommonJS shim load it -- which
 * also means this test reads the SHIPPED manifest rather than a copy of it.
 *
 * Run: `node scripts/check-builtin.test.mjs [--cordis <path to @deepseek-ai/cordis>]`
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
let checks = 0
let failures = 0
const ok = (/** @type {string} */ label) => {
  checks += 1
  process.stdout.write(`  ok   ${label}\n`)
}
const fail = (/** @type {string} */ label, /** @type {string} */ detail) => {
  checks += 1
  failures += 1
  process.stdout.write(`  FAIL ${label}\n         ${detail}\n`)
}
const equal = (/** @type {unknown} */ actual, /** @type {unknown} */ expected, /** @type {string} */ label) => {
  if (Object.is(actual, expected)) ok(label)
  else fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const truthy = (/** @type {unknown} */ value, /** @type {string} */ label) => {
  if (value) ok(label)
  else fail(label, 'expected a truthy value')
}

/**
 * The deployment lives in an npx cache whose directory name carries a hash, so it is discovered rather
 * than hard-coded — the same three sources `scripts/load-check.mjs` reads, in the same order.
 */
function findCordis() {
  const fromEnv = process.env.DSH_CORDIS
  if (fromEnv !== undefined && existsSync(join(fromEnv, 'package.json'))) return fromEnv
  const index = process.argv.indexOf('--cordis')
  const fromArgv = index === -1 ? undefined : process.argv[index + 1]
  if (fromArgv !== undefined && existsSync(join(fromArgv, 'package.json'))) return fromArgv
  const npmCache = join(
    process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'),
    'npm-cache',
    '_npx',
  )
  if (!existsSync(npmCache)) return undefined
  return readdirSync(npmCache, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(npmCache, entry.name, 'node_modules', '@deepseek-ai', 'cordis'))
    .filter((path) => existsSync(join(path, 'package.json')))
    .map((path) => ({ path, at: statSync(path).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]?.path
}

const cordisPath = findCordis()
if (cordisPath === undefined) {
  process.stdout.write('  FAIL no @deepseek-ai/cordis found; pass --cordis <path> or set DSH_CORDIS\n')
  process.stdout.write('\n0 assertions, 1 failing\n')
  process.exit(1)
}
const cordisPkg = JSON.parse(readFileSync(join(cordisPath, 'package.json'), 'utf8'))
const cordis = await import(pathToFileURL(join(cordisPath, 'lib', 'index.js')).href)
const Context = cordis.Context ?? cordis.default?.Context
process.stdout.write(`== built-in check: cordis ${cordisPkg.version} ==\n`)

const load = async (/** @type {string} */ relative) =>
  await import(pathToFileURL(join(packageRoot, relative)).href)
const { UiProjectRegistry } = await load('src/client/registry.js')
const { createUiProjectsService } = await load('src/client/service.js')

/** Evaluate one CommonJS data module — see the header for why this is not an `import`. */
function readCommonJs(/** @type {string} */ file) {
  const loaded = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', readFileSync(file, 'utf8'))(loaded, loaded.exports, () => {
    throw new Error(`${file} must not require anything`)
  })
  return loaded.exports
}

const builtIn = readCommonJs(join(packageRoot, 'src', 'client', 'skins', 'glass', 'manifest.js'))

/* ── the manifest the framework ships ───────────────────────────────────────────────────────────── */
equal(builtIn.id, 'glass', 'the built-in project is `glass`')
equal(builtIn.name, 'Glass', 'and it is called Glass')
equal(builtIn.type, 'skin', 'it is a skin, which is what the one-skin policy keys on')
equal(builtIn.scope, 'global', 'and it is a global skin rather than a region')
equal(builtIn.defaultEnabled, false, 'it ships OFF: a built-in that arrived on would be a different product')
equal(builtIn.builtIn, true, 'it is marked as the framework’s own, through `source` for anything that reads it')
equal(builtIn.package, 'dsh-ui-projects', 'its owning package is the framework, which is the field the ownership rule reads')
equal(builtIn.supports.includes('light') && builtIn.supports.includes('dark'), true, 'it declares both themes')

/* ── the composition: the framework's project and the package's, side by side ───────────────────── */
const registry = new UiProjectRegistry()
const service = createUiProjectsService({
  registry,
  enabledIds: () => [],
  hostRowsAtBoot: null,
  bootFragmentPresent: () => false,
  bodyMarkerPresent: () => false,
  notify: () => {},
})
const root = new Context()
root.provide('uiProjects', service)

/* `ctx.uiProjects.register(...)` — a METHOD call on the tracker-wrapped service, which is the only form
 * that carries the caller's fiber. A detached `const { register } = ctx.uiProjects` reaches the service
 * with no caller and is refused, which is why this is written the long way on purpose. */
root.uiProjects.register(builtIn, {})
equal(registry.ids().join(','), 'glass', 'the framework’s own project registers through the service it provides')
equal(registry.get('glass')?.source?.package, 'dsh-ui-projects', 'and the registry stamps it with the framework as its owner')
equal(registry.get('glass')?.source?.builtIn, true, 'the built-in marker reaches `source`, which is where ownership facts live')

/*
 * The published package's project, as a stand-in: same id it really uses, same type, same package name.
 * A stand-in rather than the real manifest because the package lives in another repository, and what is
 * under test here is the SERVICE's behaviour with two ids -- not that package's file.
 */
root.uiProjects.register(
  { package: '@fn-x/dsh-plugin-liquid-glass', version: '1.0.1', id: 'liquid-glass', name: 'Liquid Glass', type: 'skin', scope: 'global', defaultEnabled: false },
  {},
)
equal(registry.ids().join(','), 'glass,liquid-glass', 'and the package’s project registers beside it: two ids, no conflict')
equal(registry.get('liquid-glass')?.source?.builtIn, false, 'a registered package is not built in: `source` says so either way')
equal(registry.isEnabled('glass'), false, 'neither is switched on by registering it')
equal(registry.isEnabled('liquid-glass'), false, 'either of them')

/* ── the one-skin policy, which is what keeps them from both being on ────────────────────────────── */
registry.markActive('liquid-glass')
equal(registry.conflictIds('glass').join(','), 'liquid-glass', 'with the package’s skin applied, enabling the built-in would turn it off')
registry.markActive('glass')
equal(registry.conflictIds('liquid-glass').join(','), 'glass', 'and the other way round: the policy is symmetric and id-independent')
/*
 * ONE ACTIVE SKIN AT A TIME, so the other is taken back down before this reads: `markActive` is the
 * runtime's own bookkeeping and does NOT retire a conflict -- retiring is what the runtime does with
 * what `conflictIds` reports. Leaving both marked would have made the assertion below read the other
 * project and fail for a reason that has nothing to do with self-conflict.
 */
registry.markInactive('liquid-glass')
equal(registry.conflictIds('glass').length, 0, 'a skin does not conflict with itself, which is what lets it be re-enabled while on')

/* ── the overlay belongs to the project being ON (the `apply` decision, 2026-10-06) ─────────────── */
const skinSource = readFileSync(join(packageRoot, 'src', 'client', 'skins', 'glass', 'skin.js'), 'utf8')
const pluginSource = readFileSync(join(packageRoot, 'src', 'client', 'index.js'), 'utf8')
truthy(skinSource.includes('installOverlay()'), 'the definition installs the overlay when the project is applied')
truthy(skinSource.includes('removeOverlay()'), 'and takes it away when the project is cleaned up')
equal(
  pluginSource.includes('installOverlay'),
  false,
  'while the always-loaded client half never installs it: a reader who never turns Glass on carries no sheet',
)

/* ── the equivalence check: the built-in copy against the package it came from ───────────────────── */
/* ── the framework's own consistency, now that it is the only source ────────────────────────────── */
/*
 * WHAT REPLACED THE EQUIVALENCE CHECK, AND WHY IT IS SMALLER. Until 2026-10-06 these sheets were compared
 * byte for byte against the package they came from, and that check is what caught the encoding accident
 * recorded in docs/known-issues.md. The package is frozen now and this repository is the only source, so
 * there is nothing left to compare against -- and the claims that check was making about THIS side are the
 * ones worth keeping.
 */
const builtInId = builtIn.id
/*
 * COMMENTS DO NOT COUNT, and this file learned that the same way twice: the two authored sheets mention the
 * frozen package's marker inside explanations of what the scoper does, and a reader that does not strip
 * comments reports those mentions as stale markers. It is the lesson the package's own suite records, applied
 * here because this check inherited the job.
 *
 * AND ONLY ONE OF THE THREE CARRIES A MARKER BY HAND. `boot.css` is written the way the scoper emits it and
 * the overlay spells its markers out, but `glass.css` is authored plainly and the runtime adds the marker --
 * so requiring a marker there would fail a file that is exactly as it should be.
 */
const withoutComments = (text) => String(text).replace(/\/\*[\s\S]*?\*\//g, ' ')
for (const [label, file, carriesMarker] of [
  ['glass.css', 'src/client/skins/glass/glass.css', false],
  ['boot.css', 'src/host/skins/glass/boot.css', true],
  ['overlay.js', 'src/client/skins/glass/overlay.js', true],
]) {
  const text = withoutComments(readFileSync(join(packageRoot, file), 'utf8'))
  const stale = (text.match(/data-ui-project-(?!glass)[a-z-]+/g) ?? []).filter((one) => one !== 'data-ui-project-overlay')
  equal(stale.length, 0, `${label} names no project marker but this one`)
  if (carriesMarker) {
    truthy(text.includes('data-ui-project-' + builtInId), `${label} carries the built-in's marker`)
  } else {
    truthy(!text.includes('data-ui-project-'), `${label} is authored without a marker; the scoper adds one`)
  }
}

/* ── the mirror: the host half's copy of the id against the client's manifest ────────────────────── */
/*
 * THE TWO HALVES ARE SEPARATE BUNDLES AND CANNOT IMPORT ONE ANOTHER, so the built-in's id is written down
 * twice: once in `src/client/skins/glass/manifest.js`, which is the authority, and once in
 * `src/host/index.js`, which inlines the first-paint payload for it. This is the assertion that keeps the
 * copy honest — the same shape `SUPPORTED_PLUGIN_API` and the channel list already use in this package.
 * A rename that reached one side only would leave the host announcing a project the client never
 * registers, and the symptom (a first frame that paints nothing) looks like a caching problem.
 */
const hostId = /const BUILT_IN_PROJECT_ID = '([^']+)'/.exec(
  readFileSync(join(packageRoot, 'src', 'host', 'index.js'), 'utf8'),
)?.[1]
equal(hostId, builtIn.id, 'the host half inlines the first paint for the project the client half registers')

process.stdout.write(`\n${checks} assertions, ${failures} failing\n`)
process.exit(failures === 0 ? 0 : 1)
