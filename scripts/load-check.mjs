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

import { transform } from './bundle-client.mjs'

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
 * text. A loose substring is wrong here and was: the framework's first-paint stylesheet happens to
 * contain the word "skeleton" in one of its selectors, so "rows mentioning skeleton" matched a
 * style row as well — the kind of assertion that passes for the wrong reason until it fails for
 * one. The two conditions below are the contract: the row writes the presence global, and the id
 * it pushes is this package's.
 */
const presenceRows = table.filter((row) => (row.text ?? '').includes('__dshUiProjectRows'))
const forSkeleton = presenceRows.filter((row) => (row.text ?? '').includes('.push("skeleton")'))
if (forSkeleton.length === 1 && forSkeleton[0].kind === 'script') {
  ok('with the framework present, the package emits exactly its presence row')
} else {
  fail(`expected 1 presence row for the package, saw ${forSkeleton.length} of ${presenceRows.length}`)
}
equal(presenceRows.length, 2, 'and every mounted package announces itself exactly once')
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

const { createUiProjectsService } = loadClientModule(join(frameworkRoot, 'src', 'client', 'service.js'))

/**
 * A registry stand-in that keeps what it was handed.
 *
 * The real `registry.js` is a client-tree module with its own imports, and what this check is
 * about is the SERVICE above it: that a registration is stamped with its owner, that a disposal
 * withdraws it, and that a refused registration never reaches the registry at all.
 */
const definitions = new Map()
const registry = {
  register(definition) {
    definitions.set(definition.id, definition)
  },
  get(id) {
    return definitions.get(id)
  },
  ids() {
    return [...definitions.keys()]
  },
  notify() {},
}

const enabled = ['skeleton']
const service = createUiProjectsService({
  registry,
  enabledIds: () => enabled,
  hostRowsAtBoot: Object.freeze(['skeleton']),
  bootFragmentPresent: (id) => id === 'skeleton',
  bodyMarkerPresent: (id) => id === 'skeleton',
  notify: () => {},
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
    ctx.uiProjects.register(manifest, { apply() {}, cleanup() {} })
  },
}

const skinFiber = clientRoot.plugin(skinClient)
await skinFiber.await()

const listed = service.list()
equal(listed.length, 1, 'the package registers one project through the service')
equal(listed[0]?.id, 'skeleton', 'and the project is the one its manifest declares')
equal(listed[0]?.source?.package, 'dsh-ui-project-skeleton', 'the registration records which package owns it')
equal(listed[0]?.version, manifest.version, 'and the version the package declares')
if (definitions.has('skeleton')) ok('the registry below the service holds the project the runtime applies')
else fail('the service reported a registration the registry never received')
equal(
  service.diagnostics().projects.find((project) => project.id === 'skeleton')?.state,
  'ok',
  'a registered, enabled project whose host announced it reads as ok',
)

// The whole reason for binding a registration to its caller's fiber.
await skinFiber.dispose()
equal(service.list().length, 0, 'disposing the package withdraws its project: nothing is left registered')
equal(definitions.get('skeleton')?.type, 'retired', 'and the registry is told to stop applying it')

// Ownership: the same id from another package is refused, and both packages are named.
const holder = clientRoot.plugin(skinClient)
await holder.await()
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

process.stdout.write(failed === 0 ? `\n${passed} assertions, 0 failing\n` : `\n${passed} assertions, ${failed} failing\n`)
process.exitCode = failed === 0 ? 0 : 1
