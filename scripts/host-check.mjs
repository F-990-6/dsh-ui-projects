/**
 * Validate the host half the way dsh does.
 *
 * A missing host dependency or a throw during `apply` is uniquely nasty: the
 * client bundle can be perfect, every test that loads it can pass, and dsh still
 * refuses the loader entry and sits on "Loading plugins…". This script checks
 * the things that actually cause that — every bare import resolving, and `apply`
 * running against a plausible context — plus the settings-registration contract
 * this row exists to fulfil.
 *
 * The registration checks are not ceremony. The namespace is duplicated by
 * necessity across the two halves (`src/host/index.js` and
 * `src/client/persist.js`), and a drift between them does not fail: the browser
 * half simply reports `unavailable` and moves durable state to `localStorage`.
 * Asserting the two agree is the only thing that turns that silent downgrade
 * into a test failure.
 *
 * Usage: node scripts/host-check.mjs
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { TEST_SKIN_BOOT_CSS, TEST_SKIN_ID } from './test-skin.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const require = createRequire(join(packageRoot, 'package.json'))

let failures = 0
const ok = (line) => process.stdout.write(`  ok    ${line}\n`)
const fail = (line) => {
  failures += 1
  process.stdout.write(`  FAIL  ${line}\n`)
}
const note = (line) => process.stdout.write(`  note  ${line}\n`)

/** Structural comparison over JSON-shaped values. */
const sameShape = (left, right) => JSON.stringify(left) === JSON.stringify(right)

const EXPECTED_NAMESPACE = 'ui-projects'

// ── 1. every bare import in the built host half must resolve ─────────────────
const source = await readFile(join(packageRoot, 'lib', 'index.js'), 'utf8')
const specs = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1])

for (const spec of specs) {
  if (spec.startsWith('.') || spec.startsWith('node:')) continue
  try {
    require.resolve(spec)
    ok(`import resolves: ${spec}`)
  } catch {
    fail(`import does NOT resolve: ${spec}`)
  }
}

// ── 2. apply against a plausible context ─────────────────────────────────────
const module = await import(pathToFileURL(join(packageRoot, 'lib', 'index.js')).href)

/**
 * Fabricate the slice of a Cordis context this row touches.
 *
 * `on` and `get` were added when the row gained first-paint duties: it subscribes to
 * `webserver/index-inject` and reads the settings document at emit time. A context missing either
 * one does not fail a little — `apply` throws, and dsh refuses the loader entry.
 * @param register - stands in for `ctx.settings.register`.
 * @param section - what the settings document holds for this namespace, or undefined for
 *   "no settings service composed".
 */
