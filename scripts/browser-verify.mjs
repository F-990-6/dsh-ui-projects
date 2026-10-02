/**
 * Real-browser verification for the Liquid Glass skin.
 *
 * Everything else in this package is verified in Node: the bundle executes, the
 * registry behaves, the CSS is scoped, the tokens are real. What no Node test can
 * answer is the only question a skin ultimately has to answer — *does the running
 * application actually become glass, and does it actually come back?*
 *
 * So this script drives a real Chrome over the DevTools Protocol (WebSocket from
 * Node, no dependency) against a real `dsh web` process, and asserts against the
 * live DOM and computed styles:
 *
 *   1. the Settings › UI section opens and renders the project card
 *   2. clicking the switch turns the skin on, and the DOM says so
 *   3. shipped surfaces really gain `backdrop-filter` — measured, not assumed
 *   4. the shipped design tokens really change value
 *   5. the state survives a reload
 *   6. clicking it off again restores the original computed styles exactly
 *   7. a mobile-sized viewport gets the reduced blur and no overflow
 *   8. no console or page errors are raised along the way
 *
 * Usage (the server URL must include its `?token=`):
 *   node scripts/browser-verify.mjs "http://127.0.0.1:3081/?token=…" [--shot out.png]
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

/*
 * The URL is identified by its SHAPE, not by its position.
 *
 * It used to be `process.argv[2]`, which made one argument order-sensitive while the flags around
 * it were not — so `--no-write` alone became the "page URL", Chrome launched, every navigation
 * failed, and the suite reported fifteen skin failures that were really one bad argument. A harness
 * that answers a usage error with a verdict about the skin is worse than one that refuses to start.
 */
const cliArgs = process.argv.slice(2)
/**
 * `--self-check` runs the refusal rule against real payload shapes and exits, without a URL and
 * without a browser.
 *
 * It exists because that rule cannot be verified by reading it: the first version looked reasonable,
 * passed a self-check of its own, and refused nothing — the self-check was validating an invented
 * ARRAY payload while the client sends an object. A pure function checked against real shapes is the
 * only thing that would have caught it, and it needs to be runnable on its own so the check can be
 * run in the same breath as the edit that changes it.
 */
const selfCheckOnly = cliArgs.includes('--self-check')
const pageUrl = cliArgs.find((argument) => /^https?:\/\//i.test(argument))
if (pageUrl === undefined && !selfCheckOnly) {
  const shown = cliArgs.length === 0 ? '(none)' : cliArgs.join(' ')
  process.stderr.write(
    `usage: node scripts/browser-verify.mjs "<dsh web url with token>" [--shot out.png] [--no-write]\n` +
      `       node scripts/browser-verify.mjs --self-check\n` +
      `  arguments given: ${shown}\n` +
      `  the page URL must start with http:// or https:// (a bare host or a flag is not accepted)\n` +
      "  --no-write    refuse every write to the settings document that carries user choices\n" +
      '  --self-check  check the refusal rule against real payload shapes, then exit\n',
  )
  process.exit(2)
}
const shotIndex = cliArgs.indexOf('--shot')
const shotPath = shotIndex === -1 ? undefined : cliArgs[shotIndex + 1]
/*
 * `--no-write` keeps a run from changing anything a person chose.
 *
 * The concern is real and not hypothetical: the default run records a confirmation against the
 * current version, which overwrites whatever a person had confirmed by hand and accumulates on every
 * re-run. But a blanket "do not persist" would break this suite's own reload assertions — a skin
 * toggle that does not survive a reload fails the test that checks it — so the refusal is aimed at
 * the keys that carry USER CHOICES and nothing else: this plugin's `settings` record (where a
 * checklist confirmation lives) and the theme plugin's namespace (where the appearance preference
 * lives). `enabled`, `initialized`, `touched` and `v` still persist, because the reload assertions
 * and the record's own bookkeeping depend on them.
 *
 * The write path is HTTP, which is what makes this possible at all: every api call is a
 * `POST /api/<service>/<operation>` (see the connection layer's rpc), so the operation is in the URL
 * and the payload is in the body. Nothing here reaches into the page or mocks its code; the request
 * is simply refused in flight, which is also why the plugin's in-memory state still changes and the
 * test can assert the difference between the two.
 *
 * The boundary, stated in so many words, because a flag that sounds broader than it is gets trusted
 * too far — it was, on the first run of this suite that mattered:
 *
 *   "`--no-write` refuses writes to the `settings` key only. It does not refuse
 *   `enabled`/`initialized`/`touched`/`v`: the suite's own reload assertions
 *   require the enabled set to persist, and refusing it would remove the guard
 *   the flag exists to protect. Consequence: file mtime changes; the `settings`
 *   subtree does not."
 *
 * Counted rather than assumed: a full `--no-write` run attempts 42 writes and refuses the 8 that carry
 * `settings`; the other 34 reach the document. That is the whole difference the flag makes.
 */
/**
 * `--verify-refusal` runs the gate and nothing else.
 *
 * The gate is the first thing the suite does under `--no-write` anyway; this mode exists so it can be
 * run on its own, before a full run, on a machine whose settings document matters. It launches Chrome,
 * proves the rule against real payloads, prints the verdict and stops — and because the gate refuses
 * every write while it runs, it cannot change what it is protecting. It implies `--no-write`, because a
 * gate that did not install its interceptor would prove nothing.
 */
const verifyRefusalOnly = cliArgs.includes('--verify-refusal')
const noWrite = cliArgs.includes('--no-write') || verifyRefusalOnly
/** Thrown to end a `--verify-refusal` run after the gate, once its verdict has been recorded. */
const GATE_ONLY = 'gate-only: the refusal gate is the whole run'

/**
 * The namespaces whose writes carry user choices, and the reason to report for each.
 *
 * `ui-projects` is refused on the `settings` path only — its `enabled` and bookkeeping keys are the
 * suite's own business and must persist. `ui-theme` is refused whole: every key in it is a
 * preference somebody set, and the suite has no assertion that depends on one surviving.
 */
const PROTECTED_NAMESPACES = { 'ui-projects': 'settings', 'ui-theme': 'theme' }

/**
 * Why a settings write should be refused under `--no-write`, or null to let it through.
 *
 * THE SHAPE IS FROM THE SOURCE, NOT FROM A GUESS, and the previous version of this rule is why that
 * sentence is in capitals. It was written against an ARRAY payload that nothing ever sends, so
 * `Array.isArray(args)` was false, `namespace` was undefined, and it refused NOTHING — while its own
 * self-check passed, because the self-check had invented the same array shape. A real confirmation
 * was deleted from a real settings document by a run that promised to leave no trace.
 *
 * The chain, with the file each step was read from:
 *
 *   1. `SettingsScopeController.set(field, value)` → `mutate([{op: 'set', path: [field], value}])`
 *      — `@deepseek-ai/dsh-client-ui-settings/lib/client.js`
 *   2. `mutate` → `ctx.remote.settings.mutate(namespace, ops, revision)`
 *   3. the api gateway marshals POSITIONAL arguments into an OBJECT keyed by wire name —
 *      `args[parameter.wire] = value` — `@deepseek-ai/dsh-api-gateway/lib/client.js`
 *   4. the wire names are `namespace`, `ops`, `expectedRevision`
 *      — `@deepseek-ai/dsh-api-settings-controller/lib/typert.remote-client.js`
 *   5. the connection POSTs `{type: 'client-request', rpcId, method, payload}` with that object as
 *      `payload` — `@deepseek-ai/dsh-client-connection/lib/client.js`
 *   6. AND THE PAYLOAD WRAPS THE ARGUMENTS ONE LEVEL DEEPER: the host gateway refuses anything whose
 *      payload is not exactly `{args: <plain object>}` —
 *      "Remote payload must contain exactly one plain-object args field"
 *      — `@deepseek-ai/dsh-api-gateway/lib/index.js`
 *
 * Step 6 is where the second version of this rule died, and it died the same way as the first: it read
 * `payload.namespace` when the namespace lives at `payload.args.namespace`, so it refused nothing —
 * again. What found it was not another reading of the code but the run's own log, which printed the
 * bodies it was actually receiving. A diagnostic that prints the real thing is worth more than a
 * second careful reading.
 *
 * @param {{ payload: string, isWrite: boolean }} input
 * @returns {'settings' | 'theme' | null}
 */
function refusalReason({ payload, isWrite }) {
  if (!isWrite) return null
  let body
  try {
    body = JSON.parse(payload)
  } catch {
    return null
  }
  const envelope = body?.payload
  // An object, not an array, and never a bare `settings` property. The array form is rejected on
  // purpose — it is the shape this rule once believed in.
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return null
  // Step 6: the arguments live under `args`, and the host rejects any other shape.
  const args = envelope.args
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  /*
   * THE FIELD IS 
s, and the wire descriptor says 
amespace. The gate found that out by printing
   * the bodies the client really sends — a body is the only authority on what a body contains — and
   * this accepts either spelling so that a descriptor that catches up does not silently stop matching.
   */
  const namespace = args.ns ?? args.namespace
  const reason = PROTECTED_NAMESPACES[namespace]
  if (reason === undefined) return null
  // A whole namespace that exists only to hold preferences.
  if (reason === 'theme') return 'theme'
  /*
   * `ui-projects` is refused on its `settings` path only: that key is the plugin's record of what the
   * user chose, in EITHER direction and whatever value it carries — creating a confirmation,
   * overwriting one, and deleting one are the same act as far as somebody's data is concerned. The
   * `enabled` key and the record's bookkeeping keys still persist, because the suite's reload
   * assertions and its own restore depend on them.
   */
  const ops = Array.isArray(args.ops) ? args.ops : []
  return ops.some((op) => Array.isArray(op?.path) && op.path[0] === 'settings') ? 'settings' : null
}

/** One payload in the shape the client really sends: the envelope, the `args` wrapper, the revision. */
const wireBody = (args) =>
  JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'settings/mutate', payload: { args } })
/** One op list for a namespace, marshalled the way the gateway marshals it. */
const wireMutate = (ns, ops, expectedRevision = 12) => wireBody({ ns, ops, expectedRevision })

/**
 * One line describing a write, in the shape the client really sends.
 *
 * Values are reported by SIZE rather than content: a checklist record is somebody's data and this is a
 * log, not a dump. The KEYS are printed too — the shape is the thing that has been wrong twice here, so
 * the log states it instead of implying it.
 * @param {string} payload
 */
function describeWrite(payload) {
  let body
  try {
    body = JSON.parse(payload)
  } catch {
    return 'body=<unparseable>'
  }
  const envelope = body?.payload
  if (envelope === null || typeof envelope !== 'object') return 'payload=<not an object>'
  const args = envelope.args
  if (args === null || typeof args !== 'object') {
    return `method=${String(body?.method)} payload.keys=[${Object.keys(envelope).join(',')}] args=<missing>`
  }
  const ops = Array.isArray(args.ops) ? args.ops : []
  const described = ops.map(
    (op) =>
      `${String(op?.op)}:${Array.isArray(op?.path) ? op.path.join('.') : '?'}(${JSON.stringify(op?.value ?? null).length}B)`,
  )
  return `method=${String(body?.method)} ns=${String(args.ns ?? args.namespace)} ops=[${described.join(' ')}] revision=${String(args.expectedRevision)}`
}

/**
 * Whether a payload carries a key this run promised not to touch.
 *
 * Deliberately written out again rather than reusing `refusalReason`: this is the anomaly detector for
 * that rule, and one that asked the same function whether the function was right would be no detector
 * at all.
 * @param {string} payload
 */
function touchesProtectedKey(payload) {
  let args
  try {
    args = JSON.parse(payload)?.payload?.args
  } catch {
    return false
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false
  const namespace = args.ns ?? args.namespace
  if (namespace === 'ui-theme') return true
  if (namespace !== 'ui-projects') return false
  const ops = Array.isArray(args.ops) ? args.ops : []
  return ops.some((op) => Array.isArray(op?.path) && op.path[0] === 'settings')
}

/**
 * The refusal rule, checked against real payload shapes.
 *
 * Every payload below is written the way the client writes it — including `expectedRevision`, which
 * the gateway includes and the previous self-check had never heard of. A check that constructs its own
 * idea of the shape proves only that the rule agrees with itself.
 * @returns {number} how many cases disagreed with the expectation
 */
function runSelfCheck() {
  const settingsWrite = (value) =>
    wireMutate('ui-projects', [{ op: 'set', path: ['settings'], value }])
  const cases = [
    ['a confirmation being written', settingsWrite({ 'liquid-glass': { checks: { version: '3.0.0', items: {} } } }), 'settings'],
    ['the same record being deleted', settingsWrite({}), 'settings'],
    ['the settings key being unset', wireMutate('ui-projects', [{ op: 'unset', path: ['settings'] }]), 'settings'],
    ['a batch that carries it among others', wireMutate('ui-projects', [
      { op: 'set', path: ['enabled'], value: ['liquid-glass'] },
      { op: 'set', path: ['settings'], value: {} },
    ]), 'settings'],
    ['the appearance preference', wireMutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' }]), 'theme'],
    ['the skin toggle itself', wireMutate('ui-projects', [{ op: 'set', path: ['enabled'], value: ['liquid-glass'] }]), null],
    ['the record bookkeeping', wireMutate('ui-projects', [{ op: 'set', path: ['initialized'], value: true }]), null],
    ['a read', wireBody({ namespace: 'ui-projects', ops: [] }), null, false],
    ['a body that is not JSON', 'not json at all', null],
    ['the ARRAY shape this rule once believed in', JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'settings/mutate',
      payload: ['ui-projects', [{ op: 'set', path: ['settings'], value: {} }]],
    }), null],
    ['the shape WITHOUT the `args` wrapper (the second wrong guess)', JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'settings/mutate',
      payload: { ns: 'ui-projects', ops: [{ op: 'set', path: ['settings'], value: {} }] },
    }), null],
  ]
  let failures = 0
  for (const [label, payload, expected, isWrite = true] of cases) {
    const actual = refusalReason({ payload, isWrite })
    const ok = actual === expected
    if (!ok) failures += 1
    process.stdout.write(
      `  ${ok ? 'ok  ' : 'FAIL'} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n`,
    )
  }
  return failures
}

/**
 * ONE TOP-LEVEL KEY'S BLOCK under `ui-projects:` in the settings document, read-only.
 *
 * The key is a parameter because two of this run's readings are the same reading: the gate protects
 * `settings:`, and its own precondition quotes `enabled:` when it cannot find a project to drive. Both
 * are "the block under one key of `ui-projects`", and two readers of one file are two readers that can
 * disagree about where a block ends — so there is one, and this is it.
 *
 * NOT one line. A key holds a nested object or a list, and a writer is free to render it either way —
 * for `settings:`, the key the gate exists to protect:
 *
 *     settings: {}                                     ← no record
 *     settings: { liquid-glass: { checks: { … } } }     ← a record, inline
 *     settings:                                         ← a record, as a block
 *       liquid-glass:
 *         checks:
 *           version: '3.0.0'
 *
 * A single-line read cannot tell the first from the second, which is exactly the difference the gate
 * exists to detect. THE BLOCK RULE: start at the line whose key is `<key>:` and whose indentation is
 * that of a `ui-projects` child, and end before the next non-blank line with indentation less than or
 * equal to that — i.e. the next sibling key of `ui-projects`, or the end of the file. Blank lines inside
 * are kept; trailing whitespace is trimmed and runs of whitespace collapsed, because a writer may
 * re-indent without changing what it wrote, and a gate that reports that as data loss would be crying
 * wolf. A one-line value (`settings: {}`) comes out of the same rule as a one-line block.
 *
 * READ-ONLY, and it has to be: this file belongs to whoever is running the harness. The gate compares
 * two readings and its precondition quotes a third; none of them writes one.
 *
 * `key` is one of this file's own literals — `settings` for the record, `enabled` for the precondition's
 * quote — so it goes into the pattern as written.
 * @param {string} key
 * @returns {Promise<{ ok: true, text: string, path: string } | { ok: false, why: string }>}
 */
async function readUiProjectsBlock(key) {
  const { readFile } = await import('node:fs/promises')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const path = join(home, 'settings.yaml')
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    return { ok: false, why: `cannot read ${path}: ${String(err?.message ?? err)}` }
  }
  const lines = text.split('\n')
  const projectAt = lines.findIndex((line) => /^ui-projects:\s*$/.test(line))
  if (projectAt === -1) return { ok: false, why: 'no `ui-projects:` section in the document' }
  const keyAt = lines.findIndex((line, index) => index > projectAt && new RegExp(`^\\s+${key}:`).test(line))
  if (keyAt === -1) return { ok: true, text: `(no ${key} key)`, path }
  const indent = lines[keyAt].length - lines[keyAt].trimStart().length
  let end = keyAt + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break
    end += 1
  }
  const block = lines.slice(keyAt, end).join('\n')
  return { ok: true, text: block.replace(/\s+/g, ' ').trim(), path }
}

/**
 * The plugin's own record — `ui-projects.settings` — the key the gate exists to protect.
 * @returns {Promise<{ ok: true, text: string, path: string } | { ok: false, why: string }>}
 */
async function readSettingsSubtree() {
  return readUiProjectsBlock('settings')
}

/**
 * WHICH PROJECT THE GATE DRIVES, resolved from the page rather than named here.
 *
 * The gate used to name its project — `details.uip-tests[data-project="liquid-glass"]`, written out at
 * three call sites — and a name is not a target, it is an assumption. The project has to be ON for the
 * checklist's confirmation to reach the settings API: a click on a project the document says is off is
 * dropped without a trace, and the gate then reported `the interceptor saw and refused at least one
 * write (0)`, which reads as a broken refusal rule and was really "the project I clicked belongs to a
 * skin another skin displaced". It cost a whole self-test round: the document said
 * `enabled: [example, liquid-glass]`, the one-skin policy left `example` active, and every assertion
 * below the click was measuring a card nobody had touched.
 *
 * So the target is found: the FIRST project, in the panel's own order, that is BOTH on and carrying a
 * checklist. No id appears below, and a machine whose document names a different project — or whose
 * active project is the example rather than the skin — drives that one. A run with nothing to drive
 * fails in the gate's own precondition, naming what it saw, instead of failing three assertions later.
 *
 * `aria-checked` is read as the string the panel writes, the same reading `PANEL_STATE` and
 * `clickSwitch` already do. `boxes` counts the checklist's checkboxes: `details.uip-tests` is rendered
 * exactly when a project declares `testItems`, and a project with an empty checklist has nothing to
 * confirm.
 * @param {{ send: Function }} session
 * @returns {Promise<{ target: string | null, projects: Array<{ id: string, checked: string | null, boxes: number }> }>}
 */
async function resolveChecklistTarget(session) {
  return evaluate(
    session,
    `(() => {
      const ids = Array.from(document.querySelectorAll('li.uip-card[data-project]')).map((card) => card.getAttribute('data-project'));
      const projects = ids.map((id) => {
        const card = document.querySelector('li.uip-card[data-project="' + id + '"]');
        const control = card === null ? null : card.querySelector('[role="switch"]');
        const details = document.querySelector('details.uip-tests[data-project="' + id + '"]');
        return {
          id: id,
          checked: control === null ? null : control.getAttribute('aria-checked'),
          boxes: details === null ? 0 : details.querySelectorAll('input[type=checkbox]').length,
        };
      });
      const drivable = projects.filter((entry) => entry.checked === 'true' && entry.boxes > 0);
      return { target: drivable.length === 0 ? null : drivable[0].id, projects: projects };
    })()`,
  )
}

/**
 * Every project the precondition found, in the panel's order, on one line.
 *
 * The states are printed even when the answer is "none" — a machine where the SKIN is off and the
 * EXAMPLE is on is a different machine from one where nothing is on, and the sentence that says which
 * is the difference between a five-minute fix and a hunt.
 * @param {Array<{ id: string, checked: string | null, boxes: number }>} projects
 */
function describeSwitches(projects) {
  if (projects.length === 0) return '(the panel listed no project cards)'
  return projects.map((entry) => `${entry.id}: switch=${entry.checked}, boxes=${entry.boxes}`).join('; ')
}

