/**
 * The load check: both halves, real Cordis, no browser and no profile.
 *
 * WHAT THIS PROVES, and why it needs the real framework rather than a stub.
 *
 * The step-2 contract has four claims, and three of them are claims about Cordis itself:
 *
 *   1. the framework's host half provides `uiProjectsHost`
 *   2. the framework's client half provides `uiProjects`
 *   3. a minimal UI project package is loadable, which means its host half WAITS for that service
 *      (`inject: ['uiProjectsHost']`) and its client half registers through the other one
 *   4. the presence mechanism works end to end: a host half announces its project id, and rows for
 *      that project reach the injection table
 *
 * A stub context can show that `apply` calls the right methods. It cannot show that Cordis
 * provisions, injects or disposes anything — and disposal is the centre of the design: a package's
 * registration must be withdrawn when its plugin unloads. So this script imports the deployment's
 * own `@deepseek-ai/cordis`, builds real roots, mounts the real modules, and disposes real fibers.
 *
 * HOW THE CLIENT SOURCES ARE LOADED. They are CJS-dialect sources in a `"type": "module"` package —
 * Node itself never loads them; `scripts/build.mjs` transforms them into the browser bundle. So
 * this script loads them the same way the build does, through `bundle-client.mjs`'s `transform`,
 * which keeps the check honest about the dialect and independent of Node's require-ESM support.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never touches `$DSH_HOME`: no profile is read, no
 * composition is loaded, nothing outside this repository is written. The loader's admission of
 * `cordis.patch.yml` (a package joining `dsh.profile.bundles`) is a different claim, and belongs
 * with the loader; here the patch files are checked for shape only.
 *
 *   node scripts/load-check.mjs [--cordis <path to @deepseek-ai/cordis>]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

import { checkUiProjectDeclaration } from '../src/host/conformance.js'
import { transform } from './bundle-client.mjs'
import { createFakeDom, setSandbox } from './fake-dom.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const frameworkRoot = resolve(here, '..')
const skeletonRoot = resolve(frameworkRoot, '..', 'dsh-ui-project-skeleton')

let passed = 0
let failed = 0
const ok = (label) => {
  passed += 1
  process.stdout.write(`  ok   ${label}\n`)
}
const fail = (label) => {
  failed += 1
  process.stdout.write(`  FAIL ${label}\n`)
}
const equal = (actual, expected, label) =>
  actual === expected ? ok(label) : fail(`${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`)

/**
 * Find a Cordis installation to drive.
 *
 * The deployment lives in an npx cache whose directory name carries a hash, so it is discovered
 * rather than hard-coded: the newest `_npx/<hash>/node_modules/@deepseek-ai/cordis` wins. A
 * missing Cordis is a FAILURE, never a skip — a check that quietly does nothing is worse than no
 * check, which is a lesson this project already paid for once.
 */
function findCordis() {
  const index = process.argv.indexOf('--cordis')
  if (index >= 0 && process.argv[index + 1] !== undefined) return resolve(process.argv[index + 1])
  if (process.env.DSH_CORDIS) return resolve(process.env.DSH_CORDIS)
  const npmCache = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'npm-cache', '_npx')
  if (!existsSync(npmCache)) return undefined
  const found = []
  for (const entry of readdirSync(npmCache, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(npmCache, entry.name, 'node_modules', '@deepseek-ai', 'cordis')
    if (existsSync(join(candidate, 'package.json'))) found.push({ path: candidate, at: statSync(candidate).mtimeMs })
  }
  found.sort((a, b) => b.at - a.at)
  return found[0]?.path
}

/**
 * Load one client-tree source the way the build does: transform it, then evaluate it as CommonJS.
 * @param {string} path absolute path to a file under a package's `src/client`
 */
function loadClientModule(path) {
  const id = path.split(/[\\/]/).pop().replace(/\.js$/, '')
  const { code } = transform(id, readFileSync(path, 'utf8'), { hasModule: () => false, directory: '' })
  /** @type {(require: unknown, module: { exports: any }, exports: any) => any} */
  const evaluate = new Function('module', 'exports', code)
  const record = { exports: {} }
  evaluate(record, record.exports)
  return record.exports
}

/**
 * Materialize a BUILT client bundle the way the shell does: register its factory, then build the entry
 * module with a module table that throws on a miss.
 *
 * The difference from `loadClientModule` above is the whole point of the section that uses it: this loads
 * `lib/client.js` — the artefact a profile actually serves — rather than a source file put through the
 * same transform by hand. A miss here would mean the package had grown a dependency on the shell's module
 * table, which a UI project package must not have: it reaches the framework through a service.
 * @param {string} bundlePath
 * @returns {{ plugin: any, id: string, misses: string[] }}
 */
function materializeBundle(bundlePath) {
  /** @type {any} */
  let registered
  const globals = {
    window: { __ModuleLoader__: { load: (/** @type {any} */ r) => (registered = r) } },
    console,
  }
  globals.globalThis = globals
  vm.runInContext(readFileSync(bundlePath, 'utf8'), vm.createContext(globals), { filename: bundlePath })
  if (registered === undefined) throw new Error(`${bundlePath} did not register a ModuleLoader factory`)
  const misses = []
  const require = (/** @type {string} */ id) => {
    misses.push(id)
    throw new Error(`module-table miss: this package must not need "${id}"`)
  }
  return { plugin: registered.factory(require), id: registered.id, misses }
}