function makeContext(register, section) {
  const calls = []
  /** @type {Map<string, (arg: any) => void>} */
  const handlers = new Map()
  /** Services the row provided, by name — `uiProjectsHost` among them. */
  const provided = new Map()
  return {
    calls,
    handlers,
    provided,
    ctx: {
      logger: { info: (line) => calls.push(`info:${line}`), warn: (line) => calls.push(`warn:${line}`) },
      inject: (deps, callback) => {
        calls.push(`inject:${JSON.stringify(deps)}`)
        /*
         * A CONTEXT, not a bag of services. The real `ctx.inject` hands the callback a context scoped
         * to the dependency, and the row reaches `connection` through it — so the stub has to answer
         * `get` the way a context does, or the row dies with `ctx.get is not a function` and the
         * failure says nothing about the dependency.
         */
        const connection = {
          fetch: {
            register: (route) => {
              calls.push(`endpoint:${route.path}:${(route.methods ?? []).join(',')}`)
              return () => {}
            },
          },
        }
        callback({
          get: (service) => {
            if (service === 'connection') return connection
            if (service === 'settings' && section !== undefined) {
              return { get: (namespace) => (namespace === EXPECTED_NAMESPACE ? section : undefined) }
            }
            return undefined
          },
          settings: { register },
        })
      },
      on: (event, handler) => {
        calls.push(`on:${event}`)
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
      /*
       * The row provides `uiProjectsHost` — the service every UI project package's host half
       * injects for its first-paint rows. A stub context without `provide` does not fail a little:
       * `apply` throws, and with it the loader entry. Recorded rather than ignored, so a test can
       * ask what was provided.
       */
      /*
       * The row mounts effects (the installed-package endpoint among them), so a context without
       * `effect` fails as a boot failure rather than as a test failure — the same lesson `provide`
       * taught one round earlier.
       */
      effect: (callback) => {
        const result = callback()
        return typeof result === 'function' ? result : () => {}
      },
      provide: (name, value) => {
        calls.push(`provide:${name}`)
        provided.set(name, value)
        return () => provided.delete(name)
      },
      get: (service) =>
        service === 'settings' && section !== undefined
          ? { get: (namespace) => (namespace === EXPECTED_NAMESPACE ? section : undefined) }
          : undefined,
    },
  }
}

const registrations = []
const { calls, ctx } = makeContext((ns, schema, options) => {
  registrations.push({ ns, schema, options })
})

try {
  module.apply(ctx)
  const bad = calls.filter((line) => line.startsWith('inject-threw'))
  if (bad.length > 0) fail(`apply reported: ${bad.join(', ')}`)
  else ok(`apply ran; ${calls.length} call(s)`)

  /*
   * The row does two things and they now wait differently: the settings namespace runs at apply, the
   * endpoint waits for the connection service. Both are asserted, because "it mounted" and "it did its
   * job" are different claims — and the endpoint one is what the browser round depends on.
   */
  const endpoint = calls.find((line) => line.startsWith('endpoint:'))
  if (endpoint === undefined) fail('the installed-package endpoint was not registered when the connection service appeared')
  else ok(`the endpoint is registered: ${endpoint.slice('endpoint:'.length)}`)
  if (calls.some((line) => line.includes('"connection"'))) ok('and the row waited for the connection service by name')
  else fail('the row did not declare a dependency on the connection service')
} catch (err) {
  fail(`apply threw: ${err instanceof Error ? err.message : String(err)}`)
}

// ── 3. the settings registration contract ────────────────────────────────────
if (registrations.length !== 1) {
  fail(`expected exactly 1 settings.register call, saw ${registrations.length}`)
} else {
  const { ns, schema, options } = registrations[0]

  if (ns === EXPECTED_NAMESPACE) ok(`settings namespace: ${ns}`)
  else fail(`settings namespace is ${JSON.stringify(ns)}, expected ${JSON.stringify(EXPECTED_NAMESPACE)}`)

  if (options?.applies === 'live') ok("registration applies: 'live'")
  else fail(`applies is ${JSON.stringify(options?.applies)}, expected 'live'`)

  // The browser half is a separate bundle and cannot import this constant, so the
  // two copies are compared here instead.
  const persistSource = await readFile(join(packageRoot, 'src', 'client', 'persist.js'), 'utf8')
  const clientNamespace = /SETTINGS_NS\s*=\s*'([^']+)'/.exec(persistSource)?.[1]
  if (clientNamespace === ns) ok(`browser half binds the same namespace (${clientNamespace})`)
  else fail(`namespace drift: host registers ${JSON.stringify(ns)}, client persist.js declares ${JSON.stringify(clientNamespace)}`)

  // ── 4. the schema, against records the client actually writes ──────────────
  const defaults = { v: 1, initialized: false, enabled: [], settings: {}, touched: false }
  try {
    const resolved = schema({})
    if (sameShape(resolved, defaults)) ok('an absent section resolves to defaults')
    else fail(`defaults are wrong: ${JSON.stringify(resolved)}`)
  } catch (err) {
    fail(`an absent section must resolve, but threw: ${err.message}`)
  }

  const written = { v: 1, initialized: true, enabled: ['liquid-glass'], settings: { 'liquid-glass': { scale: 1 } }, touched: true }
  try {
    if (sameShape(schema(written), written)) ok('a record the client writes round-trips unchanged')
    else fail(`round trip altered the record: ${JSON.stringify(schema(written))}`)
  } catch (err) {
    fail(`a record the client writes was rejected: ${err.message}`)
  }

  for (const [label, record] of [
    ['v is not a number', { v: 'x' }],
    ['enabled is not an array', { enabled: 'nope' }],
  ]) {
    try {
      schema(record)
      fail(`schema accepted an invalid record (${label})`)
    } catch {
      ok(`schema rejects: ${label}`)
    }
  }

  // Measured, not assumed: schemastery preserves keys the schema does not name.
  // That is the behaviour we want (an older dsh must not delete a newer field),
  // so it is pinned here rather than left to chance.
  try {
    const withExtra = schema({ v: 1, futureField: 'kept' })
    if (withExtra.futureField === 'kept') ok('unknown keys are preserved (forward-compatible)')
    else fail(`unknown keys are dropped: ${JSON.stringify(withExtra)}`)
  } catch (err) {
    fail(`an unknown key must not reject the record: ${err.message}`)
  }
}

// ── 5. a failing registration must degrade, not throw ────────────────────────
const failing = makeContext(() => {
  throw new Error('settings namespace "ui-projects" is already registered')
})
try {
  module.apply(failing.ctx)
  const warned = failing.calls.some((line) => line.startsWith('warn:'))
  if (warned) ok('a registration failure is reported and swallowed')
  else fail('a registration failure produced no warning')
} catch (err) {
  fail(`a registration failure must not escape apply: ${err.message}`)
}

// ── 6. the first-paint CONTRACT, asserted against the fixture ────────────────
//
// The first frame happens before the client bundle is fetched, so the critical CSS and the project marker
// must already be in the served HTML. The CONTRACT for that lives in the framework (`uiProjectsHost`); the
// ROWS are contributed by whichever package owns the stylesheet.
//
// This check used to read the framework's own push for its shipped skin, naming `liquid-glass` in the
// process. It now hands the suite's fixture stylesheet to the service instead: same contract, no real
// project named, and it keeps working in 8c when the framework stops contributing rows of its own.
const FIXTURE_ON_RECORD = { v: 1, initialized: true, enabled: [TEST_SKIN_ID], settings: {}, touched: true }

