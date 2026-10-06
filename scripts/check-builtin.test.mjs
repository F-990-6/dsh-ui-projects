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
import { BUILT_IN_MAP, BUILT_IN_TREES, SKIN_PACKAGE_ENV, normalizeMarker, overlaySheets } from './builtin-map.mjs'
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
/*
 * WHY THIS IS OPT-IN, AND WHY AN OPT-IN CHECK HAS TO BE LOUD. The package lives in another repository and
 * the path to it cannot be derived from this one — the two are not siblings — so `DSH_SKIN_PACKAGE` names
 * it. With the variable unset, the honest outcome is not a green tick over a file it never read: it is a
 * marked UNCHECKED line AND a note in the summary, because a quietly skipped comparison is the one failure
 * this check cannot see for itself.
 *
 * WHAT IT COMPARES, AND WHY THE MARKER IS NORMALIZED FIRST. The built-in's id is `glass` and the package's
 * is `liquid-glass`, so every generated marker differs by that one word — and the overlay's markers are
 * hand-written, which is why they had to be substituted when the copy was made. Normalizing the one word
 * away and THEN comparing bytes is what turns "the same material" into a measurement.
 */
const skinPackage = process.env.DSH_SKIN_PACKAGE
let unchecked = false
if (skinPackage === undefined || !existsSync(skinPackage)) {
  unchecked = true
  process.stdout.write(
    '  UNCHECKED  the equivalence check against the skin package did NOT run.\n' +
      '             Set DSH_SKIN_PACKAGE to that package and run this file again; until then a divergence\n' +
      '             between the built-in copy and the package it came from would go unnoticed here.\n',
  )
} else {
  /* The marker rule and the sheet reader live in the map, so neither is written twice. */
  const normalize = (/** @type {string} */ text) => normalizeMarker(text)
  const same = (/** @type {string} */ ours, /** @type {string} */ theirs, /** @type {string} */ label) =>
    equal(ours === theirs, true, label)

  /*
   * THE COMPARISON DIFFERS PER FILE, AND THAT IS THE CORRECTION RATHER THAN A CONVENIENCE.
   *
   * `tokens.css` and `glass.css` are compared RAW. An earlier version of this check normalized the marker
   * on both sides and failed on `glass.css` — which looked like a divergence in the material and was not:
   * `glass.css` never writes the marker in a selector (its own contract forbids it, because the scoper
   * appends one), so the only occurrences are inside comments, and the framework's copy keeps the
   * package's comments verbatim. Normalizing there was normalizing text neither side had changed.
   *
   * `boot.css` and the overlay ARE substituted, by necessity — the built-in's id is `glass`, and a stale
   * marker matches nothing — so those two are normalized. To keep normalization from hiding a wrong
   * substitution behind a matching one, each is ALSO held to the counts: the built-in's marker present, the
   * package's absent.
   */
  /*
   * THE TWO TREES, FILE FOR FILE — the hole a byte comparison cannot see.
   *
   * Everything below compares files BOTH SIDES ALREADY HAVE. A file added on one side and forgotten on the
   * other is invisible to that, and it is the likeliest way for two hand-edited copies to drift: a rule
   * that changes INSIDE `glass.css` is covered, a whole new sheet is not. So the mapping is written down
   * and asserted in both directions — an unlisted file in either tree fails here, and so does a mapped
   * file that has moved.
   */
  const fileNames = (/** @type {string} */ dir) => readdirSync(dir).sort().join(',')
  /*
   * THE TREES AND THE FILE PAIRS COME FROM THE SHARED MAP, not from a list written again here.
   * `scripts/builtin-map.mjs` is read by this file and by `scripts/sync-builtin.mjs`, which is the point:
   * two lists that agree today are two lists that can disagree tomorrow, and the second one to be edited
   * is always the one nobody reads.
   */
  for (const [which, directory, expected] of BUILT_IN_TREES) {
    equal(
      fileNames(join(which === 'framework' ? packageRoot : skinPackage, directory)),
      expected,
      `${which}: ${directory} holds exactly the files the shared map expects`,
    )
  }
  for (const [label, inFramework, fromPackage] of BUILT_IN_MAP) {
    truthy(
      existsSync(join(packageRoot, inFramework)) && existsSync(join(skinPackage, fromPackage)),
      `${label} is where the shared map says it is, on both sides`,
    )
  }

  const read = (/** @type {string} */ file) => readFileSync(file, 'utf8')
  /*
   * THE COMPARISON IS DRIVEN BY THE MAP'S MODES, which is the whole point of having a map: this file and
   * `scripts/sync-builtin.mjs` ask the same question of the same rows, and neither keeps a list of its own.
   * The `none` rows are skipped here for the same reason the writer refuses them — being different is what
   * they are for.
   */
  for (const [label, inFramework, fromPackage, mode] of BUILT_IN_MAP) {
    if (mode === 'none') continue
    const ours = read(join(packageRoot, inFramework))
    const theirs = read(join(skinPackage, fromPackage))
    if (mode === 'sheets') {
      const ourSheets = overlaySheets(ours)
      const theirSheets = overlaySheets(theirs)
      equal(
        Object.keys(ourSheets).sort().join(','),
        Object.keys(theirSheets).sort().join(','),
        `${label} carries the same sheets as the package's`,
      )
      for (const name of Object.keys(theirSheets)) {
        same(
          ourSheets[name] ?? '',
          normalizeMarker(theirSheets[name]),
          `${name} is the package's CSS, once the marker is normalized`,
        )
      }
      continue
    }
    same(
      ours,
      mode === 'raw' ? theirs : normalizeMarker(theirs),
      `${label} is byte-identical to the package's${mode === 'marker' ? ', once the marker is normalized' : ''}`,
    )
    /*
     * THE MARKER COUNTS ONLY MEAN SOMETHING WHERE THE MARKER IS SUBSTITUTED. `glass.css` and `tokens.css`
     * are copied verbatim, comments included, and both mention the package's marker inside explanations of
     * what the scoper does with it — counting occurrences there fails on prose, which is exactly what the
     * first version of this assertion did (4 occurrences, all of them in comments).
     */
    if (mode === 'marker') {
      equal(
        (ours.match(/data-ui-project-liquid-glass/g) ?? []).length,
        0,
        `${label} carries none of the package's markers: a stale one would match nothing`,
      )
      truthy(
        (ours.match(/data-ui-project-glass/g) ?? []).length > 0,
        `${label} carries the built-in's own marker`,
      )
    }
  }

  /* The four overlay sheets, which are the only CSS that lives inside a `.js` file on either side. */
  const sheetsIn = (/** @type {string} */ file) => overlaySheets(readFileSync(file, 'utf8'))
  const theirSheets = sheetsIn(join(skinPackage, 'src/client/index.js'))
  const ourSheets = sheetsIn(join(packageRoot, 'src/client/skins/glass/overlay.js'))
  equal(
    Object.keys(ourSheets).sort().join(','),
    Object.keys(theirSheets).sort().join(','),
    'the overlay carries the same four sheets on both sides',
  )
  for (const name of Object.keys(theirSheets)) {
    same(ourSheets[name] ?? '', normalize(theirSheets[name]), `${name} is the package's CSS, once the marker is normalized`)
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

process.stdout.write(
  `\n${checks} assertions, ${failures} failing${unchecked ? ', with the equivalence check UNCHECKED' : ''}\n`,
)
process.exit(failures === 0 ? 0 : 1)
