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
        callback({ settings: { register } })
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

// ── 6. the first-paint injection ─────────────────────────────────────────────
//
// This is the half of step 5 that has to live on the Host: the first frame happens before the
// client bundle is fetched, so the critical CSS and the project marker must already be in the
// served HTML. Asserted here rather than in the browser suite because the shapes are what matter
// — one inert stylesheet, and a marker script only when the document says the skin is on.
const ON_RECORD = { v: 1, initialized: true, enabled: ['liquid-glass'], settings: {}, touched: true }

/** Fire the injection table the webserver emits, for one settings section. */
function collectInjections(section) {
  const probe = makeContext(() => {}, section)
  module.apply(probe.ctx)
  const emit = probe.handlers.get('webserver/index-inject')
  if (typeof emit !== 'function') return undefined
  const table = []
  emit(table)
  return table
}

const enabledTable = collectInjections(ON_RECORD)
if (enabledTable === undefined) {
  fail('the host half does not answer webserver/index-inject, so nothing reaches the first frame')
} else {
  ok('answers webserver/index-inject')
  const styles = enabledTable.filter((row) => row.kind === 'style')
  /*
   * Two scripts, with two different jobs, told apart by what they write.
   *
   * The presence announcement is new, and it is the ONLY evidence the browser half can have that
   * this package's host row mounted on this page load — the two halves run in different runtimes
   * and share no service, so the rendered document is the one channel they have (see
   * `src/client/boot-presence.js`). It is emitted whether or not the project is on, which is what
   * lets "the host half is missing" be told apart from "the project is off". The marker is the row
   * that decides the first frame.
   */
  const presence = enabledTable.filter(
    (row) => row.kind === 'script' && (row.text ?? '').includes('__dshUiProjectRows'),
  )
  const markers = enabledTable.filter((row) => row.kind === 'script' && (row.text ?? '').includes('data-ui-project-'))

  if (presence.length === 1) ok('announces the package once, for the browser half to read')
  else fail(`expected 1 presence row, saw ${presence.length}`)
  if (presence[0]?.placement === 'body') ok("the presence row is placed 'body' — read before the client bundle")
  else fail(`presence placement is ${JSON.stringify(presence[0]?.placement)}, expected 'body'`)
  if ((presence[0]?.text ?? '').includes('liquid-glass')) ok('the presence row names the project it speaks for')
  else fail('the presence row does not name the project id')

  if (styles.length === 1) {
    ok('inlines exactly one first-paint stylesheet')
  } else {
    fail(`expected 1 style row, saw ${styles.length}`)
  }

  const css = styles[0]?.text ?? ''
  if (css.includes('body[data-ui-project-liquid-glass="on"]')) {
    ok('the stylesheet is scoped to the project marker')
  } else {
    fail('the first-paint stylesheet carries no project marker — it would restyle the default UI')
  }
  /*
   * The tag is how the browser half answers "did my first-paint fragment reach this page?" with no
   * cross-plane channel at all: it scans the document's stylesheets for this exact line. The build
   * strips comments from the payload it inlines, so the tag is prepended by the service rather than
   * written into `boot.css` — which makes this assertion the only thing keeping the two in step.
   */
  if (css.startsWith('/* ui-project:liquid-glass boot-fragment v1 */')) {
    ok('the stylesheet opens with the fragment tag the browser half scans for')
  } else {
    fail(`the first-paint stylesheet does not open with its fragment tag: ${JSON.stringify(css.slice(0, 60))}`)
  }
  // Inlined verbatim into an element: a "<" could close it early and spill CSS into the document.
  if (!css.includes('<')) ok('the stylesheet contains no "<" (safe to inline)')
  else fail('the stylesheet contains "<", which can close the element it is inlined into')

  if (markers.length === 1) {
    ok('marks the document when the record says the skin is on')
  } else {
    fail(`expected 1 marker script for an enabled skin, saw ${markers.length}`)
  }
  if (markers[0]?.placement === 'body') {
    ok("the marker script is placed 'body'")
  } else {
    fail(`marker placement is ${JSON.stringify(markers[0]?.placement)}, expected 'body' — the marker is on <body>`)
  }
  const script = markers[0]?.text ?? ''
  if (script.includes('data-ui-project-liquid-glass')) ok('the script sets the project marker')
  else fail('the marker script does not set the project marker')
  if (!script.includes('<')) ok('the script contains no "<" (safe to inline)')
  else fail('the script contains "<", which can close the element it is inlined into')

  // Off, and unsaid. Both must paint the default look with nothing to undo — and the presence row
  // is still emitted, because "off" and "not mounted" are different states.
  const offTable = collectInjections({ ...ON_RECORD, enabled: [] }) ?? []
  // Script rows only: the inert stylesheet legitimately carries the marker inside its selectors,
  // which is exactly what makes it inert when the project is off.
  const offMarkers = offTable.filter((row) => row.kind === 'script' && (row.text ?? '').includes('data-ui-project-'))
  if (offMarkers.length === 0) ok('an enabled=[] record emits no marker script')
  else fail(`a disabled skin still emitted ${offMarkers.length} marker script(s)`)
  if (offTable.some((row) => (row.text ?? '').includes('__dshUiProjectRows'))) {
    ok('a disabled skin still announces its host half, so the panel can tell it apart from a missing one')
  } else {
    fail('a disabled skin stopped announcing itself — a missing host half would look identical')
  }

  const bareTable = collectInjections(undefined) ?? []
  if (bareTable.length === 2 && bareTable[0].kind === 'script' && bareTable[1].kind === 'style') {
    ok('with no settings service: the presence row and the inert stylesheet, and no marker')
  } else {
    fail(`with no settings service the table is ${JSON.stringify(bareTable.map((row) => row.kind))}`)
  }
}

process.stdout.write(failures === 0 ? '\nhost half is loadable\n' : `\n${failures} host problem(s)\n`)
process.exitCode = failures === 0 ? 0 : 1