/**
 * Drive the checklist to a confirmation, the way a person does: open the disclosure, tick every box,
 * wait for the button to accept input, click it. The gate is its only caller, and it drives a
 * confirmation and then a withdrawal on the SAME project, so there is one place that knows how this
 * control is driven and one id that says whose.
 * @param {{ send: Function }} session
 * @param {string} id the project whose checklist to drive, as `resolveChecklistTarget` returned it
 * @returns {Promise<{ ok: boolean, why?: string }>}
 */
async function driveChecklistConfirm(session, id) {
  const opened = await evaluate(
    session,
    `(() => {
      const details = document.querySelector('details.uip-tests[data-project="${id}"]')
      if (details === null) return { ok: false, why: 'no disclosure' }
      details.open = true
      const boxes = Array.from(details.querySelectorAll('input[type=checkbox]'))
      if (boxes.length === 0) return { ok: false, why: 'no boxes' }
      for (const box of boxes) if (!box.checked) box.click()
      return { ok: true, boxes: boxes.length }
    })()`,
  )
  if (opened.ok !== true) return { ok: false, why: JSON.stringify(opened) }
  try {
    await waitFor(
      session,
      `(() => {
        const button = document.querySelector('details.uip-tests[data-project="${id}"] button[data-uip-action="confirm-checks"]')
        return button !== null && !button.disabled
      })()`,
      'the confirm button to accept input',
    )
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err) }
  }
  await evaluate(
    session,
    `document.querySelector('details.uip-tests[data-project="${id}"] button[data-uip-action="confirm-checks"]').click()`,
  )
  return { ok: true }
}

/**
 * Click the withdrawal control, if it is offered — on the same project the confirmation was driven on.
 *
 * Same id for the same reason the gate needs both triggers from one card: the withdrawal is the write
 * shape WITHOUT a record, and it is only offered where the confirmation just created one. Driving it
 * elsewhere would capture a shape from a project whose state this run never established.
 * @param {{ send: Function }} session
 * @param {string} id
 */
async function driveChecklistWithdraw(session, id) {
  return evaluate(
    session,
    `(() => {
      const button = document.querySelector('details.uip-tests[data-project="${id}"] button[data-uip-action="clear-checks"]')
      if (button === null) return { ok: false, why: 'no withdrawal offered' }
      button.click()
      return { ok: true }
    })()`,
  )
}

/**
 * Whether a payload carries a write to the `settings` key of the plugin's own namespace.
 *
 * The gate's wait condition, and deliberately its own reading of the body rather than a call into the
 * rule: the gate's job is to find out whether the rule agrees with reality, so what it waits for must
 * not depend on the rule being right.
 * @param {string} payload
 */
function carriesSettingsPath(payload) {
  let args
  try {
    args = JSON.parse(payload)?.payload?.args
  } catch {
    return false
  }
  if (args === null || typeof args !== 'object') return false
  if ((args.ns ?? args.namespace) !== 'ui-projects') return false
  const ops = Array.isArray(args.ops) ? args.ops : []
  return ops.some((op) => Array.isArray(op?.path) && op.path[0] === 'settings')
}

/**
 * EVERY TOP-LEVEL PAGE EXPRESSION, PARSED BEFORE A BROWSER IS EVER LAUNCHED.
 *
 * An expression this suite evaluates is a STRING, and `node --check` validates the file that builds the
 * string rather than the string. A typo inside one — a missing paren, an unbalanced brace in a selector
 * — therefore costs a Chrome launch and a live navigation to discover, and reports itself as
 * `page exception: Unexpected token` with nothing pointing at the expression that has it.
 *
 * WHAT THIS COVERS, precisely: every top-level binding whose value is a template literal, plus the two
 * arrow functions that BUILD one (each is called with a sample argument, and the RESULT is what gets
 * parsed — the same string the page would receive). What it does NOT cover: the expressions written
 * inline at their `evaluate(...)` call site, which are the majority. A guard that claimed those would
 * have to parse the whole file; this one says what it checked and refuses to imply more.
 *
 * The registry is compared against the file in BOTH directions, so its coverage cannot rot: a page
 * expression nobody registered fails as loudly as a registered name that stopped being one.
 *
 * The interpolations are replaced with `0;` before parsing, and that is the one approximation here: it
 * keeps the syntax around them (`${HELPERS}` sits after `(() => {`, `${hook}` inside a selector string)
 * while changing the string that is parsed. Syntax is what a typo breaks; a substitution that keeps the
 * delimiters in place is enough to catch it.
 */
const PAGE_EXPRESSIONS = [
  ['HELPERS', []],
  ['PROBE', []],
  ['OPEN_PANEL', []],
  ['CLICK_SECTION', []],
  ['PANEL_STATE', []],
  ['TEXT_TARGETS', []],
  ['FILTERED_SET', []],
  ['clickSwitch', ['liquid-glass']],
  ['SURFACE_STYLE', ['standard']],
]

/**
 * The text of one template literal, from its opening backtick to its closing one.
 *
 * `\\` is skipped so an escaped backtick inside a selector does not end the literal, and `${` opens a
 * depth level so a `}` inside an interpolation does not close it early.
 * @param {string} source @param {number} start index of the opening backtick
 * @returns {{ text: string, end: number } | null}
 */
function sliceTemplate(source, start) {
  let depth = 0
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '$' && source[index + 1] === '{') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}' && depth > 0) {
      depth -= 1
      continue
    }
    if (char === '`' && depth === 0) return { text: source.slice(start, index + 1), end: index + 1 }
  }
  return null
}

/**
 * Parse each registered expression and report what does not parse.
 * @returns {string[]} one line per failure, empty when every expression parses
 */
function checkPageExpressions() {
  const failures = []
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  const found = [...source.matchAll(/^const ([A-Za-z_$][\w$]*) = (?=`|\([^)]*\) => `)/gm)].map((match) => match[1])
  for (const name of found) {
    if (!PAGE_EXPRESSIONS.some(([registered]) => registered === name)) {
      failures.push(`${name} is a page expression nothing validates — add it to PAGE_EXPRESSIONS`)
    }
  }
  for (const [name, args] of PAGE_EXPRESSIONS) {
    if (!found.includes(name)) {
      failures.push(`${name} is registered but is no longer a top-level page expression`)
      continue
    }
    const declaration = source.indexOf(`const ${name} = `)
    const sliced = sliceTemplate(source, source.indexOf('`', declaration))
    if (sliced === null) {
      failures.push(`${name}: its template literal has no closing backtick`)
      continue
    }
    const initializer = source.slice(declaration + `const ${name} = `.length, sliced.end).replace(/\$\{[^}]*\}/g, '0;')
    const call = `(${initializer})${args.length === 0 ? '' : `(${args.map((value) => JSON.stringify(value)).join(', ')})`}`
    try {
      const built = new Function(`return ${call}`)()
      new Function(String(built))
    } catch (error) {
      failures.push(`${name}: ${String(error?.message ?? error)}`)
    }
  }
  return failures
}

const expressionFailures = checkPageExpressions()
if (expressionFailures.length > 0) {
  process.stderr.write(
    `[expressions] ${expressionFailures.length} page expression(s) do not parse. Every evaluate() using one\n` +
      `[expressions] would throw inside the page, with no line here pointing at it:\n` +
      expressionFailures.map((line) => `[expressions]   ${line}\n`).join(''),
  )
  process.exit(2)
}

if (selfCheckOnly) {
  process.stdout.write('dsh-ui-projects: --no-write refusal rule, against payloads the client really sends\n')
  const failures = runSelfCheck()
  process.stdout.write(
    `every top-level page expression parses (${PAGE_EXPRESSIONS.map(([name]) => name).join(', ')})\n`,
  )
  process.stdout.write(failures === 0 ? '\nthe refusal rule covers every protected write\n' : `\n${failures} case(s) disagreed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * The mobile radius: its token name, and the value read from it.
 *
 * Named once, because the name was wrong in two places at once — this reader and the assertion that
 * reports the resolved token both looked for `--lg-blur-mobile`, which appears in no file; the real
 * name is `--lg-glass-blur-mobile`. A reader that missed then fell through `?? 0`, so the first run
 * of this suite compared the skin's mobile radius against `0px` and failed a check whose measured
 * value was exactly right.
 *
 * A miss is now a thrown error rather than a default, which is the part that matters: a value this
 * script asserts against must never be something it invented. (Round 20 removed the same class of
 * silence from the Node suite by reading a storage key from the module that owns it.)
 *
 * The path follows the sheet, not the framework: this suite drives the INSTALLED skin, so the value
 * it compares against has to come from the skin's own source. That file was this package's until
 * step 8c; the relative path to the sibling package is the same arrangement `load-check.mjs` uses to
 * mount the package's real bundle.
 */
const MOBILE_BLUR_TOKEN = '--lg-glass-blur-mobile'
const SKIN_GLASS_CSS = new URL('../../dsh-plugin-liquid-glass/src/client/projects/liquid-glass/glass.css', import.meta.url)
const mobileBlurSource = await (await import('node:fs/promises')).readFile(SKIN_GLASS_CSS, 'utf8')
const mobileBlurMatch = new RegExp(`${MOBILE_BLUR_TOKEN}:\\s*(\\d+)px`).exec(mobileBlurSource)
if (mobileBlurMatch === null) {
  throw new Error(`glass.css declares no ${MOBILE_BLUR_TOKEN}, so the mobile assertion has nothing to compare against`)
}
const MOBILE_BLUR_PX = Number(mobileBlurMatch[1])

const CHROME_CANDIDATES = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
]

let failures = 0
let checks = 0

/** @param {string} name @param {() => void | Promise<void>} body */
async function test(name, body) {
  try {
    await body()
    process.stdout.write(`  ok   ${name}\n`)
  } catch (err) {
    failures += 1
    process.stdout.write(`  FAIL ${name}\n         ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/** @param {unknown} actual @param {unknown} expected @param {string} [what] */
function equal(actual, expected, what = 'value') {
  checks += 1
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

/** @param {unknown} value @param {string} [what] */
function truthy(value, what = 'value') {
  checks += 1
  if (!value) throw new Error(`${what}: expected truthy, got ${JSON.stringify(value)}`)
}

/** @param {string} haystack @param {string} needle */
function contains(haystack, needle, detail) {
  checks += 1
  if (!String(haystack).includes(needle)) {
    throw new Error(`expected to find ${JSON.stringify(needle)}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── chrome + CDP ─────────────────────────────────────────────────────────── */

/**
 * Launch a headless browser and learn which debug port it chose.
 *
 * The port is read from `DevToolsActivePort` — the file Chrome/Edge writes into
 * the user-data directory when started with `--remote-debugging-port=0` — rather
 * than from a piped stderr. Reading the file is strictly better here: it needs no
 * pipe, so the launcher works under a sandbox that forbids piped stdio, and it is
 * the browser's own authoritative statement of the port it bound.
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number, profile: string }>}
 */
async function launchChrome() {
  const { existsSync } = await import('node:fs')
  const { readFile } = await import('node:fs/promises')
  const binary = CHROME_CANDIDATES.find((candidate) => candidate.length > 0 && existsSync(candidate))
  if (binary === undefined) throw new Error('no Chrome or Edge binary found')
  const profile = await mkdtemp(join(tmpdir(), 'dsh-ui-projects-chrome-'))
  const child = spawn(
    binary,
    [
      '--headless=new',
      // Port 0 lets the browser choose: this can never collide with a port in use.
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=1440,900',
      'about:blank',
    ],
    // No piped stdio: a sandbox may forbid capturing another program's output.
    { stdio: 'ignore' },
  )
  const marker = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + 30000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the browser exited early with code ${child.exitCode}`)
    if (existsSync(marker)) {
      const firstLine = (await readFile(marker, 'utf8')).split('\n')[0].trim()
      const port = Number(firstLine)
      if (Number.isInteger(port) && port > 0) return { child, port, profile }
    }
    if (Date.now() > deadline) throw new Error('the browser did not report a debug port within 30s')
    await sleep(200)
  }
}

/** Minimal CDP client: one socket, id-keyed replies, event fan-out. */
class Cdp {
  /** @param {string} url */
  constructor(url) {
    this.next = 1
    this.pending = new Map()
    /** @type {Map<string, Array<(params: any) => void>>} */
    this.listeners = new Map()
    this.socket = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(undefined))
      this.socket.addEventListener('error', () => reject(new Error('cdp socket error')))
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        this.pending.delete(message.id)
        if (message.error !== undefined) entry.reject(new Error(`${message.error.message} (${entry.method})`))
        else entry.resolve(message.result)
        return
      }
      const handlers = this.listeners.get(message.method)
      if (handlers !== undefined) for (const handler of [...handlers]) handler(message.params)
    })
  }

  /** @param {string} method @param {any} [params] @returns {Promise<any>} */
  send(method, params = {}) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** @param {string} method @param {(params: any) => void} handler @returns {() => void} */
  on(method, handler) {
    const handlers = this.listeners.get(method) ?? []
    handlers.push(handler)
    this.listeners.set(method, handlers)
    return () => {
      const index = handlers.indexOf(handler)
      if (index >= 0) handlers.splice(index, 1)
    }
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
  }
}

/* ── page helpers ─────────────────────────────────────────────────────────── */

/** @param {{ send: Function }} session @param {string} expression */
async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page exception: ${result.exceptionDetails.exception?.description ?? 'unknown'}`)
  }
  return result.result.value
}

/** Poll a page predicate until it is true or the budget runs out. */
async function waitFor(session, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await evaluate(session, expression)) === true) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(200)
  }
}

/* ── reading the rendered pixels ──────────────────────────────────────────── */

/**
 * Decode a PNG far enough to read its pixels.
 *
 * Chrome emits 8-bit non-interlaced PNGs, either RGB (a clipped screenshot drops
 * the alpha channel) or RGBA, so the full format is not needed: concatenate the
 * `IDAT` chunks, inflate, and undo the per-scanline filter. This is what lets the
 * suite measure *rendered* contrast instead of trusting a token value, which is the
 * only honest way to check a translucent surface.
 * @param {Buffer} png
 * @returns {{ width: number, height: number, channels: number, pixels: Buffer }}
 */
function decodePng(png) {
  let offset = 8
  let width = 0
  let height = 0
  let channels = 4
  /** @type {Buffer[]} */
  const idat = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      const colourType = data[9]
      if (depth !== 8 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${colourType})`)
      }
      channels = colourType === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]
    const line = raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride)
    const out = pixels.subarray(row * stride, (row + 1) * stride)
    const prior = row === 0 ? Buffer.alloc(stride) : pixels.subarray((row - 1) * stride, row * stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0
      const up = prior[x]
      const upLeft = x >= channels ? prior[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      out[x] = value & 0xff
    }
  }
  return { width, height, channels, pixels }
}

/** Relative luminance, the WCAG definition. */
function luminance(/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) {
  const channel = (/** @type {number} */ value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * The rendered contrast inside one element's box: the luminance distance between
 * its darkest and lightest pixel. Text on a surface always produces both, so this
 * measures what a reader actually sees over a translucent background — including
 * whatever the glass is refracting — without needing to locate glyphs.
 * @param {{ send: Function }} session
 * @param {{ x: number, y: number, width: number, height: number }} clip
 * @returns {Promise<number>} luminance delta, 0..1
 */
async function measuredContrast(session, clip) {
  const shot = await session.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
  })
  const { pixels, channels } = decodePng(Buffer.from(shot.data, 'base64'))
  let min = 1
  let max = 0
  for (let i = 0; i + channels - 1 < pixels.length; i += channels) {
    const value = luminance(pixels[i], pixels[i + 1], pixels[i + 2])
    if (value < min) min = value
    if (value > max) max = value
  }
  return Math.round((max - min) * 1000) / 1000
}

/** Shared page-side helpers, injected into every expression that needs them. */
const HELPERS = `
  const isVisible = (el) => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
  const clickable = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button' || node.tagName === 'A') return node;
    }
    return el;
  };
  const byOwnText = (needle) => Array.from(document.querySelectorAll('*'))
    .filter((el) => isVisible(el) && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() === needle))[0];
  // The project marker lives on the BODY: project stylesheets are scoped there,
  // because that is the element the shipped design tokens are declared on.
  const skinMarker = () => document.body.getAttribute('data-ui-project-liquid-glass');
  // A stable identity for "which elements are blurred", so a test can compare the
  // SET before and after rather than a count. The shipped client blurs one surface
  // of its own, so a bare count proves nothing either way.
  const blurredKeys = () => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const value = cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : cs.webkitBackdropFilter;
      if (value && value !== 'none') {
        out.push([el.tagName.toLowerCase(), String(el.className || '').slice(0, 40), Array.from(el.attributes).map((a) => a.name).filter((n) => n.startsWith('data-')).join(',')].join('|'));
      }
    }
    return out.sort();
  };
  const sweepBlur = () => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const value = cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : cs.webkitBackdropFilter;
      if (value && value !== 'none') {
        const rect = el.getBoundingClientRect();
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 50),
          attrs: Array.from(el.attributes).map((a) => a.name).filter((n) => n.startsWith('data-')).join(','),
          w: Math.round(rect.width), h: Math.round(rect.height), filter: value,
        });
      }
    }
    return out;
  };
`

const PROBE = `(() => {${HELPERS}
  const blurred = sweepBlur();
  const body = getComputedStyle(document.body);
  /*
   * The composer, read the same way the frame is: the fill from the card and the blur from the
   * pseudo-element that carries it. Nothing here assumes the rules exist — a missing hook or a
   * missing pseudo answers null and the assertions below say so.
   */
  const card = document.querySelector('[data-composer-card]');
  const seat = document.querySelector('[data-composer-seat]');
  const cardStyle = card === null ? null : getComputedStyle(card);
  const frostStyle = card === null ? null : getComputedStyle(card, '::before');
  return {
    blurredCount: blurred.length,
    blurred: blurred.slice(0, 10),
    blurKeys: blurredKeys(),
    ambient: document.querySelectorAll('.ds-ambient').length,
    skinAttr: document.documentElement.getAttribute('data-ui-skin'),
    projectAttr: skinMarker(),
    systemAttr: document.documentElement.getAttribute('data-ui-projects'),
    frames: document.querySelectorAll('[data-rightbar-col]').length,
    overlay: document.querySelectorAll('[data-shell-overlay]').length,
    composer: {
      cardFound: card !== null,
      seatFound: seat !== null,
      fill: cardStyle === null ? null : cardStyle.backgroundColor,
      isolation: cardStyle === null ? null : cardStyle.isolation,
      shadow: cardStyle === null ? null : cardStyle.boxShadow,
      radius: cardStyle === null ? null : cardStyle.borderRadius,
      frostBlur: frostStyle === null ? null : String(frostStyle.backdropFilter || frostStyle.webkitBackdropFilter || ''),
      frostRadius: frostStyle === null ? null : frostStyle.borderRadius,
      seatFade: seat === null ? null : String(getComputedStyle(seat).backgroundImage),
    },
    tokens: {
      // Read from the BODY: that is where the shipped client declares its tokens,
      // and where a project stylesheet therefore has to override them.
      layer1: body.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
      sidebar: body.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
      accent: body.getPropertyValue('--lg-accent').trim(),
      brand: body.getPropertyValue('--dsw-alias-brand-primary').trim(),
      highlight: body.getPropertyValue('--lg-highlight').trim(),
    },
  };
})()`

const OPEN_PANEL = `(() => {${HELPERS}
  // The foot trigger's label is visually hidden in the sidebar's rail state (a
  // phone-sized viewport auto-collapses it), so fall back to the accessible name and
  // then to the trigger's own control.
  const byLabel = Array.from(document.querySelectorAll('button,[role="button"]'))
    .filter((el) => isVisible(el))
    .find((el) => /设置|Settings/i.test(el.getAttribute('aria-label') || '') || /设置|Settings/i.test(el.getAttribute('title') || ''));
  const trigger = byOwnText('设置') || byOwnText('Settings') || byLabel;
  if (!trigger) {
    return {
      error: 'settings trigger not found',
      buttons: Array.from(document.querySelectorAll('button')).filter(isVisible)
        .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 12))
        .filter(Boolean).slice(0, 20),
    };
  }
  clickable(trigger).click();
  return { ok: true };
})()`