/** Let Cordis drive a plugin to its settled state — activation is asynchronous by design. */
const settle = () => new Promise((done) => setTimeout(done, 25))
/** @param {any} root @param {any} plugin */
async function mount(root, plugin) {
  const fiber = root.plugin(plugin)
  await settle()
  return fiber
}

const cordisPath = findCordis()
if (cordisPath === undefined) {
  process.stdout.write(
    '  FAIL no @deepseek-ai/cordis found; pass --cordis <path> or set DSH_CORDIS.\n' +
      '       This check needs the real framework: the claims under test are about provisioning,\n' +
      '       injection and disposal, which a stub context cannot demonstrate.\n',
  )
  process.exit(1)
}
const cordisPkg = JSON.parse(readFileSync(join(cordisPath, 'package.json'), 'utf8'))
process.stdout.write(`== load check: cordis ${cordisPkg.version} at ${cordisPath} ==\n`)

/*
 * WHICH Cordis is under test, checked rather than assumed.
 *
 * The tracker contract asserted at the end of this file is a statement about Cordis internals, and
 * it only means anything if this is the SAME Cordis the host process loads. Discovery picks the
 * newest copy in the npx cache, which is a guess; `@deepseek-ai/dsh` pins the version it actually
 * resolves. So the two are compared, and a mismatch fails here — before a single assertion is made
 * about a framework nobody runs.
 */
const dshManifest = join(cordisPath, '..', 'dsh', 'package.json')
if (existsSync(dshManifest)) {
  const pinned = JSON.parse(readFileSync(dshManifest, 'utf8')).dependencies?.['@deepseek-ai/cordis']
  if (pinned !== undefined && pinned !== cordisPkg.version) {
    process.stdout.write(
      `  FAIL the discovered Cordis (${cordisPkg.version}) is not the one dsh pins (${pinned}).\n` +
        "       Pass --cordis <the deployment's @deepseek-ai/cordis>: a different version makes the\n" +
        '       tracker contract below a statement about a framework nobody runs.\n',
    )
    process.exit(1)
  }
  process.stdout.write(`  dsh pins @deepseek-ai/cordis ${pinned ?? '(none)'}; discovered ${cordisPkg.version}\n`)
}

const cordis = await import(pathToFileURL(join(cordisPath, 'lib', 'index.js')).href)
const Context = cordis.Context ?? cordis.default?.Context
if (typeof Context !== 'function') {
  process.stdout.write('  FAIL the Cordis entry point exports no Context\n')
  process.exit(1)
}

// ── 1. the framework host half provides the first-paint service ──────────────

const frameworkHost = await import(pathToFileURL(join(frameworkRoot, 'lib', 'index.js')).href)
const skeletonHost = await import(pathToFileURL(join(skeletonRoot, 'lib', 'index.js')).href)

const hostRoot = new Context()
await mount(hostRoot, frameworkHost)
const provided = hostRoot.get('uiProjectsHost')
if (provided !== undefined && typeof provided.bootRows === 'function') {
  ok('the framework host half provides uiProjectsHost.bootRows')
} else {
  fail('the framework host half did not provide uiProjectsHost')
}

// ── 2. the minimal package waits for it, then emits its rows ─────────────────

/** Fire the index-injection table the way the host webserver does, once. */
function emitIndexInjection(root) {
  const table = []
  root.emit('webserver/index-inject', table)
  return table
}

const aloneRoot = new Context()
await mount(aloneRoot, skeletonHost)
const aloneTable = emitIndexInjection(aloneRoot)
if (aloneTable.length === 0) ok('a UI project package alone in a composition emits nothing: its host row waits for uiProjectsHost')
else fail(`a package without uiProjectsHost emitted ${aloneTable.length} row(s) instead of waiting`)
equal(aloneRoot.get('uiProjectsHost'), undefined, 'and no service appears out of nowhere')

await mount(hostRoot, skeletonHost)
const table = emitIndexInjection(hostRoot)
/*
 * Filtered on the presence row's own shape, never on the project id appearing anywhere in the
 * text. A loose substring is wrong here and was: the framework used to ship a first-paint
 * stylesheet, and that sheet happened to contain the word "skeleton" in one of its selectors, so
 * "rows mentioning skeleton" matched a style row as well — the kind of assertion that passes for
 * the wrong reason until it fails for one. The two conditions below are the contract: the row
 * writes the presence global, and the id it pushes is this package's.
 */
const presenceRows = table.filter((row) => (row.text ?? '').includes('__dshUiProjectRows'))
const forSkeleton = presenceRows.filter((row) => (row.text ?? '').includes('.push("skeleton")'))
if (forSkeleton.length === 1 && forSkeleton[0].kind === 'script') {
  ok('with the framework present, the package emits exactly its presence row')
} else {
  fail(`expected 1 presence row for the package, saw ${forSkeleton.length} of ${presenceRows.length}`)
}
/*
 * ONE, and it was two until 8c. The second was the framework's own: it pushed rows for the skin it
 * shipped, which is exactly what this assertion should stop seeing once the framework ships no
 * project. Read together with `aloneTable` above — a package with no framework emits nothing — the
 * pair still says "one row per mounted package, contributed by the package", with the framework
 * contributing none.
 */