/**
 * The host service, as a package's host half reaches it: provide `uiProjectsHost`, then ask it for rows.
 * @param {any} section the settings section, or `undefined` for a composition without a settings service
 */
function bootRowsFor(section) {
  const probe = makeContext(() => {}, section)
  module.apply(probe.ctx)
  const service = probe.provided.get('uiProjectsHost')
  if (service === undefined || typeof service.bootRows !== 'function') return undefined
  return service.bootRows(TEST_SKIN_ID, TEST_SKIN_BOOT_CSS)
}

const rows = bootRowsFor(FIXTURE_ON_RECORD)
if (rows === undefined) {
  fail('the host half provides no uiProjectsHost.bootRows, so no package can answer the first frame')
} else {
  ok('the host half provides uiProjectsHost, the service every UI project package asks for its rows')
  const kinds = rows.map((row) => row.kind).join(',')
  if (kinds === 'script,style,script') ok('bootRows emits presence, then the stylesheet, then the marker — in that order')
  else fail(`bootRows emitted ${kinds}, expected script,style,script`)

  /*
   * The presence announcement is the ONLY evidence the browser half can have that a package's host row
   * mounted on this page load — the two planes share no service, so the rendered document is the one
   * channel they have (see `src/client/boot-presence.js`). It names the project it speaks for, and it is
   * emitted whether or not the project is on, which is what lets "the host half is missing" be told apart
   * from "the project is off".
   */
  if ((rows[0].text ?? '').includes('__dshUiProjectRows') && (rows[0].text ?? '').includes(TEST_SKIN_ID)) {
    ok('the presence row names the project it speaks for, for the browser half to read')
  } else {
    fail(`the presence row does not announce ${TEST_SKIN_ID}`)
  }
  if (rows[0].placement === 'body') ok("the presence row is placed 'body' — read before the client bundle")
  else fail(`presence placement is ${JSON.stringify(rows[0].placement)}, expected 'body'`)

  const css = rows[1].text ?? ''
  if (css.startsWith(`/* ui-project:${TEST_SKIN_ID} boot-fragment v1 */`)) {
    ok('the stylesheet opens with the fragment tag the browser half scans for')
  } else {
    fail(`the first-paint stylesheet does not open with its fragment tag: ${JSON.stringify(css.slice(0, 60))}`)
  }
  if (css.includes(`body[data-ui-project-${TEST_SKIN_ID}="on"]`)) ok('the stylesheet is scoped to the project marker')
  else fail('the first-paint stylesheet carries no project marker — it would restyle the default UI')
  // Inlined verbatim into an element: a "<" could close it early and spill CSS into the document.
  if (!css.includes('<')) ok('the stylesheet contains no "<" (safe to inline)')
  else fail('the stylesheet contains "<", which can close the element it is inlined into')

  const marker = rows[2].text ?? ''
  if (marker.includes(`data-ui-project-${TEST_SKIN_ID}`) && marker.includes('data-ui-skin')) {
    ok('the marker row sets both the project marker and the skin attribute the runtime reads back')
  } else {
    fail('the marker row does not set the markers the runtime reads back')
  }
  if (marker.includes(JSON.stringify(TEST_SKIN_ID))) ok('and names the project it turns on')
  else fail('the marker script does not name the project')
  if (!marker.includes('<')) ok('the script contains no "<" (safe to inline)')
  else fail('the script contains "<", which can close the element it is inlined into')

  // Off: the stylesheet is still inlined (every selector carries the marker, so it is inert) and the
  // presence row is still there, but nothing marks the document.
  const offRows = bootRowsFor({ ...FIXTURE_ON_RECORD, enabled: [] }) ?? []
  if (offRows.length === 2) ok('with the record off: the presence row and the inert stylesheet, and no marker')
  else fail(`with the record off the rows are ${JSON.stringify(offRows.map((row) => row.kind))}`)
  if (offRows.some((row) => (row.text ?? '').includes('__dshUiProjectRows'))) {
    ok('a disabled project still announces its host half, so a missing one cannot look identical')
  } else {
    fail('the presence row stopped being emitted when the project is off')
  }

  // And with no settings service at all: the same two rows, because "nothing is on" is the safe answer.
  const bareRows = bootRowsFor(undefined) ?? []
  if (bareRows.length === 2 && bareRows[0].kind === 'script' && bareRows[1].kind === 'style') {
    ok('with no settings service: the presence row and the stylesheet, and no marker')
  } else {
    fail(`with no settings service the rows are ${JSON.stringify(bareRows.map((row) => row.kind))}`)
  }
}

process.stdout.write(failures === 0 ? '\nhost half is loadable\n' : `\n${failures} host problem(s)\n`)
process.exitCode = failures === 0 ? 0 : 1
