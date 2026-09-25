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
 * @param register - stands in for `ctx.settings.register`.
 */
function makeContext(register) {
  const calls = []
  return {
    calls,
    ctx: {
      logger: { info: (line) => calls.push(`info:${line}`), warn: (line) => calls.push(`warn:${line}`) },
      inject: (deps, callback) => {
        calls.push(`inject:${JSON.stringify(deps)}`)
        callback({ settings: { register } })
      },
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

process.stdout.write(failures === 0 ? '\nhost half is loadable\n' : `\n${failures} host problem(s)\n`)
process.exitCode = failures === 0 ? 0 : 1