equal(presenceRows.length, 1, 'and every mounted package announces itself exactly once, the framework contributing none')
equal(forSkeleton[0]?.placement, 'body', 'the presence row is a body row, so it runs before any client bundle')
equal(
  (forSkeleton[0]?.text ?? '').includes('__dshUiProjectRows'),
  true,
  'the presence row writes the global the browser half reads',
)
equal(
  table.some((row) => (row.text ?? '').includes('data-ui-project-skeleton')),
  false,
  'and no marker is emitted for a project the settings document does not have on',
)

// ── 3. the duplicated first-paint literals agree ─────────────────────────────

const hostService = await import(pathToFileURL(join(frameworkRoot, 'src', 'host', 'service.js')).href)
const clientPresence = loadClientModule(join(frameworkRoot, 'src', 'client', 'boot-presence.js')).__contract
equal(
  clientPresence.PRESENCE_GLOBAL,
  hostService.PRESENCE_GLOBAL,
  'the presence global is spelled the same in both halves',
)
equal(clientPresence.fragmentTag('x'), hostService.fragmentTag('x'), 'and so is the fragment tag the browser half scans for')
equal(
  clientPresence.markerAttribute('x'),
  hostService.markerAttribute('x'),
  'and so is the body marker the client scoper stamps rules with',
)

// ── 4. the client service: registration, ownership, and lifetime ─────────────


/*
 * The REAL runtime, from the built bundle.
 *
 * `runtime.js` is a client-tree module with a web of sibling imports, so it is loaded the way the
 * browser loads it — through the bundle's own module registry, using the public `__internals` seam
 * the entry module exposes for exactly this purpose. The bundle's one external (react) is never
 * requested: the entry materialises its modules lazily, and nothing here renders.
 */
let bundleEntry
const previousWindow = globalThis.window
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      bundleEntry = factory((spec) => {
        throw new Error(`this check does not provide the shell module "${spec}"`)
      })
    },
  },
}
new Function(readFileSync(join(frameworkRoot, 'lib', 'client.js'), 'utf8'))()
globalThis.window = previousWindow
const { createRuntime } = bundleEntry.__internals

const fakeDom = createFakeDom()

const { createUiProjectsService } = loadClientModule(join(frameworkRoot, 'src', 'client', 'service.js'))

/*
 * NO STUBS HERE, and this is the change that matters most in this file.
 *
 * The previous version of this check built the service over a stub registry, and the stub accepted
 * anything it was handed — including `type: 'retired'`, a project type the real registry refuses
 * outright. So the check passed while retirement was, in production, throwing inside a Cordis
 * disposer where the failure is isolated into a log line: the project stayed registered, the panel
 * kept its card, and a screenshot was the only way to find out. A stub cannot testify about the
 * class it stands in for.
 *
 * So: the real `UiProjectRegistry`, the real `UiProjectRuntime` from the built bundle, and the
 * real fake DOM the suite uses — the only fiction left is the settings adapter, which is a counter
 * here because what it has to prove is that the withdrawal does NOT write to it.
 */
const { UiProjectRegistry } = await import(pathToFileURL(join(frameworkRoot, 'src', 'client', 'registry.js')).href)
const registry = new UiProjectRegistry()

/** The fake document, shared with the suite: one copy of the matcher, not two. */
setSandbox({ window: globalThis.window })
globalThis.document = fakeDom.document

let appliedProjects = 0
let cleanedUp = 0
let writes = 0
let insertedCss = []
let persistedRecord = { v: 1, initialized: true, enabled: ['skeleton'], settings: {}, touched: true }
const persist = {
  read: () => persistedRecord,
  ready: () => Promise.resolve(),
  write: async (next) => {
    writes += 1
    persistedRecord = next
  },
}
const runtime = createRuntime({
  registry,
  persist,
  ctx: { get: () => undefined },
  insertCss: (id) => {
    insertedCss.push(id)
    return () => {
      insertedCss = insertedCss.filter((entry) => entry !== id)
    }
  },
})

const enabled = ['skeleton']
/*
 * The panel is told, and this counts it rather than stubbing it away.
 *
 * `notify` is how a withdrawal reaches the interface: the panel renders from a snapshot taken when the
 * registry last changed, so a registration that leaves without telling it leaves a card for a package
 * that is gone. It fires from `register` and from `withdraw` (`service.js:138`, `:195`), which is why
 * the assertion below is a DELTA rather than an absolute count.
 */
let notifications = 0
const service = createUiProjectsService({
  registry,
  enabledIds: () => enabled,
  hostRowsAtBoot: Object.freeze(['skeleton']),
  bootFragmentPresent: (id) => id === 'skeleton',
  bodyMarkerPresent: (id) => id === 'skeleton',
  retire: (id) => runtime.retire(id),
  adopt: (id) => runtime.adopt(id),
  notify: () => {
    notifications += 1
  },
})

