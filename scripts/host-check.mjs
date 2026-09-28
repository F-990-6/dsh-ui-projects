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
function makeContext(register, section, options = {}) {
  const calls = []
  /** @type {Map<string, (arg: any) => void>} */
  const handlers = new Map()
  /** Services the row provided, by name — `uiProjectsHost` among them. */
  const provided = new Map()
  /** Effect disposers, so a test can unload the row and see what that clears. */
  const disposers = []
  /** `ctx.inject(['connection'], …)` callbacks that were NOT run, for the scenarios that need a wait. */
  const withheld = []
  /*
   * WHEN THE CONNECTION SERVICE ARRIVES, which is the whole subject of section 7 below.
   *
   *   'now'    (the default, and what every other section wants) — the callback runs inside `apply`,
   *            the way it does in a composition whose connection row has already activated.
   *   'never'  — the callback is withheld for the life of the run: a composition without a connection
   *            service at all (Electron over `file://`, a headless profile, every test composition).
   *   'manual' — withheld until `releaseConnection()`, which is a LATE arrival: the service exists but
   *            activates after this row's `apply` returned, which is what a real `dsh web` does.
   */
  const arrival = options.connection ?? 'now'
  const withholds = arrival === 'never' || arrival === 'manual'
  return {
    calls,
    handlers,
    provided,
    /** Run every withheld connection callback, and report how many there were. */
    releaseConnection: () => {
      const pending = withheld.splice(0)
      for (const run of pending) run()
      return pending.length
    },
    /** Unload the row: run every disposer the effects returned. */
    disposeEffects: () => {
      for (const dispose of disposers) dispose()
      return disposers.length
    },
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
              // The one failure the row has to survive visibly: a route that cannot be registered.
              if (options.registerThrows === true) throw new Error('route is already registered')
              return () => {}
            },
          },
        }
        const run = () =>
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
        if (withholds && deps.includes('connection')) {
          withheld.push(run)
          return
        }
        run()
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
       * taught one round earlier. The disposer is KEPT now, because section 7 asks what unloading
       * clears.
       */
      effect: (callback) => {
        const result = callback()
        const dispose = typeof result === 'function' ? result : () => {}
        disposers.push(dispose)
        return dispose
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

  /*
   * A record with one id in it, and the id is the suite's fixture rather than a real project. It used
   * to be `liquid-glass` — the skin this package shipped — which made a schema round-trip assertion
   * depend on which project happened to live here. The shape is what is under test, and the fixture is
   * the only id this repository is entitled to name.
   */
  const written = { v: 1, initialized: true, enabled: [TEST_SKIN_ID], settings: { [TEST_SKIN_ID]: { scale: 1 } }, touched: true }
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

// ── 7. the connection wait notice: a state, an ending, and a clean timer ─────

/**
 * Run `apply` with the notice's timer, its `clearTimeout` and `console.error` under test control.
 *
 * WHY THIS IS POSSIBLE AT ALL, since the question was asked: the row arms a bare GLOBAL `setTimeout`
 * (not `ctx.setTimeout`), and this check runs the real host half in-process — so swapping the two
 * globals around `apply` is enough to decide when the sample is taken. The swap is restored in
 * `finally` for the reason it is dangerous: a leaked fake `setTimeout` would hang every later
 * assertion in this file rather than fail one.
 *
 * The notice is the only timer armed during `apply`, which assertion 1 pins: if that stops being true,
 * the scenario runner is firing the wrong callback and the count is what says so.
 * @param {{ connection?: 'now'|'never'|'manual', registerThrows?: boolean }} options
 * @param {(notice: any) => Promise<void>} body
 */
async function withNoticeControl(options, body) {
  const probe = makeContext(() => {}, undefined, options)
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realConsoleError = console.error
  const timers = []
  const cleared = []
  const errors = []
  globalThis.setTimeout = (callback, delay) => {
    const handle = { callback, delay }
    timers.push(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    cleared.push(handle)
  }
  console.error = (...args) => {
    errors.push(args.map((value) => String(value)).join(' '))
  }
  try {
    module.apply(probe.ctx)
    await body({
      probe,
      timers,
      cleared,
      errors,
      /** Take the sample: run every armed timer's callback. */
      fire: () => {
        for (const timer of timers) timer.callback()
      },
      release: probe.releaseConnection,
      dispose: probe.disposeEffects,
    })
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    console.error = realConsoleError
  }
}

/*
 * THE NOTICE IS A SAMPLE, NOT A VERDICT.
 *
 * It used to say "the connection service has not appeared … the endpoint is not mounted" five seconds
 * in, and never speak again — a permanent claim about a state that changes a second later in the
 * composition this is normally run in (the connection row's own `apply` is async and lives in an earlier
 * layer). A real dsh web printed that line and then listed three packages, which needs a successful
 * authenticated request through that very service.
 *
 * Five scenarios, because five different things were wrong to have to be right: a fast boot must stay
 * silent, a wait must be described as a wait, a late arrival must finish the pair, an arrival before the
 * sample must leave it silent, and unloading must clear the timer.
 */
{
  // 1-3. The connection is already there: the sample is taken and says nothing.
  await withNoticeControl({ connection: 'now' }, async (notice) => {
    if (notice.timers.length === 1) ok('apply arms exactly one timer for the connection wait')
    else fail(`apply armed ${notice.timers.length} timer(s), expected 1`)
    const delay = notice.timers[0]?.delay
    if (delay === 5000) ok('and it is the five-second wait this round reasons about')
    else fail(`the wait notice fires after ${JSON.stringify(delay)}ms, expected 5000`)

    notice.fire()
    if (notice.errors.length === 0) {
      ok('a connection that is already there is never announced: a fast boot stays silent')
    } else {
      fail(`a mounted endpoint still produced console.error: ${JSON.stringify(notice.errors)}`)
    }
  })

  // 4-7. It never arrives: one line, phrased as a state, naming the symptom.
  await withNoticeControl({ connection: 'never' }, async (notice) => {
    notice.fire()
    const line = notice.errors[0]
    if (notice.errors.length === 1) ok('a connection that never arrives is reported exactly once')
    else fail(`expected exactly one line, got ${JSON.stringify(notice.errors)}`)
    if (typeof line === 'string' && line.includes('still waiting')) {
      ok('as a STATE — still waiting — rather than as a verdict about the service')
    } else {
      fail(`the line no longer reads as a state: ${JSON.stringify(line)}`)
    }
    const verdicts = ['has not appeared', 'is not mounted'].filter((phrase) => typeof line === 'string' && line.includes(phrase))
    if (verdicts.length === 0) ok('and it claims neither that the service is absent nor that the endpoint is unmounted')
    else fail(`the line still reports a verdict the page cannot support: ${JSON.stringify(verdicts)}`)
    if (typeof line === 'string' && line.includes('after 5s') && line.includes('cannot read the listing')) {
      ok('while saying how long the wait has been, and the symptom a person will see')
    } else {
      fail(`the line lost the duration or the symptom: ${JSON.stringify(line)}`)
    }
  })

  // 8-10. It arrives after the sample was taken: the pair gets its ending.
  await withNoticeControl({ connection: 'manual' }, async (notice) => {
    notice.fire()
    const waiting = notice.errors.slice()
    notice.release()
    if (notice.errors.length === 2) {
      ok('a late arrival finishes the pair: the notice, then one line saying it arrived')
    } else {
      fail(`expected the waiting line and the arrival line, got ${JSON.stringify(notice.errors)}`)
    }
    const arrival = String(notice.errors[1])
    if (/arrived after \d+(\.\d+)?s; the installed-package endpoint is mounted/.test(arrival)) {
      ok('and the arrival line reports the measured wait and the mount')
    } else {
      fail(`the arrival line is not the measured form: ${JSON.stringify(arrival)}`)
    }
    if (waiting.length === 1 && notice.errors.length === 2 && notice.errors[0] === waiting[0]) {
      ok('and the first line is left exactly as it was: a log gets an ending, it cannot be rewritten')
    } else {
      fail(`the waiting line was replaced or not followed: ${JSON.stringify(notice.errors)}`)
    }
  })

  // 11. It arrives before the sample: the notice must not fire into a mounted composition.
  await withNoticeControl({ connection: 'manual' }, async (notice) => {
    notice.release()
    notice.fire()
    if (notice.errors.length === 0) ok('an arrival before the sample leaves the notice silent when it fires')
    else fail(`the notice fired over a mounted endpoint: ${JSON.stringify(notice.errors)}`)
  })

  // 12. Unloading the row clears the pending timer.
  await withNoticeControl({ connection: 'never' }, async (notice) => {
    notice.dispose()
    if (notice.cleared.length === 1) ok('unloading the row clears the pending notice')
    else fail(`unload cleared ${notice.cleared.length} timer(s), expected 1`)
  })

  // 13-15. The endpoint cannot be mounted: the failure is named, and nothing claims a mount.
  await withNoticeControl({ connection: 'manual', registerThrows: true }, async (notice) => {
    let escaped
    try {
      notice.release()
    } catch (error) {
      escaped = error
    }
    if (escaped !== undefined) ok('a registration failure still reaches Cordis instead of being swallowed here')
    else fail('the registration failure was swallowed by the row')

    const named = notice.errors.filter((line) => line.includes('could not be mounted'))
    if (named.length === 1) ok('and the row says the service arrived but the endpoint could not be mounted')
    else fail(`expected one "could not be mounted" line, got ${JSON.stringify(notice.errors)}`)
    if (notice.errors.some((line) => line.includes('endpoint is mounted')) === false) {
      ok('with no line claiming a mount that did not happen')
    } else {
      fail(`a line claims the endpoint is mounted: ${JSON.stringify(notice.errors)}`)
    }
  })
}

process.stdout.write(failures === 0 ? '\nhost half is loadable\n' : `\n${failures} host problem(s)\n`)
process.exitCode = failures === 0 ? 0 : 1