const CLICK_SECTION = `(() => {${HELPERS}
  const section = byOwnText('界面') || byOwnText('UI');
  if (!section) {
    return {
      error: 'UI section not found',
      seen: Array.from(document.querySelectorAll('*'))
        .filter(isVisible)
        .map((el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(''))
        .filter((t) => t.length > 0 && t.length < 12).slice(0, 30),
    };
  }
  clickable(section).click();
  return { ok: true };
})()`

const PANEL_STATE = `(() => {
  const card = document.querySelector('[data-project="liquid-glass"]');
  const sw = card ? card.querySelector('[role="switch"]') : null;
  return {
    panel: document.querySelectorAll('.uip-root').length,
    cards: Array.from(document.querySelectorAll('[data-project]')).map((c) => c.getAttribute('data-project')),
    checked: sw ? sw.getAttribute('aria-checked') : null,
    label: sw ? sw.getAttribute('aria-label') : null,
    status: card ? card.getAttribute('data-status') : null,
    name: card ? (card.querySelector('.uip-name') || {}).textContent : null,
  };
})()`

/*
 * Click the switch, waiting first for it to accept input, and report what happened AT THAT INSTANT.
 *
 * The switch is disabled while an action is pending, and a click on a disabled button is dropped
 * without a trace. That is not a defect in the panel — it is the panel refusing input while it is
 * still persisting the previous change — but it made this suite flaky in a way that read as a skin
 * failure: the marker wait timed out, the switch looked perfectly healthy afterwards, and nothing was
 * logged, because by then the pending flag had cleared. A person seeing a greyed-out control waits;
 * so does this now, and it reports how long it waited.
 *
 * The state is read at click time because a probe taken when the wait gives up cannot tell "the click
 * was refused" from "the click was accepted and the skin did not follow" — the first version of this
 * diagnostic was taken thirty seconds too late and reported a healthy switch through a whole run.
 */
const clickSwitch = (id) => `(async () => {
  const find = () => document.querySelector('[data-project="${id}"] [role="switch"]');
  if (find() === null) return { error: 'switch not found' };
  const startedAt = Date.now();
  let target = find();
  while (target !== null && target.disabled === true && Date.now() - startedAt < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    target = find();
  }
  if (target === null) return { error: 'switch disappeared while waiting for it to accept input' };
  const waitedMs = Date.now() - startedAt;
  if (target.disabled === true) return { error: 'switch stayed disabled for 10s', waitedMs };
  const was = target.getAttribute('aria-checked');
  target.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const now = find();
  return {
    ok: true,
    was,
    waitedMs,
    replaced: now !== target,
    checkedAfter: now === null ? null : now.getAttribute('aria-checked'),
    disabledAfter: now === null ? null : now.disabled === true,
    markerAfter: document.body.getAttribute('data-ui-project-${id}'),
  };
})()`

/*
 * THE SKIN IS ONE PROJECT ID, and this suite used to be unable to say so.
 *
 * The click expression hard-coded `[data-project="liquid-glass"]` and the marker it read was
 * `data-ui-project-liquid-glass`, so every phase could drive exactly one project package — the one
 * this file was written beside. Step 9b shipped a SECOND project package (the example), and the
 * difference between "the framework applies a project" and "the framework applies this project" is
 * only visible when two of them exist. `clickSwitch(id)` is that expression with the id as a
 * parameter; `CLICK_SWITCH` is the skin's instance of it, so every existing use is unchanged.
 */
const CLICK_SWITCH = clickSwitch('liquid-glass')

/**
 * Boxes of the text a reader depends on, with the label to report them under. Each
 * is a place the glass sits behind real words, so each is a place the skin could
 * have destroyed legibility.
 *
 * The list falls back to always-present application text, because the settings
 * panel is not open in every phase that measures contrast.
 */
/**
 * Boxes of text a reader depends on, with the label to report them under.
 *
 * Only UNOBSTRUCTED text qualifies. When the settings dialog is open, the
 * application behind it sits under the dialog's scrim: the sidebar label is
 * covered, so measuring its pixels finds a flat wash and would report a contrast
 * failure for a label nobody is reading at that moment. What is measured instead
 * is the settings surface — which really does sit on the glass — plus, only when
 * no dialog covers it, the sidebar's own label.
 */
/* ── the two example surfaces, and what "covered" means in computed styles ─── */

/**
 * One example surface's computed material, by hook.
 *
 * The pair these read is the whole of step 9b's third example: two surfaces that look identical and
 * differ in one attribute. The skin's rule is
 * `:where([role='dialog'], [role='menu'], [role='listbox'], [role='tooltip'])`, so `role="dialog"` is
 * reachable by a published interface and `role="custom-dialog"` is reachable by nothing.
 *
 * `boxShadow` is read beside `backdropFilter` because the two are set by the same rule and prove
 * different halves: the filter says the frost landed, the shadow says the rule's OTHER declaration did
 * — and since the example's own stylesheet sets `box-shadow` too (from the shipped palette), a shadow
 * that changed is evidence the skin's declaration won on specificity rather than a default.
 * @param {string} hook `standard` | `custom`
 */
const SURFACE_STYLE = (hook) => `(() => {
  const el = document.querySelector('[data-example-dialog="${hook}"]');
  if (el === null) return null;
  const style = getComputedStyle(el);
  return {
    role: el.getAttribute('role'),
    backdropFilter: String(style.backdropFilter || style.webkitBackdropFilter || ''),
    boxShadow: String(style.boxShadow),
  };
})()`

/**
 * Every element whose computed `backdrop-filter` is doing something, as stable identities.
 *
 * THE SET, not a count, and that is the assertion test C needs: "the page is back to normal" cannot be
 * said by counting, because one element that gained frost while another lost it leaves the count
 * unchanged. Identities are tag + id + class list + role, sorted — enough to compare two moments of the
 * same page, and deliberately not a selector, because the elements this catches are the ones no
 * selector of ours names.
 */
const FILTERED_SET = `(() => {
  const seen = [];
  for (const el of document.querySelectorAll('*')) {
    const style = getComputedStyle(el);
    const value = String(style.backdropFilter || style.webkitBackdropFilter || '');
    if (value === '' || value === 'none') continue;
    const classes = typeof el.className === 'string' && el.className.trim().length > 0
      ? '.' + el.className.trim().split(/\\s+/).join('.')
      : '';
    const role = el.getAttribute('role');
    seen.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + classes + (role ? '[role=' + role + ']' : ''));
  }
  return seen.sort();
})()`

const TEXT_TARGETS = `(() => {${HELPERS}
  const runBox = (el, label) => {
    if (!el) return null;
    const textNode = Array.from(el.childNodes).find((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!textNode) return null;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const firstLine = range.getClientRects()[0];
    if (!firstLine) return null;
    const width = Math.min(firstLine.width, 420);
    const height = Math.min(firstLine.height, 40);
    return width >= 16 && height >= 10
      ? { label, x: firstLine.x, y: firstLine.y, width, height }
      : null;
  };
  const elementBox = (el, label) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 10
      ? { label, x: r.x, y: r.y, width: Math.min(r.width, 420), height: Math.min(r.height, 40) }
      : null;
  };
  const dialogOpen = document.querySelector('.uip-root') !== null;
  const own = (needle) => Array.from(document.querySelectorAll('*'))
    .filter((el) => isVisible(el) && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() === needle))[0];
  const settingsLabel = own('设置') || own('Settings') || own('界面') || own('UI');
  return [
    dialogOpen ? null : runBox(settingsLabel, 'sidebar label'),
    elementBox(document.querySelector('.uip-intro'), 'settings panel copy'),
    elementBox(document.querySelector('.uip-description'), 'project card description'),
    elementBox(document.querySelector('.uip-title'), 'settings panel title'),
  ].filter(Boolean);
})()`

/**
 * Open Settings on the UI section, whatever state the shell is in.
 *
 * The sidebar trigger TOGGLES, so a naive "click trigger, then click section" closes
 * the dialog again whenever it happened to be open — which made several phases
 * intermittently fail for reasons that had nothing to do with the skin. This checks
 * first, retries once from a known-closed state, and is safe to call any number of
 * times.
 * @param {{ send: Function }} session
 */
async function ensurePanel(session) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await evaluate(session, "document.querySelectorAll('.uip-root').length > 0")) === true) return
    const opened = await evaluate(session, OPEN_PANEL)
    if (opened.ok !== true) {
      // A narrow viewport auto-collapses the sidebar into a rail, where the foot
      // trigger may not be rendered at all until the rail is expanded. Expanding it
      // is the one extra step, and it is a real user action rather than a hack.
      const expanded = await evaluate(session, `(() => {${HELPERS}
        const toggle = Array.from(document.querySelectorAll('button')).filter(isVisible)
          .find((el) => /展开|收起|expand|collapse|sidebar/i.test((el.getAttribute('aria-label') || '') + (el.getAttribute('title') || '')));
        if (!toggle) return { error: 'no sidebar toggle', width: window.innerWidth };
        toggle.click();
        return { ok: true };
      })()`)
      if (expanded.ok !== true) {
        throw new Error(
          `the settings trigger could not be found at ${expanded.width}px: ${JSON.stringify({ opened, expanded })}`,
        )
      }
      await sleep(500)
      continue
    }
    await evaluate(session, CLICK_SECTION)
    try {
      await waitFor(session, "document.querySelectorAll('.uip-root').length > 0", 'the UI panel', 6000)
      return
    } catch (err) {
      if (attempt === 2) throw err
      // Start the next attempt from a state we know: dialog closed.
      await closePanel(session)
    }
  }
}

/**
 * Close Settings if it is open, using Escape — the shell owns that chrome, and the
 * close control is not something a skin test should have to guess at.
 * @param {{ send: Function }} session
 */