const clientRoot = new Context()
clientRoot.provide('uiProjects', service)

const manifest = loadClientModule(join(skeletonRoot, 'src', 'client', 'manifest.generated.js'))
equal(manifest.package, 'dsh-ui-project-skeleton', 'the generated manifest carries the package identity from package.json')
equal(manifest.id, 'skeleton', 'and the project id its package declares')

/** A UI project package's client half, in three lines — exactly what the skeleton ships. */
const skinClient = {
  name: 'ui-project-skeleton',
  inject: ['uiProjects'],
  apply(ctx) {
    ctx.uiProjects.register(manifest, {
      apply(projectCtx) {
        appliedProjects += 1
        projectCtx.insertCss('body[data-ui-project-skeleton="on"]{ --skeleton: 1 }')
      },
      cleanup() {
        cleanedUp += 1
      },
    })
  },
}

const skinFiber = clientRoot.plugin(skinClient)
await skinFiber.await()

const listed = service.list()
equal(listed.length, 1, 'the package registers one project through the service')
equal(listed[0]?.id, 'skeleton', 'and the project is the one its manifest declares')
equal(listed[0]?.source?.package, 'dsh-ui-project-skeleton', 'the registration records which package owns it')
equal(listed[0]?.version, manifest.version, 'and the version the package declares')
if (registry.get('skeleton') !== undefined) ok('the real registry holds the project the service reported')
else fail('the service reported a registration the real registry never received')
equal(
  service.diagnostics().projects.find((project) => project.id === 'skeleton')?.state,
  'ok',
  'a registered, enabled project whose host announced it reads as ok',
)

/*
 * ── THE SKIN PACKAGE, LOADED FOR REAL ─────────────────────────────────────────
 *
 * Everything above this line mounts a package the way the SKELETON does it: a hand-written client half with
 * a generated manifest. That proves the contract, and it says nothing about the package that actually
 * ships a skin — so this section mounts `dsh-plugin-liquid-glass`'s REAL built bundle through the same real
 * Cordis, and asserts what a registration has to get right: who owns the project, what version it carries,
 * and that unloading the package takes it away again.
 *
 * It is the closest thing to production that runs without a browser: the same Cordis the deployment loads,
 * the same service implementation, the same bundle format.
 */
{
  const skinRoot = resolve(frameworkRoot, '..', 'dsh-plugin-liquid-glass')
  const skinManifest = loadClientModule(join(skinRoot, 'src', 'client', 'manifest.generated.js'))
  equal(skinManifest.package, '@xjl-resources/dsh-plugin-liquid-glass', 'the skin package’s generated manifest carries its scoped name')
  equal(skinManifest.id, 'liquid-glass', 'and the project id its package declares — unchanged from the framework era')
  equal(skinManifest.version, '1.0.0', 'and the version of the PACKAGE, which is what a checklist stamp records')

  const skinBundle = materializeBundle(join(skinRoot, 'lib', 'client.js'))
  equal(skinBundle.id, '@xjl-resources/dsh-plugin-liquid-glass', 'the built bundle registers under the scoped package name')
  equal(skinBundle.misses.length, 0, 'and resolves entirely inside itself: a client half needs no module from the framework')

  const before = service.list().length
  const skinPackageFiber = clientRoot.plugin(skinBundle.plugin)
  await skinPackageFiber.await()

  const registered = service.list().find((project) => project.id === 'liquid-glass')
  equal(service.list().length, before + 1, 'mounting the package adds exactly one project')
  if (registered !== undefined) ok('the real service lists the skin’s project')
  else fail('the skin package registered nothing through the service')
  equal(registered?.source?.package, '@xjl-resources/dsh-plugin-liquid-glass', 'stamped with the scoped package that owns it')
  equal(registered?.version, skinManifest.version, 'and carrying the PACKAGE version, so a stamp can never disagree with the install')
  if (registry.get('liquid-glass') !== undefined) ok('the real registry holds the project the service reported')
  else fail('the service reported a registration the real registry never received')

  /*
   * A CROSS-PACKAGE ID CLASH IS REFUSED. Two packages cannot own one project id: the second registration
   * throws rather than taking over the first, and the message names both packages — because the alternative
   * is a project whose owner depends on load order, which no card could explain.
   *
   * ON AN ISOLATED ROOT, and that is not tidiness: a refusal is RECORDED by the service it happened on, and
   * the section further down asserts the exact number of refusals the shared service holds. Provoking one
   * here would have changed that count and turned a passing check into a puzzling failure — which is
   * exactly what the first version of this section did.
   */
  const clashRoot = new Context()
  const clashService = createUiProjectsService({
    registry: new UiProjectRegistry(),
    enabledIds: () => [],
    hostRowsAtBoot: Object.freeze([]),
    bootFragmentPresent: () => false,
    bodyMarkerPresent: () => false,
    notify: () => {},
  })
  clashRoot.provide('uiProjects', clashService)
  const first = clashRoot.plugin({
    name: 'ui-project-first',
    inject: ['uiProjects'],
    apply(ctx) {
      ctx.uiProjects.register(skinManifest, { apply() {}, cleanup() {} })
    },
  })
  await first.await()
  let clash
  try {
    const intruder = clashRoot.plugin({
      name: 'ui-project-intruder',
      inject: ['uiProjects'],
      apply(ctx) {
        ctx.uiProjects.register({ ...skinManifest, package: 'some-other-package' }, { apply() {}, cleanup() {} })
      },
    })
    await intruder.await()
  } catch (error) {
    clash = error
  }
  if (clash !== undefined && String(clash.message ?? clash).includes('some-other-package')) {
    ok('a second package claiming the same project id is refused, by name')
  } else {
    fail(`a cross-package id clash was not refused: ${String(clash?.message ?? 'no error')}`)
  }
  equal(clashService.list().length, 1, 'and the first package keeps the project it registered')

  // Unloading the package withdraws its project, and touches nothing else.
  await skinPackageFiber.dispose()
  for (let attempt = 0; attempt < 20 && service.list().some((project) => project.id === 'liquid-glass'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  equal(service.list().some((project) => project.id === 'liquid-glass'), false, 'unloading the package withdraws its project')
  equal(service.list().length, before, 'and leaves the service exactly as it found it')

  // And the package's declaration passes the conformance checker the CLI uses, over the real package.json.
  const declaration = checkUiProjectDeclaration({
    ...JSON.parse(readFileSync(join(skinRoot, 'package.json'), 'utf8')),
    patchFileExists: existsSync(join(skinRoot, 'cordis.patch.yml')),
  })
  equal(declaration.length, 0, 'the skin package’s own declaration passes the conformance checker')
}

/*
 * WHAT A PACKAGE OWNS, AND WHAT THE USER OWNS — asserted together, because the interesting failure is
 * a cleanup that takes the second with the first.
 *
 * The record is seeded to look like a used installation: the id in `enabled` (the switch the user
 * threw), a settings entry of its own (a recorded confirmation and an option), and a SECOND package's
 * entry, which no part of this withdrawal has any business touching.
 *
 * The decision this pins is deliberate, and it reverses an earlier reading of the specification:
 * `settings[id]` is the USER's data, exactly like `enabled`, so a package going away does not take it
 * with it. Reinstalling restores the configuration the user had, instead of the defaults — and the
 * same rule holds in the `localStorage` fallback record, which stores the same shape.
 */
persistedRecord = {
  ...persistedRecord,
  enabled: ['skeleton'],
  settings: {
    skeleton: { checks: { version: manifest.version, items: { 'readable-copy': true } }, strength: 7 },
    'other-package-project': { strength: 3 },
  },
}
const recordBeforeWithdrawal = JSON.stringify(persist.read())
const notifiedBeforeWithdrawal = notifications

// The whole reason for binding a registration to its caller's fiber.
await skinFiber.dispose()
equal(service.list().length, 0, 'disposing the package withdraws its project: nothing is left registered')
equal(registry.get('skeleton'), undefined, 'and the REAL registry no longer holds it')
equal(appliedProjects, 1, 'the project was applied, so this is a retirement of something live')
equal(cleanedUp, 1, "and retirement ran the project's cleanup, because it goes through the runtime")
equal(insertedCss.length, 0, "every stylesheet the project owned is gone with it")
equal(writes, 0, "and the user's record was not written by the withdrawal")
equal(
  JSON.stringify(persist.read()),
  recordBeforeWithdrawal,
  "the user's record is byte-identical afterwards: the switch, this project's own settings and the other package's entry all survive",
)
equal(
  persist.read().enabled.includes('skeleton'),
  true,
  'the id stays in `enabled`, so a reinstall restores the choice the user made rather than the default',
)
equal(
  persist.read().settings?.skeleton?.checks?.items?.['readable-copy'],
  true,
  "and the recorded confirmation survives with it: settings are the user's data, not the package's cache",
)
equal(
  persist.read().settings?.['other-package-project']?.strength,
  3,
  "while a different package's entry was never in question",
)
equal(
  notifications,
  notifiedBeforeWithdrawal + 1,
  'and the panel is asked to re-render exactly once, so the card for a package that is gone does not linger',
)

// Ownership: the same id from another package is refused, and both packages are named.
const holder = clientRoot.plugin(skinClient)
await holder.await()
/*
 * The other half of the decision above, and the reason for it: a package that comes back finds what
 * the user had. Not "reinstalling is as good as a fresh install" — that would quietly throw away a
 * recorded verification, which is the one piece of configuration a person cannot reproduce by
 * clicking around.
 */
equal(
  appliedProjects,
  2,
  'reinstalling the package applies the project again, because the record still says the user wants it',
)
equal(
  persist.read().settings?.skeleton?.checks?.items?.['readable-copy'],
  true,
  'and the configuration it had recorded is still there for it to come back to',
)

/*
 * A VERSION CHANGE — what an update looks like from the record's side.
 *
 * The package goes away and comes back with a different version, which is what `git pull` plus a rebuild
 * looks like to this layer. The claim under test is Round 36's decision: the record belongs to the USER,
 * so a new version of the package does not rewrite it. The confirmation it holds then describes a version
 * that is no longer registered — which is the exact input to the store's `stale` verdict.
 *
 * Written AFTER the reinstall above, because it disposes that registration: a test that reaches for a
 * `const` before its declaration fails with a ReferenceError rather than an assertion, which is exactly
 * what the first version of this block did.
 */
await holder.dispose()
const upgraded = clientRoot.plugin({
  name: 'ui-project-skeleton-upgraded',
  inject: ['uiProjects'],
  apply(ctx) {
    ctx.uiProjects.register({ ...manifest, version: '9.9.9' }, { apply() {}, cleanup() {} })
  },
})
await upgraded.await()
equal(persist.read().enabled.includes('skeleton'), true, 'a new version does not drop the switch the user set')
equal(
  persist.read().settings?.skeleton?.checks?.version,
  manifest.version,
  'and the recorded confirmation still carries the version it was made against',
)
equal(
  persist.read().settings?.['other-package-project']?.strength,
  3,
  "while another package's settings were never in question",
)
equal(registry.get('skeleton')?.version, '9.9.9', 'the registry really does report the new version')
if (registry.get('skeleton')?.version !== persist.read().settings?.skeleton?.checks?.version) {
  ok("the record and the registration disagree, which is the input to the store's stale verdict")
}
else {
  fail('the record and the registration agree, so nothing would ever read as stale')
}
let conflict
try {
  const intruder = clientRoot.plugin({
    name: 'ui-project-intruder',
    inject: ['uiProjects'],
    apply(ctx) {
      ctx.uiProjects.register({ ...manifest, package: 'dsh-ui-project-other', version: '9.9.9' }, { apply() {} })
    },
  })
  await intruder.await()
} catch (error) {
  conflict = error
}
const conflictText = conflict === undefined ? '' : String(conflict.message ?? conflict)
if (conflictText.includes('dsh-ui-project-skeleton') && conflictText.includes('dsh-ui-project-other')) {
  ok('an id already owned by another package is refused, and the message names both packages')
} else {
  fail(`a second package registered the same id (error: ${conflictText.slice(0, 140) || 'none'})`)
}
equal(service.refusals().length, 1, 'and the refusal is recorded for the panel to show')
equal(service.list().length, 1, 'while the original registration is untouched')

// The registration order rule: a fiber that is already gone cannot own anything.
const doomed = clientRoot.plugin(skinClient)
await doomed.await()
const doomedCtx = doomed.ctx
await doomed.dispose()
const before = service.list().length
let inactiveError
try {
  service.register.call({ ctx: doomedCtx }, { ...manifest, id: 'skeleton-two' }, { apply() {} })
} catch (error) {
  inactiveError = error
}
equal(
  inactiveError === undefined ? 'no throw' : inactiveError.code ?? inactiveError.name,
  'INACTIVE_EFFECT',
  'registering from a disposed fiber throws INACTIVE_EFFECT rather than creating an unowned project',
)
equal(service.list().length, before, 'and nothing was added: the lifetime binding comes before the table')

/*
 * The guard against this file growing a stub again. The bug this round fixed existed because a stub
 * stood in for the class it was testing and accepted what the class refuses; the assertion is on
 * the SOURCE, because that is where the substitution would reappear.
 */
const check = (condition, label) => (condition ? ok(label) : fail(label))
const ownSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
check(
  !/const definitions = new Map\(/.test(ownSource) && !/register\(definition\) \{\n\s*definitions\.set/.test(ownSource),
  'no stub registry in this file: the real UiProjectRegistry is the one under test',
)
check(
  ownSource.includes("await import(pathToFileURL(join(frameworkRoot, 'src', 'client', 'registry.js')).href)"),
  'and the real registry is what it imports',
)
check(ownSource.includes('createRuntime('), 'and the real runtime is constructed here, not in another process')

// ── 5. the patch files the loader will read ──────────────────────────────────

for (const [label, root] of [
  ['dsh-ui-projects', frameworkRoot],
  ['dsh-ui-project-skeleton', skeletonRoot],
]) {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const rows = [...text.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)]
  equal(
    pkg.dsh?.bundle?.patch,
    './cordis.patch.yml',
    `${label} declares dsh.bundle.patch, without which the loader would never admit it`,
  )
  equal(rows.length, 1, `${label}'s patch inserts exactly one row`)
  if (text.includes(`name: ${pkg.name}`)) ok(`${label}'s row resolves the package by its own name`)
  else fail(`${label}'s patch row does not name the package`)
}

// ── 6. the tracker contract: what makes the caller's context available at all ─

/*
 * WHY THIS IS ASSERTED RATHER THAN ASSUMED.
 *
 * `register` binds a registration's lifetime to the CALLER's fiber, and it can only do that
 * because the service object declares Cordis's tracker — `Symbol.for('cordis.tracker')` with
 * `{ property: 'ctx', noShadow: true }` — which is what makes `getTraceable` wrap the service for
 * the calling context. Nothing here can import that symbol from Cordis: the browser bundle has no
 * Cordis dependency, so the marker is hand-written in `src/client/service.js`.
 *
 * So the contract is pinned from the outside, in three parts: the marker works, what it yields is
 * the caller rather than the provider, and a service WITHOUT it gets nothing at all. If a Cordis
 * upgrade renames the symbol, changes the tracker's shape, or starts wrapping every service, the
 * first assertion fails here — instead of a user reporting that unloading a package left a dead
 * project behind in the panel.
 */
const TRACKER = Symbol.for('cordis.tracker')
const providerRoot = new Context()
let seenCtx
let seenFiberName
let seenBareCtx = 'never called'
let callerCtx
providerRoot.provide('probe', {
  [TRACKER]: { property: 'ctx', noShadow: true },
  whoAmI() {
    seenCtx = this.ctx
    seenFiberName = this.ctx?.fiber?.name
    return seenFiberName
  },
})
providerRoot.provide('bareProbe', {
  whoAmI() {
    seenBareCtx = this.ctx
  },
})
const callerFiber = providerRoot.plugin({
  name: 'the-caller',
  inject: ['probe', 'bareProbe'],
  apply(ctx) {
    callerCtx = ctx
    ctx.probe.whoAmI()
    ctx.bareProbe.whoAmI()
  },
})
await callerFiber.await()
equal(
  seenFiberName,
  'the-caller',
  `the tracker contract (cordis ${cordisPkg.version}): a marked service sees the calling fiber`,
)
equal(seenCtx === callerCtx, true, 'and what it sees IS the caller’s own context, not the provider’s')
equal(seenCtx === providerRoot, false, 'specifically not the context the service was provided on')
equal(
  seenBareCtx,
  undefined,
  'an unmarked service sees no caller context at all — which is why this service writes the marker by hand',
)

/*
 * And the behavioural half of the same claim, on the real service: two callers, two registrations,
 * two lifetimes. If `register` had captured the provider's context instead of each caller's, both
 * projects would die together and the first disposal would take the other package's project with
 * it.
 */
const baseline = service.list().length
const alphaFiber = clientRoot.plugin({
  name: 'alpha-package-client',
  inject: ['uiProjects'],
  apply(ctx) {
    ctx.uiProjects.register({ ...manifest, id: 'alpha-project', package: 'pkg-alpha' }, { apply() {} })
  },
})
await alphaFiber.await()
const betaFiber = clientRoot.plugin({
  name: 'beta-package-client',
  inject: ['uiProjects'],
  apply(ctx) {
    ctx.uiProjects.register({ ...manifest, id: 'beta-project', package: 'pkg-beta' }, { apply() {} })
  },
})
await betaFiber.await()
equal(service.list().length, baseline + 2, 'two callers register two projects of their own')
await alphaFiber.dispose()
const survivors = service.list()
equal(survivors.length, baseline + 1, 'disposing one caller withdraws exactly its own project')
equal(
  survivors.some((project) => project.id === 'beta-project'),
  true,
  'and the other caller keeps the project it registered',
)
await betaFiber.dispose()
equal(service.list().length, baseline, 'disposing the last caller leaves the table as it was')


// ── 7. the installed-package endpoint ────────────────────────────────────────

/*
 * Mounted on the Connection service's fetch registry, not on the webserver: the webserver implements
 * no authentication at all, and this payload names every installed package. The service is stubbed
 * here because what is under test is OUR registration and OUR payload — and the stub records enough
 * to assert the shape the real one demands.
 */
const { registerInstalledEndpoint, INSTALLED_PATH, INSTALLED_SCHEMA_VERSION, CHANGELOG_PATH, UPDATES_PATH } = await import(
  pathToFileURL(join(frameworkRoot, 'src', 'host', 'installed-endpoint.js')).href
)

const registeredRoutes = []
const endpointRoot = new Context()
endpointRoot.provide('connection', {
  fetch: {
    register(route) {
      registeredRoutes.push(route)
      return async () => {
        registeredRoutes.pop()
      }
    },
  },
})
const endpointCtx = endpointRoot
endpointCtx.logger = { info: () => {}, warn: () => {} }

const scanFixture = {
  profileName: 'web',
  readAt: '2026-01-01T00:00:00.000Z',
  dependencies: [
    { name: 'dsh-ui-projects', spec: 'link:E:/dsh/plugins/dsh-ui-projects', resolved: true, version: '0.1.0', dir: 'E:/dsh/plugins/dsh-ui-projects', realDir: 'E:/dsh/plugins/dsh-ui-projects', via: 'link', kind: 'bundle', bundled: true, problems: [] },
  ],
  bundles: { all: ['dsh-ui-projects'], inBox: [], fromDependencies: ['dsh-ui-projects'] },
  uiProjectPackages: [],
  orphanedBindings: [],
  unresolved: [],
  problems: [],
}

const askedFor = []
const disposeEndpoint = registerInstalledEndpoint(endpointCtx, {
  scan: async () => scanFixture,
  // The channel reader and the checker are injected here the way `src/host/index.js` injects them: the
  // route's behaviour — which packages it asks about, and with which channel — is what this pins.
  channels: (name) => (name === 'dsh-ui-projects' ? 'beta' : 'stable'),
  check: async (packages) => {
    askedFor.push(packages)
    return { checkedAt: '2026-01-01T00:00:00.000Z', results: [] }
  },
})
/*
 * THREE ROUTES SINCE PHASE 3, STEP 1. The listing and the CHANGELOG were joined by the update check: the
 * same fence, the same scan, asked for on demand and never from the boot path. Selected BY PATH rather
 * than by position, because position is what a fourth route would silently break.
 */
equal(registeredRoutes.length, 3, 'the endpoint registers exactly three routes: the listing, the changelog and the update check')
equal(
  registeredRoutes.map((route) => route.path).sort().join(','),
  [INSTALLED_PATH, CHANGELOG_PATH, UPDATES_PATH].sort().join(','),
  'at the three namespaced paths, and nothing else',
)
const listingRoute = registeredRoutes.find((route) => route.path === INSTALLED_PATH)
const changelogRoute = registeredRoutes.find((route) => route.path === CHANGELOG_PATH)
const updatesRoute = registeredRoutes.find((route) => route.path === UPDATES_PATH)
equal(
  [INSTALLED_PATH, CHANGELOG_PATH, UPDATES_PATH].every((path) => path.startsWith('/api/')),
  true,
  'all three under /api, which is the only prefix the Host/Origin fence and the browser session cover',
)
equal(
  [listingRoute, changelogRoute, updatesRoute].map((route) => route?.methods?.join(',')).join('|'),
  'GET|GET|GET',
  'and all three answer GET only',
)

/*
 * THE UPDATE ROUTE'S OWN BEHAVIOUR, driven with stubs.
 *
 * ADDED AFTER the phase-3 step-1 red set, and disclosed as such: the red pinned that the route EXISTS,
 * and this pins what it DOES — which packages it asks about and which channel it asks with. Without it,
 * a route that answered `{results: []}` for everything would pass every other assertion here.
 */
const updatesPayload = await (await updatesRoute.fetch(new Request('http://127.0.0.1' + UPDATES_PATH))).json()
equal(updatesPayload.checkedAt, '2026-01-01T00:00:00.000Z', 'the update payload says when the registry was asked')
equal(
  JSON.stringify(askedFor),
  JSON.stringify([[{ name: 'dsh-ui-projects', version: '0.1.0', channel: 'beta' }]]),
  'and the route asked about each resolved dependency, with the channel its user chose',
)

const okResponse = await listingRoute.fetch(new Request('http://127.0.0.1' + INSTALLED_PATH))
const okPayload = await okResponse.json()
equal(okPayload.schemaVersion, INSTALLED_SCHEMA_VERSION, 'the payload carries its own version')
equal(okPayload.scan.profileName, 'web', 'and the profile it describes, by name')
equal(okPayload.scan.dependencies[0].name, 'dsh-ui-projects', 'and the packages in it')
equal(
  Object.prototype.hasOwnProperty.call(okPayload.scan.dependencies[0], 'dir'),
  false,
  'and NOT the absolute directories the CLI keeps for a human: the payload is a projection',
)

/*
 * The changelog route, end to end against a REAL directory: the fixture's `dir` is this package's own
 * source tree, which ships the 284 KB CHANGELOG.md this round was designed around. That is the one
 * assertion no unit test can make — that the directory the scan resolved is the directory the reader
 * opens — and it is also what proves the size cap does not get in the way of a real file.
 */
const changelogResponse = await changelogRoute.fetch(new Request('http://127.0.0.1' + CHANGELOG_PATH + '?name=dsh-ui-projects'))
const changelogPayload = await changelogResponse.json()
equal(changelogPayload.reason, null, 'the changelog route reads the directory the scan resolved')
equal(changelogPayload.sections.length, 1, 'and answers with the newest section')
equal(
  String(changelogPayload.sections[0].heading).startsWith('## '),
  true,
  'whose heading is the file own heading line',
)
equal(changelogPayload.sections[0].truncated, true, 'and a 284 KB changelog has a section long enough to be capped')

const failing = registerInstalledEndpoint(endpointCtx, {
  scan: async () => {
    throw new Error('no profile')
  },
})
const failingRoutes = registeredRoutes.slice(-3)
const failPayload = await (
  await failingRoutes.find((route) => route.path === INSTALLED_PATH).fetch(new Request('http://127.0.0.1' + INSTALLED_PATH))
).json()
equal(failPayload.error.message, 'no profile', 'a failed scan becomes a payload, not a thrown transport error')
equal(failPayload.scan, undefined, 'and carries no scan at all')
const failChangelog = await (
  await failingRoutes
    .find((route) => route.path === CHANGELOG_PATH)
    .fetch(new Request('http://127.0.0.1' + CHANGELOG_PATH + '?name=dsh-ui-projects'))
).json()
equal(failChangelog.reason, 'unreadable', 'and the changelog route answers the same failure with its own reason')
equal(failChangelog.sections.length, 0, 'carrying no sections, so the row has nothing to render but the sentence')
failing()

const withoutConnection = registerInstalledEndpoint({ get: () => undefined, logger: { warn: () => {} } }, { scan: async () => scanFixture })
equal(typeof withoutConnection, 'function', 'a composition without a connection service skips the endpoint instead of refusing the row')
withoutConnection()
disposeEndpoint()

process.stdout.write(failed === 0 ? `\n${passed} assertions, 0 failing\n` : `\n${passed} assertions, ${failed} failing\n`)
process.exitCode = failed === 0 ? 0 : 1