async function closePanel(session) {
  if ((await evaluate(session, "document.querySelectorAll('.uip-root').length")) === 0) return
  for (const type of ['keyDown', 'keyUp']) {
    await session.send('Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
  }
  await waitFor(session, "document.querySelectorAll('.uip-root').length === 0", 'the dialog to close', 10000)
}

/**
 * Whether one project is applied right now.
 *
 * Read from the marker rather than from the switch's own attribute: the two agree, and when they do
 * not, the marker is the one the stylesheet keys off — it decides what the page looks like.
 *
 * The marker is on `<body>`: `runtime.js` stamps `body[data-ui-project-<id>="on"]` and scopes every
 * project stylesheet with that selector (`scope-css.js` documents `html[…]`, which is an older
 * spelling of the same idea and NOT what the runtime writes — measured, not assumed).
 * @param {{ send: Function }} session
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function projectIsOn(session, id) {
  return (await evaluate(session, `document.body.getAttribute('data-ui-project-${id}') === 'on'`)) === true
}

/**
 * Drive ONE project to a known state through the UI, the way a person would.
 *
 * Each phase states the state it needs rather than inheriting one from the phase before it. Two
 * things made that necessary rather than tidy: the suite used to assume the settings document
 * happened to say `enabled: []` when it started — a machine where somebody had switched the skin on
 * produced a dozen failures, every one of them an echo of that single mismatch — and one phase "set"
 * the state by writing a `localStorage` key this plugin has never read, which worked only because
 * the document beside it happened to say the right thing.
 *
 * The project id is a parameter because there is more than one project package now; `setSkin` below
 * is the skin's call.
 * @param {{ send: Function }} session
 * @param {string} id
 * @param {boolean} wantOn
 */
async function setProject(session, id, wantOn) {
  await ensurePanel(session)
  if ((await projectIsOn(session, id)) === wantOn) return
  const clicked = await evaluate(session, clickSwitch(id))
  truthy(clicked.ok, `switch click for ${id} (${JSON.stringify(clicked)})`)
  await waitFor(
    session,
    wantOn
      ? `document.body.getAttribute('data-ui-project-${id}') === 'on'`
      : `document.body.getAttribute('data-ui-project-${id}') === null`,
    wantOn ? `the ${id} marker` : `the ${id} marker to clear`,
  )
}

/**
 * The skin, as one project among several.
 *
 * Kept as a name because the suite's phases are about the skin and read better for it, and kept as a
 * WRAPPER rather than a second implementation so the two can never drift: there is one click, one
 * marker read, one wait, and this is the skin's arguments to it. The four `skinIsOn` call sites and
 * the six `setSkin` call sites below are unchanged for the same reason.
 * @param {{ send: Function }} session
 * @param {boolean} wantOn
 */
async function setSkin(session, wantOn) {
  return setProject(session, 'liquid-glass', wantOn)
}

/** Whether the skin is on — the read half of the wrapper above. @param {{ send: Function }} session */
async function skinIsOn(session) {
  return projectIsOn(session, 'liquid-glass')
}

/**
 * Go to Settings — UI — the PROJECTS page, whatever the panel happens to be showing.
 *
 * The suite has one opener (`ensurePanel`) and one section selector (`CLICK_SECTION`, matched by the
 * section's own label), and they are separate steps on purpose: the earlier phases are the projects
 * page's, the plugins group is the other page's, and a test that needs one of them has to say so.
 * @param {{ send: Function }} session
 */
async function gotoProjectsPage(session) {
  await ensurePanel(session)
  const section = await evaluate(session, CLICK_SECTION)
  truthy(
    section?.ok === true,
    `the UI section item exists (${JSON.stringify(section?.error ?? '')} ${JSON.stringify(section?.seen ?? [])})`,
  )
  await waitFor(session, `document.querySelector('[data-project="liquid-glass"]') !== null`, 'the project card')
}

/**
 * Go to Settings — UI plugins — the PACKAGES page.
 *
 * Matched by the nav item's own copy, which is the only handle the shell offers (it renders our
 * `label()` and nothing else); everything asserted afterwards reads the `data-uip-*` hooks our own
 * renderer writes, so a copy edit in either language cannot break those.
 * @param {{ send: Function }} session
 */

/**
 * The names the HOST says are installed, read from the endpoint the column reads.
 *
 * Used as a PRECONDITION, never as an assertion of the feature: a test whose subject is not installed
 * has to fail with a sentence that says which package is missing and what to do, rather than pass
 * against an empty page or quietly skip. Skipping would let a green run mean "everything is fine"
 * on a machine where the example packages were never installed.
 * @param {{ send: Function }} session
 * @param {string[]} names
 * @returns {Promise<string[]>}
 */
async function requireInstalled(session, names) {
  const listed = await evaluate(
    session,
    `fetch('/api/ui-projects/installed.json', { credentials: 'same-origin' })
      .then(async (response) => ((await response.json()).scan?.dependencies ?? []).map((entry) => entry.name))
      .catch(() => null)`,
  )
  const missing = names.filter((name) => !(listed ?? []).includes(name))
  if (missing.length > 0) {
    throw new Error(
      `PRECONDITION NOT MET — the profile listing has no ${missing.join(', ')}. ` +
        `Install it into the profile this page is served from, restart dsh web, then re-run. ` +
        `Listing seen: ${JSON.stringify(listed ?? null)}`,
    )
  }
  return listed ?? []
}

/*
 * THE EXAMPLE PACKAGES' OWN NAMES, scoped, read out of their `package.json`s rather than guessed.
 *
 * They were guessed first, and wrongly: the suite looked for `dsh-plugin-example` while the package
 * that ships is `@xjl-resources/dsh-plugin-example` — so every precondition below would have failed
 * with "the listing has no dsh-plugin-example" on a machine where it was installed and working. The
 * names are the same identity the listing, the row and the removal command all use.
 */
const EXAMPLE_PROJECT_PACKAGE = '@xjl-resources/dsh-plugin-example'
const EXAMPLE_DIALOG_PACKAGE = '@xjl-resources/dsh-plugin-example-dialog'

/**
 * The two example packages, and the DOM only they can produce.
 *
 * The listing alone is not enough: a package can be installed and still not be in the page, because
 * the running process loaded its composition before the install — which is the ordinary state right
 * after `dsh plugin add` and exactly what this suite's own README tells a reader to expect. So this
 * checks both halves and names which one is missing.
 * @param {{ send: Function }} session
 */
async function requireExamplePackages(session) {
  const listed = await requireInstalled(session, [EXAMPLE_PROJECT_PACKAGE, EXAMPLE_DIALOG_PACKAGE])
  const scene = await evaluate(
    session,
    `({
      surfaces: document.querySelectorAll('[data-example-dialog]').length,
      roles: Array.from(document.querySelectorAll('[data-example-dialog]')).map((el) => el.getAttribute('role')),
    })`,
  )
  if (scene?.surfaces !== 2) {
    throw new Error(
      `PRECONDITION NOT MET — ${EXAMPLE_DIALOG_PACKAGE} is listed (${listed.includes(EXAMPLE_DIALOG_PACKAGE)}) ` +
        `but its two [data-example-dialog] surfaces are not in the page (${JSON.stringify(scene ?? null)}). ` +
        `The running dsh web loaded its composition before the install: stop it, start it again, then re-run.`,
    )
  }
  return scene
}

/* ── run ──────────────────────────────────────────────────────────────────── */

const chrome = await launchChrome()
process.stdout.write(
  `\nLiquid Glass browser verification\nchrome:   port ${chrome.port}\npage:     ${pageUrl}\nsettings: ${
    noWrite ? 'writes REFUSED for the checklist (--no-write)' : 'writes allowed (the checklist records a real confirmation)'
  }\n\n`,
)

/** @type {Cdp | undefined} */
let cdp
/** @type {Cdp | undefined} */
let page
/**
 * What the skin's state was before this run touched anything.
 *
 * Declared out here because the restore lives in the `finally` below, and a `const` inside the `try`
 * block is not in scope there.
 */
let startedWithSkinOn = false
/**
 * The checklist record the instance had before this run; the closing guard compares against it.
 *
 * Declared out here for the same reason `startedWithSkinOn` is: the guard lives in the `finally`, and
 * a `let` inside the `try` is not in scope there. It was inside first, and the guard threw a
 * ReferenceError instead of reporting anything — in the one code path whose whole job is to report.
 */
let checksAtStart = null

/**
 * EVERY pause on the settings API, counted BEFORE anything is decided about it.
 *
 * WHY THIS EXISTS, and it is this file's own history: the interceptor used to log a request only when
 * it judged the request to be a WRITE, so "the page never touched the settings API" and "the page made
 * a hundred settings READS" produced exactly the same output — silence. A run was spent on that
 * difference: the gate reported `the interceptor saw and refused at least one write (0)` while the
 * truth was that the client's settings scope was not talking to the API at all (its reads and writes
 * never crossed the wire), so there was nothing for `--no-write` to refuse and nothing wrong with the
 * rule. Counting every pause turns those two cases into two different lines of output, which is the
 * whole fix.
 *
 * Declared OUT here for the same reason `startedWithSkinOn` and `checksAtStart` are: the summary
 * belongs in the `catch` that ends a `--verify-refusal` run, and a `const` inside the `try` is not in
 * scope there.
 */
const settingsPauses = { total: 0, describe: 0, mutate: 0, other: 0, writes: 0, reads: 0 }
/** How many pauses may be logged per bucket; past it they are counted and not printed, so a run stays readable. */
const SETTINGS_PAUSE_LOG_CAP = 20
const settingsPauseLogs = { describe: 0, mutate: 0, other: 0 }
/** The summary is printed once; the `catch` below is a backstop for an abort before the gate's report. */
let settingsPausesReported = false

/**
 * Which bucket a paused settings request belongs to, by its LAST path segment.
 *
 * The last segment is the only part that says what the call IS: `describe` is the read, and
 * `mutate`/`replace`/`update` are the three write-shaped verbs the refusal rule recognises — counted
 * together, because the question this answers is "did a write arrive at all", not which verb it used.
 * Anything else under the prefix is `other`: an API this suite has never seen, which is exactly the
 * thing worth seeing in a count.
 * @param {string} url
 * @returns {'describe' | 'mutate' | 'other'}
 */
function settingsPauseBucket(url) {
  let path = url
  try {
    path = new URL(url).pathname
  } catch {
    /* not a URL this runtime can parse: bucket it by its own text */
  }
  const segments = path.split('/').filter((part) => part.length > 0)
  const last = segments.length === 0 ? '' : segments[segments.length - 1]
  if (last === 'describe') return 'describe'
  if (last === 'mutate' || last === 'replace' || last === 'update') return 'mutate'
  return 'other'
}

/**
 * The one-line summary of the pauses above, plus the verdict when there were none.
 *
 * `reached` says whether the gate got as far as its own report: a run that died before any page loaded
 * also has zero pauses, and saying "this page never used the settings API" about a page that never
 * existed would be a worse diagnostic than saying nothing.
 * @param {string} tag @param {boolean} reached
 */
function reportSettingsPauses(tag, reached) {
  if (settingsPausesReported) return
  settingsPausesReported = true
  const { describe, mutate, other, total, writes, reads } = settingsPauses
  process.stdout.write(
    `${tag} settings pauses: describe ×${describe}, mutate ×${mutate}, other ×${other} ` +
      `(total ${total}; judged writes ${writes}, reads ${reads})\n`,
  )
  if (reached && describe === 0 && mutate === 0) {
    process.stdout.write(
      `${tag} CONCLUSION: this page never used the settings API — not one request under /api/settings/* was ` +
        `paused, so --no-write had nothing to refuse and the rule was never exercised. Before blaming the ` +
        `rule, check the panel's storage line and the page's own /api/settings/* requests.\n`,
    )
  }
}

try {
  const version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()
  cdp = new Cdp(version.webSocketDebuggerUrl)
  await cdp.ready

  // Attach straight to a page target's own socket: `Page`/`Runtime` are page
  // domains, so a browser-level socket has neither. A fresh tab keeps the run
  // independent of any other window the profile might restore.
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json()
  const target = targets.find((entry) => entry.id === targetId)
  if (target?.webSocketDebuggerUrl === undefined) throw new Error('the page target exposes no debugger socket')

  page = new Cdp(target.webSocketDebuggerUrl)
  await page.ready
  /** @type {{ send: (method: string, params?: any) => Promise<any> }} */
  const session = page

  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Log.enable')

  /** @type {string[]} */
  const pageErrors = []
  page.on('Runtime.exceptionThrown', (params) => {
    pageErrors.push(String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '?'))
  })
  page.on('Log.entryAdded', (params) => {
    if (params.entry.level === 'error') pageErrors.push(String(params.entry.text))
  })
  /*
   * Page-level `console.error` calls, which arrive on THIS event and nowhere else.
   *
   * The suite asserted "the skin raises no console or page errors" while listening only to the two
   * events above, so the claim was broader than the instrument: a page's own `console.error` — how
   * React reports duplicate list keys, among much else — was invisible to it. The gap was found while
   * adding the registry's uniqueness rule, which removes one source of exactly such a warning.
   *
   * Errors only: the shell logs informational lines through the same event by design.
   */
  page.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error') return
    pageErrors.push((params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' '))
  })
  /**
   * Whether every assertion that READS `pageErrors` has already run.
   *
   * The console calibration at the end of this file deliberately produces one, so from that point on
   * the collector is no longer a clean channel. That contract is asserted rather than described —
   * see the calibration test — because a comment cannot fail when someone adds an assertion after it.
   */
  let consoleAssertionsDone = false

  /** How many checklist writes `--no-write` refused, so the test can prove it refused something. */
  let refusedWrites = 0
  /**
   * The gate's mode, and it DEFAULTS TO THE SAFE ONE.
   *
   * `blanket` refuses every write to the settings API without consulting the rule at all, so during the
   * gate the document is safe BY CONSTRUCTION — whether or not `refusalReason` is right. That is the
   * entire point: this rule has now been wrong three times, and each time a run deleted somebody's
   * confirmation while the rule was being debugged. Fail-safe by default, and only the gate may switch.
   *
   * `rule` is the normal mode, reached only after the gate has proved the rule against bodies the
   * client really sent.
   */
  let refusalMode = 'blanket'
  /** Bodies the blanket phase refused: real payloads, for the rule to be checked against afterwards. */
  const gateBodies = []
  let gateRefusals = 0
  if (noWrite) {
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/settings/*', requestStage: 'Request' }] })
    page.on('Fetch.requestPaused', (params) => {
      /*
       * Answer a paused request, tolerating the one answer that can legitimately fail.
       *
       * A paused request is discarded when the page navigates away from it, and answering it
       * afterwards fails with `Invalid InterceptionId`. This suite navigates constantly, so the race
       * is not avoidable — and it is not a failure of anything. It must still be CAUGHT: these sends
       * are fire-and-forget, and an unhandled rejection does not fail an assertion, it aborts the
       * entire run mid-suite. That is how this was found: a full green run up to the mobile check,
       * then a crash with no verdict at all.
       *
       * Anything else is recorded rather than thrown, so a real interception problem shows up in the
       * console assertions instead of silently disappearing.
       */
      const answer = (method, request) =>
        session.send(method, request).catch((err) => {
          const message = String(err?.message ?? err)
          if (/Invalid InterceptionId/i.test(message)) return
          pageErrors.push(`[no-write] ${method}: ${message}`)
        })
      /*
       * Every paused request MUST be answered or the page hangs, so the decision is wrapped: a
       * handler that threw would present as a frozen application rather than as a failed assertion.
       */
      try {
        const url = String(params.request.url)
        const isWrite = /settings\/(mutate|replace|update)(\?|$)/.test(url)
        const payload = String(params.request.postData ?? '')
        /*
         * COUNTED FIRST, before the rule, before the refusal, before anything decides this request is
         * interesting. The bucket is the request's own last path segment and the write/read split is
         * the same predicate the rule uses — so the summary says what ARRIVED, independently of what
         * was done about it. See `settingsPauses` for the run that made this necessary.
         */
        const bucket = settingsPauseBucket(url)
        settingsPauses.total += 1
        settingsPauses[bucket] += 1
        if (isWrite) settingsPauses.writes += 1
        else settingsPauses.reads += 1
        if (settingsPauseLogs[bucket] < SETTINGS_PAUSE_LOG_CAP) {
          settingsPauseLogs[bucket] += 1
          process.stderr.write(
            `[no-write] pause #${settingsPauses.total} ${String(params.request.method ?? '?')} ${url} ` +
              `→ ${isWrite ? 'write' : 'read'} (${bucket})\n`,
          )
        } else if (settingsPauseLogs[bucket] === SETTINGS_PAUSE_LOG_CAP) {
          settingsPauseLogs[bucket] += 1
          process.stderr.write(
            `[no-write] (${bucket}: further pauses are counted but not printed, cap ${SETTINGS_PAUSE_LOG_CAP})\n`,
          )
        }
        /*
         * EVERY write is logged, in the shape it actually has, before any decision is taken.
         *
         * This is the diagnostic the plan promised and the first implementation did not deliver: it
         * logged only refusals, so a run that refused nothing printed nothing and could not say
         * whether the rule had failed to match or the request had never arrived. Two runs were spent
         * on that difference. The raw body goes out too, because the whole lesson of this file is that
         * a payload shape guessed from a type declaration is not a payload shape.
         */
        if (isWrite) {
          process.stderr.write(
            `[no-write] write ${describeWrite(payload)}\n[no-write]   raw ${payload.slice(0, 240)}\n`,
          )
        }
        const reason = refusalReason({ payload, isWrite })
        /*
         * THE GATE'S BLANKET PHASE. No classification, no rule, no judgement: every write to the
         * settings API is refused while the gate runs, and its body is kept. The document cannot change
         * in this phase even if `refusalReason` is completely wrong — which is the property that was
         * missing on the three occasions a wrong rule ran first and data was lost.
         */
        if (isWrite && refusalMode === 'blanket') {
          gateRefusals += 1
          gateBodies.push(payload)
          process.stderr.write(`[gate] REFUSED (blanket) ${describeWrite(payload)}\n`)
          void answer('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' })
          return
        }
        if (reason !== null) {
          refusedWrites += 1
          process.stderr.write(`[no-write] REFUSED (${reason})\n`)
          void answer('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' })
          return
        }
        /*
         * An ALLOWED write that carries a protected key means this rule is broken, and it is worth
         * more than a failed assertion later: the settings document is about to change under somebody.
         * Told loudly, with the payload, and the run's exit code is set by the closing guard.
         */
        if (isWrite && touchesProtectedKey(payload)) {
          process.stderr.write(
            `[no-write] FATAL: a protected write was ALLOWED through — the refusal rule is broken.\n` +
              `[no-write] ${describeWrite(payload)}\n` +
              `[no-write] ${payload.slice(0, 400)}\n`,
          )
        }
      } catch {
        /* fall through to continuing the request */
      }
      void answer('Fetch.continueRequest', { requestId: params.requestId })
    })
  }

  const navigate = async (url) => {
    await session.send('Page.navigate', { url })
    await waitFor(session, "document.querySelectorAll('#root *').length > 40", 'the app to mount', 45000)
    await waitFor(session, "document.querySelector('[data-rightbar-col]') !== null", 'the app frame')
  }

  await test('the application boots and mounts', async () => {
    await navigate(pageUrl)
  })

  if (noWrite) {
    /*
     * The refusal rule is checked ABOVE, before Chrome is launched, against payloads in the shape the
     * client really sends — the same `runSelfCheck` this file runs under `--self-check`. It used to be
     * checked here, from inside the session, with payloads written as arrays that nothing sends, which
     * is why a rule that refused nothing looked verified.
     */
    const failures = runSelfCheck()
    equal(failures, 0, 'the refusal rule agrees with real payload shapes before anything is touched')
  }

  await test('the Settings › UI section opens from the sidebar', async () => {
    const opened = await evaluate(session, OPEN_PANEL)
    truthy(opened.ok, `settings trigger (${JSON.stringify(opened)})`)
    const section = await evaluate(session, CLICK_SECTION)
    truthy(section.ok, `UI section (${JSON.stringify(section)})`)
    await waitFor(session, "document.querySelectorAll('.uip-root').length > 0", 'the UI panel')
  })

  /*
   * ── THE GATE ───────────────────────────────────────────────────────────────
   *
   * Three runs of this suite deleted a confirmation from a real settings document, because a rule that
   * refuses nothing looks exactly like a rule whose case never came up. Each time the fix was to read
   * the source more carefully and try again, and each time the next run paid for the mistake.
   *
   * So the rule no longer runs first. This gate runs first, in `blanket` mode, where every write to the
   * settings API is refused WITHOUT CONSULTING THE RULE — the document is safe whether the rule is
   * right or wrong — and the bodies it refuses are kept. Then, and only then, the rule is asked to
   * classify those REAL payloads. A rule that disagrees with what the client actually sends fails here,
   * with the document untouched and the log showing exactly what arrived.
   *
   * Two triggers, not one, because one capture proves one shape: a confirmation writes the `settings`
   * key carrying a record, and a withdrawal writes it without one. Both are refused in this phase, so
   * the run leaves the checklist as it found it and the UI's in-memory state is discarded by the reload
   * below.
   */
  const gateStartFailures = failures
  if (!noWrite) {
    process.stdout.write('         note  the refusal gate only runs under --no-write; skipping it\n')
  }
  if (noWrite) await test('the refusal rule is proved against real payloads first', async () => {
    const before = await readSettingsSubtree()
    if (!before.ok) {
      process.stdout.write(`         note  the document could not be read (${before.why}); the state check is skipped\n`)
    }

    await navigate(pageUrl)
    await ensurePanel(session)
    /*
     * The state this run found, read here rather than in the phase that normally reads it: in
     * `--verify-refusal` mode the run ends before that phase, and the closing restore would otherwise
     * act on a value that was never observed.
     */
    startedWithSkinOn = await skinIsOn(session)

    /*
     * ── THE PRECONDITION, BEFORE ANY CLICK ────────────────────────────────────
     *
     * The gate's subject is the refusal rule, but its evidence is a WRITE, and a write only happens if
     * the project it drives is on. That made every assertion below the click depend on a fact nobody
     * had checked: the gate named `liquid-glass`, the one-skin policy can leave another skin active
     * instead, and a click on a project the document says is off is dropped in silence. The run then
     * reported `the interceptor saw and refused at least one write (0)` — a sentence about the rule,
     * about a run where the rule never got a chance to speak. An hour went into reading the rule again.
     *
     * So the target is RESOLVED first and the resolution is asserted, which turns that class of failure
     * into one sentence that names the state it found: which projects exist, which are on, and which of
     * them carry a checklist. Nothing is clicked before it passes, and no id is named: `enabled` in
     * somebody's document decides, not this file.
     */
    const resolved = await resolveChecklistTarget(session)
    if (resolved.target === null) {
      const enabled = await readUiProjectsBlock('enabled')
      /*
       * The pause summary is printed HERE, not at the gate's usual report further down: this failure is
       * the one where the counts decide the diagnosis — a page that never reached the settings API and a
       * click that was dropped both produce zero writes — and the summary prints once by design
       * (`settingsPausesReported`). The gate's own call below therefore prints nothing when this fires,
       * which is why the tag in the log is `[gate precondition]` and not `[gate]`.
       */
      reportSettingsPauses('[gate precondition]', true)
      throw new Error(
        'PRECONDITION NOT MET — no project is both ON and carrying a checklist, so the gate has nothing ' +
          'it can drive. It clicks a project the document says is off at its peril: the click is dropped ' +
          'without a trace and the failure is then read as a broken refusal rule. Turn a project with a ' +
          'checklist on, then re-run.' +
          `\n           switch states: ${describeSwitches(resolved.projects)}` +
          `\n           ui-projects.enabled: ${enabled.ok ? enabled.text : `(unreadable — ${enabled.why})`}`,
      )
    }
    // Named in the log rather than implied: which project this run drove is part of its evidence.
    process.stdout.write(
      `         note  the gate drives ${resolved.target}: switch on, checklist present\n`,
    )
    const confirmed = await driveChecklistConfirm(session, resolved.target)
    truthy(
      confirmed.ok,
      `the gate could drive a confirmation on ${resolved.target} (${JSON.stringify(confirmed)})`,
    )
    const withdrew = await driveChecklistWithdraw(session, resolved.target)
    // Not an assertion: whether a withdrawal is offered depends on whether the instance has a record,
    // and a gate that demanded one would fail on a machine with nothing to protect.
    process.stdout.write(`         note  the withdrawal trigger: ${JSON.stringify(withdrew)}\n`)

    /*
     * WAIT FOR THE WRITES, because they are sent a moment after the click: a record write is one field
     * write per key, queued, and the gate's first version judged on whatever had arrived by then — a
     * single `enabled` write — and reported a rule failure that was really a timing failure. It waits
     * for the write that matters: a body carrying the `settings` path, which is the one this whole
     * exercise is about. A timeout is a different failure from a rule that misclassifies, and the
     * message says which.
     */
    const settingsDeadline = Date.now() + 8000
    while (Date.now() < settingsDeadline && !gateBodies.some((body) => carriesSettingsPath(body))) {
      await sleep(100)
    }

    truthy(gateRefusals > 0, `the interceptor saw and refused at least one write (${gateRefusals})`)
    truthy(gateBodies.length > 0, `and kept its body (${gateBodies.length})`)
    truthy(
      gateBodies.some((body) => carriesSettingsPath(body)),
      `a write carrying the settings key was attempted within 8s (${gateBodies.map(describeWrite).join(' | ')})`,
    )

    /*
     * The rule, against bodies the client really sent. Every captured body is classified, and the
     * classification is cross-checked against the independent detector: a body either carries a
     * protected key and is refused, or carries none and is allowed. A disagreement in EITHER direction
     * is a broken rule, and this is the assertion that would have caught all three of the wrong shapes
     * before a single byte was at risk.
     */
    const verdicts = gateBodies.map((body) => ({
      described: describeWrite(body),
      reason: refusalReason({ payload: body, isWrite: true }),
      carriesProtected: touchesProtectedKey(body),
    }))
    for (const verdict of verdicts) {
      process.stdout.write(
        `         gate  ${JSON.stringify(verdict.reason)} carriesProtectedKey=${verdict.carriesProtected} ${verdict.described}\n`,
      )
    }
    const contradictions = verdicts.filter((verdict) => (verdict.reason !== null) !== verdict.carriesProtected)
    equal(
      contradictions.map((verdict) => verdict.described),
      [],
      'the rule and the detector agree on every body the client actually sent',
    )
    truthy(
      verdicts.some((verdict) => verdict.reason === 'settings'),
      `at least one real body is refused as a settings write (${JSON.stringify(verdicts.map((v) => v.reason))})`,
    )

    if (before.ok) {
      const after = await readSettingsSubtree()
      truthy(after.ok, `the document is still readable after the gate (${after.why ?? ''})`)
      equal(after.text, before.text, 'and its settings block is byte-for-byte what it was')
    }
  })

  if (noWrite) {
    /*
     * THE GATE'S CLOSING REPORT, printed whether the gate passed or failed — that is the point of it.
     * The failure this answers was a gate that could only say "0 writes were refused", which reads as a
     * broken rule and was really a page that never used the settings API; the counts say which.
     */
    reportSettingsPauses('[gate]', true)
    const gateFailures = failures - gateStartFailures
    if (gateFailures > 0) {
      throw new Error(
        `the refusal gate failed (${gateFailures} assertion(s)): this build's --no-write cannot be ` +
          `trusted with the settings document, so the run stops here. The gate itself was in blanket ` +
          `mode, which refuses every write without consulting the rule, so nothing was changed.`,
      )
    }
    /*
     * Only now does the rule take over. And the page is reloaded first, because the gate drove a
     * confirmation whose write was refused: the panel holds an in-memory record that the document does
     * not have, and every phase below would be reading that contradiction instead of the truth.
     */
    refusalMode = 'rule'
    await navigate(pageUrl)
    await ensurePanel(session)
    process.stdout.write('         note  the gate passed; the refusal rule is now in charge\n')
  }
  if (verifyRefusalOnly) throw new Error(GATE_ONLY)

  /*
   * Start from the state the phases below assume, and remember what it was.
   *
   * The alternative — requiring a machine whose settings document happens to say `enabled: []` — is
   * not a precondition, it is a fragility: the suite passed only where nobody had switched the skin
   * on, and a person who had would see a dozen failures that all echoed that one mismatch. The
   * `finally` below puts the document back, so a run that starts with the skin ON still ends with it
   * ON.
   */
  await test('the run starts from the skin off, whatever the document said', async () => {
    startedWithSkinOn = await skinIsOn(session)
    if (!startedWithSkinOn) return
    await setSkin(session, false)
    equal(await skinIsOn(session), false, 'the skin is off, so the phases below measure the default interface first')
  })

  await test('the panel lists the registered project with a keyboard-accessible switch', async () => {
    const state = await evaluate(session, PANEL_STATE)
    truthy(state.panel > 0, 'the panel is rendered')
    contains(JSON.stringify(state.cards), 'liquid-glass')
    equal(state.checked, 'false', 'the skin ships off')
    contains(state.label, 'Liquid Glass')
    equal(state.name, 'Liquid Glass', 'card title')
    equal(state.status, 'inactive', 'card status')

    /*
     * What the document said about the checklist BEFORE this run touched anything.
     *
     * A machine that has a confirmation recorded is a normal machine, not a broken one, and two things
     * have to know about it. `--no-write` refuses the checklist write, so with a record already there
     * the reload assertion below would otherwise read the INHERITED record and call it evidence that
     * this run wrote one. And the withdrawal check presses the card's reset, whose write carries no
     * `checks` at all — refusing writes that merely mention `checks` is not enough to protect a record
     * from being deleted by a run that is supposed to leave no trace.
     */
    checksAtStart = await evaluate(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        const record = details === null ? null : details.querySelector('[data-uip-checks]')
        return record === null ? null : record.getAttribute('data-uip-checks')
      })()`,
    )
    if (checksAtStart !== null) {
      process.stdout.write(
        `         note  this instance starts with a checklist record (${checksAtStart}); ` +
          `--no-write will hand it back unchanged\n`,
      )
    }
  })

  /** @type {any} */
  let before
  await test('the default interface is untouched before the skin is on', async () => {
    before = await evaluate(session, PROBE)
    equal(before.projectAttr, null, 'no project marker')
    equal(before.ambient, 0, 'no ambient layer')
    equal(before.tokens.accent, '', 'the skin vocabulary is absent')
    truthy(before.frames > 0, 'the app frame is present to measure against')
    truthy(before.tokens.layer1 !== '', 'the shipped token resolves')
    // The shipped client blurs one surface of its own, so the skin is held to the
    // stronger claim: it must ADD blur, and later remove exactly what it added.
    truthy(Array.isArray(before.blurKeys), 'the blurred-element set is observable')
  })

  /** @type {any} */
  let after
  await test('turning the skin on really makes shipped surfaces glass', async () => {
    const clicked = await evaluate(session, CLICK_SWITCH)
    truthy(clicked.ok, `switch click (${JSON.stringify(clicked)})`)
    try {
      await waitFor(session, "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'", 'the marker')
    } catch (err) {
      /*
       * Report WHY the click had no effect, rather than only that it did not, and keep watching:
       * the switch is disabled while an action is pending, so a click on it is silently dropped. A
       * suite whose first action succeeds while the second does nothing two seconds later is
       * describing exactly that — so measure how long the pending state actually lasts instead of
       * leaving it to be guessed at.
       */
      const probe = `(() => {
        const sw = document.querySelector('[data-project="liquid-glass"] [role="switch"]')
        return {
          switchFound: sw !== null,
          disabled: sw === null ? null : sw.disabled,
          ariaChecked: sw === null ? null : sw.getAttribute('aria-checked'),
          panelOpen: document.querySelectorAll('.uip-root').length,
        }
      })()`
      const state = await evaluate(session, probe)
      const startedAt = Date.now()
      let recoveredAfter = null
      while (Date.now() - startedAt < 30000) {
        const now = await evaluate(session, probe)
        if (now.disabled === false) {
          recoveredAfter = Date.now() - startedAt
          break
        }
        await sleep(250)
      }
      const final = await evaluate(session, probe)
      throw new Error(
        `${err.message}; click ${JSON.stringify(clicked)}; switch at failure ${JSON.stringify(state)}; ` +
          `enabled again after ${recoveredAfter === null ? '>30000' : recoveredAfter} ms, now ${JSON.stringify(final)}; ` +
          `errors so far ${JSON.stringify(pageErrors.filter((m) => !/favicon|net::ERR_/i.test(m)).slice(-3))}`,
      )
    }

    after = await evaluate(session, PROBE)
    equal(after.projectAttr, 'on', 'project marker')
    equal(after.skinAttr, 'liquid-glass', 'skin marker')
    equal(after.systemAttr, 'on', 'system marker')
    equal(after.ambient, 0, 'no ambient layer: the material is stylesheet-only')

    // The point of the whole exercise: the skin adds refraction to shipped regions.
    // Compared as a set, so the one surface the client already blurs is not
    // mistaken for the skin's own work.
    const added = after.blurKeys.filter((key) => !before.blurKeys.includes(key))
    truthy(
      added.length > 0,
      `the skin added blurred surfaces (added ${added.length}: ${JSON.stringify(added.slice(0, 4))})`,
    )
    const large = after.blurred.filter((entry) => entry.w > 200 && entry.h > 100)
    truthy(large.length > 0, `a real application region is blurred: ${JSON.stringify(after.blurred.slice(0, 4))}`)

    // The shipped design tokens changed value — that is what turns components glass.
    truthy(
      after.tokens.layer1 !== before.tokens.layer1,
      `the layer-1 token changed: ${before.tokens.layer1} → ${after.tokens.layer1}`,
    )
    contains(after.tokens.layer1, '/', 'the new fill is translucent rather than opaque')
    truthy(
      after.tokens.sidebar !== before.tokens.sidebar,
      `the sidebar fill changed: ${before.tokens.sidebar} → ${after.tokens.sidebar}`,
    )
    /*
     * The accent pair — and the halves are here because the assertion that used to stand here
     * compared the wrong token with the wrong value.
     *
     * `--lg-accent` is the skin's OWN token: the specification names its palette, `#007aff`, in the
     * system-blue family that `--lg-accent-dark` and the indigo pair beside it belong to. It has to
     * reach the page, because the skin's own material reads it. Assert `#4d6bfe` here and the check
     * is describing the shell's brand colour while measuring the skin's.
     *
     * The shipped accent is the other half, and it is the more interesting claim: a skin is a
     * material, not a re-brand. `--dsw-alias-brand-primary` is the shell's colour — the one its own
     * components fall back to — and the skin must leave it exactly as it found it.
     */
    equal(before.tokens.accent, '', 'no Liquid Glass accent exists in the default interface')
    equal(after.tokens.accent, '#007aff', "the skin's own accent reaches the page")
    truthy(before.tokens.brand !== '', 'the shipped brand accent is present to compare against')
    equal(after.tokens.brand, before.tokens.brand, 'and the skin did not re-brand it')

    /*
     * The composer, which is the surface the specification never named.
     *
     * Measured, not asserted from the stylesheet: the fill has to actually change, the blur has to
     * be on the pseudo-element, and the pseudo-element has to be the thing that carries it — the card
     * itself must stay free of `backdrop-filter`, because that property is what would create a
     * containing block for a fixed descendant.
     */
    truthy(after.composer.cardFound, 'the composer card is in the document')
    truthy(after.composer.seatFound, 'and the seat it sits in')
    /*
     * The alpha, read from the computed colour rather than pattern-matched for a `/`: Chrome
     * serialises a computed `backgroundColor` in the legacy comma form (`rgba(255, 255, 255, 0.58)`),
     * so a translucency test written the way the token values are written would fail on a correct
     * page. `undefined` means the colour has no alpha channel, i.e. it is opaque.
     */
    const alphaOf = (value) => /rgba\([^)]*,\s*([\d.]+)\)\s*$/.exec(String(value))?.[1]
    equal(alphaOf(before.composer.fill), undefined, `the shipped card is opaque (${before.composer.fill})`)
    truthy(
      after.composer.fill !== before.composer.fill,
      `the card's fill changed: ${before.composer.fill} → ${after.composer.fill}`,
    )
    truthy(
      Number(alphaOf(after.composer.fill)) < 1,
      `and it is now translucent (${after.composer.fill})`,
    )
    contains(after.composer.frostBlur, 'blur', `the frost is on the pseudo-element (${after.composer.frostBlur})`)
    contains(after.composer.frostBlur, '20px', `at the full radius (${after.composer.frostBlur})`)
    equal(after.composer.isolation, 'isolate', 'with the stacking context the frost needs to land in')
    /*
     * The seat is deliberately NOT asserted here. The skin declares no rule about it — that absence
     * is asserted in `suite` — and a browser-side value comparison would be vacuous: with the skin
     * off no skin rule applies, so the two readings are equal whatever the skin says.
     */
  })

  await test('the switch reports its state accessibly after the change', async () => {
    const state = await evaluate(session, PANEL_STATE)
    equal(state.checked, 'true', 'aria-checked follows the state')
    // The accessible name is localized, so assert it names the project and reflects
    // the new state rather than pinning one language's wording.
    contains(state.label, 'Liquid Glass')
    truthy(
      /Turn off|关闭/.test(String(state.label)),
      `the label says the switch will turn it OFF: ${state.label}`,
    )
    equal(state.status, 'active', 'card status')
  })

  if (shotPath !== undefined) {
    await test('a screenshot of the skinned interface is captured', async () => {
      const shot = await session.send('Page.captureScreenshot', { format: 'png' })
      await writeFile(shotPath, Buffer.from(shot.data, 'base64'))
      process.stdout.write(`         saved ${shotPath} (dialog open)\n`)
    })

    await test('the interface itself is captured with the dialog closed', async () => {
      // The dialog covers the conversation, so the skin's effect on the *content* —
      // the thing that must stay readable — is only visible with it dismissed. An
      // earlier version of this skin failed exactly here, and a passing panel
      // screenshot hid it.
      //
      // Dismissed with Escape rather than by hunting for the close button: the shell
      // owns that chrome, and guessing at it clicked the wrong control.
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await waitFor(session, "document.querySelectorAll('.uip-root').length === 0", 'the dialog to close', 10000)
      // Let the dialog's exit transition and the shell's own animations settle: a
      // capture taken mid-transition is a photograph of the animation, not of the
      // interface, and would misreport a readable page as a blurred one.
      await sleep(700)
      const shot = await session.send('Page.captureScreenshot', { format: 'png' })
      const closedPath = shotPath.replace(/\.png$/, '-closed.png')
      await writeFile(closedPath, Buffer.from(shot.data, 'base64'))
      process.stdout.write(`         saved ${closedPath} (dialog closed)\n`)

      // Record what the capture should show, so a blurred result can be attributed
      // instead of guessed at.
      const state = await evaluate(session, `(() => {${HELPERS}
        const blurred = sweepBlur();
        const copy = Array.from(document.querySelectorAll('[data-rightbar-col] *'))
          .filter((el) => el.children.length === 0 && (el.textContent || '').trim().length > 1)
          .slice(0, 3)
          .map((el) => ({ text: (el.textContent || '').trim().slice(0, 20), opacity: getComputedStyle(el).opacity, filter: getComputedStyle(el).filter, blur: getComputedStyle(el).backdropFilter }));
        return { blurredCount: blurred.length, blurred: blurred.slice(0, 5), sample: copy, animations: document.getAnimations().length };
      })()`)
      process.stdout.write(`         closed state: ${JSON.stringify(state)}\n`)

      // Re-open for the phases that follow.
      await ensurePanel(session)
    })
  }

  await test('text over the glass is still readable, measured from the rendered pixels', async () => {
    // Runs while the skin is ON and the panel is open, so both the application's
    // own text and the settings copy are measurable. A translucent skin can look
    // convincing and still fail here — which is the whole reason for measuring.
    const targets = await evaluate(session, TEXT_TARGETS)
    truthy(targets.length >= 2, `text targets located (${JSON.stringify(targets.map((t) => t.label))})`)

    /** @type {Array<{ label: string, delta: number }>} */
    const measured = []
    for (const target of targets) {
      measured.push({ label: target.label, delta: await measuredContrast(session, target) })
    }
    const worst = measured.reduce((a, b) => (a.delta <= b.delta ? a : b))
    // 14px body text needs 4.5:1 against its background, roughly a luminance delta
    // of 0.25 for the greys this design uses. Under 0.2 means the glass has washed
    // the text out, whatever the token values claim.
    truthy(
      worst.delta >= 0.2,
      `every measured text box keeps contrast (worst: ${worst.label} at ${worst.delta}; all: ${JSON.stringify(measured)})`,
    )
  })

  await test('the skin survives a reload', async () => {
    await navigate(pageUrl)
    await waitFor(session, "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'", 'the marker')
    const restored = await evaluate(session, PROBE)
    equal(restored.projectAttr, 'on', 'the marker is restored from persisted state')
    equal(restored.ambient, 0, 'still no ambient layer after a reload')
    equal(restored.tokens.layer1, after.tokens.layer1, 'the skin palette is restored')
    // And the refraction comes back where it belongs: on a floating surface.
    await ensurePanel(session)
    const withDialog = await evaluate(session, PROBE)
    truthy(withDialog.blurredCount > 0, 'the dialog carries the refraction after a reload')
  })

  await test('turning the skin off restores the original computed styles exactly', async () => {
    await ensurePanel(session)
    const clicked = await evaluate(session, CLICK_SWITCH)
    truthy(clicked.ok, `switch click (${JSON.stringify(clicked)})`)
    await waitFor(
      session,
      "document.body.getAttribute('data-ui-project-liquid-glass') === null",
      'the marker to clear',
    )

    const restored = await evaluate(session, PROBE)
    equal(restored.projectAttr, null, 'project marker removed')
    equal(restored.skinAttr, null, 'skin marker removed')
    equal(restored.ambient, 0, 'ambient layer removed')
    equal(restored.blurKeys, before.blurKeys, 'exactly the original blurred surfaces remain')
    equal(restored.tokens.layer1, before.tokens.layer1, 'the layer-1 token is back to its original value')
    equal(restored.tokens.sidebar, before.tokens.sidebar, 'the sidebar fill is back to its original value')
    equal(restored.tokens.accent, '', 'the skin vocabulary is gone')
    /*
     * The composer too, and the comparison is against the RECORDED value rather than a colour written
     * here: hard-coding `#fff` would fail on a dark-themed instance for a reason that has nothing to
     * do with the skin, which is a mistake this suite has already made once.
     */
    equal(restored.composer.fill, before.composer.fill, 'the composer fill is back to the shipped opaque value')
    equal(restored.composer.frostBlur, before.composer.frostBlur, 'and its frost layer is gone')
    equal(restored.composer.isolation, before.composer.isolation, 'with the stacking context it declared')
  })

  await test('a mobile-sized viewport gets the reduced blur with no overflow', async () => {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    })
    /*
     * Cleared in a `finally`, and that is load-bearing rather than tidy. On this suite's first run
     * the assertions below failed, the clear at the end of the body never executed, and the 390px
     * viewport stayed in force for every test after it — which is why the tier check three tests
     * later measured the mobile radius and reported it as a wrong full-tier blur. A failed test
     * must not change what the next test is measuring.
     */
    try {
      // The skin is turned ON for this phase explicitly, rather than relying on what
      // the previous test left behind: each phase states the state it needs.
      await setSkin(session, true)
      await navigate(pageUrl)
      await waitFor(session, "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'", 'the marker')
      // Open the panel: the refraction lives on floating surfaces, so a dialog is what
      // makes it measurable — and the dialog is also the surface a phone user opens.
      await ensurePanel(session)
      const mobile = await evaluate(session, `(() => {${HELPERS}
        const blurred = sweepBlur();
        // The element to measure is the one carrying the SKIN's material, not merely the
        // first blurred node in the tree: the dialog's own mask is a shipped element that
        // blurs 2px, and it comes first. Selecting by the saturate() the skin always adds
        // keeps this a measurement of the skin.
        const skinBlur = blurred.find((entry) => entry.filter.includes('saturate')) || blurred[0];
        return {
          count: blurred.length,
          blurValue: skinBlur ? skinBlur.filter : '',
          blurred,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          width: window.innerWidth,
          mobileQuery: matchMedia('(max-width: 768px)').matches,
          resolvedRadius: getComputedStyle(document.body).getPropertyValue(${JSON.stringify(MOBILE_BLUR_TOKEN)}).trim(),
          /*
           * The composer's own frost, read from its pseudo-element. It is in this probe because a
           * phone is where it matters most — the card is nearly the full width of the viewport — and
           * because a degradation block that forgot it would otherwise pass this test while leaving
           * the one large surface at the desktop radius.
           */
          composerBlur: (() => {
            const card = document.querySelector('[data-composer-card]');
            return card === null ? null : String(getComputedStyle(card, '::before').backdropFilter || '');
          })(),
        };
      })()`)
      equal(mobile.width, 390, 'the emulated viewport applied')
      truthy(mobile.count > 0, `a floating surface is still blurred on mobile (${JSON.stringify(mobile)})`)
      // The mobile step-down is the whole point of that media query, so assert it.
      contains(
        mobile.blurValue,
        `${MOBILE_BLUR_PX}px`,
        `measured ${JSON.stringify(mobile.blurValue)}; radius token ${JSON.stringify(mobile.resolvedRadius)}; ` +
          `mobile query ${mobile.mobileQuery}; blurred ${JSON.stringify(mobile.blurred)}`,
      )
      equal(mobile.overflow, false, 'the skin introduces no horizontal overflow')
      contains(
        String(mobile.composerBlur),
        `${MOBILE_BLUR_PX}px`,
        `the composer steps down with everything else on a phone (${mobile.composerBlur})`,
      )
    } finally {
      await session.send('Emulation.clearDeviceMetricsOverride')
    }
  })

  await test('dark mode gets blue-black glass, not the light palette', async () => {
    /*
     * Dark mode is selected through the SAME signal the shipped client uses to
     * switch its own palette: the `data-ds-dark-theme` attribute on `body`. That is
     * the whole interface between the theme feature and a skin, and setting it
     * directly is what makes this phase independent of which Settings section
     * happens to be open — an earlier version drove the Appearance control and
     * broke whenever the dialog remembered a different section.
     *
     * The skin's own behaviour is what is under test here, and the token values
     * below are read from computed styles, so nothing about this is assumed.
     */
    await navigate(pageUrl)
    await waitFor(
      session,
      "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'",
      'the restored skin',
    )
    await evaluate(session, "document.body.setAttribute('data-ds-dark-theme', '')")
    await waitFor(session, "document.body.getAttribute('data-ds-dark-theme') !== null", 'dark mode to apply', 10000)

    const dark = await evaluate(session, PROBE)
    const darkState = await evaluate(session, `(() => {${HELPERS}
      const bs = getComputedStyle(document.body);
      const supports = (q) => window.CSS && CSS.supports ? CSS.supports(q) : 'no CSS.supports';
      // Which rule actually won for the layer-1 token, and why.
      let winner = null;
      for (const sheet of document.styleSheets) {
        let rules = [];
        try { rules = Array.from(sheet.cssRules); } catch (e) { continue; }
        for (const rule of rules) {
          const text = rule.cssText || '';
          if (!text.includes('--dsw-alias-bg-layer-1')) continue;
          winner = winner || [];
          if (winner.length < 4) winner.push(text.slice(0, 150));
        }
      }
      return {
        darkAttr: document.body.getAttribute('data-ds-dark-theme'),
        layer1: bs.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
        sidebar: bs.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
        blurSupported: supports('backdrop-filter: blur(1px)'),
        webkitBlurSupported: supports('-webkit-backdrop-filter: blur(1px)'),
        winner,
      };
    })()`)
    // The skin must still be applied, and its fill must be the DARK one.
    equal(dark.projectAttr, 'on', 'the skin is still applied in dark mode')
    equal(dark.ambient, 0, 'and none in dark mode either')
    // The refraction is on floating surfaces, so it is checked with the dialog open
    // (the dark-mode block below re-opens it) rather than on the page at rest.
    truthy(
      String(darkState.layer1).includes('/') && !String(darkState.layer1).includes('255 255 255'),
      `the dark fill resolves to translucent blue-black (state: ${JSON.stringify(darkState)})`,
    )

    const darkText = String(darkState.layer1).match(/rgb\((\d+) (\d+) (\d+)/)
    truthy(darkText !== null && Number(darkText[1]) < 90, `the dark fill is dark: ${darkState.layer1}`)

    // Re-open the panel so there is unobstructed glass-backed text to measure, and so
    // the dark palette's refraction is present on a floating surface.
    await ensurePanel(session)
    const darkFloating = await evaluate(session, PROBE)
    truthy(darkFloating.blurredCount > 0, 'the floating surface is glass in dark mode too')

    // And it must stay readable over that fill, measured from pixels, not tokens.
    const darkTargets = await evaluate(session, TEXT_TARGETS)
    const darkUi = await evaluate(session, `(() => {${HELPERS}
      return {
        panelOpen: document.querySelectorAll('.uip-root').length,
        visibleTexts: Array.from(document.querySelectorAll('*'))
          .filter(isVisible)
          .map((el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(''))
          .filter((t) => t.length > 0 && t.length < 14)
          .slice(0, 16),
      };
    })()`)
    truthy(
      Array.isArray(darkTargets) && darkTargets.length >= 1,
      `dark-mode text targets located (got ${JSON.stringify(darkTargets)}; ui ${JSON.stringify(darkUi)})`,
    )
    const measured = []
    for (const target of darkTargets) {
      measured.push({ label: target.label, delta: await measuredContrast(session, target) })
    }
    const worst = measured.reduce((a, b) => (a.delta <= b.delta ? a : b))
    truthy(
      worst.delta >= 0.2,
      `dark-mode text keeps contrast (worst: ${worst.label} at ${worst.delta}; all: ${JSON.stringify(measured)})`,
    )

    if (shotPath !== undefined) {
      const darkShot = shotPath.replace(/\.png$/, '-dark.png')
      const shot = await session.send('Page.captureScreenshot', { format: 'png' })
      await writeFile(darkShot, Buffer.from(shot.data, 'base64'))
      process.stdout.write(`         saved ${darkShot}\n`)
    }

    // Leave the page in light mode so the run is repeatable: the same signal that
    // switched it on switches it back.
    await evaluate(session, "document.body.removeAttribute('data-ds-dark-theme')")
  })

  await test('the skin raises no console or page errors', () => {
    /*
     * Every channel a page can complain on: uncaught exceptions, browser log entries, and — since this
     * round — the page's own `console.error`. The name of this test used to promise more than the
     * instrument covered.
     */
    const relevant = pageErrors.filter((message) => !/favicon|net::ERR_|Failed to load resource/i.test(message))
    equal(relevant, [], 'no errors raised while the skin was applied')
    // The collector is a clean channel up to here; the calibration at the end of the run is what
    // makes it dirty, and it asserts this flag before it does.
    consoleAssertionsDone = true
  })

  /*
   * The verification checklist, driven the way a person drives it.
   *
   * The suite cannot judge whether text is comfortable to read; a person can. What it CAN check is
   * that the instrument around that judgement works: the disclosure opens, the boxes tick, the
   * button refuses until every box is ticked, and the confirmation survives a reload — which is the
   * whole point of recording it.
   *
   * NOTE: this writes to the durable settings document. The run leaves a confirmation recorded
   * against the current version, which is honest — a test did look at it — but it is a real change
   * to the profile this suite is pointed at.
   */
  await test('the verification checklist records a confirmation that survives a reload', async () => {
    await ensurePanel(session)
    await waitFor(
      session,
      `document.querySelector('details.uip-tests[data-project="liquid-glass"]') !== null`,
      'the checklist disclosure',
    )

    const opened = await evaluate(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        if (details === null) return { ok: false, why: 'no disclosure' }
        details.open = true
        const boxes = Array.from(details.querySelectorAll('input[type=checkbox]'))
        if (boxes.length === 0) return { ok: false, why: 'no boxes' }
        return { ok: true, boxes: boxes.length }
      })()`,
    )
    truthy(opened.ok, `the disclosure opens with items (${JSON.stringify(opened)})`)

    // The button must refuse while the boxes are unticked: the confirmation is an assertion, not an
    // automatic consequence of opening the panel.
    /*
     * STATE-AGNOSTIC, and it was not before. The card arrives in whatever state the record left it in:
     * the boxes are the READING and they are seeded from the record, so a machine that already holds a
     * CURRENT confirmation opens with every box ticked — and this assertion then failed with
     * `expected true, got false` on the button, which reads as the checklist refusing to work rather
     * than as an assertion that quietly assumed an empty one. (It held until a real confirmation
     * existed on this machine, which is exactly when it stopped being true.)
     *
     * So the unticked state is CREATED here rather than assumed: untick one box, wait for the button to
     * refuse, and let the step below tick everything again.
     */
    const untick = await evaluate(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        const box = details.querySelector('input[type=checkbox]')
        if (box === null) return { ok: false, why: 'no boxes' }
        if (box.checked) box.click()
        return { ok: true }
      })()`,
    )
    truthy(untick.ok === true, `the checklist has a box to untick (${JSON.stringify(untick)})`)
    await waitFor(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        const button = details.querySelector('button[data-uip-action="confirm-checks"]')
        return button !== null && button.disabled
      })()`,
      'the button to refuse an incomplete reading',
    )

    /*
     * Found by its `data-uip-action` hook, never by its label. The label is localized — this
     * interface is Chinese — so looking for the English words found nothing, and the `null` that came
     * back read as the checklist refusing to render rather than as a test that spoke one language.
     */
    const beforeTicking = await evaluate(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        const button = details.querySelector('button[data-uip-action="confirm-checks"]')
        return { disabled: button === null ? null : button.disabled, label: button === null ? null : button.textContent }
      })()`,
    )
    equal(beforeTicking.disabled, true, `the button refuses while an item is unticked (${beforeTicking.label})`)

    // Tick them all, the way a click does, then wait for React to re-render the button.
    await evaluate(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        for (const box of details.querySelectorAll('input[type=checkbox]')) if (!box.checked) box.click()
        return true
      })()`,
    )
    await waitFor(
      session,
      `(() => {
        const button = document.querySelector('details.uip-tests[data-project="liquid-glass"] button[data-uip-action="confirm-checks"]')
        return button !== null && !button.disabled
      })()`,
      'the button to become available',
    )

    await evaluate(
      session,
      `document.querySelector('details.uip-tests[data-project="liquid-glass"] button[data-uip-action="confirm-checks"]').click()`,
    )
    /*
     * Both modes assert the confirmation APPEARS: the plugin updates its in-memory settings before
     * it persists, and the store is notified, so the card redraws whether or not the write lands.
     * That is the half `--no-write` can still hold to account.
     *
     * Read from `data-uip-checks`, not from the sentence: the sentence is translated, the state is
     * not, and an assertion that can only pass in English is an assertion about the test's language.
     */
    await waitFor(
      session,
      `document.querySelector('[data-uip-checks][data-uip-checks-version]') !== null`,
      'the recorded confirmation',
    )
    /*
     * `current`, not merely present — and this is the assertion that would have caught the empty-items
     * bug from the browser side.
     *
     * The check above only asks whether a record exists, and a confirmation written with `items: {}`
     * satisfies it: the version is there, the element is there. What it does NOT satisfy is being a
     * confirmation of anything, so the state it reports is `incomplete` — here, before the reload, in
     * BOTH modes, because the plugin updates its in-memory record before it persists and `--no-write`
     * only refuses the write. Reading it here is what makes the three ticked boxes above mean
     * something: with the ids lost on their way to the store, this reads `incomplete` while the
     * presence check stays green.
     */
    equal(
      await evaluate(
        session,
        `document.querySelector('[data-uip-checks]')?.getAttribute('data-uip-checks') ?? null`,
      ),
      'current',
      'the confirmation covers every declared item, rather than being a record with an empty set of ticks',
    )

    await navigate(pageUrl)
    await ensurePanel(session)
    const afterReload = await evaluate(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        if (details === null) return null
        const record = details.querySelector('[data-uip-checks]')
        return record === null ? false : record.getAttribute('data-uip-checks')
      })()`,
    )

    if (noWrite) {
      // The refusal is the point of the flag, so it must be observed rather than assumed: a pattern
      // that matched nothing would leave this test passing while quietly writing to the document.
      truthy(refusedWrites > 0, `the settings write was refused in flight (${refusedWrites} request(s))`)
      /*
       * And the state after a reload is the state the run INHERITED, not "nothing".
       *
       * The old form asserted `false` here, which is only the right answer on a machine that had no
       * record to begin with: an instance with a confirmation already stored came back from the
       * reload showing it, and the assertion called that evidence that this run had written one. The
       * flag's promise is "this run records nothing", and the honest test of that is that the
       * document says exactly what it said at the start.
       */
      equal(afterReload === false ? null : afterReload, checksAtStart, 'and the document says what it said before the run')
    } else {
      // `current`, not merely present: a confirmation carried over from another version is reported
      // as stale, and that is a different outcome from the one this test is about.
      equal(afterReload, 'current', 'the confirmation survives a reload, recorded against this version')
    }
  })

  /*
   * WITHDRAWING IT AGAIN, through the card's own reset button, in a running browser.
   *
   * The order is deliberate: this re-records a confirmation first, so the check is about the removal
   * rather than inheriting a state from the test above — and in `--no-write` mode that matters twice
   * over, because the refused write leaves the confirmation in memory only, so there is still
   * something on the card to withdraw.
   *
   * What it asserts is the pair a reset has to satisfy: the record goes, and the reading goes with it.
   * A card that kept its boxes ticked would leave a full checklist standing beside no confirmation,
   * one click away from recording the same claim again.
   */
  await test('the card reset withdraws the confirmation and the ticks with it', async () => {
    const openAndTick = `(() => {
      const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
      if (details === null) return { error: 'no disclosure' }
      details.open = true
      const boxes = Array.from(details.querySelectorAll('input[type=checkbox]'))
      for (const box of boxes) if (!box.checked) box.click()
      return { boxes: boxes.length }
    })()`
    const recordState = `(() => {
      const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
      if (details === null) return { error: 'no disclosure' }
      const record = details.querySelector('[data-uip-checks]')
      const boxes = Array.from(details.querySelectorAll('input[type=checkbox]'))
      return {
        record: record === null ? null : record.getAttribute('data-uip-checks'),
        withdrawOffered: details.querySelector('button[data-uip-action="clear-checks"]') !== null,
        ticked: boxes.filter((box) => box.checked).length,
        boxes: boxes.length,
      }
    })()`

    await ensurePanel(session)
    // State stated rather than inherited: this check needs the skin running, and it ends by switching
    // it off, so it must not depend on which phase left it in which state.
    await setSkin(session, true)
    const ticked = await evaluate(session, openAndTick)
    truthy(ticked.boxes >= 1, `the checklist has items (${JSON.stringify(ticked)})`)
    await waitFor(
      session,
      `(() => {
        const button = document.querySelector('details.uip-tests[data-project="liquid-glass"] button[data-uip-action="confirm-checks"]')
        return button !== null && !button.disabled
      })()`,
      'the confirm button to become available',
    )
    await evaluate(
      session,
      `document.querySelector('details.uip-tests[data-project="liquid-glass"] button[data-uip-action="confirm-checks"]').click()`,
    )
    await waitFor(
      session,
      `document.querySelector('details.uip-tests[data-project="liquid-glass"] [data-uip-checks]') !== null`,
      'a confirmation to exist',
    )
    const recorded = await evaluate(session, recordState)
    equal(recorded.withdrawOffered, true, 'the card offers to withdraw it')
    equal(recorded.ticked, recorded.boxes, 'every item is ticked')

    /*
     * Wait for the reset control to ACCEPT input before clicking it.
     *
     * The panel disables its buttons while an action is pending, and this test's confirm click is
     * still in flight when the record is already on the card — which is the case on an instance that
     * had a confirmation before the run started, where the `waitFor` above is satisfied instantly.
     * A click on a disabled button is dropped without a trace, and the failure it produces is a
     * timeout three steps later. Same lesson as the switch: wait, then click.
     */
    /*
     * (B1, 2026-09-30: the card-reset steps stood here — a `waitFor` that the button accepted input (the
     * panel disables its buttons while an action is pending, and a click on a disabled button is dropped
     * without a trace), then an `evaluate` that clicked
     * `li.uip-card[data-project="liquid-glass"] button[data-uip-action="reset-one"]`, then the assertions
     * that followed it. The reset control is one of the three blocks being removed from the card, so the
     * wait, the click and the withdrawal assertions that depended on them go together.)
     */

    await waitFor(
      session,
      `document.querySelector('details.uip-tests[data-project="liquid-glass"] [data-uip-checks]') === null`,
      'the confirmation to be withdrawn',
    )
    const cleared = await evaluate(session, recordState)
    equal(cleared.record, null, 'the card no longer claims a verification')
    equal(cleared.withdrawOffered, false, 'and offers no withdrawal for a record that is gone')
    equal(cleared.ticked, 0, 'the ticks went with the record, so nothing is left half-claimed')

    /*
     * THE "UI PLUGINS" COLUMN IS GONE, AND WHAT REMAINS SHOWS ONLY UI PROJECTS (2026-09-30).
     *
     * The cards come from `store.js:236` — `projects: registry.list().map(…)`, the UI-project registry —
     * so the framework row and non-UI plugins, which live in the INSTALLED-PACKAGE scan and are never
     * registered here, cannot appear in this column. Asserted rather than assumed: it is the one effect of
     * the removal a reader would notice, and swapping the data source is the kind of refactor that would
     * change it silently.
     *
     * NO HARD-CODED COUNT, deliberately: the number of cards is whatever this fixture registered, and a
     * literal here would have to be maintained twice. The self-consistent form below says the same thing —
     * one card per distinct registered id, none of them the framework — and cannot rot.
     */
    const cards = await evaluate(
      session,
      `(() => {
        const list = Array.from(document.querySelectorAll('li.uip-card'))
        const ids = list.map((card) => card.getAttribute('data-project'))
        return {
          count: list.length,
          distinct: new Set(ids).size,
          ids,
          menu: {
            uninstall: document.querySelector('li.uip-card [data-uip-action="uninstall"]') !== null,
            changelog: document.querySelector('li.uip-card [data-uip-action="view-changelog"]') !== null,
            diagnostics: document.querySelector('li.uip-card [data-uip-action="copy-diagnostics"]') !== null,
          },
        }
      })()`,
    )
    truthy(cards.count > 0, 'the remaining column renders at least one card')
    equal(cards.count, cards.distinct, 'one card per registered UI project, and nothing else')
    equal(cards.ids.includes('dsh-ui-projects'), false, 'the framework is NOT one of the cards: it is never registered as a UI project')
    equal(cards.menu.uninstall, true, 'and the card menu offers to copy the uninstall command')
    equal(cards.menu.changelog, true, 'to open the CHANGELOG it already has')
    equal(cards.menu.diagnostics, true, 'and to copy the diagnostics this build can actually see')
    /*
     * The reset is "back to the shipped default", and this skin's default is OFF — so the assertion
     * is that it went off, not that it stayed on. The state is then put back, because every phase
     * below measures the skin and this one has just switched it off.
     */
    equal(await skinIsOn(session), false, 'and the reset returned the skin to its shipped default, which is off')
    await setSkin(session, true)

    if (noWrite) {
      /*
       * In refusal mode the write never lands, so the document still says what it said at the start —
       * which is the whole promise of the flag, and the opposite of what a write-mode run shows.
       *
       * The expected value is the state the run INHERITED, not "gone": on an instance that had a
       * record, the record must still be there after the reload, and on one that had none, it must
       * still be absent. Asserting "gone" here would be asserting something refusal mode makes
       * impossible — and it is what the old form did, which is why it could only pass on a machine
       * with nothing to lose.
       */
      truthy(refusedWrites > 0, `the settings write was refused (${refusedWrites} request(s))`)
      await navigate(pageUrl)
      await ensurePanel(session)
      const afterWithdrawal = await evaluate(
        session,
        `(() => {
          const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
          const record = details === null ? null : details.querySelector('[data-uip-checks]')
          return record === null ? false : record.getAttribute('data-uip-checks')
        })()`,
      )
      equal(
        afterWithdrawal === false ? null : afterWithdrawal,
        checksAtStart,
        'the record after a reload is exactly the one the run found',
      )
    }
  })

  /*
   * A request for more contrast, answered where it can actually be measured: in pixels.
   *
   * `Emulation.setEmulatedMedia` is how a real `prefers-contrast: more` is presented to the page
   * without changing the machine's settings. The measurement is the same coarse instrument the
   * rest of this suite uses — the darkest-to-lightest spread inside a text box — which is exactly
   * the right tool here: a contrast request should WIDEN that spread, and a branch that only
   * rewrote token values without changing what is painted would leave it flat.
   *
   * The emulation is restored in a `finally`, and that is not tidiness: under this query the skin
   * drops its frost entirely, so leaving it on would make the tier check below measure a blur that
   * is deliberately not there.
   */
  await test('prefers-contrast: more raises the contrast, in tokens and in painted pixels', async () => {
    const readState = `(() => {
      const body = getComputedStyle(document.body)
      return {
        layer1: body.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
        border1: body.getPropertyValue('--dsw-alias-border-l1').trim(),
        gradient: String(body.backgroundImage),
        layers: (document.body.getAttribute('data-ui-perf') || '') + '|' + (document.body.getAttribute('data-ui-project-liquid-glass') || ''),
        dark: document.body.hasAttribute('data-ds-dark-theme'),
      }
    })()`
    /** @returns {Promise<number>} the narrowest spread across the sampled text boxes */
    const worstSpread = async () => {
      const targets = await evaluate(session, TEXT_TARGETS)
      truthy(Array.isArray(targets) && targets.length >= 1, `text targets located (${JSON.stringify(targets)})`)
      const measured = []
      for (const target of targets) measured.push(await measuredContrast(session, target))
      return measured.reduce((a, b) => (a <= b ? a : b))
    }

    /*
     * Both themes are measured, and that is what this check exists for now.
     *
     * The gradient is painted by a plain `body` rule in light mode and by `body[data-ds-dark-theme]`
     * in dark mode. A media query adds no specificity, so a suppression written as `body { … }` beat
     * the light rule on source order and lost to the dark one — which means a light-mode-only check
     * passed while a dark-mode reader kept the moving wash of colour they had asked to be rid of.
     * Covering one theme per run is how that survives; covering both is how it cannot.
     */
    const setTheme = (/** @type {boolean} */ dark) =>
      evaluate(
        session,
        dark
          ? "(() => { document.body.setAttribute('data-ds-dark-theme', ''); return document.body.hasAttribute('data-ds-dark-theme') })()"
          : "(() => { document.body.removeAttribute('data-ds-dark-theme'); return document.body.hasAttribute('data-ds-dark-theme') })()",
      )
    const originalDark = (await evaluate(session, "document.body.hasAttribute('data-ds-dark-theme')")) === true

    /** @param {boolean} dark @returns {Promise<{before: any, after: any, beforeSpread: number, afterSpread: number}>} */
    const measure = async (dark) => {
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'no-preference' }] })
      await navigate(pageUrl)
      await setTheme(dark)
      const before = await evaluate(session, readState)
      const beforeSpread = await worstSpread()
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] })
      await navigate(pageUrl)
      await setTheme(dark)
      const after = await evaluate(session, readState)
      const afterSpread = await worstSpread()
      return { before, after, beforeSpread, afterSpread }
    }

    try {
      for (const dark of [false, true]) {
        const theme = dark ? 'dark' : 'light'
        const { before, after, beforeSpread, afterSpread } = await measure(dark)

        // The instrument first: if the theme did not hold, every number below is about the other one.
        equal(before.dark, dark, `the ${theme} theme is in force before the query`)
        equal(after.dark, dark, `and still in force under it`)

        // Deterministic half: the branch reached the page, and it changed what will be painted.
        // The fills go transparent -> opaque, and the decorative wash goes with them.
        /*
         * The branch is written per theme, so the expected fill has to be read from the theme the
         * page is actually in rather than assumed. Assuming light made this assertion fail against a
         * correct dark fill — the check was describing the harness, not the skin.
         */
        const opaqueFill = dark ? '#1e212a' : '#fff'
        equal(after.layer1, opaqueFill, `the page fill is opaque under more contrast (${theme})`)
        truthy(
          before.layer1 !== after.layer1,
          `and it was not already (${theme}: before ${before.layer1}, after ${after.layer1})`,
        )
        // Non-vacuous: there has to have been a wash for its removal to mean anything.
        truthy(before.gradient !== 'none', `a decorative gradient is painted before the query (${theme})`)
        equal(after.gradient, 'none', `and the decorative gradient is gone under it (${theme})`)
        truthy(
          after.border1 !== before.border1,
          `the hairline got heavier (${theme}: before ${before.border1}, after ${after.border1})`,
        )
        // The skin is still applied: this branch changes the material, not whether it exists.
        contains(after.layers, 'on')

        // Measured half, with the whole suite's caveat attached: this instrument reports the spread
        // inside a text box, which cannot prove a ratio but does catch a surface that never
        // repainted. A branch that rewrote tokens without changing paint would leave it flat.
        /*
         * The tolerance is the instrument's own resolution, not a cushion for a failing check.
         *
         * The spread is the distance between the SINGLE darkest and SINGLE lightest pixel in the box,
         * decoded from an 8-bit PNG, and the extremes are glyph edges — antialiased pixels whose value
         * shifts by a step or two between screenshots. Two steps at each end of the scale is about
         * 0.006 in luminance, so anything smaller than 0.01 is the measurement talking. A legibility
         * regression is not that: a text/background pair losing its separation moves this number by
         * five or ten times the tolerance.
         *
         * What this half canNOT catch is a branch that changed nothing at all — before and after would
         * be equal and equal passes. That case is the deterministic half above, which requires the
         * fills, the hairline and the gradient to have changed.
         */
        const SPREAD_TOLERANCE = 0.01
        truthy(
          afterSpread >= beforeSpread - SPREAD_TOLERANCE,
          `the painted text spread did not narrow (${theme}: before ${beforeSpread}, after ${afterSpread}, tolerance ${SPREAD_TOLERANCE})`,
        )
      }
    } finally {
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'no-preference' }] })
      // The theme is put back, including the case where this test is what changed it.
      await setTheme(originalDark)
    }
  })

  /*
   * The two modes that ask for less transparency, measured instead of reasoned about.
   *
   * `prefers-reduced-transparency` is a real Chrome feature since Chrome 118 — not a Safari-only
   * nicety — so the branch the skin has always carried can finally be exercised rather than trusted.
   * The stylesheet guard in `verify.mjs` proves the tokens are declared; this proves they arrive.
   *
   * `forced-colors` is different in kind, and the distinction decides what can be asserted: the
   * platform replaces author BACKGROUND COLOURS with system ones, so every translucent fill is
   * opaque by the time it paints and the skin needs no token work for it. It does not force CUSTOM
   * PROPERTY values, so reading `--dsw-alias-bg-layer-3` off the body under this query would report
   * the skin's own declaration and prove nothing. What can be measured is the outcome on elements:
   * the fills are opaque, and they are not the values they had a moment earlier.
   */
  await test('the modes that ask for less transparency get it', async () => {
    const readState = `(() => {
      const body = getComputedStyle(document.body)
      /*
       * The settings PANEL, found through the section this suite already knows how to open, rather
       * than the first [role="dialog"] in the document. The first form measured whichever dialog
       * happened to come first — rgba(0, 0, 0, 0.52) came back, which is neither the skin's fill nor
       * a system colour, and read like a scrim rather than a panel. Naming the element by the panel
       * it contains is the difference between measuring a surface and measuring whatever is first in
       * the tree.
       */
      const section = document.querySelector('.uip-root')
      const panel = section === null ? null : section.closest('[role="dialog"]')
      const card = document.querySelector('[data-composer-card]')
      const frost = card === null ? null : getComputedStyle(card, '::before')
      return {
        tokens: {
          layer3: body.getPropertyValue('--dsw-alias-bg-layer-3').trim(),
          overlay: body.getPropertyValue('--dsw-alias-bg-overlay').trim(),
          module: body.getPropertyValue('--dsw-alias-bg-module-platform').trim(),
          tooltip: body.getPropertyValue('--dsw-alias-tooltip-bg').trim(),
          glass: body.getPropertyValue('--lg-glass-bg').trim(),
        },
        panelFound: panel !== null,
        panel: panel === null ? null : getComputedStyle(panel).backgroundColor,
        panelAdjust: panel === null ? null : getComputedStyle(panel).forcedColorAdjust,
        card: card === null ? null : getComputedStyle(card).backgroundColor,
        cardAdjust: card === null ? null : getComputedStyle(card).forcedColorAdjust,
        frost: frost === null ? null : String(frost.backdropFilter || ''),
        reducedTransparencyMatches: matchMedia('(prefers-reduced-transparency: reduce)').matches,
        forcedColorsMatches: matchMedia('(forced-colors: active)').matches,
      }
    })()`
    /** The alpha a computed colour carries, or undefined when it has none — i.e. it is opaque. */
    const alphaOf = (value) => /rgba\([^)]*,\s*([\d.]+)\)\s*$/.exec(String(value))?.[1]

    await setSkin(session, true)
    await navigate(pageUrl)
    await waitFor(session, "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'", 'the marker')
    await ensurePanel(session)
    const before = await evaluate(session, readState)
    truthy(
      before.panelFound && before.card !== null,
      `the surfaces to measure exist (${JSON.stringify(before)})`,
    )
    truthy(
      Number(alphaOf(before.panel)) < 1,
      `the premise: the panel fill is translucent before any query (${before.panel})`,
    )

    try {
      // ── prefers-reduced-transparency ────────────────────────────────────────
      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
      })
      const reduced = await evaluate(session, readState)
      /*
       * The capability probe, printed rather than swallowed. If a browser or a CDP version does not
       * know this feature the query never matches, and silently asserting nothing would turn "not
       * tested" into "passed". The stylesheet guard still covers the branch in that case, and this
       * says so out loud.
       */
      const supported = reduced.reducedTransparencyMatches === true
      if (!supported) {
        process.stdout.write(
          '         note  this browser does not apply prefers-reduced-transparency; the branch is ' +
            'covered by the stylesheet guard in verify.mjs, not by a measurement here\n',
        )
      } else {
        const stillTranslucent = Object.entries(reduced.tokens)
          .filter(([, value]) => Number(alphaOf(value)) < 1 || /rgba\(/.test(String(value)))
          .map(([name, value]) => `${name}=${value}`)
        equal(
          stillTranslucent,
          [],
          `every surface token resolves opaque under prefers-reduced-transparency (${stillTranslucent.join(', ') || 'all opaque'})`,
        )
        equal(alphaOf(reduced.card), undefined, `the composer's fill is opaque (${reduced.card})`)
        equal(alphaOf(reduced.panel), undefined, `and so is the panel's (${reduced.panel})`)
        equal(reduced.frost, 'none', `the composer's frost is dropped (${reduced.frost})`)
      }
    } finally {
      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }],
      })
    }

    try {
      // ── forced-colors ───────────────────────────────────────────────────────
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
      const forced = await evaluate(session, readState)
      /*
       * The outcome, not the cause: the skin's branch asks for the blur to go and the platform may
       * also be forcing it, and this cannot tell the two apart. It can tell that the fills are no
       * longer translucent and no longer what they were, which is the claim worth having.
       *
       * The raw readings are in every message, because the first attempt at this measured the wrong
       * element and the failure said only "expected undefined, got 0.52" — a number that names no
       * element. A diagnostic that cannot say WHAT it measured costs a run to interpret.
       */
      const raw = JSON.stringify({ forced: forced.forcedColorsMatches, panel: forced.panel, card: forced.card })
      /*
       * The CALIBRATION, added because the first two attempts at this measured expensive nonsense:
       * both elements reported the same `rgba(0, 0, 0, 0.52)`, which is neither of their own fills,
       * and a single number that describes no element cannot tell a forced palette from a wrong
       * selector. A throwaway element with a colour nothing else uses answers the question the whole
       * assertion rests on: does this mode replace AUTHOR background colours at all?
       */
      const calibration = await evaluate(
        session,
        `(() => {
          const probe = document.createElement('div')
          probe.style.backgroundColor = 'rgb(1, 2, 3)'
          probe.style.color = 'rgb(4, 5, 6)'
          const translucent = document.createElement('div')
          translucent.style.backgroundColor = 'rgba(1, 2, 3, 0.52)'
          document.body.append(probe, translucent)
          const style = getComputedStyle(probe)
          const half = getComputedStyle(translucent)
          const result = {
            background: style.backgroundColor,
            color: style.color,
            adjust: style.forcedColorAdjust,
            translucentBackground: half.backgroundColor,
          }
          probe.remove()
          translucent.remove()
          return result
        })()`,
      )
      const full = JSON.stringify({
        forced: forced.forcedColorsMatches,
        panel: forced.panel,
        panelAdjust: forced.panelAdjust,
        card: forced.card,
        cardAdjust: forced.cardAdjust,
        probe: calibration,
      })
      /*
       * What the calibration establishes, and why it changed the design of this branch.
       *
       * The platform DOES replace author colours here — `rgb(1, 2, 3)` came back as `rgb(0, 0, 0)`
       * and the text colour as white — which was the assumption this branch was built on. But it
       * keeps the author's ALPHA: the same probe at `rgba(1, 2, 3, 0.52)` comes back as
       * `rgba(0, 0, 0, 0.52)`. So a translucent fill stays translucent in this mode, and the skin
       * cannot leave the fills to the platform after all. That was measured twice — the panel and the
       * card both reported `rgba(0, 0, 0, 0.52)`, the card's own alpha, and the first version of this
       * assertion had called the platform's takeover sufficient and skipped the tokens.
       */
      truthy(
        calibration.background !== 'rgb(1, 2, 3)',
        `calibration: the platform replaces author colours (${full})`,
      )
      contains(
        String(calibration.translucentBackground),
        '0.52',
        `calibration: and keeps the author's alpha, which is why the tokens are needed here too (${full})`,
      )
      truthy(forced.forcedColorsMatches, `the query is in force in this browser (${full})`)
      equal(alphaOf(forced.panel), undefined, `forced colors leaves the panel fill opaque (${full})`)
      equal(alphaOf(forced.card), undefined, `and the composer's (${full})`)
      equal(forced.frost, 'none', `the composer's frost is gone (${forced.frost}; ${full})`)
      truthy(
        forced.panel !== before.panel && forced.card !== before.card,
        `and both fills were replaced rather than merely already opaque (panel ${before.panel} → ${forced.panel}, card ${before.card} → ${forced.card})`,
      )    } finally {
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] })
    }

    // Put the page back the way the tests around this one expect to find it.
    await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'no-preference' }] })
    await navigate(pageUrl)
    await ensurePanel(session)
  })

  /*
   * The effect tier, against a device forced to be weak.
   *
   * `Emulation.setHardwareConcurrencyOverride` applies to the TARGET, so it has to be set BEFORE the
   * page loads: the tier is decided once at `apply` time from the signals available then, not
   * polled. Both directions are checked, because a mechanism that only ever lowered the tier would
   * pass a one-sided test while leaving every capable machine on the cheap treatment.
   *
   * The blur is read from the frame's `::before` — the one frost layer — so this measures what the
   * stylesheet resolved, not what the attribute claims.
   */
  await test('a low-capacity device gets the reduced tier, and a capable one keeps the full tier', async () => {
    const readTier = `(() => {
      const column = document.querySelector('[data-ui-skin-column]')
      const frame = column === null ? null : column.parentElement
      const card = document.querySelector('[data-composer-card]')
      return {
        tier: document.body.getAttribute('data-ui-perf'),
        blur: frame === null ? null : getComputedStyle(frame, '::before').backdropFilter,
        composerBlur: card === null ? null : String(getComputedStyle(card, '::before').backdropFilter || ''),
      }
    })()`
    const original = await evaluate(session, 'navigator.hardwareConcurrency')
    truthy(typeof original === 'number' && original > 0, `the browser reports a core count (${original})`)

    try {
      await session.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 2 })
      await navigate(pageUrl)
      const weak = await evaluate(session, readTier)
      equal(weak.tier, 'low', 'two cores cap the tier at low')
      contains(String(weak.blur), '12px', `and the frost drops to the low radius (${weak.blur})`)
      /*
       * And the composer drops with it. Without this the tier block would leave the one card the
       * reader types into at the desktop radius on a device that can afford least — the same
       * omission as the suppression branches, in the other direction.
       */
      contains(
        String(weak.composerBlur),
        '12px',
        `the composer's frost drops too on a capped device (${weak.composerBlur})`,
      )
    } finally {
      await session.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: original })
    }

    await navigate(pageUrl)
    const capable = await evaluate(session, readTier)
    /*
     * The expected tier is derived from the machine, not written down. A capable device can only be
     * as good as the hardware it claims to be: on a two-core host the skin's own demand is capped
     * at `low`, and asserting `high` there would fail against a correct page — the check would be
     * describing the workstation rather than the skin.
     */
    const capableCap = original >= 4 ? 'high' : original >= 2 ? 'medium' : 'low'
    const RADIUS = { high: '20px', medium: '16px', low: '12px' }
    truthy(
      RADIUS[capable.tier] !== undefined && RADIUS[capable.tier] === RADIUS[capableCap],
      `the tier follows the machine — ${original} cores cap it at ${capableCap}, got ${capable.tier}`,
    )
    // The stronger half: whatever tier was chosen, the frost matches THAT tier's radius, so the
    // attribute and the stylesheet cannot drift apart.
    contains(String(capable.blur), RADIUS[capable.tier], `and the frost is at ${capable.tier} radius (${capable.blur})`)
    contains(
      String(capable.composerBlur),
      RADIUS[capable.tier],
      `and so is the composer's (${capable.composerBlur})`,
    )
  })

  /*
   * Step 5, verified the hard way — and deliberately LAST, because it blocks the bundle.
   *
   * Everything above drives the RUNNING application, and a skin that is correct once the bundle
   * has loaded says nothing about the first frame, which happens before that bundle is even
   * fetched. With `dsh-ui-projects/client.js` blocked the application never mounts, so whatever
   * the document shows came from the served HTML alone: the host's inlined stylesheet and its
   * marker script. If the first frame is skinned here, it is skinned on every real load too —
   * including the ones where the bundle is still in flight.
   *
   * The boundary this asserts around: the FROST is not expected, because it hangs off
   * `data-ui-skin-column`, stamped by the client runtime. The colours, the transparent frame and
   * the ambient gradient are.
   */
  /*
   * WHERE THIS GROUP MUST RUN: after every test that uses the settings panel, and BEFORE these two —
   *
   *   `the first frame is already the skin, with the client bundle blocked` deliberately blocks the
   *   client bundle, and the page it leaves behind has no application and therefore no buttons;
   *
   *   `the console collector observes page console errors at all` says in its own comment that it must
   *   be last, because a later assertion would read a collector that is no longer clean.
   *
   * This group was inserted after both and failed with `"buttons":[]` — nothing wrong with what it
   * asserted, only with when. Move it again only to a place that respects the same two boundaries.
   */
  // ── Settings › UI plugins ───────────────────────────────────────────────────

  /**
   * The page-error count when this group started. Module scope on purpose: the assertion that reads it
   * lives in the group's LAST test, and the `const` this used to be was scoped to the first one — so the
   * check threw `errorsAtGroupStart is not defined` instead of comparing two numbers.
   */
  let errorsAtGroupStart = 0


  await test('the page can fetch the endpoint the host mounted', async () => {
    const probe = await evaluate(
      session,
      `fetch('/api/ui-projects/installed.json', { credentials: 'same-origin' })
        .then(async (response) => ({ status: response.status, body: await response.json() }))
        .catch((error) => ({ status: 0, error: String(error) }))`,
    )
    equal(probe?.status, 200, `the endpoint answers this page (${JSON.stringify(probe?.error ?? '')})`)
    equal(probe?.body?.schemaVersion, 1, 'with the payload version this client understands')
    equal(typeof probe?.body?.scan?.profileName, 'string', 'and the profile it describes, by name')
  })


  /*
   * THE BLOCK A PERSON COPIES CARRIES THAT ROW'S OWN NAME (8d review).
   *
   * The bug the user found by READING THE PAGE, which is why it is asserted here and not only in the
   * suite: every row printed its own name in the command on its own line and `dsh-ui-projects` in the
   * block four lines below it, because the block came from a dictionary literal while the command was
   * built from the row. Two sources, one command, and the disagreement only appears once a profile has
   * more than one removable package — a framework-only profile renders no removal command at all.
   *
   * It is its own test rather than one more assertion above, for the reason this file states twice: an
   * assertion inside an existing test prints nothing of its own, and a reader deserves "the copied block
   * does not match its row" instead of having to guess which of a dozen claims failed.
   *
   * The unit suite's half of this pair renders the real dictionaries and compares the two blocks against
   * each other; this one reads the live DOM, where the profile's real package names come from the host
   * rather than from a fixture.
   */
  await test('the block each row offers to copy repeats that row’s own removal command', async () => {
    const rows = await evaluate(
      session,
      `Array.from(document.querySelectorAll('[data-uip-command]')).map((block) => ({
        name: block.getAttribute('data-uip-command'),
        printed: Array.from(block.querySelectorAll('pre')).map((pre) => pre.textContent.trim()),
      }))`,
    )
    truthy(
      Array.isArray(rows) && rows.length >= 1,
      `at least one row offers a removal command (${JSON.stringify(rows ?? null)})`,
    )
    /*
     * Compared WITHIN each row and without assuming a profile name: the block's text must contain the
     * exact standalone command printed beside it. That is the "one source" property itself, and it is
     * what a hard-coded literal breaks.
     */
    const mismatched = (rows ?? []).filter((row) => {
      const standalone = row.printed.find((text) => text.startsWith('dsh plugin --profile ') && text.includes(' remove '))
      const block = row.printed.find((text) => text.startsWith('# 1.'))
      return standalone === undefined || block === undefined || block.includes(standalone) === false
    })
    equal(
      mismatched.length,
      0,
      `every row's copied block repeats that row's own command (${JSON.stringify(mismatched)} of ${JSON.stringify(rows ?? null)})`,
    )
    equal(
      (rows ?? []).filter((row) => row.printed.some((text) => text.startsWith('# 1.') && text.includes(' remove dsh-ui-projects'))).length,
      0,
      'and no block names the framework, whose row carries no removal command at all',
    )
  })

  /*
   * THE CARD'S MAINTENANCE DISCLOSURE (7d-2b), as its OWN test rather than one more assertion inside the
   * row test above.
   *
   * Split out on purpose: when this fails, the reader should see "the card's block did not render" instead
   * of having to work out which of a dozen assertions in a bigger test produced it — and an assertion
   * inside an existing test prints nothing of its own, so only the count would ever show it had run.
   */
  /*
   * (B2, 2026-09-30: an entire test stood here — "a project card offers the maintenance commands, folded
   * and hooked". It read `[data-uip-maintenance-panel]` off the live page, asserted at least one card
   * carried the block, that every such card printed all three commands (`install.ps1 -Snapshot`, `-Update`,
   * `-Rollback`), that they started folded, and — behind a `try`/`finally` — that at least one card stated
   * its version situation.
   *
   * THREE THINGS WORTH KEEPING IN WRITING, each one paid for:
   *
   *   · WHY IT WAS ITS OWN TEST. "When this fails, the reader should see 'the card's block did not render'
   *     instead of having to work out which of a dozen assertions in a bigger test produced it — and an
   *     assertion inside an existing test prints nothing of its own, so only the count would ever show it
   *     had run."
   *   · "A FIX THAT MOVED THE FAILURE RATHER THAN REMOVING IT." The isolation repair dropped the "go to
   *     this page" line but kept the "come back" at the end; the test then looked for
   *     `[data-uip-maintenance-panel]` while the panel was still on the plugins page, found none, and
   *     failed with `[]`. What the earlier test left dirty was never "having switched" but "not switching
   *     back".
   *   · THE CONTRACT IS VOID WITH THE COLUMN. "Go where you need to go, hand the panel back on the PLUGINS
   *     page" — this test's `finally` clicked the `UI 插件 | UI plugins` tab to do exactly that, and that
   *     tab is what this removal deletes. Two preconditions elsewhere need revisiting with it: `ensurePanel`
   *     (whose "return to the plugins page" half has no page left to return to) and the test that follows
   *     below, whose version-state assertions were about the same card block.)
   */

  /*
   * THE READER'S ROUTE (7d-2c), which this suite had never walked.
   *
   * The card test above reaches its assertions along the suite's own path: the plugins column is opened
   * FIRST, and that is what asks the host — the projects page is visited afterwards, so the listing is
   * already in hand before the first card renders. A person does not do that. They open Settings › UI to
   * look at the skin, and on that path nothing had ever requested the listing: the store stayed `idle`
   * for the life of the page, every card stayed silent, and the four version states existed unreachable.
   * The suite was green and the feature was missing, because both the suite and the code only ever went
   * the other way round.
   *
   * So this test starts from a RELOADED page and takes the reader's route: settings, UI section, nothing
   * else. The reload is what makes "the plugins page was never opened" true of this page instance rather
   * than a claim about the run's history.
   *
   * (B3, 2026-09-30: this paragraph used to explain WHICH of the four version states appears —
   * `host-stale` (a host whose code predates the `versions` field: a restart that has not happened yet),
   * `none`, `same` and `different` — and said the test existed to catch the fifth: no attribute at all.
   * The state assertions were about the card's maintenance block and went with it; the paragraph goes with
   * them. THE FIFTH STATE IS STILL THIS TEST'S SUBJECT, and it is why the name keeps the word "once": what
   * it catches is a page that never asked, which now reads as `calls !== 1` rather than as a missing
   * attribute.)
   */
  await test('opening the projects page alone asks the host once', async () => {
    await navigate(pageUrl)
    try {
      /*
       * The count is MEASURED, not assumed, and that is what makes the word "once" in this test's name a
       * claim rather than a hope. Installed after the reload and before the section is opened, so it sees
       * every request this page makes for that one path.
       */
      await evaluate(
        session,
        `(() => {
          const real = window.fetch
          window.__uipRealFetch = real
          window.__uipInstalledCalls = 0
          window.fetch = (input, init) => {
            const url = typeof input === 'string' ? input : (input && input.url) || ''
            if (url.includes('/api/ui-projects/installed.json')) window.__uipInstalledCalls += 1
            return real(input, init)
          }
          return { ok: true }
        })()`,
      )
      await ensurePanel(session)
      await sleep(500)
      const scene = await evaluate(
        session,
        `(async () => {${HELPERS}
          /*
           * (B3, 2026-09-30: this expression used to collect the cards and their version states —
           * 'cards()' read 'details[data-uip-maintenance-panel]', it polled up to 8s for a
           * '[data-uip-version-state]' to appear, expanded every card and returned '{ cards, states,
           * visible, calls }'. All of that was about the card's maintenance block and went with it. What is
           * left is the ONE thing this test is named for: how many times this page asked the host for the
           * listing, counted by the patched 'fetch' installed above.)
           */
          return { calls: window.__uipInstalledCalls }
        })()`,
      )
      /*
       * (B3, 2026-09-30: three assertions stood here — the page rendered cards, at least one card stated
       * its version situation, and that sentence was visible once the card was expanded. All three read
       * the card's maintenance block, which this removal deletes; the first is covered by the card-shape
       * assertions added at the top of this round, and the other two have no subject left. What follows is
       * this test's own claim, and the reason its name still ends in "once".)
       */
      equal(scene?.calls, 1, `this page asked the host for the listing exactly once (${JSON.stringify(scene ?? null)})`)
      equal(scene?.calls, 1, `this page asked the host for the listing exactly once (${JSON.stringify(scene ?? null)})`)
    } finally {
      await evaluate(
        session,
        `(() => {
          if (window.__uipRealFetch) window.fetch = window.__uipRealFetch
          delete window.__uipRealFetch
          delete window.__uipInstalledCalls
          return { ok: true }
        })()`,
      )
      /*
       * (B3, 2026-09-30: the "hand the panel back" step stood here — it clicked the `UI 插件 | UI plugins`
       * tab in this `finally`, under the contract the card test also kept: leave the panel where the NEXT
       * test looks for its controls. That tab is the column this removal deletes, so there is no page to
       * hand back to and the click would find nothing (it returns `{ ok: false }` rather than throwing,
       * which is why this is a contract to rewrite rather than a failure to read).
       *
       * TO-DO, recorded here because this is where the contract is kept: `ensurePanel`'s "return to the
       * plugins page" half is void for the same reason and needs revisiting once the tests that depend on
       * that page are gone.)
       */
    }
  })


  /* ── the two example packages, in a real page (9b) ───────────────────────────
   *
   * WHAT THIS GROUP CAN SEE THAT NO OFFLINE SUITE CAN. Everything above is about the skin, and every
   * one of those assertions is compatible with a framework that can only ever apply ONE project. Step
   * 9b shipped two example packages — a UI project package and a plain client plugin that mounts two
   * floating surfaces differing in one attribute — and these tests walk the pair through a real page:
   * the skin reaches the surface that carries a WAI-ARIA role and cannot reach the one that does not;
   * switching the skin off puts the page back exactly; two projects switch independently; and the
   * settings column tells a reader all of it, including about the framework itself.
   *
   * ORDER, and it is a contract rather than a preference: this group runs after the plugins group
   * (which leaves the panel on that page) and before the last two tests — one blocks the client
   * bundle, the other calibrates the console collector. It leaves the skin ON and the panel on the
   * PLUGINS page, because `the first frame is already the skin` requires `marker === 'on'`.
   *
   * A MISSING EXAMPLE PACKAGE IS A FAILURE WITH A NAME, never a skip: these tests are the only place
   * the two-sided example is exercised end to end, so a green run on a machine where it was never
   * installed would be the suite lying by omission.
   */
  const errorsAtExampleGroupStart = pageErrors.length

  await test('a role="dialog" surface from a third-party plugin is reached by the skin', async () => {
    await requireExamplePackages(session)
    await gotoProjectsPage(session)
    /*
     * THE PROPERTY, MEASURED AS A DIFFERENCE — not the mechanism.
     *
     * This assertion used to demand that the skin's box-shadow WIN over the surface's own stylesheet,
     * and it failed against a correct implementation: the skin's dialog rule is written with `:where()`,
     * and `scopeCss` puts the project marker INSIDE that `:where()`, so the scoped selector carries ZERO
     * specificity and deliberately yields to any material a component declares for itself
     * (glass.css: "a component that wants its own material can still have it"). The shadow therefore
     * comes from the surface's own `var(--dsw-alias-shadow-l2, none)`, which resolves to `none` because
     * the shipped palette has no such token — a true measurement that the old assertion called a bug.
     *
     * What the skin is for is FROST, and what a third-party component is entitled to keep is its OWN
     * material. So: same surface, twice, with the skin off and on — the filter must change, the shadow
     * must not.
     */
    await setSkin(session, false)
    const before = await evaluate(session, SURFACE_STYLE('standard'))
    equal(
      before?.role,
      'dialog',
      `the surface carries the WAI-ARIA role the skin selects by (${JSON.stringify(before ?? null)})`,
    )
    await setSkin(session, true)
    const after = await evaluate(session, SURFACE_STYLE('standard'))
    truthy(
      after?.backdropFilter !== before?.backdropFilter,
      `with the skin on, the frost on that surface is not what it was without it (${JSON.stringify({ off: before?.backdropFilter, on: after?.backdropFilter })})`,
    )
    contains(
      after?.backdropFilter ?? '',
      'blur',
      `and what it gained is a blur, without the skin knowing the package (${JSON.stringify(after ?? null)})`,
    )
    equal(
      after?.boxShadow,
      before?.boxShadow,
      `while the surface's own box-shadow is exactly what it was: the skin adds frost and does not take a component's material (${JSON.stringify({ off: before?.boxShadow, on: after?.boxShadow })})`,
    )
  })

  await test('a role="custom-dialog" surface is NOT reached, and the difference is the role', async () => {
    await requireExamplePackages(session)
    await gotoProjectsPage(session)
    await setSkin(session, true)
    const custom = await evaluate(session, SURFACE_STYLE('custom'))
    equal(
      custom?.role,
      'custom-dialog',
      `the second surface carries a role no stylesheet can name (${JSON.stringify(custom ?? null)})`,
    )
    equal(
      custom?.backdropFilter,
      'none',
      `so the skin cannot frost it: this is the contract violation made visible (${JSON.stringify(custom ?? null)})`,
    )
    /*
     * AND THE CONTROL, which is what makes the assertion above mean anything: on the SAME page, at the
     * same moment, with the same skin, the reachable surface beside it IS frosted. Without this, the
     * test would pass on a page where the skin was simply off.
     */
    const standard = await evaluate(session, SURFACE_STYLE('standard'))
    contains(
      standard?.backdropFilter ?? '',
      'blur',
      `while the role="dialog" surface beside it is frosted right now (${JSON.stringify(standard ?? null)})`,
    )
  })

  await test('switching the skin off restores both surfaces, the body marker, and the frosted set', async () => {
    await requireExamplePackages(session)
    await gotoProjectsPage(session)

    /* The baseline: skin off, panel closed, and both surfaces as the example package ships them. */
    await setSkin(session, false)
    await closePanel(session)
    await sleep(400)
    const baseline = await evaluate(session, FILTERED_SET)
    const offSurfaces = await evaluate(
      session,
      `({ standard: ${SURFACE_STYLE('standard')}, custom: ${SURFACE_STYLE('custom')} })`,
    )
    equal(offSurfaces?.standard?.backdropFilter, 'none', "with the skin off, the reachable surface keeps its own look")
    equal(offSurfaces?.custom?.backdropFilter, 'none', 'and so does the unreachable one')

    /* On: the page gains frost that the baseline did not have. */
    await setSkin(session, true)
    await closePanel(session)
    await sleep(400)
    const frosted = await evaluate(session, FILTERED_SET)
    truthy(
      Array.isArray(frosted) && frosted.length > (baseline ?? []).length,
      `the skin frosts elements the baseline did not have (${JSON.stringify({ baseline: baseline?.length, on: frosted?.length })})`,
    )

    /* Off again: the SET is compared, not a count — one element gaining frost while another loses it
     * leaves a count unchanged, which is exactly the kind of restoration this test exists to refuse. */
    await setSkin(session, false)
    await closePanel(session)
    await sleep(400)
    const after = await evaluate(session, FILTERED_SET)
    equal(
      after,
      baseline,
      `the set of elements carrying backdrop-filter is exactly what it was before the skin was switched on (${JSON.stringify({ baseline, after })})`,
    )
    const marker = await evaluate(session, "document.body.getAttribute('data-ui-project-liquid-glass')")
    equal(marker, null, 'the body marker is gone: the stylesheet is scoped to it, so this is what switches the CSS off')
    const afterSurfaces = await evaluate(session, SURFACE_STYLE('standard'))
    equal(
      afterSurfaces?.backdropFilter,
      'none',
      `and the surface the skin had frosted is back to the look it ships with (${JSON.stringify(afterSurfaces ?? null)})`,
    )

    /* The next test in this suite needs the skin on; so does `the first frame is already the skin`. */
    await setSkin(session, true)
  })

  /*
   * THE NON-SKIN CALLER OF `setProject`, and the reason the helper is parameterized at all: with only
   * the skin in the page, "a project package is applied" and "THIS project package is applied" are the
   * same sentence. Step 9b's example package makes them different sentences.
   *
   * THE POLICY THIS ASSERTS, and the assertion it replaces was wrong about it: this test used to demand
   * that switching `example` on leave `liquid-glass` alone. The framework's documented rule is the
   * opposite — `registry.conflictIds` returns the other ACTIVE skins and `runtime.#enable` disables them
   * first ("at most one global look, so the previous one goes first"), so a second skin TAKES OVER and
   * the first steps down, including its body marker and `data-ui-skin`. Two skins at once is exactly
   * what the policy forbids, and a test that asks for it fails against a correct implementation.
   *
   * The state it needs is STATED rather than assumed (`setProject(…, false)` first): a machine where
   * somebody had switched the example on is not a broken machine, and the suite has already paid once
   * for assuming what the settings document happened to say.
   */
  await test('a second project package takes over the skin role, one skin at a time', async () => {
    await requireExamplePackages(session)
    await gotoProjectsPage(session)
    await setProject(session, 'example', false)
    await setSkin(session, true)
    try {
      equal(
        await projectIsOn(session, 'liquid-glass'),
        true,
        'the skin is active before this runs, so there is something for the second skin to take over from',
      )
      await setProject(session, 'example', true)
      equal(await projectIsOn(session, 'example'), true, 'the example project sets its OWN marker')
      equal(
        await projectIsOn(session, 'liquid-glass'),
        false,
        'and the skin steps down: the framework allows one global look at a time',
      )
      const scoped = await evaluate(
        session,
        `({
          ownMarker: Array.from(document.querySelectorAll('style')).some((style) =>
            String(style.textContent).includes('data-ui-project-example')),
          card: document.querySelector('[data-project="example"]') !== null,
          rootSkin: document.documentElement.getAttribute('data-ui-skin'),
        })`,
      )
      equal(
        scoped?.ownMarker,
        true,
        'the framework scoped the example stylesheet to the example marker rather than to the skin’s',
      )
      equal(scoped?.card, true, 'the project has its own card on this page, beside the skin’s')
      equal(
        scoped?.rootSkin,
        'example',
        'and the hand-over is stated on the root, not left to be inferred from the markers',
      )
    } finally {
      /* Whatever happened, the page is handed back the way this test found it: example off, skin on. */
      await setProject(session, 'example', false)
      await setSkin(session, true)
    }
    equal(await projectIsOn(session, 'example'), false, 'switching it off clears its marker again')
    equal(await projectIsOn(session, 'liquid-glass'), true, 'and the skin is active again, as it was')
  })



  await test('the first frame is already the skin, with the client bundle blocked', async () => {
    await session.send('Network.enable')
    await session.send('Network.setBlockedURLs', { urls: ['*dsh-ui-projects/client.js*'] })
    try {
      await session.send('Page.navigate', { url: pageUrl })
      await waitFor(
        session,
        "document.body !== null && document.body.hasAttribute('data-ui-project-liquid-glass')",
        'the host-emitted marker',
        20000,
      )
      const first = await evaluate(
        session,
        `(() => {
          const body = document.body
          const style = getComputedStyle(body)
          return {
            marker: body.getAttribute('data-ui-project-liquid-glass'),
            rootSkin: document.documentElement.getAttribute('data-ui-skin'),
            fill: style.getPropertyValue('--dsw-alias-bg-base').trim(),
            gradient: String(style.backgroundImage).includes('radial-gradient'),
            attachment: String(style.backgroundAttachment),
            clientStyles: document.querySelectorAll('style[id^="dsh-ui-projects"]').length,
            clientColumns: document.querySelectorAll('[data-ui-skin-column]').length,
          }
        })()`,
      )

      /*
       * The bundle never ran, and the proof is that nothing the client owns is in the document.
       *
       * This used to assert the shell's BOOT PAGE was still in place, on the reasoning that its
       * survival IS the bundle's absence. That reasoning is wrong twice over, and both halves were
       * measured rather than assumed: the served HTML is `<div id="root"></div>` with nothing in
       * it, so there is no boot page before scripts run at all; and the element is created by the
       * RENDERER bundle (its own request, untouched by the block), not by this plugin, so its
       * presence tracks the renderer mounting the application and says nothing about whether this
       * bundle arrived. The assertion was therefore false on every run — including the runs where
       * the skin assertions below it never got to execute. A check that cannot pass is worse than
       * a missing one, because it hides the ones behind it.
       *
       * `style[id^="dsh-ui-projects"]` is the honest replacement: those elements are created by
       * this client bundle and by nothing else, so their absence states exactly what this test
       * needs — the document was painted by the served HTML alone.
       */
      equal(first.clientStyles, 0, 'the client bundle never ran, so it injected no stylesheet')
      equal(first.clientColumns, 0, 'and it stamped no skin column')
      equal(first.marker, 'on', 'the host marked the body before the first paint')
      equal(first.rootSkin, 'liquid-glass', 'and the root carries the skin id')
      truthy(
        String(first.fill).includes('/ 0%)'),
        `the frame is already see-through on the first frame (${first.fill})`,
      )
      truthy(first.gradient, 'the ambient gradient is already painted on the body')
      contains(first.attachment, 'fixed', `the gradient is viewport-anchored (${first.attachment})`)
    } finally {
      await session.send('Network.setBlockedURLs', { urls: [] })
    }
  })

  /*
   * The console collector, calibrated — and LAST, because calibrating it dirties it.
   *
   * `the skin raises no console or page errors` reads `pageErrors`, and this pushes an error into that
   * same array on purpose. The two facts have to be asserted rather than described: a listener that
   * silently stopped working would leave every run green while proving nothing, which is the failure
   * this round exists to fix — and a later assertion added below this one would read a channel that is
   * no longer clean, so the ordering contract is checked here instead of trusted.
   */
  await test('the console collector observes page console errors at all', async () => {
    truthy(consoleAssertionsDone, 'every assertion that reads the collector has already run')
    await evaluate(session, `(() => { console.error('dsh-ui-projects calibration'); return true })()`)
    await sleep(300)
    truthy(
      pageErrors.some((message) => message.includes('dsh-ui-projects calibration')),
      `a page console.error reaches the collector (${pageErrors.length} message(s) collected)`,
    )
  })

} catch (err) {
  /*
   * `--verify-refusal` ends by design; anything else ends the way it should — loudly, with the exit
   * code the recorded failures already set.
   */
  if (err instanceof Error && err.message === GATE_ONLY) {
    /*
     * The backstop for requirement this file states twice: a `--verify-refusal` run must SAY what the
     * interceptor saw, even when it ended early. In the normal path the gate already reported (the
     * summary prints once), so this is silent then — and when it is not silent, the run never reached
     * the gate, which is why the verdict line is suppressed (`reached: false`): zero pauses before any
     * page loaded is not evidence about the page.
     */
    reportSettingsPauses('[gate]', false)
    process.stdout.write('\n[gate] the refusal gate is the whole run; stopping here by design.\n')
  } else if (verifyRefusalOnly) {
    reportSettingsPauses('[gate]', false)
    process.stderr.write(`\n[gate] the gate could not be completed: ${String(err?.message ?? err)}\n`)
    process.exitCode = 1
  } else {
    throw err
  }
} finally {
  /*
   * Put the skin back the way this run found it.
   *
   * `test()` never throws — it records a failure and the next test runs — so this exists for the
   * unexpected abort, which is exactly when a harness is most likely to leave a machine changed. It
   * restores only when the run STARTED with the skin off: the phases turn it on and leave it on, so
   * a run that started with it on already ends in the state it began with, and a redundant toggle
   * would be a write for nothing.
   */
  if (startedWithSkinOn === false && page !== undefined && !verifyRefusalOnly) {
    /*
     * NOT in `--verify-refusal` mode. That mode ends inside the gate, before the phase that reads the
     * starting state — so `startedWithSkinOn` still holds its initial `false`, and the restore would
     * "put back" a state the run never found: it switched the skin off on an instance that had it on.
     * The gate itself never touches the skin (it drives the checklist, not the switch), so there is
     * nothing to restore in that mode either way.
     */
    try {
      await page.send('Page.navigate', { url: pageUrl })
      await waitFor(page, "document.querySelectorAll('#root *').length > 40", 'the app to mount', 45000)
      await setSkin(page, false)
    } catch (err) {
      // The run has already reported its own failures; a failed restore must not mask them.
      process.stdout.write(`         note  could not restore the skin state: ${String(err)}\n`)
    }
  }

  /*
   * The closing guard, and it belongs HERE — inside the `finally`, BEFORE the page is closed.
   *
   * `--no-write` promises that a run cannot change what a person chose. `refusedWrites > 0` proves the
   * rule fired at least once, which is not the same claim: if the rule were wrong in the way it was
   * wrong before, the writes would have gone through and the count would simply be zero with nothing
   * to notice. So the document's own state is read back — through the running client, which is the
   * only thing that can read it — and a difference is reported as FATAL rather than as a failed
   * assertion, because it means somebody's data changed and the run should not read as merely "not
   * green". Reading it after `page.close()` would throw instead of reporting anything.
   */
  if (noWrite && checksAtStart !== null && page !== undefined) {
    try {
      await page.send('Page.navigate', { url: pageUrl })
      await waitFor(page, "document.querySelectorAll('#root *').length > 40", 'the app to mount', 45000)
      await ensurePanel(page)
      const after = await page.send('Runtime.evaluate', {
        expression: `(() => {
          const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
          const record = details === null ? null : details.querySelector('[data-uip-checks]')
          return record === null ? null : record.getAttribute('data-uip-checks')
        })()`,
        returnByValue: true,
        awaitPromise: true,
      })
      const finalState = after?.result?.value ?? null
      if (finalState !== checksAtStart) {
        process.stderr.write(
          `\n[no-write] FATAL: this run changed the checklist record it found (${checksAtStart} → ${String(finalState)}).\n` +
            `[no-write] The settings key was supposed to be untouchable. The REFUSED/ALLOWED log above says\n` +
            `[no-write] what the interceptor saw. Do not treat this run's result as valid.\n`,
        )
        process.exitCode = 1
        failures += 1
      } else {
        process.stdout.write(`         note  the record this run found is unchanged after it (${finalState})\n`)
      }
    } catch (err) {
      process.stderr.write(`[no-write] FATAL: could not verify the record survived: ${String(err)}\n`)
      process.exitCode = 1
      failures += 1
    }
  }

  page?.close()
  cdp?.close()
  chrome.child.kill()
}

process.stdout.write(`\n${checks} assertions, ${failures} failing\n`)
if (failures > 0) process.exitCode = 1
