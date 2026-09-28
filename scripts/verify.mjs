/**
 * Behavioural verification for dsh-ui-projects.
 *
 * The browser half cannot be tested by importing its source, because the client
 * is delivered as one lazy-CJS bundle resolved against the shell's frozen module
 * table. So this script rebuilds that situation faithfully:
 *
 *   - it loads `lib/client.js` through a real `window.__ModuleLoader__` facade,
 *   - resolves `require('react')` against the real React package,
 *   - throws on any module request outside the shell's table,
 *   - boots the plugin against a fake Cordis context whose `effect` records
 *     disposers exactly like the real one, and a minimal DOM that records
 *     attributes and style elements,
 *   - renders the real settings component to markup with `react-dom/server`.
 *
 * It then asserts the observable contract: registry policy, persistence, live
 * toggling, CSS scoping, complete cleanup, and the rendered settings card.
 *
 * Run: `npm test` (after `npm run build`).
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const nodeRequire = createRequire(join(packageRoot, 'package.json'))

const react = nodeRequire('react')
const server = nodeRequire('react-dom/server')

/* ── assertions ───────────────────────────────────────────────────────────── */

let failures = 0
let checks = 0

/**
 * Run only the tests whose name contains this substring, for the evidence of ONE test on its own.
 *
 * `DSH_TEST_ONLY=... node scripts/verify.mjs`. A skip is counted and announced at the end, because a
 * filtered run that stays silent about what it skipped is a run whose green means nothing — the same
 * reason the browser suite prints the mode it started in.
 */
const onlyTest = process.env.DSH_TEST_ONLY ?? ''
let skipped = 0

/** @param {string} name @param {() => void | Promise<void>} body */
async function test(name, body) {
  if (onlyTest !== '' && !name.includes(onlyTest)) {
    skipped += 1
    return
  }
  try {
    await body()
    process.stdout.write(`  ok   ${name}\n`)
  } catch (err) {
    failures += 1
    process.stdout.write(`  FAIL ${name}\n         ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/** @param {unknown} actual @param {unknown} expected @param {string} [what] */
/**
 * A description of a value that never throws.
 *
 * `JSON.stringify` is the obvious choice and the wrong one here: the harness holds fake
 * DOM nodes, whose parent/child links are circular, so stringifying one throws
 * "Converting circular structure to JSON" and buries the assertion that actually
 * failed. A DOM-ish value is described by its tag and attributes instead — which is
 * also far more readable in a failure message.
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  const node = /** @type {any} */ (value)
  if (typeof node.tagName === 'string') {
    const attrs = ['id', 'className']
      .filter((key) => typeof node[key] === 'string' && node[key].length > 0)
      .map((key) => `${key}="${node[key]}"`)
      .join(' ')
    return `<${node.tagName.toLowerCase()}${attrs === '' ? '' : ' ' + attrs}>`
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 6).map(describe)
    return `[${head.join(', ')}${value.length > 6 ? `, …${value.length - 6} more` : ''}]`
  }
  try {
    return JSON.stringify(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/** @param {unknown} actual @param {unknown} expected @param {string} [what] */
function equal(actual, expected, what = 'value') {
  checks += 1
  const a = describe(actual)
  const b = describe(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

/** @param {unknown} value @param {string} [what] */
function truthy(value, what = 'value') {
  checks += 1
  if (!value) throw new Error(`${what}: expected truthy, got ${describe(value)}`)
}

/** @param {string} haystack @param {string} needle */
function contains(haystack, needle) {
  checks += 1
  if (!String(haystack).includes(needle)) throw new Error(`expected to find ${JSON.stringify(needle)}`)
}

/** @param {string} haystack @param {string} needle */
function excludes(haystack, needle) {
  checks += 1
  if (String(haystack).includes(needle)) throw new Error(`expected NOT to find ${JSON.stringify(needle)}`)
}

/* ── fake DOM ─────────────────────────────────────────────────────────────── */

import { createElement, createFakeDom, createStorage, FakeMutationObserver, wrapGetComputedStyle, setSandbox } from './fake-dom.mjs'





/* ── fake Cordis context ──────────────────────────────────────────────────── */

/**
 * The settings namespace this plugin owns and binds.
 *
 * Named once here because three places need the same string: seeding the fake document, the
 * `settingsScope` fake's lookup, and the harness's `settingsSection()` reader.
 */
const SETTINGS_SCOPE_NS = 'ui-projects'

/**
 * @param {object} input
 * @param {ReturnType<typeof createFakeDom>} input.dom
 * @param {boolean} [input.withSettingsScope]
 * @param {Record<string, unknown>} [input.scopeRecord] The record the settings document already
 *   holds when the page loads, so a test can start from a user's existing choice.
 * @param {number} [input.scopeDelayMs] How long the scope stays `idle` before its first read
 *   settles. This reproduces the real cold-load gap; without it the fake is instantly `ready`
 *   and the whole readiness path is untestable.
 * @param {string} [input.scopeError] Make the read fail: the status stays `idle` and `error` is
 *   set, which is the terminal state a broken transport leaves behind.
 * @param {boolean} [input.withTheme]
 */
function createCtx(input) {
  const {
    dom,
    withSettingsScope = false,
    scopeRecord,
    scopeDelayMs = 0,
    scopeError,
    withTheme = false,
  } = input
  /** @type {Map<string, any>} */
  const services = new Map()
  /** @type {Array<() => void>} */
  const effects = []
  /** @type {Array<{ name: string, id: string, order?: number, label?: any }>} */
  const registrations = []
  /** @type {Map<string, any>} */
  const namespaces = new Map()
  let themeLayers = 0

  if (withSettingsScope) {
    // Seeded before anything binds, the way `settings.yaml` already holds a record by the time a
    // page loads.
    if (scopeRecord !== undefined) namespaces.set(SETTINGS_SCOPE_NS, scopeRecord)
    services.set('settingsScope', {
      bind(/** @type {{ namespace: string }} */ spec) {
        let revision = 1
        const listeners = new Set()
        /*
         * `status` is the field the plugin's readiness wait reads, and in the real service it
         * starts at `idle`: ui-settings kicks off the first `settings.describe` read without
         * awaiting it and publishes the service immediately, so every consumer binds while the
         * document is still in flight. `scopeDelayMs` is that gap, made controllable.
         *
         * A FAILED read never reaches `ready` either: ui-settings keeps the last good view and
         * leaves the status at `idle`, putting the reason in `error`. `scopeError` reproduces
         * exactly that shape, which is why it also suppresses the delayed release.
         */
        const failed = scopeError !== undefined
        const delayed = scopeDelayMs > 0
        const pending = failed || delayed
        const settled = namespaces.get(spec.namespace)
        const snapshot = {
          status: pending ? 'idle' : 'ready',
          value: pending ? undefined : settled,
          base: undefined,
          user: pending ? undefined : settled,
          revision,
          writable: true,
          mode: 'host',
          error: scopeError ?? null,
        }
        if (delayed && !failed) {
          setTimeout(() => {
            snapshot.status = 'ready'
            snapshot.value = namespaces.get(spec.namespace)
            snapshot.user = snapshot.value
            revision += 1
            for (const listener of listeners) listener()
          }, scopeDelayMs)
        }
        return {
          getSnapshot: () => ({ ...snapshot, revision }),
          subscribe(/** @type {() => void} */ listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          async set(/** @type {string} */ field, /** @type {unknown} */ value) {
            const section = namespaces.get(spec.namespace) ?? {}
            section[field] = value
            namespaces.set(spec.namespace, section)
            revision += 1
            snapshot.value = section
            snapshot.user = section
            for (const listener of listeners) listener()
          },
          async unset(/** @type {string} */ field) {
            const section = namespaces.get(spec.namespace) ?? {}
            delete section[field]
            revision += 1
            snapshot.value = section
            for (const listener of listeners) listener()
          },
          async mutate() {},
          dispose() {},
        }
      },
    })
  }

  if (withTheme) {
    services.set('theme', {
      overrideTokens() {
        themeLayers += 1
        return () => {
          themeLayers -= 1
        }
      },
    })
  }

  /** Section render handlers, keyed by slot. */
  const handlers = new Map()
  /** Callbacks waiting for a slot to be declared, keyed by slot. */
  const pendingInjections = new Map()
  const slots = {
    /**
     * The real service runs the callback once the slot is DECLARED, and the
     * callback returns the registration's disposer. This fake treats a slot as
     * declared as soon as someone injects on it, and runs the callback on the next
     * microtask — the same "declaration becomes true later" shape the plugin must
     * work with.
     * @param {string} key @param {() => any} callback
     */
    inject(key, callback) {
      const list = pendingInjections.get(key) ?? []
      list.push(callback)
      pendingInjections.set(key, list)
      let disposed = false
      queueMicrotask(() => {
        if (disposed) return
        for (const entry of list) {
          const result = entry()
          if (typeof result === 'function') disposers.push(result)
        }
        list.length = 0
      })
      return () => {
        disposed = true
      }
    },
    /** @param {any} options @param {() => any} component */
    register(options, component) {
      registrations.push(options)
      handlers.set(`${options.name}:${options.id}`, component)
      return () => {
        const index = registrations.indexOf(options)
        if (index >= 0) registrations.splice(index, 1)
        handlers.delete(`${options.name}:${options.id}`)
      }
    },
  }
  /** @type {Array<() => void>} */
  const disposers = []
  services.set('slots', slots)

  /** Every `$on` this bundle registered, so a test can prove the wiring happened. */
  const remoteSubscriptions = []
  services.set('remote', {
    /**
     * @param {string} name
     * @param {(...args: any[]) => any} handler
     */
    $on: (name, handler) => {
      remoteSubscriptions.push({ name, handler })
      return () => {
        const at = remoteSubscriptions.findIndex((entry) => entry.handler === handler)
        if (at >= 0) remoteSubscriptions.splice(at, 1)
      }
    },
  })

  /**
   * Cordis's traceable-service contract, in the small.
   *
   * A service carrying `Symbol.for('cordis.tracker')` is handed back as a proxy whose
   * `tracker.property` (for `uiProjects`, `ctx`) is the context that REACHED it, and whose methods run
   * with a shadow of the service as `this` — the shadow inherits everything and differs only in that
   * property. This is not decoration: `src/client/service.js` reads `this.ctx` to bind a registration's
   * lifetime to the caller's fiber, so without it the fixture's `ctx.uiProjects.register(...)` would
   * throw "must be called as ctx.uiProjects.register(...)" — a fake that refuses the real call shape.
   *
   * Production implementation: `cordis/lib/index.js` (`createTraceable`, and the shadow it builds for
   * methods). The tracker itself is declared in `src/client/service.js`.
   * @param {any} accessingCtx @param {any} value @param {{ property: string }} tracker
   */
  const traceableFor = (accessingCtx, value, tracker) => {
    const shadow = Object.create(value)
    shadow[tracker.property] = accessingCtx
    return new Proxy(value, {
      get(target, prop, receiver) {
        if (prop === tracker.property) return accessingCtx
        const inner = Reflect.get(target, prop, receiver)
        if (typeof inner !== 'function') return inner
        return (/** @type {any[]} */ ...args) => inner.apply(shadow, args)
      },
    })
  }

  /**
   * One context over the shared service map.
   *
   * `own` is where this context's `effect` registrations go, and that is the whole of `child()`: the
   * root keeps the plugin's own disposers, and a child stands in for a PACKAGE's fiber, so a test can
   * unload one package (`fiber.cleanup()`) without tearing down the framework it registered against.
   * @param {Array<() => void>} own
   * @param {boolean} isRoot
   */
  const makeCtx = (own, isRoot) => {
    /** One traceable view per (context, service), so `ctx.uiProjects === ctx.uiProjects` holds. */
    const views = new WeakMap()
    /**
     * A service as THIS context sees it.
     *
     * The traceable wrapper is built per access rather than once at `provide` time, and that is the
     * whole point: `this.ctx` must be the context that REACHED the service — a package's fiber when a
     * package registers, the framework's own context when the framework does. Building it once would
     * pin every caller to whoever provided it first.
     * @param {string} name
     */
    const resolve = (name) => {
      const raw = services.get(name)
      if (raw === null || typeof raw !== 'object') return raw
      const tracker = /** @type {any} */ (raw)[Symbol.for('cordis.tracker')]
      if (tracker === undefined) return raw
      const cached = views.get(raw)
      if (cached !== undefined) return cached
      const view = traceableFor(ctx, raw, tracker)
      views.set(raw, view)
      return view
    }
    const base = {
      get: (/** @type {string} */ name) => resolve(name),
      /**
       * Cordis' dependency-resolved injection. The fake runs the callback immediately when
       * every named service already exists, which is how the real one behaves — and it
       * calls back synchronously, so the bundle's subscriptions exist by the time `apply`
       * returns, exactly as they do in the browser.
       * @param {string[]} names
       * @param {(scoped: any) => any} callback
       */
      inject(names, callback) {
        const ready = names.every((name) => services.get(name) !== undefined)
        if (!ready) return () => {}
        const result = callback(ctx)
        const dispose = typeof result === 'function' ? result : () => {}
        own.push(dispose)
        return dispose
      },
      provide(/** @type {string} */ name, /** @type {unknown} */ value) {
        services.set(name, value)
        return () => services.delete(name)
      },
      on() {
        return () => {}
      },
      /** @param {() => any} callback */
      effect(callback) {
        const result = callback()
        const dispose = typeof result === 'function' ? result : () => {}
        own.push(dispose)
        return dispose
      },
      /** A fiber of its own, for a package that registers through the service. */
      child: () => makeCtx([], false),
      cleanup() {
        for (const dispose of own.reverse()) dispose()
        own.length = 0
        /*
         * The slots bookkeeping belongs to the ROOT only: unloading a package must not unregister the
         * framework's own settings sections, which is exactly the mistake this distinction prevents.
         */
        if (isRoot) {
          registrations.length = 0
          handlers.clear()
        }
      },
    }
    /*
     * A provided service is also a PROPERTY (`ctx.uiProjects`), which is how every UI project package
     * reaches it — the client half of a package writes `ctx.uiProjects.register(...)`, not
     * `ctx.get('uiProjects')`. The proxy adds that, and nothing else: everything already on the context
     * wins, and symbols are passed straight through.
     */
    const ctx = new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !(prop in target)) {
          const service = resolve(prop)
          if (service !== undefined) return service
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    return ctx
  }

  const ctx = makeCtx(effects, true)

  void dom
  return {
    ctx,
    registrations,
    handlers,
    namespaces,
    /** Every `$on` the bundle registered, so a test can prove the wiring happened. */
    remoteSubscriptions,
    themeLayers: () => themeLayers,
  }
}


/**
 * A timer stand-in that a test advances by hand.
 *
 * The runtime's two retry loops are driven by wall-clock time: one bridges the gap between a
 * project being applied and the shell mounting the application, the other waits for a boot page
 * to become stale. Neither could be tested before — and both polled forever, which no test could
 * have noticed either way. Waiting five real seconds to watch a bounded retry give up would make
 * this suite unbearable, so this records what was scheduled and lets a test say "the deadline
 * passed" at the moment it means, exactly as `FakeMutationObserver.flushAll()` does for DOM
 * changes.
 *
 * Handles are objects rather than numbers so the runtime's `handle?.unref?.()` is a real call
 * here too, and so a `clearInterval` can be matched against what it actually created.
 */
class FakeTimers {
  constructor() {
    /** @type {Map<number, { callback: () => void, ms: number }>} */
    this.intervals = new Map()
    /** @type {Map<number, { callback: () => void, ms: number }>} */
    this.timeouts = new Map()
    this.nextId = 1
  }

  /** @param {() => void} callback @param {number} ms */
  setInterval(callback, ms) {
    const id = this.nextId++
    this.intervals.set(id, { callback, ms })
    return { id, unref() {} }
  }

  /** @param {any} handle */
  clearInterval(handle) {
    if (handle !== undefined && handle !== null) this.intervals.delete(handle.id)
  }

  /** @param {() => void} callback @param {number} ms */
  setTimeout(callback, ms) {
    const id = this.nextId++
    this.timeouts.set(id, { callback, ms })
    return { id, unref() {} }
  }

  /** @param {any} handle */
  clearTimeout(handle) {
    if (handle !== undefined && handle !== null) this.timeouts.delete(handle.id)
  }

  /** Running intervals. Zero is the number these tests exist to assert. */
  get pendingIntervals() {
    return this.intervals.size
  }

  /** Armed deadlines. */
  get pendingTimeouts() {
    return this.timeouts.size
  }

  /**
   * The periods of the intervals still running.
   *
   * A bare count cannot tell "the marking retry stopped" from "some other loop took its place";
   * the period can, and it is what a reader would check by hand.
   */
  get runningPeriods() {
    return [...this.intervals.values()].map((entry) => entry.ms)
  }

  /** Run every running interval once, skipping any that a callback cleared. */
  tickIntervals() {
    for (const [id, entry] of [...this.intervals.entries()]) {
      if (this.intervals.has(id)) entry.callback()
    }
  }

  /** Run every armed deadline once and clear it, as a real timer does when it fires. */
  fireTimeouts() {
    const pending = [...this.timeouts.values()]
    this.timeouts.clear()
    for (const entry of pending) entry.callback()
  }
}


/* ── bundle loader ────────────────────────────────────────────────────────── */

/**
 * The bundle under test.
 *
 * By default the freshly built `lib/client.js`. Setting
 * `DSH_UI_PROJECTS_BUNDLE_URL` (or passing a URL as the first argument) makes the
 * suite read the bytes a running dsh process actually serves instead — the
 * strongest available check short of a browser, because it exercises the same
 * composition, the same `dsh.client` scan and the same bundle route the page uses.
 * @returns {Promise<{ source: string, origin: string }>}
 */
async function readBundleSource() {
  const url = process.argv[2] ?? process.env.DSH_UI_PROJECTS_BUNDLE_URL
  if (url === undefined || url.length === 0) {
    return { source: await readFile(join(packageRoot, 'lib', 'client.js'), 'utf8'), origin: 'lib/client.js (built)' }
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`cannot read the served bundle from ${url}: HTTP ${response.status}`)
  return { source: await response.text(), origin: url }
}

/**
 * Execute a bundle the way the shell does: register its factory, then materialize
 * the entry module with a module table that throws on a miss.
 *
 * The bundle runs inside a real `vm` global whose `document`/`window` are
 * re-pointed at each test's fake DOM, so the plugin resolves them exactly as it
 * would in a browser (`document` is a global there, not an import).
 *
 * The sandbox intentionally provides a global `require`: the bundle is a browser
 * script, but Node classifies a script that mentions `require` without providing
 * one as ambiguous CommonJS/ESM (`ERR_AMBIGUOUS_MODULE_SYNTAX`). A browser has no
 * such global, which is exactly why the bundle must never rely on one.
 * @returns {Promise<{ plugin: any, sandbox: Record<string, any>, origin: string }>}
 */
async function loadClientBundle() {
  const { source, origin } = await readBundleSource()
  /** @type {{ id: string, factory: (require: (id: string) => any) => any } | undefined} */
  let registered
  const sandbox = {
    document: undefined,
    window: {
      __ModuleLoader__: {
        /** @param {any} registration */
        load(registration) {
          registered = registration
        },
      },
      localStorage: undefined,
    },
    console,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  vm.runInContext(source, context, { filename: 'client.js' })
  if (registered === undefined) throw new Error('bundle did not register a ModuleLoader factory')
  equal(registered.id, 'dsh-ui-projects', 'bundle id')

  /** The shell's frozen module table. React is the very same instance the
   * renderer uses, so hooks resolve to one copy. */
  const staticModules = {
    react,
    'react/jsx-runtime': { jsx: () => null },
    'react-dom': { default: {} },
  }
  const require = (/** @type {string} */ id) => {
    if (Object.prototype.hasOwnProperty.call(staticModules, id)) {
      return /** @type {Record<string, any>} */ (staticModules)[id]
    }
    throw new Error(`module-table miss: the shell exposes no "${id}"`)
  }

  // The bundle's `require` argument is passed straight through the factory call,
  // so it stays a host function and React keeps its real identity.
  const plugin = registered.factory(require)

  // `window.__ModuleLoader__` lives inside the context; give the context a
  // request function too, for the global-require path.
  context.require = require
  return { plugin, sandbox, context, origin, source }
}

/**
 * Materialize the bundle's entry module under a caller-supplied module table,
 * inside its own global, which it returns so a caller can install fake browser
 * globals before calling `apply`.
 *
 * This is how the load-time contracts are tested: the shell materializes the entry
 * module BEFORE calling `apply`, with a `require` that answers only its frozen
 * table, so a bundle that imports React or a project at load time fails in the
 * browser and nowhere else.
 * @param {string} source
 * @param {(id: string) => any} require
 * @returns {{ entry: any, globals: Record<string, any> }}
 */
function materializeEntry(source, require) {
  /** @type {any} */
  let registered
  /** @type {Record<string, any>} */
  const globals = {
    document: undefined,
    window: { __ModuleLoader__: { load: (/** @type {any} */ r) => (registered = r) }, localStorage: undefined },
    console,
  }
  globals.globalThis = globals
  vm.runInContext(source, vm.createContext(globals), { filename: 'client.js' })
  if (registered === undefined) throw new Error('bundle did not register a ModuleLoader factory')
  return { entry: registered.factory(require), globals }
}

/* ── boot helper ──────────────────────────────────────────────────────────── */

const { plugin, sandbox, origin, source: bundleSource } = await loadClientBundle()
const { createInstalledStore, UiPluginsSection, UiProjectsSection } = plugin.__internals
setSandbox(sandbox)
const { Registry, scopeCss, strings, detectLocale, formatStamp } = plugin.__internals
/**
 * The `localStorage` key the fallback adapter uses, taken from the module that owns it.
 *
 * Typed by hand it was wrong — `dsh.ui.projects.v1` against a real `dsh.ui-projects.v1` — and the
 * assertion that depended on it had been passing vacuously. Reading it here is what makes the
 * literal impossible to get wrong twice.
 */
const LOCAL_STORAGE_KEY = plugin.__internals.persistKeys.localKey
// The opacity scale is shared by every project, so the tests assert against the same
// constants the runtime uses rather than repeating the numbers.
const { MATERIAL_ALPHA_CEILING, MATERIAL_ALPHA_FLOOR, MATERIAL_SCALE_REVISION } = await import(
  '../src/client/project-constants.js'
)

/** Tears down the most recent boot, so tests cannot leak into one another. */
let activeCleanup

/*
 * ── THE TEST SKIN ─────────────────────────────────────────────────────────────
 *
 * The framework's own fixture, registered the way an EXTERNAL UI project package registers: a manifest
 * shaped like `dsh.uiProject` plus a definition carrying behaviour and nothing else, handed to
 * `ctx.uiProjects.register(manifest, definition)` from a fiber of its own.
 *
 * Its data lives in `./test-skin.mjs` rather than here, because `host-check.mjs` needs the same stylesheet
 * to assert the first-paint contract without naming any real project — and a second copy of a fixture is a
 * fixture that can drift.
 */
const {
  TEST_SKIN_ID,
  TEST_SKIN_MANIFEST,
  TEST_SKIN_DEFINITION,
} = await import('./test-skin.mjs')

/**
 * Register the test skin through the service, from a fiber of its own.
 *
 * This is the same three lines an external package's client half writes — `inject: ['uiProjects']`, then
 * `register(manifest, definition)` — with the injection already satisfied. `harness.testSkin.unmount()`
 * unloads that fiber, which is how "a package going away withdraws its projects" becomes testable here
 * rather than only in `load-check.mjs`.
 * @param {any} harness
 * @param {{ manifest?: Record<string, any>, definition?: Record<string, any> }} [overrides]
 */
function mountTestSkin(harness, overrides = {}) {
  const manifest = { ...TEST_SKIN_MANIFEST, ...(overrides.manifest ?? {}) }
  const fiber = harness.ctx.child()
  fiber.uiProjects.register(manifest, { ...TEST_SKIN_DEFINITION, ...(overrides.definition ?? {}) })
  return { manifest, fiber, unmount: () => fiber.cleanup() }
}

/**
 * Boot a plugin instance against fake DOM globals and fake services.
 *
 * Each boot tears down the previous one first, so tests neither leak effects into
 * one another nor double-dispose them.
 * @param {{ withStorage?: boolean | ReturnType<typeof createStorage>, withSettingsScope?: boolean, scopeRecord?: Record<string, unknown>, scopeDelayMs?: number, scopeError?: string, withTheme?: boolean, detachedFrame?: boolean, viewportWidth?: number, viewportHeight?: number, fakeTimers?: boolean, device?: { cores?: number, saveData?: boolean }, withTestSkin?: boolean }} [options]
 */
async function boot(options = {}) {
  // Tear down BEFORE the sandbox globals move: a previous instance's disposers
  // read `document` when they run, so they must still see the document they
  // wrote to.
  if (activeCleanup !== undefined) {
    activeCleanup()
    activeCleanup = undefined
  }
  const storage =
    typeof options.withStorage === 'object' && options.withStorage !== null ? options.withStorage : createStorage()
  const dom = createFakeDom()

  // A minimal stand-in for the shipped frame: the runtime finds it by asking the DOM
  // (a grid with a multi-track template and more than one child), so the fake DOM has to
  // answer that question for `markColumns` to be exercised at all. The stub's display is
  // reported through `getComputedStyle`, which is what the runtime reads.
  const appRoot = createElement('div')
  appRoot.id = 'root'
  const frame = createElement('div')
  frame.setAttribute('data-test-frame', '')
  const fakeColumns = [createElement('div'), createElement('div'), createElement('div')]
  for (const column of fakeColumns) frame.appendChild(column)
  // Plus the two things that are NOT columns: the frame-wide overlay (a container, and
  // blurring it softens everything) and the zero-area resize handle.
  const fakeOverlay = createElement('div')
  fakeOverlay.setAttribute('data-test-overlay', '')
  frame.appendChild(fakeOverlay)
  const fakeHandle = createElement('div')
  fakeHandle.setAttribute('data-test-overlay', '')
  frame.appendChild(fakeHandle)
  appRoot.appendChild(frame)
  // `detachedFrame` reproduces the real ordering problem: a project is applied while the
  // shell is still booting, so the frame is not in the document yet — which is exactly when a
  // one-shot lookup fails and only the observer can save it.
  if (options.detachedFrame !== true) dom.body.appendChild(appRoot)
  dom.mountFrame = () => {
    if (!dom.body.children.includes(appRoot)) dom.body.appendChild(appRoot)
    return frame
  }
  /** The frame stub itself, for a test that wants to replace its children. */
  dom.frame = () => frame

  // The plugin reads the DOM through globals, so the sandbox's globals are what
  // change per boot — not `globalThis`, which the bundle never sees.
  sandbox.document = dom.document
  sandbox.window.localStorage = storage
  // A viewport to measure against: the runtime compares the container's content height with it
  // to decide whether the boot page is genuinely in the way.
  sandbox.window.innerWidth = options.viewportWidth ?? 1400
  sandbox.window.innerHeight = options.viewportHeight ?? 800
  /*
   * The device signals `perf.js` reads, set explicitly so a test decides the effect tier instead
   * of inheriting whatever machine happens to run the suite. `undefined` means "this host exposes
   * no signals", which is also the shape a browser without `navigator.connection` presents.
   */
  sandbox.navigator =
    options.device === undefined
      ? undefined
      : {
          connection: { saveData: options.device.saveData === true },
          hardwareConcurrency: options.device.cores,
        }
  sandbox.getComputedStyle = wrapGetComputedStyle(dom)
  // The bundle retries the frame lookup on a timer, because the shell has not mounted the
  // application when a project is first applied. A sandbox without timers would make that
  // retry impossible to exercise — and would licence a plugin that hangs on a real page.
  // With `fakeTimers` the same retry becomes observable instead of merely assumed: the test
  // decides when the interval ticks and when the deadline passes.
  const timers = options.fakeTimers === true ? new FakeTimers() : undefined
  if (timers === undefined) {
    sandbox.setInterval = setInterval
    sandbox.clearInterval = clearInterval
    sandbox.setTimeout = setTimeout
    sandbox.clearTimeout = clearTimeout
  } else {
    sandbox.setInterval = (/** @type {() => void} */ callback, /** @type {number} */ ms) =>
      timers.setInterval(callback, ms)
    sandbox.clearInterval = (/** @type {any} */ handle) => timers.clearInterval(handle)
    sandbox.setTimeout = (/** @type {() => void} */ callback, /** @type {number} */ ms) =>
      timers.setTimeout(callback, ms)
    sandbox.clearTimeout = (/** @type {any} */ handle) => timers.clearTimeout(handle)
  }
  // The runtime also marks on DOM changes, which is what catches the shell mounting the
  // application. Without a MutationObserver in the sandbox that path is silently untested.
  FakeMutationObserver.reset()
  sandbox.MutationObserver = FakeMutationObserver
  void fakeColumns

  const host = createCtx({
    dom,
    withSettingsScope: options.withSettingsScope,
    scopeRecord: options.scopeRecord,
    scopeDelayMs: options.scopeDelayMs,
    scopeError: options.scopeError,
    withTheme: options.withTheme,
  })
  await plugin.apply(host.ctx)
  // The initial state application settles asynchronously, and the settings section
  // registers once the slot is declared (also asynchronous). Wait for both, exactly
  // as a host integration would.
  await plugin.ready()
  await new Promise((resolve) => queueMicrotask(resolve))

  const runtime = plugin.runtime
  if (runtime === undefined) throw new Error('the plugin did not publish its runtime')

  /*
   * THE FIXTURE IS MOUNTED HERE, by default, because a framework test almost always needs a project to
   * be about — and mounting it in `boot()` is what keeps the thirty-two converted tests from growing a
   * setup paragraph each. `withTestSkin: false` is for the tests whose subject is the ABSENCE of a
   * registration: an empty registry, a refusal that must leave nothing behind, or "nothing registers
   * before the slot is declared".
   */
  const testSkin = options.withTestSkin === false ? undefined : mountTestSkin({ ctx: host.ctx })

  activeCleanup = () => {
    host.ctx.cleanup()
    sandbox.document = undefined
    sandbox.window.localStorage = undefined
  }

  return {
    dom,
    storage,
    ctx: host.ctx,
    registrations: host.registrations,
    registry: plugin.registry,
    runtime,
    /**
     * The panel's data source, so a test can assert on the snapshot the panel renders from rather
     * than re-deriving it. Captured at boot: the module-level handle moves on with the next boot.
     */
    store: plugin.store,
    /** The fixture, when one was mounted: its manifest, its fiber, and how to unload the package. */
    testSkin,
    /** Present only with `fakeTimers`, and then the only place timers can be inspected. */
    timers,
    persistKind: runtime.persist.kind,
    /** The settings namespace this plugin wrote, as the fake host sees it. */
    settingsSection: () => host.namespaces.get(SETTINGS_SCOPE_NS),
    /**
     * The project's marker, which the runtime sets on the BODY: project styles are
     * scoped there because that is where the shipped client declares its tokens.
     */
    projectMarker: (/** @type {string} */ id) => dom.document.body.getAttribute(`data-ui-project-${id}`),
    stylesContain: (/** @type {string} */ needle) =>
      dom.styles().some((style) => style.textContent.includes(needle)),
    allCss: () => dom.allCss(),
    /** Render the registered settings section exactly as the shell would. */
    render: () => renderPanel(plugin),
    themeLayers: host.themeLayers,
  }
}

/**
 * Every CSS custom property the shipped web client declares.
 *
 * The skin re-binds the design system's own alias tokens rather than inventing
 * names, so this is the reference set that proves it: a typo in a `--dsw-*` name
 * would silently do nothing in the browser, and this turns that into a test
 * failure. Read from the installed frontend and theme bundles — the actual source
 * of truth for the running application — not from this package.
 * @returns {Promise<Set<string>>}
 */
async function shippedDesignTokens() {
  const declared = new Set()
  for (const file of await shippedCssFiles()) {
    for (const token of declaredTokens(await readFile(file, 'utf8'))) declared.add(token)
  }
  if (declared.size === 0) throw new Error('no shipped design tokens found; the reference set would be vacuous')
  return declared
}

/**
 * The stylesheets the running client loads: the built frontend plus the token
 * sheet the theme plugin injects.
 * @returns {Promise<string[]>}
 */
async function shippedCssFiles() {
  const install = join(
    process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'),
    'npm-cache',
    '_npx',
    '1e7f6d9597241db0',
    'node_modules',
    '@deepseek-ai',
  )
  const { readdir } = await import('node:fs/promises')
  const files = []
  const assets = join(install, 'dsh-web-frontend', 'dist', 'assets')
  for (const entry of await readdir(assets)) {
    if (entry.endsWith('.css')) files.push(join(assets, entry))
  }
  files.push(join(install, 'dsh-client-ui-theme', 'lib', 'client.js'))
  return files
}

/**
 * Every custom property DECLARED in a stylesheet (`--name:`), as opposed to merely
 * referenced (`var(--name)`).
 * @param {string} css
 * @returns {Set<string>}
 */
function declaredTokens(css) {
  const found = new Set()
  for (const match of String(css).matchAll(/(--[a-z0-9][a-z0-9-]*)\s*:/gi)) found.add(match[1])
  return found
}

/**
 * Render the Settings › UI panel to static markup.
 *
 * The panel is rendered through React, exactly as the shell renders it: React
 * supplies the hook dispatcher, so the component's own state and effects run for
 * real. A ready snapshot is handed in so the render does not depend on a live
 * store subscription.
 * @param {any} plugin
 * @returns {string}
 */
function renderPanel(plugin) {
  return server.renderToStaticMarkup(react.createElement(plugin.section))
}

/* ── suite ────────────────────────────────────────────────────────────────── */

process.stdout.write(`\ndsh-ui-projects verification\nbundle: ${origin}\n\n`)

await test('the bundle registers one plugin with the two hard dependencies it needs', () => {
  equal(plugin.name, 'ui-projects', 'plugin name')
  /*
   * `settingsScope` is a TIMING dependency rather than a functional one: the plugin degrades to
   * localStorage without it, so nothing here fails loudly when it is missing. But it binds the
   * scope synchronously in `apply`, while the provider appears only after the host handshake — so
   * leaving it out meant the bind always ran first and always lost, and the switch silently
   * persisted per-browser while the settings document kept a stale copy.
   *
   * The list is asserted, not described, because a missing declaration is invisible to every
   * behavioural test in this file: `boot()` calls `plugin.apply(ctx)` directly, which bypasses
   * exactly the parking the declaration controls.
   */
  equal(plugin.inject, ['slots', 'settingsScope'], 'inject list')
  equal(typeof plugin.apply, 'function', 'apply')
  equal(typeof plugin.ready, 'function', 'ready() exposes the applied-state settlement')
  equal(plugin.section, undefined, 'nothing is published before the plugin is applied')
})

await test('the registry rejects a malformed project id', () => {
  const registry = new Registry()
  for (const id of ['Bad Id', '9leading', '', 'has_underscore', 'has?question']) {
    let threw = false
    try {
      registry.register({ id, name: 'x' })
    } catch {
      threw = true
    }
    truthy(threw, `"${id}" must be rejected (an id becomes a CSS attribute selector)`)
  }
  equal(registry.ids(), [], 'nothing registered')
})

await test('the runtime feeds the theme service a layer it can take back', async () => {
  const harness = await boot({ withTheme: true })
  equal(harness.themeLayers(), 0, 'no layer before the skin is on')
  await harness.runtime.enable('test-skin')
  equal(harness.themeLayers(), 0, 'the skin itself registers no theme layer (its palette is a stylesheet)')
  harness.runtime.dispose()
  equal(harness.themeLayers(), 0, 'and none survives')
})

/*
 * THE FIXTURE'S OWN CONTRACT — the one test that says what `boot()` mounts, and that the way it mounts
 * is the way an external package mounts.
 *
 * It replaces `test-skin registers as a skin that is off by default`, which read the framework's own
 * built-in definition out of `__internals`. That export disappears with the skin in 8c; what is left is
 * the property the framework actually owns — a package hands over a manifest and behaviour, the service
 * validates and stamps them, and the registry sees one project whose fields came from the manifest.
 */
await test('the test skin registers through the service, the way an external package does', async () => {
  const harness = await boot()
  const project = harness.registry.get('test-skin')
  truthy(project !== undefined, 'the registry holds the fixture')
  equal(project.type, 'skin', 'its type comes from the manifest')
  equal(project.defaultEnabled, false, 'it is off by default')
  equal(project.version, '1.0.0', 'and its version IS the package version — never a second number')
  equal(project.source.package, 'test-skin-package', 'stamped with the package that registered it')
  equal(project.source.version, '1.0.0', 'and that package’s version')
  equal(harness.registry.isEnabled('test-skin'), false, 'registered is not enabled')
  /*
   * AND IT IS THE ONLY PROJECT IN THIS HARNESS. The framework ships none of its own: the fixture
   * `boot()` mounts is the whole registry, so the count below is the honest form of a claim that
   * used to be written as "and the framework still ships its own skin until 8c moves it". Stating
   * it as a count rather than by naming the moved project is deliberate — this suite must not
   * depend on which package happens to be installed beside it.
   */
  equal(harness.registry.ids().length, 1, 'the fixture is the only project in the registry: this package registers none of its own')

  // The fiber is real: unloading the package withdraws the project, and nothing else. Withdrawal is
  // asynchronous — it retires the project (releasing its stylesheets, its marker and the persisted
  // record) before dropping the definition — so this waits for the registry to change rather than
  // assuming how many ticks that takes.
  const registeredBefore = harness.registry.ids().length
  harness.testSkin.unmount()
  for (let attempt = 0; attempt < 50 && harness.registry.get('test-skin') !== undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  equal(harness.registry.get('test-skin'), undefined, 'unloading the package withdraws its project')
  equal(harness.registry.ids().length, registeredBefore - 1, 'and takes nothing else with it')
})

await test('enabling test-skin marks the root and mounts its material', async () => {
  const harness = await boot()
  const before = harness.dom.styles().length
  await harness.runtime.enable('test-skin')

  equal(harness.registry.isEnabled('test-skin'), true, 'registry state')
  equal(harness.projectMarker('test-skin'), 'on', 'project marker')
  equal(harness.dom.root.getAttribute('data-ui-skin'), 'test-skin', 'skin marker')
  equal(harness.dom.root.getAttribute('data-ui-projects'), 'on', 'system marker')
  truthy(harness.dom.styles().length > before, 'a stylesheet was inserted')
  truthy(harness.stylesContain('--ts-fill'), 'design tokens present')
  truthy(harness.stylesContain('body[data-ui-project-test-skin="on"]'), 'CSS scoped to the marker')
  truthy(harness.stylesContain('@supports not'), 'the no-backdrop-filter fallback ships with it')
  equal(harness.dom.ambient().length, 0, 'this skin mounts no DOM: stylesheets only')
})

await test('skins are mutually exclusive and the previous one is fully removed', async () => {
  const harness = await boot()
  harness.registry.register({
    id: 'other-skin',
    name: 'Other Skin',
    description: '',
    version: '1.0.0',
    type: 'skin',
  })

  await harness.runtime.enable('test-skin')
  await harness.runtime.enable('other-skin')

  equal(harness.registry.isEnabled('test-skin'), false, 'previous skin off')
  equal(harness.registry.isEnabled('other-skin'), true, 'new skin on')
  equal(harness.dom.root.getAttribute('data-ui-skin'), 'other-skin', 'skin marker follows the winner')
  equal(harness.projectMarker('test-skin'), null, 'previous marker removed')
  equal(harness.dom.ambient().length, 0, 'previous skin DOM removed')
  excludes(harness.allCss(), '--ts-fill', 'previous skin CSS removed')
})

await test('disabling test-skin leaves no style, marker or theme residue', async () => {
  const harness = await boot({ withTheme: true })
  const before = harness.dom.styles().length

  await harness.runtime.enable('test-skin')
  truthy(harness.dom.styles().length > before, 'stylesheet added while on')

  await harness.runtime.disable('test-skin')
  equal(harness.dom.styles().length, before, 'stylesheet removed')
  excludes(harness.allCss(), '--ts-fill', 'no fixture CSS left — the label said "no glass CSS left" until 8c, when the frame it described became this suite\'s own fixture')
  equal(harness.dom.ambient().length, 0, 'ambient layer removed')
  equal(harness.registry.isEnabled('test-skin'), false, 'registry state')
  equal(harness.projectMarker('test-skin'), null, 'project marker removed')
  equal(harness.dom.root.getAttribute('data-ui-skin'), null, 'skin marker removed')
  equal(harness.dom.root.getAttribute('data-ui-projects'), 'on', 'system marker stays while mounted')
  equal(harness.themeLayers(), 0, 'no theme token layer left')
})

await test('project CSS is scoped to its own marker, at-rules included', () => {
  const compact = (/** @type {string} */ css) =>
    css
      .replace(/\s*\{\s*/g, '{')
      .replace(/\s*\}\s*/g, '}')
      .replace(/\s*,\s*/g, ',')
      .replace(/\s+/g, ' ')
      .trim()
  const scoped = compact(
    scopeCss(
      'body[data-ui-project-x="on"]',
      `:root { --a: 1; }
.card, .row:hover { color: red; }
@media (max-width: 560px) { .card { padding: 0; } }
@keyframes spin { from { opacity: 0 } to { opacity: 1 } }`,
    ),
  )
  contains(scoped, 'body[data-ui-project-x="on"]{--a: 1;}')
  contains(scoped, 'body[data-ui-project-x="on"] .card,body[data-ui-project-x="on"] .row:hover{color: red;}')
  contains(scoped, '@media (max-width: 560px){body[data-ui-project-x="on"] .card{padding: 0;}}')
  contains(scoped, '@keyframes spin{from{opacity: 0}to{opacity: 1}}')
  excludes(scoped, ':root{--a: 1;}')
})

await test('a selector about the root or the body binds to that element, not below it', () => {
  const marker = 'body[data-ui-project-x="on"]'
  const compact = (/** @type {string} */ css) => css.replace(/\s+/g, ' ').trim()

  // The skin's dark branch is written as `body[data-ds-dark-theme]` — the shipped
  // client's own signal. Prefixing it produced `body[marker] body[data-ds-dark-theme]`,
  // "a body inside a body", which matches nothing and left dark mode completely dead.
  // This case exists because that happened.
  equal(
    compact(scopeCss(marker, 'body[data-ds-dark-theme] { --a: 1; }')),
    'body[data-ui-project-x="on"][data-ds-dark-theme]{ --a: 1; }',
    'a body-scoped selector gains the marker as an attribute, not as an ancestor',
  )
  equal(
    compact(scopeCss(marker, 'body { --a: 1; }')),
    'body[data-ui-project-x="on"]{ --a: 1; }',
    'a bare body becomes the marker',
  )
  equal(
    compact(scopeCss(marker, 'html { --a: 1; }')),
    'body[data-ui-project-x="on"]{ --a: 1; }',
    'html is the root, so it becomes the marker',
  )
  // The ordinary case is untouched: a component selector stays a descendant.
  equal(
    compact(scopeCss(marker, '.card { --a: 1; }')),
    'body[data-ui-project-x="on"] .card{ --a: 1; }',
    'a component selector is still a descendant of the marker',
  )
  equal(
    compact(scopeCss(marker, ':where([data-rightbar-col]) > * { --a: 1; }')),
    'body[data-ui-project-x="on"] :where([data-rightbar-col]) > *{ --a: 1; }',
    'a structural selector is still a descendant',
  )
})

await test('a project that throws on apply is rolled back and reported as an error', async () => {
  const harness = await boot()
  harness.registry.register({
    id: 'broken',
    name: 'Broken',
    description: '',
    version: '1.0.0',
    apply() {
      throw new Error('boom')
    },
  })

  // The plugin logs the failure on purpose; keep the suite output readable.
  const realError = console.error
  console.error = () => {}
  try {
    await harness.runtime.enable('broken')
  } finally {
    console.error = realError
  }
  equal(harness.registry.isEnabled('broken'), false, 'not enabled')
  equal(harness.registry.status('broken'), 'error', 'status reported as error')
  contains(harness.registry.error('broken'), 'boom')
  equal(harness.projectMarker('broken'), null, 'no marker left behind')
})

await test('dispose() removes every effect it owns', async () => {
  const harness = await boot()
  await harness.runtime.enable('test-skin')
  harness.runtime.dispose()
  equal(harness.registry.isEnabled('test-skin'), false, 'nothing active after dispose')
  equal(
    harness.dom.styles().length,
    1,
    'the project stylesheet is removed; only the system stylesheet is left',
  )
  excludes(harness.allCss(), '--ts-fill', 'no project CSS left')
  equal(harness.dom.ambient().length, 0, 'ambient removed')
  equal(harness.dom.root.getAttribute('data-ui-projects'), null, 'system marker removed')
})

await test('state persists and survives a reload, in both directions', async () => {
  const storage = createStorage()
  const first = await boot({ withStorage: storage })
  await first.runtime.enable('test-skin')
  equal(first.registry.isEnabled('test-skin'), true, 'enabled before reload')
  equal(
    JSON.stringify(first.runtime.persist.read().enabled),
    '["test-skin"]',
    'the record stores what is on, not what is off',
  )

  // A page refresh: fresh runtime, same storage. Turning a default-off project on
  // must therefore survive it — the bug the record shape exists to prevent.
  const reloaded = await boot({ withStorage: storage })
  await reloaded.runtime.start()
  equal(reloaded.registry.isEnabled('test-skin'), true, 'restored on reload')
  equal(reloaded.projectMarker('test-skin'), 'on', 'marker restored')
  equal(reloaded.dom.ambient().length, 0, 'and it mounts no DOM on reload either')
  truthy(reloaded.stylesContain('--ts-fill'), 'its stylesheet restored')

  const turnedOff = await boot({ withStorage: storage })
  await turnedOff.runtime.start()
  await turnedOff.runtime.disable('test-skin')
  equal(
    JSON.stringify(turnedOff.runtime.persist.read().enabled),
    '[]',
    'turning it off is recorded as an empty active set',
  )

  const third = await boot({ withStorage: storage })
  await third.runtime.start()
  equal(third.registry.isEnabled('test-skin'), false, 'stays off after reload')
  equal(third.projectMarker('test-skin'), null, 'no marker after reload')
})

await test('storage keys from a previous generation are swept on load', async () => {
  /*
   * `dsh-liquid-glass.settings` and `dsh-liquid-glass.settings.version` were written by an
   * earlier generation of this plugin, which kept per-project state in its own localStorage
   * keys. Nothing reads them now — the shared `ui-projects` record owns state — but a stale
   * key that looks authoritative costs a future reader real time, so `persist.js` deletes
   * them the moment it sees them.
   *
   * Asserted rather than assumed, because the sweep is best-effort and silent by design: if
   * it quietly stopped running, nothing else in this suite would notice.
   */
  const storage = createStorage()
  storage.map.set('dsh-liquid-glass.settings', '{"scale":1}')
  storage.map.set('dsh-liquid-glass.settings.version', '3')
  /*
   * The CURRENT key, read from the module that owns it rather than typed here.
   *
   * It used to be typed, and it was typed wrong — `dsh.ui.projects.v1` against a real key of
   * `dsh.ui-projects.v1`, one character apart. So this line asserted the survival of a key the
   * plugin has never read, under a label claiming it was the key the plugin uses. A rename could
   * not have caught it either, because nothing tied the literal to the constant.
   */
  storage.map.set(LOCAL_STORAGE_KEY, '{"kept":true}')

  await boot({ withStorage: storage })

  equal(storage.map.has('dsh-liquid-glass.settings'), false, 'the stale settings key is swept')
  equal(storage.map.has('dsh-liquid-glass.settings.version'), false, 'and so is its version key')
  // The sweep is a list of two names, not "clear everything": the current key must survive.
  equal(storage.map.has(LOCAL_STORAGE_KEY), true, 'while the key this plugin actually uses is untouched')
})

await test('state uses the dsh settings document when the host offers a scope', async () => {
  const harness = await boot({ withSettingsScope: true })
  equal(harness.persistKind, 'settings', 'adapter kind')

  await harness.runtime.enable('test-skin')
  equal(harness.settingsSection()?.touched, true, 'touched recorded')
  equal(harness.settingsSection()?.initialized, true, 'initialized recorded')
  equal(JSON.stringify(harness.settingsSection()?.enabled), '["test-skin"]', 'enabled recorded')

  await harness.runtime.disable('test-skin')
  equal(JSON.stringify(harness.settingsSection()?.enabled), '[]', 'disabled recorded as an empty set')
})

/*
 * Every cold load binds the scope while the settings document is still in flight: ui-settings
 * starts the describe read without awaiting it and publishes the service straight away. Reading
 * the snapshot at that moment returns the EMPTY record, and the empty record means "the user has
 * never chosen anything" — so `start()` restored the shipped defaults, and the skin stayed off
 * even though the document said it was on.
 *
 * The declared inject list is asserted in "the bundle registers one plugin with the two hard
 * dependencies it needs" above; this is the behaviour that declaration buys.
 */
await test('a record that arrives after the bind is still restored', async () => {
  const harness = await boot({
    withSettingsScope: true,
    scopeDelayMs: 20,
    scopeRecord: { v: 1, initialized: true, enabled: ['test-skin'], settings: {}, touched: true },
  })

  equal(harness.persistKind, 'settings', 'the settings document is the backend')
  equal(harness.runtime.persist.readiness, 'ready', 'and the wait settled on a real answer')
  equal(harness.registry.isEnabled('test-skin'), true, 'the stored choice is applied, not the shipped default')
  truthy(harness.projectMarker('test-skin') !== null, 'so the skin is genuinely on')
})

await test('a failed read settles instead of waiting out the deadline', async () => {
  // A failed describe read leaves the status at `idle` and puts the reason in `error`, so a
  // readiness check that only watched `status` would burn the full two seconds on every broken
  // transport. Terminal means terminal.
  const harness = await boot({ withSettingsScope: true, scopeError: 'transport down' })

  equal(harness.runtime.persist.readiness, 'error', 'a snapshot carrying an error is terminal')
  equal(harness.persistKind, 'settings', 'the backend is still the settings document')
  equal(harness.registry.isEnabled('test-skin'), false, 'and the defaults apply rather than a hang')
})

await test('resetAll returns to the shipped default in one step', async () => {
  const harness = await boot()
  await harness.runtime.enable('test-skin')
  await harness.runtime.resetAll()
  equal(harness.registry.isEnabled('test-skin'), false, 'back to its default')
  equal(harness.projectMarker('test-skin'), null, 'no marker')
  equal(harness.dom.styles().length, 1, 'only the system stylesheet remains')
})

await test('the settings section registers once, with a localized label thunk', async () => {
  const harness = await boot()
  const registration = /** @type {any} */ (
    harness.registrations.find((entry) => entry.name === 'settings.section')
  )
  truthy(registration !== undefined, 'settings.section registered')
  equal(registration.id, 'ui', 'section id')
  equal(typeof registration.order, 'number', 'order present')
  equal(typeof registration.label, 'function', 'label is a thunk so a locale change re-renders')
  equal(registration.label(), 'UI', 'label in en')
  equal(typeof plugin.section, 'function', 'the render handler is published for the host')
  equal(plugin.runtime, harness.runtime, 'the live runtime is published')
  truthy(plugin.store !== undefined, 'the panel store is published')
})

await test('the rendered page shows a keyboard-accessible switch per project', async () => {
  const harness = await boot()
  const markup = harness.render()

  contains(markup, 'class="uip-root"')
  contains(markup, 'Test Skin')
  contains(markup, 'role="switch"')
  contains(markup, 'aria-checked="false"')
  contains(markup, 'aria-label="Turn on Test Skin"')
  contains(markup, 'v1.0.0')
  contains(markup, 'Skin')
  contains(markup, 'Restore default UI')
  contains(markup, 'data-status="inactive"')

  await harness.runtime.enable('test-skin')
  const after = harness.render()
  contains(after, 'aria-checked="true"')
  contains(after, 'aria-label="Turn off Test Skin"')
  contains(after, 'data-status="active"')
})

await test('a second project appears with no change to the settings page', async () => {
  const harness = await boot()
  harness.registry.register({
    id: 'demo-enhancement',
    name: 'Demo Enhancement',
    description: 'Registered only through the registry.',
    version: '2.3.4',
    type: 'enhancement',
  })
  const markup = harness.render()
  contains(markup, 'Demo Enhancement')
  contains(markup, 'Registered only through the registry.')
  contains(markup, 'v2.3.4')
  contains(markup, 'Enhancement')
})

await test('the entry module loads without touching React or a project', () => {
  // The contract the real loader enforces, and the one a Node test is most prone
  // to miss: the shell materializes the entry module BEFORE calling `apply`, with
  // a `require` that answers only its frozen module table. Importing React or a
  // project at load time is a module-table miss that takes the whole plugin down —
  // which is exactly what the first browser run of this package hit.
  const requested = []
  const strict = (/** @type {string} */ id) => {
    requested.push(id)
    throw new Error(`module-table miss: the shell exposes no "${id}"`)
  }
  const { entry: probe } = materializeEntry(bundleSource, strict)
  equal(requested, [], 'the entry module requests nothing from the shell at load time')
  equal(typeof probe.apply, 'function', 'it still exports a usable plugin')
  equal(probe.inject, ['slots', 'settingsScope'], 'and still declares its service dependencies')
})

await test('the project modules register only once the settings slot is declared', async () => {
  const requested = []
  /** The shell's frozen table: React and nothing else. */
  const shellTable = (/** @type {string} */ id) => {
    requested.push(id)
    if (id === 'react') return react
    throw new Error(`module-table miss: the shell exposes no "${id}"`)
  }
  const { entry: probe, globals } = materializeEntry(bundleSource, shellTable)
  equal(requested, [], 'nothing is requested at load time')

  // `apply` writes markers and a stylesheet immediately, so the fake browser globals
  // must be in place first — the bundle reads them as globals, not as imports.
  const dom = createFakeDom()
  globals.document = dom.document
  globals.window.localStorage = createStorage()

  /** @type {Array<() => any>} */
  const injections = []
  /** Services provided through this stub context, by name. */
  const provided = new Map()
  /** @type {any} */
  let registeredSection
  const ctx = {
    get: (/** @type {string} */ name) =>
      name === 'slots'
        ? {
            inject: (/** @type {string} */ key, /** @type {() => any} */ callback) => {
              void key
              injections.push(callback)
              return () => {}
            },
            register: (/** @type {any} */ options) => {
              registeredSection = options
              return () => {}
            },
          }
        : name === 'remote'
          ? { $on: () => () => {} }
          : undefined,
    // Honour the requested dependency names rather than assuming one, so a fake
    // context stays faithful if the plugin's `ctx.inject` calls change.
    inject: (/** @type {string[]} */ names, /** @type {(scoped: any) => any} */ callback) =>
      names.includes('remote') ? callback(ctx) : () => {},
    on: () => () => {},
    /*
     * The registration surface the client half now provides. Modelled rather than ignored because
     * a context without it takes the whole plugin down: `apply` calls `ctx.provide` before it does
     * anything else, so this stub is what keeps this probe faithful.
     */
    provide: (/** @type {string} */ name, /** @type {unknown} */ value) => {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    effect: (/** @type {() => any} */ callback) => {
      const result = callback()
      return typeof result === 'function' ? result : () => {}
    },
  }

  try {
    probe.apply(ctx)
    /*
     * `apply` starts the runtime asynchronously, and this probe's context cannot hand the
     * settlement back — its `effect` returns the disposer, not the promise. So wait on the
     * plugin's own `ready()`, exactly as `boot()` does.
     *
     * Without this the read inside `start()` landed AFTER the `finally` below had already cleared
     * `globals.window.localStorage`, and the localStorage adapter reported — correctly, and
     * confusingly — that it could not read a storage that no longer existed. A green suite that
     * prints an unexplained error is how real failures get ignored later.
     */
    await probe.ready()
    // One settings section: the UI project manager. It waits for the slot
    // declaration, so it does not register before the slot exists.
    equal(injections.length, 2, 'both settings sections wait for the slot declaration: the projects page and the plugins page')
    /*
     * The registration surface, and the one thing it can say about the host plane.
     *
     * This probe runs with `window` present and `window.__dshUiProjectRows` absent — which is
     * exactly the shape of a page served without any UI project package's host half. The service
     * must report that as `absent` rather than as an error, because it is a valid composition and
     * the panel's job is to say so on the card, not to refuse to render.
     */
    const service = provided.get('uiProjects')
    equal(typeof service?.register, 'function', 'the client half provides the uiProjects registration service')
    const diagnosis = service.diagnostics()
    equal(diagnosis.hostPlane, 'absent', 'with no host announcement the host plane is reported as absent, not as a failure')
    equal(Array.isArray(diagnosis.projects), true, 'the diagnosis lists the projects it covers')
    /*
     * NO PROJECT IS REGISTERED BY THE FRAMEWORK ITSELF, and this probe is where that became visible.
     *
     * Until 8b this package registered its own skin straight into the registry
     * (`installBuiltInProjects`) — the one registration that skipped the service, because a package
     * cannot hand itself a manifest it does not have. Step 8c deleted that call for good, so what
     * appears in a registry appears because a PACKAGE registered it: the fixture `boot()` mounts goes
     * through `ctx.uiProjects.register`, and the test above this one asserts exactly that path. A
     * custom context with no package in it therefore has an empty registry, which is the honest
     * assertion rather than a gap — and the two below it are the same claim from both directions.
     */
    equal(diagnosis.projects.length, 0, 'no project is service-registered until a package registers one')
    equal(registeredSection, undefined, 'and it does not register before the slot exists')

    injections[0]()
    truthy(registeredSection !== undefined, 'the section registers once the slot exists')
    equal(registeredSection.id, 'ui', 'section id')
    equal(typeof registeredSection.label, 'function', 'localized label thunk')
    /*
     * ZERO, and it used to be one. This is the assertion that would have caught the framework
     * quietly keeping a built-in project: a composition with no UI project package in it must have
     * an empty registry, because the framework has nothing of its own to put there. `registering a
     * settings section` used to be the moment the shipped skin was (re-)installed — the ordering
     * hazard `src/client/index.js` documents at length — so the count is read here, after that
     * callback has run, rather than only at load.
     */
    equal(
      probe.registry.ids().length,
      0,
      'a package-less composition has an empty registry: this package registers no project of its own',
    )

    // The retired reminders section used to be a second registration here, with
    // its own id, label, and `probe.reminders` handle. Nothing replaced it: the
    // UI project manager is the plugin's only settings section, which is what
    // `injections.length` above now pins.

    // React is reached when the panel renders, never while the plugin loads.
    const element = react.createElement(probe.section)
    equal(typeof element, 'object', 'the section render handler produces an element')
    equal(
      requested.filter((id) => id !== 'react'),
      [],
      `only React was ever requested, got: ${requested.join(', ')}`,
    )
  } finally {
    globals.document = undefined
    globals.window.localStorage = undefined
  }
})

await test('the section label follows the real locale snapshot shape', async () => {
  // The locale service publishes `{ active, locales, revision }`. Reading `locale`,
  // `id` or `current` finds nothing, falls back to English, and leaves the whole
  // section untranslated in a Chinese client — which is exactly what happened. This
  // asserts against the real shape rather than a convenient one.
  const harness = await boot()
  harness.ctx.provide('locale', { getSnapshot: () => ({ active: 'zh', locales: ['zh', 'en'], revision: 3 }) })
  equal(detectLocale(harness.ctx), 'zh', 'the active locale is read from `active`')
  equal(strings(detectLocale(harness.ctx)).sectionLabel, '界面', 'and the zh section label is used')
  equal(strings(detectLocale(harness.ctx)).resetAll, '恢复默认界面', 'as is the rest of the copy')

  // A plain string snapshot, and a composition with no locale service at all.
  harness.ctx.provide('locale', { getSnapshot: () => 'en' })
  equal(detectLocale(harness.ctx), 'en', 'a plain string snapshot is accepted')
  const bare = await boot()
  equal(detectLocale(bare.ctx), 'en', 'a composition with no locale service falls back to English')
})

await test('both languages carry exactly the same copy', async () => {
  /*
   * Key parity, which nothing asserted until a key was added to one language and not the other.
   *
   * The failure mode is silent and one-sided: a missing key in `zh` renders `undefined` — or, if the
   * panel falls back, an English sentence inside a Chinese interface — while every assertion written
   * against the English copy keeps passing. This compares the two structures key by key, including
   * the nested groups (`tests`, `badges`, `scopes`), because the nested ones are where a new string
   * actually gets added.
   */
  const shapes = {
    zh: strings('zh'),
    en: strings('en'),
  }
  /** @param {unknown} value @param {string} at @returns {string[]} */
  const paths = (value, at) => {
    if (value === null || typeof value !== 'object') return [at]
    return Object.keys(value).flatMap((key) => paths(value[key], `${at}.${key}`))
  }
  const zhPaths = paths(shapes.zh, 'zh')
  const enPaths = paths(shapes.en, 'en').map((path) => path.replace(/^en/, 'zh'))
  const missingInZh = enPaths.filter((path) => !zhPaths.includes(path))
  const missingInEn = zhPaths.filter((path) => !enPaths.includes(path))
  equal(JSON.stringify(missingInZh), '[]', `copy that exists in en but not in zh`)
  equal(JSON.stringify(missingInEn), '[]', `copy that exists in zh but not in en`)
  // And the new key is really in both, so the comparison above is not vacuous.
  equal(shapes.zh.tests.withdraw, '撤回确认', 'the withdrawal label is translated')
  equal(shapes.en.tests.withdraw, 'Withdraw confirmation', 'and it exists in English too')
})

await test('materialising the entry never touches an internal module, exactly as the loader does', () => {
  /*
   * The sharpest load-time contract, and the one a browser enforces: the shell materializes
   * the entry module with a `require` that answers ONLY its frozen table. A module graph
   * resolves its own imports, so the bundle's internal requests never reach that table — but
   * a load-time side effect that walks the graph eagerly, or a circular import, surfaces here
   * as a thrown exception rather than as a page stuck on "Loading plugins…".
   *
   * Deliberately stricter than the other load-time cases: the table answers React ONLY, so
   * anything else the entry reaches for at load time is a failure.
   */
  const requested = []
  const strict = (/** @type {string} */ id) => {
    requested.push(id)
    if (id === 'react') return react
    throw new Error(`module-table miss: the shell exposes no "${id}"`)
  }
  /** @type {any} */
  let entry
  try {
    entry = materializeEntry(bundleSource, strict).entry
  } catch (err) {
    throw new Error(`the entry module threw while loading: ${err instanceof Error ? err.message : String(err)}`)
  }
  equal(requested.filter((id) => id !== 'react'), [], 'nothing outside React was requested at load time')
  equal(typeof entry.apply, 'function', 'and the plugin exports an apply')
})

/**
 * The frost predicate, as a function so the rule can be tested in BOTH directions.
 *
 * A `backdrop-filter` on a CONTAINER blurs every surface inside it at once. That is what made an earlier
 * version of this skin unreadable: the frame's whole-viewport floating layer (`[data-shell-overlay]`,
 * measured 1414×800) and every direct child of the frame were blurred, so the conversation was softened
 * along with everything else. Frost belongs on the columns and on floating panels — the surfaces.
 * @param {string} css
 */
const frostViolations = (css) => {
  const blurSelectors = [...String(css).matchAll(/(^|\})\s*([^{}@]+)\{[^{}]*backdrop-filter[^{}]*\}/g)]
    .map((match) => match[2].trim())
    .filter((selector) => selector.length > 0)
  const violations = []
  for (const selector of blurSelectors) {
    if (selector.includes('data-shell-overlay')) violations.push(`a container: ${selector}`)
    else if (selector.includes('body') && !selector.includes('data-ui-project')) violations.push(`the document body: ${selector}`)
  }
  return { blurSelectors, violations }
}

await test('the frost goes on surfaces, never on a container of them', async () => {
  /*
   * THE SKIN AUTHOR'S RULE, KEPT IN THE FRAMEWORK — and pointing at the fixture.
   *
   * It used to read Liquid Glass's own stylesheet; it stays here, in step 8b, because the rule is not about
   * that skin: any skin that blurs a container blurs everything inside it, and the failure reads as "the
   * interface went soft" rather than as "a selector was too broad". What changed is the subject — the
   * framework's own `test-skin` — and what is new is the second half.
   *
   * TWO-SIDED ON PURPOSE. A rule checker run only against a stylesheet that obeys it proves that the
   * checker RUNS, not that it REFUSES; the three cases below are the shapes the rule exists to catch, and
   * each is named so a failure says which one got through.
   */
  const harness = await boot()
  await harness.runtime.enable('test-skin')
  const { blurSelectors, violations } = frostViolations(harness.allCss())

  truthy(blurSelectors.length > 0, 'the fixture does apply refraction somewhere, so this rule has a subject')
  equal(violations, [], 'and it obeys the rule')
  truthy(
    blurSelectors.some((selector) => selector.includes('data-ui-skin-column')),
    `the columns carry the frost, which is the direction the rule allows (found: ${JSON.stringify(blurSelectors.slice(0, 4))})`,
  )

  const marker = 'body[data-ui-project-test-skin="on"]'
  const broken = [
    ['the frame-wide floating container', `${marker} [data-shell-overlay]{ backdrop-filter: blur(20px) }`],
    ['the document body', `body{ backdrop-filter: blur(20px) }`],
    ['a container reached through the marker', `${marker} [data-shell-overlay]::before{ backdrop-filter: blur(20px) }`],
  ]
  for (const [label, source] of broken) {
    equal(frostViolations(source).violations.length, 1, `a blur on ${label} is caught`)
  }

  /*
   * The seam the frost is aimed by is STAMPED BY THE RUNTIME, not guessed by a structural selector — the
   * guess failed silently twice in this package. The retry machinery has its own three tests; what this
   * one adds is the property the frost rule depends on: the columns it selects are marked while the
   * project is on, nothing else is, and the marks go when the project does.
   */
  const harnessWithFrame = await boot()
  await harnessWithFrame.runtime.enable('test-skin')
  const markedCount = () =>
    harnessWithFrame.dom.document.body.querySelectorAll('div').filter((el) => el.hasAttribute('data-ui-skin-column')).length
  // The marking retries on a timer, because at `apply` time the shell has not mounted the application yet
  // and there is no frame to find. So the test waits for it, exactly as the browser does — the assertion
  // is about the outcome, not the latency.
  for (let attempt = 0; attempt < 40 && markedCount() < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  equal(markedCount(), 3, 'exactly the frame’s three columns were marked')
  // And it marked ONLY columns: not the frame-wide overlay, which is a container.
  const markedEls = harnessWithFrame.dom.document.body
    .querySelectorAll('div')
    .filter((el) => el.hasAttribute('data-ui-skin-column'))
  equal(
    markedEls.filter((el) => el.hasAttribute('data-test-overlay')).length,
    0,
    'the overlay container and the resize handle were left unmarked',
  )
  await harnessWithFrame.runtime.disable('test-skin')
  equal(markedCount(), 0, 'and the marks go when the project does')
})

await test('every inserted stylesheet is owned and removable', async () => {
  const harness = await boot()
  equal(
    harness.dom.styles().length,
    1,
    'exactly the system stylesheet before any project is on',
  )
  await harness.runtime.enable('test-skin')
  equal(harness.dom.styles().length, 2, 'system + the fixture’s one stylesheet')
  for (const style of harness.dom.styles()) truthy(String(style.id).length > 0, 'style element carries an id')
  harness.runtime.dispose()
  equal(
    harness.dom.styles().length,
    1,
    'the project stylesheets are gone; only the system stylesheet remains (the plugin is still mounted)',
  )
})

await test('a project can declare a control, and the page renders it without knowing what it does', async () => {
  /*
   * The mechanism outlives the feature. Test Skin used to declare an opacity slider and no
   * longer does — the material has one fixed look — but "a project may declare controls and the
   * settings page renders them without knowing what any of them mean" is the extensibility
   * promise this package exists to keep. So the control is exercised through a purpose-built
   * project here, which is also a better test: it belongs to the harness rather than to a skin
   * that might change its mind again.
   */
  const harness = await boot()
  harness.registry.register({
    id: 'with-a-control',
    name: 'Has a control',
    description: 'Declares one slider and nothing else.',
    version: '1.0.0',
    type: 'enhancement',
    scope: 'global',
    supports: [],
    defaultEnabled: false,
    controls: [
      {
        id: 'wobble',
        type: 'slider',
        labelKey: 'opacity',
        min: 0,
        max: 10,
        step: 1,
        defaultValue: 4,
        storageKey: 'wobble',
      },
    ],
    apply: () => {},
  })
  await harness.runtime.enable('with-a-control')

  const markup = harness.render()
  contains(markup, 'data-control="wobble"')
  contains(markup, 'type="range"')
  // The label comes from the shared control copy, keyed by the control's own `labelKey`.
  contains(markup, 'aria-label=')
  // The value is the control's own declared default, since nothing is stored yet.
  contains(markup, 'value="4"')

  // A project that declares no controls renders none — the card is not obliged to have any.
  await harness.runtime.enable('test-skin')
  excludes(harness.render(), 'data-control="opacity"', 'the skin no longer declares a control')
})

await test('the slider mirrors the switch exactly', async () => {
  const harness = await boot()
  await harness.runtime.enable('test-skin')
  const css = harness.allCss()
  /** @param {string} needle */
  const rule = (needle) => {
    const at = css.indexOf(needle)
    if (at < 0) return ''
    const open = css.indexOf('{', at)
    const close = css.indexOf('}', open)
    return open < 0 || close < 0 ? '' : css.slice(open + 1, close)
  }

  // The two controls sit on the same card and mean the same kind of thing, so the slider's
  // geometry and colour are asserted against the switch's OWN declarations rather than
  // against literals: if the switch is restyled, this test follows it.
  const switchRule = rule('.uip-switch{') || rule('.uip-switch {')
  const knobRule = rule('.uip-knob{') || rule('.uip-knob {')
  const trackRule = rule('::-webkit-slider-runnable-track')
  const thumbRule = rule('::-webkit-slider-thumb')

  truthy(trackRule.length > 0, 'the slider has a track rule')
  truthy(thumbRule.length > 0, 'the slider has a thumb rule')

  // Track: the switch's own height, border and rounding, and the same background tier.
  contains(trackRule, 'height: 24px', "the track uses the switch's height")
  contains(switchRule, 'height: 24px', "and that is in fact the switch's height")
  contains(trackRule, 'border: 1px solid var(--dsw-alias-border-l2)', "the track uses the switch's border")
  contains(switchRule, 'border: 1px solid var(--dsw-alias-border-l2)', "and that is the switch's border")
  contains(trackRule, 'border-radius: 999px', "the track uses the switch's rounding")
  contains(switchRule, 'border-radius: 999px', 'and that is the switch rounding')
  contains(trackRule, 'background: var(--dsw-alias-bg-layer-2)', "the track uses the switch's fill tier")
  contains(switchRule, 'background: var(--dsw-alias-bg-layer-2)', 'and that is the switch fill')

  // Thumb: literally the switch's knob — same size, fill and shadow.
  for (const declaration of [
    'width: 18px',
    'height: 18px',
    'border-radius: 50%',
    'background: var(--dsw-alias-bg-overlay)',
    'box-shadow: 0 1px 2px rgb(15 23 42 / 30%)',
  ]) {
    contains(thumbRule, declaration, `the thumb matches the switch knob (${declaration})`)
    contains(knobRule, declaration, `and the switch knob really declares it (${declaration})`)
  }
})

await test('marking the columns survives the application not being mounted yet', async () => {
  /*
   * The case that fails in a real browser and nowhere else.
   *
   * A project is applied while the shell is still booting, so the frame either does not exist
   * yet or exists with zero-area children that a filter for "actually occupies the grid"
   * rejects. Both are transient, and both look exactly like success to a one-shot lookup.
   *
   * So: boot with the frame DETACHED, enable the project, and only afterwards let the frame
   * appear. Marking must still happen — driven by the DOM-change observer, not by luck of
   * timing.
   */
  const harness = await boot({ detachedFrame: true })
  await harness.runtime.enable('test-skin')

  const markedCount = () =>
    harness.dom.document.body.querySelectorAll('div').filter((el) => el.hasAttribute('data-ui-skin-column')).length
  equal(markedCount(), 0, 'nothing is marked while there is no frame to mark')

  // The shell mounts the application: this is the mutation the runtime waits for.
  harness.dom.mountFrame()
  FakeMutationObserver.flushAll()

  equal(markedCount(), 3, 'the columns are marked as soon as the frame appears')
  const state = harness.runtime.markingState.get('test-skin')
  truthy(
    typeof state?.note === 'string' && /marked/.test(state.note),
    `the diagnostic records that it succeeded (${JSON.stringify(state)})`,
  )

  await harness.runtime.disable('test-skin')
  equal(markedCount(), 0, 'and a disable still unmarks them')
})

/*
 * The retry that bridges "the project was applied" and "the shell mounted the application" used
 * to run for the life of the session — four times a second, for every active project, whether or
 * not there was anything left to find. No test could see that: the loop was driven by wall-clock
 * time, so the only way to observe it was to load a real page and watch. That is why the loop is
 * now driven by the sandbox's timers in these two tests, and why the two halves of the contract
 * are asserted separately — the interval must stop, and the observer must not.
 */
await test('the column-marking retry stops once it succeeds, and the observer repairs a re-render', async () => {
  const harness = await boot({ detachedFrame: true, fakeTimers: true })
  await harness.runtime.enable('test-skin')

  const marked = () =>
    harness.dom.document.body.querySelectorAll('div').filter((el) => el.hasAttribute('data-ui-skin-column'))
  equal(marked().length, 0, 'nothing is marked while there is no frame')
  equal(
    harness.timers.runningPeriods.join(','),
    '500,250',
    'two loops run: the boot-page watch from plugin load, and the marking retry from enable',
  )

  // The shell mounts the application: the mutation the observer waits for.
  harness.dom.mountFrame()
  FakeMutationObserver.flushAll()

  equal(marked().length, 3, 'the columns are marked as soon as the frame appears')
  equal(
    harness.timers.runningPeriods.join(','),
    '500',
    'and ONLY the boot-page watch is left — the 250ms poll is gone for the rest of the session',
  )
  equal(harness.timers.pendingTimeouts, 1, 'the marking deadline went with it; one deadline remains')

  /*
   * A re-render replaces the frame's children with new elements that carry no attribute. This is
   * the report the observer exists for (marking seen working, then absent, with no toggle in
   * between), and it has to keep working with no timer running at all.
   */
  const frame = harness.dom.frame()
  for (const child of [...frame.children]) frame.removeChild(child)
  const replacement = [createElement('div'), createElement('div'), createElement('div')]
  for (const column of replacement) frame.appendChild(column)
  FakeMutationObserver.flushAll()

  equal(marked().length, 3, 'the new columns are marked too')
  equal(
    replacement.filter((column) => column.hasAttribute('data-ui-skin-column')).length,
    3,
    'the attributes sit on the NEW elements, not left behind on detached ones',
  )
  equal(
    harness.timers.runningPeriods.join(','),
    '500',
    "and that repair needed no timer at all: it is the observer's job",
  )

  await harness.runtime.disable('test-skin')
  equal(marked().length, 0, 'a disable still unmarks them')
})

await test('a retry that never succeeds stops at its deadline, and leaves the observer connected', async () => {
  const harness = await boot({ detachedFrame: true, fakeTimers: true })
  await harness.runtime.enable('test-skin')

  equal(
    harness.timers.runningPeriods.join(','),
    '500,250',
    'both bounded loops are running: the boot-page watch and the marking retry',
  )

  // Five seconds pass and no frame ever appears.
  harness.timers.tickIntervals()
  harness.timers.tickIntervals()
  harness.timers.fireTimeouts()

  equal(
    harness.timers.pendingIntervals,
    0,
    'both deadlines clear their intervals, so NEITHER loop can poll forever',
  )
  const state = harness.runtime.markingState.get('test-skin')
  equal(state.timedOut, true, 'giving up is recorded where the diagnostics overlay reads it')
  truthy(/stopped retrying/.test(String(state.note)), `the note carries the reason (${String(state.note)})`)
  // `ctx.fail()` would deactivate the project while its stylesheet stayed inserted, so the
  // deadline deliberately does not call it. The registry must therefore still say "on".
  equal(
    harness.runtime.registry.isEnabled('test-skin'),
    true,
    'and the project is NOT deactivated — a timer giving up is not the project failing',
  )

  // The frame turns up after the deadline: the observer was left connected on purpose.
  harness.dom.mountFrame()
  FakeMutationObserver.flushAll()
  const marked = harness.dom.document.body.querySelectorAll('div').filter((el) => el.hasAttribute('data-ui-skin-column'))
  equal(marked.length, 3, 'a frame that arrives late is still marked')
  equal(harness.timers.pendingIntervals, 0, 'and still without restarting the poll')
})

/*
 * RETIRED — "the emitted selectors actually match the elements they are meant to hide".
 *
 * That test built the cost-meter's dock row (`.cm-root`) and the composer's stats marker in
 * the DOM, then executed the skin's emitted selectors against them with a real matcher, to
 * prove the hiding rule reached the elements rather than merely existing.
 *
 * The rule it guarded is gone, and its removal is a deliberate loss of behaviour:
 *
 *   CSS:        body [data-composer-stats], body .cm-root { display: none }
 *   Behaviour:  the composer's token row and the session total were hidden while the skin
 *               was on — at the user's request.
 *   Removed by: v3's rule that the skin carries no `display` declaration. `display` is a
 *               layout property, and setting it on another package's elements is the same
 *               class of coupling as the hash-class and `!important` overrides that broke
 *               this skin twice. It is not the frost bug, but it is the same shape.
 *
 * So the rows are visible again while Test Skin is on. Nothing else about the skin depends
 * on them, and the two elements belong to `dsh-cost-meter` rather than to dsh.
 *
 * CORRECTION — that last paragraph described the state on the day it was written and stopped
 * being true shortly afterwards. The user asked for the hiding back, so the rule returned as an
 * explicit exception with its own rule and comment, which is exactly the form this note asked
 * for: see "the composer stat rows are hidden, and without moving the composer" below, which
 * pins the current rule (`visibility: hidden`). Read that test for what the skin does NOW; read
 * this note for why the original rule was withdrawn.
 *
 * If the hiding is wanted back it should return as an explicit, separately-reviewed exception
 * with its own rule and comment — not folded quietly into a skin's stylesheet, and not
 * re-added without this note being deleted on purpose.
 */

await test('the composer hooks and the ring token still exist in the installed client', async () => {
  /*
   * Two anti-rot checks, because both halves of this feature are borrowed from the shipped client
   * rather than owned by this package.
   *
   * The hooks: a `data-` attribute is a contract with somebody else's markup, and nothing in this
   * repository would notice if the composer were rewritten without them — the rules would simply
   * stop matching, and the composer would quietly go back to being opaque.
   *
   * The ring: `--dsw-elevation-stroke` is composed into the card's shadow. It is declared by the
   * installed design system today. `every value the skin reads is one the skin or the design system
   * declares` already fails on a dangling reference in general; this states the specific dependency,
   * because a vanished ring is invisible in review and in a screenshot.
   */
  const shipped = await shippedDesignTokens()
  for (const token of ['--dsw-elevation-stroke', '--dsw-elevation-stroke-color', '--dsw-alias-border-l2']) {
    truthy(shipped.has(token), `the installed client declares ${token}`)
  }

  const { readFile } = await import('node:fs/promises')
  const install = join(
    process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'),
    'npm-cache',
    '_npx',
    '1e7f6d9597241db0',
    'node_modules',
    '@deepseek-ai',
  )
  const conversation = await readFile(join(install, 'dsh-client-ui-conversation', 'lib', 'client.js'), 'utf8')
  const chat = await readFile(join(install, 'dsh-client-ui-chat', 'lib', 'client.js'), 'utf8')
  contains(conversation, 'data-composer-card', 'the shipped conversation client still renders the card hook')
  contains(conversation, 'data-composer-seat', 'and the seat hook')
  // The seat is the shell's own layout reference too, in a different package — a second reason the
  // hook is stable rather than incidental.
  contains(chat, '[data-composer-seat]', 'and the chat client still queries the seat')
})

await test('the scoper refuses to emit a doubled project marker', async () => {
  /*
   * The bug this catches, in full.
   *
   * A rule was written as `body[data-ui-project-test-skin='on'] .VOzbGW_panel` — the marker
   * spelled out by hand, which is allowed. The scoper leaves a selector containing the marker
   * alone, but this one did not match the runtime's marker exactly (single quotes against double),
   * so it was scoped a second time into:
   *
   *     body[data-ui-project-test-skin="on"][data-ui-project-test-skin='on'] .VOzbGW_panel
   *
   * The same attribute twice on one compound. That matches nothing, on any page, forever — and it
   * reads as perfectly reasonable CSS. The guard makes the next occurrence a thrown error instead
   * of a rule that silently does nothing for several rounds.
   */
  const marker = 'body[data-ui-project-x="on"]'
  let threw = false
  try {
    scopeCss(marker, "body[data-ui-project-x='on'] .thing { color: red }")
  } catch (err) {
    threw = true
    truthy(
      String(err).includes('twice'),
      `the failure explains itself (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  truthy(threw, 'a selector that would carry the marker twice is refused')

  // The legitimate forms still work, and are scoped exactly once.
  const plain = scopeCss(marker, 'body .thing { color: red }')
  equal((plain.match(/data-ui-project-x/g) ?? []).length, 1, 'a plain `body …` is scoped once')
  const explicit = scopeCss(marker, `${marker} .thing { color: red }`)
  equal((explicit.match(/data-ui-project-x/g) ?? []).length, 1, 'an exact marker is left alone')

  // And no emitted rule in the shipped sheet carries the marker twice.
  const harness = await boot()
  await harness.runtime.enable('test-skin')
  const doubled = /\[data-ui-project-[a-z0-9-]+[^\]]*\][^\s>+~]*\[data-ui-project-/.exec(harness.allCss())
  equal(doubled, null, 'the shipped sheet contains no doubled marker')
})

/**
 * The hash-shape predicate, as a function so the rule can be tested in BOTH directions.
 *
 * A CSS-module hash reads like `.Ab3xY_panel`: alphanumerics, an underscore, more alphanumerics. This
 * project's own vocabulary (`.lg-glass`) and the runtime's markers (`[data-ui-skin-column]`) contain no
 * underscore, which is what makes the pattern precise rather than a hopeful grep.
 */
const hashShapedClasses = (css) => [...String(css).matchAll(/\.[A-Za-z0-9]{3,}_[A-Za-z0-9]+/g)].map((match) => match[0])

await test('the skin names no CSS-module hash, and reaches shipped surfaces by role', async () => {
  /*
   * This test used to assert the OPPOSITE: that `.VOzbGW_panel` still existed in the installed client, and
   * that the skin's stylesheet named it. That guard made binding to a build-hashed class survivable — it
   * turned "the hash changed" from a silent regression into a failing test. The binding is gone, so the old
   * guard has no subject; what remains worth guarding is the reverse risk, because a frontend rebuild
   * renames a hashed class, every rule referencing it stops matching, and nothing reports a problem.
   *
   * IT STAYS IN THE FRAMEWORK, and points at the fixture, because it is a rule for SKIN AUTHORS rather than
   * a fact about one skin — the same reason the frost rule above stays. And it is two-sided for the same
   * reason there: a checker that has only ever seen a stylesheet that obeys it has not been shown to
   * refuse anything.
   */
  const harness = await boot()
  await harness.runtime.enable('test-skin')
  const css = String(harness.allCss())

  equal(
    hashShapedClasses(css),
    [],
    `no build-hashed class appears in the emitted CSS (found: ${JSON.stringify([...new Set(hashShapedClasses(css))].slice(0, 6))})`,
  )
  contains(css, 'role=', 'and shipped floating surfaces are reached by ARIA role')
  equal(/\bdialog\b/.test(css), true, 'dialog included')

  // The rule refuses a hash — on its own, and mixed into a stylesheet that is otherwise clean.
  equal(hashShapedClasses('.Ab3xY_panel{ color: red }'), ['.Ab3xY_panel'], 'a hash-shaped class is caught')
  equal(
    hashShapedClasses(`${css}\n.VOzbGW_dialog{ color: red }`).length,
    1,
    'and it is still caught when the rest of the sheet is healthy',
  )
})

await test('a settings record left over from the removed opacity slider is harmless', async () => {
  /*
   * Users of an earlier version have `{opacity: 0}` — and a scale revision — sitting in their
   * stored settings. The feature that read those keys is gone, so the only requirement is that
   * stale keys change nothing: the material must come out identical whether or not they are
   * present.
   *
   * That is worth asserting rather than assuming. The stored opacity of 0 is exactly what made a
   * previous round look like the skin had stopped working, so "a leftover 0 can no longer reach
   * the material" is the property that retires the bug for good.
   */
  /** A localStorage holding one settings record, in the shape `persist.js` writes. */
  const storageWith = (settings) => {
    const storage = createStorage()
    storage.setItem(
      'dsh.ui-projects.v1',
      JSON.stringify({ v: 1, initialized: true, enabled: ['test-skin'], settings, touched: true }),
    )
    return storage
  }

  const leftovers = await boot({
    withStorage: storageWith({ 'test-skin': { opacity: 0, opacityScale: 1 } }),
  })
  await leftovers.runtime.enable('test-skin')
  // Read everything from the first harness BEFORE booting the second: `boot()` tears the previous
  // instance down, so a harness held across another boot has had its stylesheets removed — which
  // is what made this comparison read 0 against 26293 and look like a product bug.
  const leftoverCss = leftovers.allCss()
  const leftoverStyle = leftovers.dom.document.body.style.getPropertyValue('--lg-material-swap')

  const clean = await boot()
  await clean.runtime.enable('test-skin')

  truthy(leftoverCss.length > 0, 'the leftover record still produces a stylesheet')
  equal(
    leftoverCss.length,
    clean.allCss().length,
    'and it is identical to the one a fresh record produces',
  )
  equal(leftoverStyle, '', 'the leftover opacity never reaches the document')
})

await test('a scanner never emits a selector that cannot match', async () => {
  /*
   * Two scoper bugs, both of which made a rule silently dead or silently global while looking
   * perfectly reasonable in the source:
   *
   *   1. `:where(html)` / `:where(body)` hid the compound from the binding decision, so they
   *      became `body[marker] :where(body)` — a body INSIDE a body, which matches nothing on
   *      any page. `overflow: clip` was written that way and never applied.
   *   2. A functional pseudo-class takes a selector LIST, and only the first branch was scoped:
   *      `:where([role='dialog'], [role='menu'])` became a rule whose second branch was
   *      `[role='menu']` — unscoped, so a rule meant for menus applied to the whole document.
   *
   * Both are asserted as properties rather than as strings, so a future rewrite of the scoper
   * keeps passing as long as it is correct.
   */
  const marker = 'body[data-ui-project-x="on"]'
  /** Every compound in the output must carry the marker, and none may ask for a body in a body. */
  const assertScoped = (/** @type {string} */ input) => {
    const out = scopeCss(marker, `${input} { color: red }`)
    excludes(out, `${marker} ${marker}`, `no doubled marker from ${input}`)
    excludes(out, `${marker} :where(body)`, `no body-inside-body from ${input}`)
    excludes(out, `${marker} :where(html)`, `no html-inside-body from ${input}`)
    // Every branch of every `:where(...)` must mention the marker.
    for (const list of String(out).matchAll(/:where\(([^)]*)\)/g)) {
      for (const branch of list[1].split(',')) {
        truthy(branch.includes(marker), `every :where branch carries the marker (${input} → ${branch.trim()})`)
      }
    }
    return out
  }

  contains(assertScoped(':where(html), :where(body)'), `:where(${marker})`)
  const dialogList = assertScoped(":where([role='dialog'], [role='menu'], [role='listbox'])")
  contains(dialogList, `[role='dialog']`)
  contains(dialogList, `[role='menu']`)
  contains(dialogList, `[role='listbox']`)
  assertScoped(':where([data-composer-stats]), :where(.probe)')
  assertScoped('body[data-ds-dark-theme]')
  assertScoped(':where(.uip-panel)')

  // And the shipped sheet itself must contain no rule of the impossible kind: the two bug
  // shapes are checked against what the skin actually emits, not only against examples.
  const harness = await boot()
  await harness.runtime.enable('test-skin')
  const css = harness.allCss()
  excludes(css, `] :where(body)`, 'the shipped sheet has no body-inside-body selector')
  excludes(css, `] :where(html)`, 'and no html-inside-body selector')
  // v3 has no `:where(body)` rule: the `overflow: clip` this assertion guarded is gone,
  // because `overflow` is a layout property. What remains is a plain `body` selector for the
  // system background, which the scoper binds directly to the marker — the form that cannot
  // produce a body-inside-body.
  contains(css, 'body[data-ui-project-test-skin="on"]', 'the sheet binds its body rules to the marker')
})

await test('the boot page is dismissed once it is genuinely in the way', async () => {
  /*
   * The shipped frontend ends with `new Boot(document.getElementById("root")).run()`, which
   * mounts the application but never removes the page it built. Both are `height: 100%`
   * children of `#root`, so once the app is up the container's content is about twice the
   * viewport: the page scrolls to a second screen and the application's own layout is measured
   * against a box twice the size of the window.
   *
   * The removal must be conditional, though. During boot the page is the ONLY child and must be
   * left alone — so a slow boot is never affected, and the check is the container overflowing,
   * not the page merely existing.
   */
  const harness = await boot()
  const bootElement = createElement('div')
  bootElement.setAttribute('data-dsh-boot', '')
  const root = harness.dom.body.children[0]
  root.insertBefore(bootElement, root.children[0])
  root.scrollHeight = 800 // Exactly the viewport: one screen, nothing doubled.

  // One child only, container fits: the page is still doing its job.
  equal(harness.runtime.dismissBootPage(), false, 'a boot page alone in the container is left alone')
  equal(bootElement.removed, false, 'and stays in the document')

  // Now the application is up beside it and the container is taller than the window.
  root.scrollHeight = 1600
  equal(harness.runtime.dismissBootPage(), true, 'an oversized container with an app in it loses the page')
  equal(bootElement.removed, true, 'the page is removed')

  // Idempotent: a second call finds nothing and reports nothing.
  equal(harness.runtime.dismissBootPage(), false, 'a second attempt is a no-op')
})

/*
 * `the first-paint predicate reads selectors the way CSS does` MOVED OUT in 8c.
 *
 * `classifyPrelude` decides which rules a first paint may carry, and it is a statement about a
 * PACKAGE's CSS — `tools/derive-boot-css.mjs` runs it over a package's stylesheets to write that
 * package's `src/host/boot.css`. This suite has no CSS of its own any more, so the twelve cases now
 * live in `@xjl-resources/dsh-plugin-liquid-glass`, against the real sheets whose first frame they
 * decide. `scripts/boot-css-rules.mjs` and the derivation tool went with them.
 */

/*
 * The effect tier — step 6, first workstream.
 *
 * A project DECLARES what it was designed for (`perfLevel`); the device reports, always weakly,
 * what it can afford; the runtime publishes the lower of the two as `data-ui-perf` on the body and
 * the stylesheet degrades itself by reading that attribute. The policy is three pure functions on
 * purpose: this sandbox has no `navigator` and no `requestAnimationFrame`, so anything expressed as
 * an effect on globals could not be tested at all.
 */
await test('the effect tier is decided by pure functions over signals', () => {
  const { deviceLevel, combineLevels, minLevel, levelForFrameInterval, median } = plugin.__internals.perf

  // `saveData` is the strongest signal and the only statement of intent rather than an inference.
  equal(deviceLevel({ saveData: true, cores: 16 }), 'low', 'saveData demotes regardless of cores')
  equal(deviceLevel({ saveData: false, cores: 2 }), 'low', 'two cores is low')
  equal(deviceLevel({ saveData: false, cores: 4 }), 'medium', 'four cores is medium')
  equal(deviceLevel({ saveData: false, cores: 8 }), 'high', 'eight cores is high')
  // An unreadable count is "no opinion", not "suspect": demoting on absence would classify a
  // browser by which APIs it exposes rather than by its hardware.
  equal(deviceLevel({}), 'high', 'no signals means capable')
  equal(deviceLevel({ cores: 0 }), 'high', 'a nonsense count is ignored')
  equal(deviceLevel({ cores: Number.NaN }), 'high', 'and so is a non-number')

  equal(combineLevels([], 'high'), undefined, 'nothing active means no tier at all')
  equal(combineLevels(['low', undefined, 'high'], 'high'), 'high', 'the heaviest demand wins')
  equal(combineLevels(['high'], 'medium'), 'medium', 'the device caps it')
  equal(combineLevels(['low'], 'high'), 'low', 'and it is never raised above the demand')
  equal(minLevel(undefined, 'low'), 'low', 'no opinion defers')

  equal(levelForFrameInterval(30), 'low', 'a slow median is low')
  equal(levelForFrameInterval(20), 'medium', 'a middling median is medium')
  equal(levelForFrameInterval(16.7), 'high', 'a 60Hz median is high')
  equal(levelForFrameInterval(undefined), undefined, 'nothing measured means nothing claimed')
  equal(median([1, 3, 2]), 2, 'median of an odd list')
  equal(median([1, 2, 3, 4]), 2.5, 'median of an even list')
  equal(median([]), undefined, 'median of nothing')
})

await test('the tier in force is published on the body, and removed with the last project', async () => {
  const capable = await boot({ device: { cores: 8 } })
  equal(capable.dom.document.body.getAttribute('data-ui-perf'), null, 'no project, no tier')
  await capable.runtime.enable('test-skin')
  equal(capable.dom.document.body.getAttribute('data-ui-perf'), 'high', 'the skin asks for the full tier')
  await capable.runtime.disable('test-skin')
  equal(capable.dom.document.body.getAttribute('data-ui-perf'), null, 'and the tier goes with it')

  /*
   * The device, not the skin, is what demotes it — and the attribute has to land on the BODY.
   *
   * That is not a detail: the scoper replaces a leading `html`/`:root` with the project marker, so
   * a degradation rule authored as `html[data-ui-perf='low'] …` compiles to
   * `body[data-ui-project-…="on"][data-ui-perf='low'] …`. Publishing the attribute anywhere else
   * would leave every one of those rules matching nothing, silently.
   */
  const weak = await boot({ device: { saveData: true } })
  await weak.runtime.enable('test-skin')
  equal(weak.dom.document.body.getAttribute('data-ui-perf'), 'low', 'saveData caps the skin at reduced')
  equal(
    weak.dom.document.body.getAttribute('data-ui-project-test-skin'),
    'on',
    'the project marker itself is unaffected by the tier',
  )
  equal(weak.runtime.perfLevel(), 'low', 'and the runtime reports the same tier the stylesheet reads')
})

await test('the card shows the declared tier, and says when the device demoted it', async () => {
  const harness = await boot({ device: { cores: 2 } })
  await harness.runtime.enable('test-skin')
  const markup = harness.render()
  contains(markup, 'Performance: full')
  // A cheaper material with no explanation reads as a rendering bug, so the demotion is stated.
  contains(markup, 'Performance: reduced')
  contains(markup, 'because this device reported less capacity')
})

await test('an unknown performance tier is refused at registration', () => {
  const registry = new Registry()
  let message = ''
  try {
    registry.register({ id: 'perf-typo', name: 'Typo', perfLevel: 'Low' })
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  truthy(/perfLevel/.test(message), `a mis-cased tier must fail loudly, got: ${message}`)
  equal(registry.ids(), [], 'nothing registered')
})

/*
 * Execution order — step 6, second workstream's first half.
 *
 * The order projects run in is a request the composition makes (`priority`), and until now it was
 * an accident: `activeIds()` sorts, so the applied set came back alphabetically by id and a rename
 * could change when a project ran with nothing recording that it had.
 */
await test('the applied set runs in priority order, ties broken by registration order', async () => {
  const order = []
  /** @param {string} id @param {number} priority */
  const probe = (id, priority) => ({ id, name: id, priority, apply: () => order.push(id) })

  // The record lists them in one order, the registry registers them in another, and neither is the
  // canonical order: only the sort can produce the expected sequence.
  const storage = createStorage()
  storage.map.set(
    LOCAL_STORAGE_KEY,
    JSON.stringify({ v: 1, initialized: true, touched: true, settings: {}, enabled: ['late', 'early', 'middle'] }),
  )
  const harness = await boot({ withStorage: storage })
  harness.registry.register(probe('late', 200))
  harness.registry.register(probe('early', 10))
  harness.registry.register(probe('middle', 100))
  await harness.runtime.start()

  equal(order.join(','), 'early,middle,late', 'lower priority runs first')
  equal(harness.runtime.outOfOrderId(), undefined, 'and the session order is the canonical one')

  // Same priority: registration order decides, so the sequence is reproducible rather than
  // dependent on which id sorts first alphabetically.
  const tied = []
  const second = await boot()
  second.registry.register({ id: 'zulu', name: 'Zulu', priority: 100, apply: () => tied.push('zulu') })
  second.registry.register({ id: 'alpha', name: 'Alpha', priority: 100, apply: () => tied.push('alpha') })
  await second.runtime.enable('zulu')
  await second.runtime.enable('alpha')
  equal(tied.join(','), 'zulu,alpha', 'equal priorities keep registration order, not alphabetical')
})

await test('a dependency runs before whatever requires it, whatever the numbers say', async () => {
  const order = []
  const harness = await boot()
  harness.registry.register({
    id: 'dependent',
    name: 'Dependent',
    priority: 1,
    requires: ['base'],
    apply: () => order.push('dependent'),
  })
  harness.registry.register({ id: 'base', name: 'Base', priority: 999, apply: () => order.push('base') })

  await harness.runtime.enable('dependent')
  equal(order.join(','), 'base,dependent', 'the dependency wins over priority, because order is correctness here')
})

await test('a click does not re-order running projects, and says so', async () => {
  const harness = await boot()
  harness.registry.register({ id: 'late-arrival', name: 'Early Bird', priority: 10 })
  harness.registry.register({ id: 'settled', name: 'Settled', priority: 200 })

  await harness.runtime.enable('settled')
  equal(harness.runtime.outOfOrderId(), undefined, 'a lone project is in canonical order')

  // The new project declares higher precedence, and is applied LAST: re-applying the running one
  // to reorder it would make the interface flicker, which is the trade this test pins.
  await harness.runtime.enable('late-arrival')
  equal(harness.runtime.outOfOrderId(), 'settled', 'the project now running too early is named')
  const markup = harness.render()
  contains(markup, 'running ahead of a higher-priority project')

  // The next load applies the canonical order, so the notice is about this session only.
  equal(
    harness.registry.canonicalOrder(['settled', 'late-arrival']).join(','),
    'late-arrival,settled',
    'the canonical order puts the lower priority first',
  )
})

await test('priority is validated, and the card shows it only where it means something', async () => {
  const registry = new Registry()
  for (const [label, priority] of [
    ['a string', 'high'],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
  ]) {
    let threw = false
    try {
      registry.register({ id: 'bad-priority', name: 'Bad', priority })
    } catch {
      threw = true
    }
    truthy(threw, `priority ${label} must be refused`)
  }
  equal(registry.ids(), [], 'nothing registered')
  equal(new Registry().canonicalOrder(['x']).length, 1, 'an unregistered id still sorts (defensively)')

  // Default, and the badge rule: a skin never shows it, an enhancement does.
  const harness = await boot()
  harness.registry.register({ id: 'plain', name: 'Plain Enhancement' })
  equal(harness.registry.get('plain')?.priority, 100, 'the default priority is 100')
  await harness.runtime.enable('plain')
  const markup = harness.render()
  /*
   * Asserted per card rather than by counting badges in the page: the registry is shared across
   * boots, so every enhancement an earlier test registered is still in this render. Counting would
   * make this test depend on the ones above it.
   */
  const cardOf = (id) => new RegExp(`data-project="${id}"[\\s\\S]*?</li>`).exec(markup)?.[0] ?? ''
  const enhancementCard = cardOf('plain')
  const skinCard = cardOf('test-skin')
  truthy(enhancementCard.length > 0, 'the enhancement card rendered')
  truthy(skinCard.length > 0, 'the skin card rendered')
  contains(enhancementCard, 'Priority 100')
  excludes(skinCard, 'Priority', 'the skin carries no priority badge — it is alone by policy and never sorted')
})

/*
 * Regions and conflicts — step 6, unit B/2.
 *
 * Two enhancements that are active together and claim the same surface may fight over it. The
 * warning is advisory by construction: they may also compose perfectly, and nothing here may block
 * an enable. Skins are out of scope by design — one is alone by policy, and its footprint is broad
 * enough that including it would make every enhancement "conflict" with it.
 */
await test('shared regions are detected between enhancements, and only advisory', async () => {
  const harness = await boot()
  harness.registry.register({ id: 'tint', name: 'Tint', modifies: ['composer', 'tokens'] })
  harness.registry.register({ id: 'pad', name: 'Pad', modifies: ['composer'] })
  harness.registry.register({ id: 'elsewhere', name: 'Elsewhere', modifies: ['sidebar'] })

  equal(harness.registry.regionConflicts().length, 0, 'nothing is applied, so nothing conflicts')

  await harness.runtime.enable('tint')
  await harness.runtime.enable('pad')
  const pairs = harness.registry.regionConflicts()
  equal(pairs.length, 1, 'one pair shares a region')
  equal(pairs[0].ids.join('+'), 'tint+pad', 'and it names both projects, in registration order')
  equal(pairs[0].regions.join(','), 'composer', 'and the region they share')
  equal(harness.registry.isEnabled('tint'), true, 'a conflict never blocks an enable')
  equal(harness.registry.isEnabled('pad'), true, 'for either side')

  await harness.runtime.enable('elsewhere')
  equal(harness.registry.regionConflicts().length, 1, 'a disjoint region adds no warning')

  const snapshot = harness.store.snapshot()
  equal(snapshot.regionConflicts.length, 1, 'the store reports the same pair')
  equal(snapshot.regionConflicts[0].names.join('+'), 'Tint+Pad', 'with names resolved for display')
})

await test('a conflict with a skin is not reported, because a skin is alone by policy', async () => {
  const harness = await boot()
  harness.registry.register({ id: 'shares-with-skin', name: 'Shares', modifies: ['tokens', 'background'] })
  await harness.runtime.enable('test-skin')
  await harness.runtime.enable('shares-with-skin')
  equal(harness.registry.isEnabled('test-skin'), true, 'the skin is on')
  equal(
    harness.registry.regionConflicts().length,
    0,
    'and the overlap with it is not a warning — a broad skin would make every enhancement noisy',
  )
})

await test('a nesting needs two blurs, and is read from the CSS rather than declared', async () => {
  const { declaresBackdropFilter, filteredSelectors } = plugin.__internals.cssFilter

  // `none` is a rule that REMOVES a blur — the skin's own `@supports not` fallback. Counting it as
  // "this project blurs" would report a nesting between rules that can never both be live.
  equal(declaresBackdropFilter('.a{backdrop-filter:none}'), false, 'none is not a blur')
  equal(declaresBackdropFilter('.a{backdrop-filter:blur(4px)}'), true, 'a blur is a blur')
  equal(declaresBackdropFilter('.a{-webkit-backdrop-filter:blur(4px)}'), true, 'the prefixed form counts')
  equal(declaresBackdropFilter('/* .a{backdrop-filter:blur(4px)} */'), false, 'a commented-out rule is not a rule')
  equal(declaresBackdropFilter('@media (min-width:1px){.a{backdrop-filter:blur(1px)}}'), true, 'including inside a conditional')
  equal(filteredSelectors('.a,.b{backdrop-filter:blur(1px)}').map((entry) => entry.selector).join(','), '.a,.b', 'every selector in a list')
  equal(
    filteredSelectors('@supports not (backdrop-filter:blur(1px)){.a{backdrop-filter:blur(9px)}}')[0].condition,
    '@supports not (backdrop-filter:blur(1px))',
    'and the condition it sits under, which decides whether it can be live at all',
  )

  const harness = await boot()
  harness.registry.register({
    id: 'blur-a',
    name: 'Blur A',
    modifies: ['dialogs'],
    apply: (ctx) => ctx.insertCss('.blur-a{backdrop-filter:blur(6px)}'),
  })
  harness.registry.register({
    id: 'blur-b',
    name: 'Blur B',
    modifies: ['dialogs'],
    apply: (ctx) => ctx.insertCss('.blur-b{backdrop-filter:blur(4px)}'),
  })
  await harness.runtime.enable('blur-a')
  equal(harness.runtime.declaresFilter('blur-a'), true, 'a project that filters is seen to filter')
  await harness.runtime.enable('blur-b')
  const pair = harness.store.snapshot().regionConflicts[0]
  equal(pair.nested, true, 'two blurs on one region escalate the warning')

  // One blur alone has nothing to nest inside, so it must not escalate.
  await harness.runtime.disable('blur-b')
  const lonely = await boot()
  lonely.registry.register({
    id: 'blur-only',
    name: 'Blur Only',
    modifies: ['dialogs'],
    apply: (ctx) => ctx.insertCss('.blur-only{backdrop-filter:blur(6px)}'),
  })
  lonely.registry.register({ id: 'plain-sharer', name: 'Plain Sharer', modifies: ['dialogs'] })
  await lonely.runtime.enable('blur-only')
  await lonely.runtime.enable('plain-sharer')
  equal(lonely.store.snapshot().regionConflicts[0].nested, false, 'one blur and one non-blur cannot nest')
})

await test('an unknown region is refused, and the warnings reach the panel', async () => {
  const registry = new Registry()
  let message = ''
  try {
    registry.register({ id: 'typo-region', name: 'Typo', modifies: ['composr'] })
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  truthy(/composr/.test(message), `a misspelled region must fail loudly, got: ${message}`)
  equal(registry.ids(), [], 'nothing registered')

  const harness = await boot()
  harness.registry.register({ id: 'warn-a', name: 'Warn A', modifies: ['rightbar'] })
  harness.registry.register({ id: 'warn-b', name: 'Warn B', modifies: ['rightbar'] })
  await harness.runtime.enable('warn-a')
  await harness.runtime.enable('warn-b')
  const markup = harness.render()
  contains(markup, 'may conflict', 'the section says what is shared')
  contains(markup, 'right panel', 'naming the region in the reader\'s language')
  const cardOf = (id) => new RegExp(`data-project="${id}"[\\s\\S]*?</li>`).exec(markup)?.[0] ?? ''
  contains(cardOf('warn-a'), 'Shares the right panel with Warn B')
  contains(cardOf('warn-b'), 'Shares the right panel with Warn A')
  excludes(cardOf('test-skin'), 'Shares', 'a project in no conflict gets no line')
})

/*
 * The verification checklist — step 6, final workstream.
 *
 * A project declares what a human should check; the panel renders it as a disclosure; confirming it
 * records a claim about a PAIR — the version and the checklist it was made against. Either one moving
 * invalidates the claim, for a different reason each time, and the card says which: `stale` when the
 * version changed, `incomplete` when the checklist did. See `checksStateOf`.
 */
await test('a checklist is declared, validated, and rendered as a disclosure', async () => {
  const registry = new Registry()
  for (const [label, testItems] of [
    ['an item with no id', [{ label: 'Looks right' }]],
    ['an item with an unusable id', [{ id: 'Not An Id', label: 'Looks right' }]],
    ['an item with no label', [{ id: 'looks-right' }]],
    ['the same item id twice', [{ id: 'one', label: 'One' }, { id: 'one', label: 'One again' }]],
  ]) {
    let threw = false
    try {
      registry.register({ id: 'bad-items', name: 'Bad', testItems })
    } catch {
      threw = true
    }
    truthy(threw, `${label} must be refused: a checklist that cannot record is silent by construction`)
  }
  equal(registry.ids(), [], 'nothing registered — a refused definition leaves no half-built entry')
  equal(new Registry().get('missing'), undefined, 'and an unknown id answers undefined')

  /*
   * And the refusal has to be actionable. A duplicate is the one case an author cannot see from the
   * card — the two rows look identical there — so the message names the id and both labels.
   */
  let duplicate = ''
  try {
    registry.register({
      id: 'bad-items',
      name: 'Bad',
      testItems: [
        { id: 'one', label: 'One' },
        { id: 'one', label: 'One again' },
      ],
    })
  } catch (err) {
    duplicate = err instanceof Error ? err.message : String(err)
  }
  contains(duplicate, '"one"', 'the message names the duplicated id')
  contains(duplicate, '"One"', 'and the label it was first declared with')
  contains(duplicate, '"One again"', 'and the label that collided with it')

  const harness = await boot()
  harness.registry.register({
    id: 'checkable',
    name: 'Checkable',
    version: '2.1.0',
    testItems: [
      { id: 'first', label: 'The first thing holds' },
      { id: 'second', label: 'The second thing holds' },
    ],
  })
  // Something with no items, so the negative case has a subject — the shipped skin declares its own
  // checklist, and asserting the absence on it would have been asserting the feature away.
  harness.registry.register({ id: 'no-items', name: 'No Items' })
  const markup = harness.render()
  const cardOf = (id) => new RegExp(`data-project="${id}"[\\s\\S]*?</li>`).exec(markup)?.[0] ?? ''
  contains(cardOf('checkable'), '<details', 'the checklist is a native disclosure')
  contains(cardOf('checkable'), '<summary', 'with a summary the platform makes keyboard-operable')
  contains(cardOf('checkable'), 'Verification checklist (2)')
  contains(cardOf('checkable'), 'The first thing holds')
  contains(cardOf('checkable'), 'Mark as passed')
  /*
   * The hooks the browser suite drives the checklist through. They exist so that suite never has to
   * match localized copy — it did, and on a Chinese interface the English label it looked for was
   * absent, which read as the checklist failing rather than as a test that only spoke one language.
   * Asserted here so a rename cannot silently unhook every browser assertion at once.
   */
  contains(cardOf('checkable'), 'data-uip-action="confirm-checks"', "the confirm button's stable hook")
  /*
   * Narrowed in 7d-2, and the narrowing is the point: a card now legitimately carries a `<details>` for
   * the maintenance commands, so "no empty disclosure" has to mean "no empty CHECKLIST disclosure". The
   * claim being protected is that a project declaring no items renders no checklist — not that the card
   * contains no disclosure of any kind.
   */
  excludes(
    cardOf('no-items'),
    'data-uip-action="confirm-checks"',
    'a project with no items gets no empty checklist disclosure',
  )
  contains(cardOf('test-skin'), 'Verification checklist', 'and the shipped skin declares a real one')
  contains(cardOf('test-skin'), 'data-uip-action="confirm-checks"', 'with the same hook')
})

await test('a confirmation is worth exactly what the version and the checklist are worth', async () => {
  /*
   * THE CURRENCY RULE, and every way it can be wrong.
   *
   * The record is a claim about a PAIR: this version, and this list. The rule used to compare the
   * version and stop, so three things went unnoticed — an item added without a version bump, an item
   * removed, and a record with no items at all in it. The last one was found in a real settings
   * document (`{version: '3.0.0', items: {}}`): the card said "confirmed for 3.0.0" while nothing had
   * been read, and nothing about the interface looked wrong.
   */
  const harness = await boot()
  const base = { id: 'checkable', name: 'Checkable', version: '1.0.0' }
  const definition = (over) => ({ ...base, ...over })
  harness.registry.register(
    definition({ testItems: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }, { id: 'three', label: 'Three' }] }),
  )
  await harness.runtime.enable('checkable')
  const state = () => harness.store.snapshot().projects.find((p) => p.id === 'checkable')?.checksState
  const record = () => harness.store.snapshot().projects.find((p) => p.id === 'checkable')?.checks
  /**
   * Write a record directly, the way a hand-edited document or an older build would.
   *
   * `enable` first, because re-registering the project — which every step below does, to change the
   * checklist — leaves it un-applied, and `contextFor` answers undefined for a project that is not
   * applied. Enabling again is idempotent and re-persists the same settings, so it cannot disturb the
   * record under test.
   */
  const write = async (checks) => {
    await harness.runtime.enable('checkable')
    const context = harness.runtime.contextFor('checkable')
    if (context === undefined) {
      throw new Error(
        `no context for "checkable": registered=${harness.registry.get('checkable') !== undefined} ` +
          `enabled=${harness.registry.isEnabled('checkable')} ids=${harness.registry.ids().join(',')}`,
      )
    }
    await context.writeSetting('checks', checks)
  }

  equal(state(), undefined, 'no record, no state — not "incomplete", absent')

  // 1. The baseline the other cases are measured against.
  await write({ version: '1.0.0', items: { one: true, two: true, three: true } })
  equal(state(), 'current', 'every declared item ticked, same version')

  // 2. A new version: the claim is about different code.
  harness.registry.register(
    definition({ version: '1.1.0', testItems: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }, { id: 'three', label: 'Three' }] }),
  )
  equal(state(), 'stale', 'a new version invalidates it')

  // 3. An item ADDED without a version bump: the claim is about a different list. The record is
  //    rewritten at 1.1.0 first, so the ONLY difference left is the added item — otherwise the
  //    version mismatch from step 2 would answer for it and this case would prove nothing.
  const threeItems = [
    { id: 'one', label: 'One' },
    { id: 'two', label: 'Two' },
    { id: 'three', label: 'Three' },
  ]
  await write({ version: '1.1.0', items: { one: true, two: true, three: true } })
  equal(state(), 'current', 'the 1.1.0 record is current against the 1.1.0 checklist')
  harness.registry.register(definition({ version: '1.1.0', testItems: [...threeItems, { id: 'four', label: 'Four' }] }))
  equal(state(), 'incomplete', 'an item added without a version bump invalidates it too')

  // 4. The reverse — an item REMOVED — must NOT invalidate it, and both halves of that are asserted:
  //    the state stays current, and the removed item does not survive into the snapshot's items
  //    either. `storedChecks`'s filter is what makes the first true, so a later "optimisation" that
  //    kept every key would fail here rather than quietly change the meaning of a confirmation.
  harness.registry.register(definition({ version: '1.1.0', testItems: [threeItems[0], threeItems[1]] }))
  await write({ version: '1.1.0', items: { one: true, two: true, three: true, ghost: true } })
  equal(state(), 'current', 'an item removed from the checklist keeps it valid: it was read, and it holds')
  equal(
    JSON.stringify(record()?.items),
    '{"one":true,"two":true}',
    'and neither the removed item nor a key that was never declared reaches the snapshot',
  )

  // 5. A record with no items in it — the shape found on a real machine.
  await write({ version: '1.1.0', items: {} })
  equal(state(), 'incomplete', 'a record with nothing ticked in it is not a confirmation')

  // 6. Partially ticked: one true, the rest missing or false.
  await write({ version: '1.1.0', items: { one: true, two: false } })
  equal(state(), 'incomplete', 'a partial record is not a confirmation')

  // 8. The state reaches the panel, with the right sentence for each of the three. The four-item
  //    checklist is restored first, because step 4 shrank it on purpose.
  harness.registry.register(definition({ version: '1.1.0', testItems: [...threeItems, { id: 'four', label: 'Four' }] }))
  await write({ version: '1.1.0', items: { one: true, two: true, three: true, four: true } })
  const current = harness.render()
  contains(current, 'data-uip-checks="current"', 'the hook reports the state')
  contains(current, 'Confirmed for v1.1.0.', 'and the sentence matches it')
  await write({ version: '9.9.9', items: { one: true } })
  const stale = harness.render()
  contains(stale, 'data-uip-checks="stale"', 'a version change reads as stale')
  contains(stale, 'Confirmed for v9.9.9; this version needs confirming again.', 'with the version-change sentence')
  await write({ version: '1.1.0', items: { one: true } })
  const incomplete = harness.render()
  contains(incomplete, 'data-uip-checks="incomplete"', 'a changed checklist reads as incomplete')
  contains(
    incomplete,
    'Confirmed for v1.1.0, but the checklist changed since; confirm it again.',
    'with the sentence that says so',
  )

  /*
   * 9. An out-of-date record still seeds the boxes it can.
   *
   * The assertion names the items rather than looking for `checked` anywhere: a rendering where the
   * wrong item was ticked, or where every item was, would satisfy the loose form. What has to hold is
   * that the record's own keys arrive as ticks and the keys it does not have do not.
   */
  await write({ version: '9.9.9', items: { one: true, four: true } })
  /*
   * Scoped to THIS project's card, because `render()` draws every registered project and the registry
   * is module-level and shared across the suite — the first version of this assertion counted seven
   * checkboxes and was measuring another test's project as well.
   */
  const card = /data-project="checkable"[\s\S]*?<\/li>/.exec(harness.render())?.[0] ?? ''
  const boxes = [...card.matchAll(/<input type="checkbox"([^>]*)>/g)].map((match) => match[1])
  equal(boxes.length, 4, 'the checklist rendered every declared item')
  const tickedIds = boxes.map((attributes) => attributes.includes('checked')).join(',')
  equal(tickedIds, 'true,false,false,true', 'only the items the stale record carries are ticked')

  // 10. The old field is gone rather than left beside the new one: two fields that describe the same
  //     thing are two fields that can disagree.
  excludes(JSON.stringify(harness.store.snapshot()), 'checksCurrent', 'the boolean was replaced, not joined')
})

await test('the record an instance actually had is read from the document, not from a click', async () => {
  /*
   * The shape found on a real machine: `{version: '<the installed version>', items: {}}` — a
   * confirmation claiming a version with nothing ticked in it. The fixture's version is what makes
   * `incomplete` the answer rather than `stale`: a record stamped with a DIFFERENT version is a claim
   * about other code, which is the other state entirely.
   *
   * Booted with the document already holding it, rather than written through a context, so this also
   * covers the path that matters in practice: the state is computed from the settings document at
   * boot, with nobody clicking anything.
   *
   * IN ITS OWN TEST because a second `boot()` inside another test moves the module-level registry
   * handle, and every read through the older harness then consults the newer registry: the first
   * version of this lived in the test above and its `enable`/`isEnabled` disagreed for that reason,
   * which is the kind of cross-talk this suite should not be relying on.
   */
  const harness = await boot({
    withSettingsScope: true,
    scopeRecord: {
      v: 1,
      initialized: true,
      enabled: [],
      settings: { 'test-skin': { checks: { version: '1.0.0', items: {} } } },
      touched: true,
    },
  })
  const project = harness.store.snapshot().projects.find((p) => p.id === 'test-skin')
  equal(project?.checksState, 'incomplete', 'the record reads as incomplete, not as confirmed')

  /*
   * The exact sentence, not a fragment: the whole point of the third state is that the reader is told
   * the checklist moved rather than the version, so the assertion reads the paragraph back and
   * compares it in full. A `contains` would pass on a sentence that merely shared a phrase, and would
   * say nothing useful when it failed.
   */
  const sentence = /<p[^>]*data-uip-checks[^>]*>([^<]*)<\/p>/.exec(harness.render())?.[1]
  equal(
    sentence,
    'Confirmed for v1.0.0, but the checklist changed since; confirm it again.',
    'and the panel says the checklist moved, not the version',
  )
  /*
   * The Chinese copy is checked through `strings`, not through a render: the harness mounts no locale
   * service, so every harness renders English. Reading the table directly is locale-independent, and
   * the parity test already guarantees both languages carry the key.
   */
  equal(
    strings('zh').tests.incomplete('3.0.0'),
    '已针对 v3.0.0 确认过，但清单此后有变动；请重新确认。',
    'with the Chinese sentence saying the same thing',
  )
})

await test('confirming records the version, and a new version invalidates it', async () => {
  const harness = await boot()
  const definition = (version) => ({
    id: 'confirmable',
    name: 'Confirmable',
    version,
    testItems: [{ id: 'one', label: 'One' }],
  })
  harness.registry.register(definition('1.0.0'))
  await harness.runtime.enable('confirmable')

  // Nothing recorded yet: the card must not claim a confirmation nobody made.
  equal(harness.store.snapshot().projects.find((p) => p.id === 'confirmable')?.checks, undefined, 'nothing stored yet')

  await harness.store.confirmChecks('confirmable', ['one'])
  const stored = harness.runtime.settingsFor('confirmable')?.checks
  equal(stored?.version, '1.0.0', 'the version travels inside the record, so one write carries both')
  equal(stored?.items?.one, true, 'and the ticked item with it')
  // And the withdrawal is offered exactly when there is something to withdraw — the pair matters,
  // because a button with nothing to act on is as wrong as a record with no way to retract it.
  contains(harness.render(), 'data-uip-action="clear-checks"', 'the card offers to withdraw the confirmation')
  /*
   * And the panel was told, which is the half that has no other mechanism behind it.
   *
   * A setting is not a registry change, so the store's snapshot — taken when the registry last
   * changed — would keep the OLD record, and the confirmation would never appear on the card
   * without some unrelated action. Asserted by subscribing rather than by rendering, because
   * `render()` takes a fresh snapshot and would pass either way; that is exactly how this went
   * unnoticed when it was written.
   */
  let notified = 0
  const stopWatching = harness.store.subscribe(() => {
    notified += 1
  })
  await harness.store.confirmChecks('confirmable', ['one'])
  stopWatching()
  truthy(notified > 0, 'the store is notified after a settings write, so the card can redraw')
  const confirmed = harness.store.snapshot().projects.find((p) => p.id === 'confirmable')
  equal(confirmed?.checksState, 'current', 'the confirmation is current for the registered version')

  // The project ships a new version. The confirmation is now about code that no longer exists.
  harness.registry.register(definition('1.1.0'))
  const after = harness.store.snapshot().projects.find((p) => p.id === 'confirmable')
  equal(after?.checksState, 'stale', 'a new version invalidates the confirmation')
  equal(after?.checks?.version, '1.0.0', 'and the old one is still reported, not deleted')
  contains(harness.render(), 'needs confirming again', 'which the card says in words')

  // An unknown item id cannot be smuggled into the record.
  await harness.store.confirmChecks('confirmable', ['one', 'not-declared'])
  equal(
    JSON.stringify(harness.runtime.settingsFor('confirmable')?.checks?.items),
    '{"one":true}',
    'only declared items are recorded',
  )

  /*
   * WITHDRAWING THE CONFIRMATION, and the three ways this could have been quietly wrong.
   *
   * The record is a claim about a past run, and the three properties that make removing it honest are:
   * the key is GONE rather than emptied (an empty object survives every `=== undefined` check in the
   * codebase), the project's other options SURVIVE (retracting a claim must not cost a
   * configuration), and it works whether or not the project is APPLIED (a card shows a stale
   * confirmation while the project is off, so it has to be able to withdraw it there too).
   */
  contains(JSON.stringify(harness.runtime.settingsFor('confirmable')), '"checks"', 'there is a record to withdraw')
  // A second option, to prove the withdrawal is surgical rather than a project-wide wipe.
  await harness.runtime.contextFor('confirmable').writeSetting('strength', 7)
  await harness.store.clearChecks('confirmable')
  const remaining = harness.runtime.settingsFor('confirmable')
  equal(remaining?.checks, undefined, 'the confirmation key is gone')
  equal(JSON.stringify(remaining), '{"strength":7}', 'and the project kept its other options')
  excludes(harness.render(), 'Confirmed for v', 'the card no longer claims a verification')
  excludes(
    harness.render(),
    'data-uip-action="clear-checks"',
    'and offers no withdrawal for a record that is already gone',
  )

  /*
   * The same withdrawal from a project that is NOT applied.
   *
   * `contextFor` answers undefined for a project that is off, which is exactly why the runtime owns
   * this path instead of the key being written through the project context — and `settingsFor` reads
   * the record with the project off, by design, so a card can say "confirmed for 1.0.0" while the
   * skin is switched off. Reading it there and being unable to withdraw it there is the asymmetry
   * this asserts against.
   */
  await harness.store.confirmChecks('confirmable', ['one'])
  contains(JSON.stringify(harness.runtime.settingsFor('confirmable')), '"checks"', 'a record exists again')
  await harness.runtime.disable('confirmable')
  equal(harness.runtime.contextFor('confirmable'), undefined, 'the project is off, so it has no context')
  contains(
    JSON.stringify(harness.runtime.settingsFor('confirmable')),
    '"checks"',
    'but its record is still readable with the project off',
  )
  await harness.store.clearChecks('confirmable')
  const offAfter = harness.runtime.settingsFor('confirmable')
  equal(offAfter?.checks, undefined, 'and withdrawable while off')
  equal(JSON.stringify(offAfter), '{"strength":7}', 'without touching the options beside it')

  /*
   * `resetAll`, which the docstring has always described as forgetting every user choice.
   *
   * It kept `settings`, so a reset could leave "confirmed for 1.0.0" standing on a card whose options
   * had just been restored to the shipped defaults. Asserted on the persisted document as well as the
   * in-memory map, because the document is what a reload reads.
   */
  await harness.runtime.enable('confirmable')
  await harness.store.confirmChecks('confirmable', ['one'])
  contains(JSON.stringify(harness.runtime.settingsFor('confirmable')), '"checks"', 'a record exists again')
  await harness.runtime.resetAll()
  equal(harness.runtime.settingsFor('confirmable'), undefined, 'resetAll clears the in-memory settings')
  excludes(
    JSON.stringify(harness.settingsSection() ?? {}),
    '"confirmable"',
    'and the persisted record carries no settings for it either',
  )
})

/*
 * THE CONNECTION BETWEEN THE CARD AND THE STORE, which the five `confirmChecks` assertions above
 * cannot reach.
 *
 * Those call `store.confirmChecks(id, ['one'])` directly: a well-formed array, handed to the layer
 * BELOW the bug. The bug was in the wiring above it — `createCard` passed `project.id` to a callback
 * that already closed over it — so the store received the string `'three-items'` where the item ids
 * belonged, `for…of` walked its characters, matched no declared item and recorded `{ version, items: {} }`.
 * All five of those assertions stayed green while the card in the browser recorded nothing at all.
 * A connection between a component and a store needs an assertion ON the connection.
 */
await test('the card hands the item ids to the store, not the project id', async () => {
  const harness = await boot()
  harness.registry.register({
    id: 'three-items',
    name: 'Three items',
    version: '1.0.0',
    testItems: [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
      { id: 'three', label: 'Three' },
    ],
  })
  await harness.runtime.enable('three-items')

  /*
   * The card is reached through React rather than through the store, because React's element props are
   * where the bug was. `panel.js` holds the same React instance this suite does — the loader's module
   * table hands out one copy, which is what makes hooks resolve to a single dispatcher — so wrapping
   * `createElement` for the duration of one render is enough to observe what the card hands its
   * checklist. No DOM, no clicking, and no second React to disagree with the first.
   */
  const realCreateElement = react.createElement
  /** @type {any[]} */
  const checklists = []
  react.createElement = (type, props, ...rest) => {
    if (typeof type === 'function' && props !== null && typeof props === 'object' && typeof props.onConfirm === 'function') {
      checklists.push(props)
    }
    return realCreateElement(type, props, ...rest)
  }
  try {
    harness.render()
  } finally {
    react.createElement = realCreateElement
  }
  const checklist = checklists.find((props) => props.project.id === 'three-items')
  truthy(
    checklist !== undefined,
    `the project's card renders a checklist (saw ${checklists.map((props) => props.project.id).join(', ') || 'none'})`,
  )

  // Exactly what the button computes once all three boxes are ticked — the state the browser suite
  // puts the card in before it clicks.
  const itemIds = checklist.project.testItems.map((item) => item.id)

  /** @type {any[]} */
  const seen = []
  /** @type {Promise<any>[]} */
  const writes = []
  const realConfirmChecks = harness.store.confirmChecks
  harness.store.confirmChecks = (id, ids) => {
    seen.push([id, ids])
    const write = realConfirmChecks(id, ids)
    writes.push(write)
    return write
  }
  try {
    checklist.onConfirm(itemIds)
    await Promise.all(writes)
  } finally {
    harness.store.confirmChecks = realConfirmChecks
  }

  equal(
    JSON.stringify(seen),
    JSON.stringify([['three-items', ['one', 'two', 'three']]]),
    'the store is called with the ids and nothing else: the id the callback closes over must not arrive as a second argument',
  )
  const record = harness.runtime.settingsFor('three-items')?.checks
  equal(record?.version, '1.0.0', 'and the write carries the registered version')
  equal(
    JSON.stringify(record?.items),
    '{"one":true,"two":true,"three":true}',
    'with every ticked item in it, rather than an empty set',
  )
  equal(
    harness.store.snapshot().projects.find((project) => project.id === 'three-items')?.checksState,
    'current',
    'so the card reads as confirmed — the reading the browser showed as `incomplete` for a record with no items',
  )
})

/**
 * The store's own boundary, which the same bug also went through.
 *
 * `for…of` over a string is legal, iterates its characters and matches nothing, so the shape mistake
 * above produced a WRITTEN record rather than an error. Both guards throw instead: the input must be a
 * non-empty array, and matching it against the declared items must not leave the record empty either.
 * An empty `items` is never a legitimate confirmation — the panel renders no checklist for a project
 * that declares no items, so no honest path through `confirmChecks` produces one.
 */
await test('confirmChecks refuses anything that would record an empty confirmation', async () => {
  const harness = await boot()
  harness.registry.register({
    id: 'guarded',
    name: 'Guarded',
    version: '1.0.0',
    testItems: [{ id: 'one', label: 'One' }],
  })
  await harness.runtime.enable('guarded')

  /** @param {any} value @returns {Promise<string>} */
  const outcome = async (value) => {
    try {
      await harness.store.confirmChecks('guarded', value)
      return 'accepted'
    } catch (err) {
      return err?.name ?? 'threw a non-Error'
    }
  }

  const outcomes = []
  for (const wrong of ['guarded', [], undefined, { one: true }]) outcomes.push(await outcome(wrong))
  equal(
    JSON.stringify(outcomes),
    JSON.stringify(['TypeError', 'TypeError', 'TypeError', 'TypeError']),
    'a string of ids, an empty array, undefined and an object are all refused by name',
  )

  const named = await harness.store.confirmChecks('guarded', 'guarded').then(
    () => 'accepted',
    (err) => String(err?.message ?? ''),
  )
  contains(named, '"guarded"', 'and the refusal quotes what it received, so the string-of-ids mistake is readable')

  const unmatched = await harness.store.confirmChecks('guarded', ['not-declared']).then(
    () => 'accepted',
    (err) => String(err?.message ?? ''),
  )
  contains(unmatched, 'not-declared', 'ids that name no declared item are refused too, rather than recorded as empty')

  equal(
    harness.runtime.settingsFor('guarded')?.checks,
    undefined,
    'and no refusal wrote a record — a confirmation with nothing in it is what this replaced',
  )

  // The honest call still works, so the guards did not close the door they were put beside.
  await harness.store.confirmChecks('guarded', ['one'])
  equal(
    JSON.stringify(harness.runtime.settingsFor('guarded')?.checks?.items),
    '{"one":true}',
    'while a real confirmation is still recorded',
  )
})

// ── retired: the sound-reminders suite ───────────────────────────────────────
//
// Twelve tests used to sit here, asserting the contract of a sound-reminders
// feature this plugin no longer carries: one master switch, approval-only
// ringing, a 900 ms cadence, quiet hours, cross-tab ring claims, notification
// clicks, the scheduler's fixed grid, and the reminder page's localized copy.
//
// That feature was a second subsystem sharing this package's bundle, and it was
// removed on purpose: `src/client/reminders/**`, the `dsh-reminders` settings
// namespace this plugin registered on the host, the second `settings.section`
// entry, and `__internals.reminders`. The package, its name, and every file in
// it now describe one thing — the UI project system.
//
// They are RETIRED rather than retargeted because there is nothing left to
// retarget them at. "A waiting approval rings until it is answered" has no
// UI-project equivalent, and repointing the assertions at something else would
// have produced twelve tests that no longer test what their names claim. The
// behaviour they covered, if it is wanted again, belongs in its own package with
// its own suite.
//
// What was NOT lost — the shared machinery those tests incidentally exercised —
// is still asserted above: effect ownership and complete removal (see `dispose()
// removes every effect it owns`), the stylesheet ledger (`every inserted
// stylesheet is owned and removable`), durable state through the settings scope
// (`state uses the dsh settings document when the host offers a scope`), and the
// single `settings.section` registration.

/* ── the installed-package column ─────────────────────────────────────────── */

/** A React stand-in that builds plain data, so the section can be inspected without a renderer. */
const renderSection = (props) => server.renderToStaticMarkup(react.createElement(UiPluginsSection, props))

await test('the installed store persists nothing, by construction and by assertion', async () => {
  /*
   * A stored listing is a claim about a profile at a moment that has passed, with no invalidation
   * point: install something and the stored copy is a lie. The store's source is checked rather than
   * its behaviour, because the failure this prevents is a future edit that adds a cache.
   */
  const source = await readFile(join(packageRoot, 'src', 'client', 'installed.js'), 'utf8')
  equal(/localStorage|sessionStorage|settingsScope|persist\.write/.test(source), false, 'the store touches no storage of any kind')
  const store = createInstalledStore({ request: async () => ({ schemaVersion: 1, scan: { profileName: 'web', dependencies: [] } }) })
  await store.refresh()
  equal(store.state().status, 'ready', 'and a refresh leaves nothing behind but the state it returns')
})

await test('a per-package problem is rendered against its own row, and a failed column leaves the projects page alone', async () => {
  const flatCopy = {
    title: 'UI plugins',
    intro: 'intro',
    loading: 'Reading…',
    failed: (reason) => `Cannot read: ${reason}`,
    failedHint: 'hint',
    refresh: 'Read again',
    empty: 'Nothing installed',
    composed: 'composed',
    notComposed: 'not composed',
    framework: 'framework',
    project: (id) => `project id: ${id}`,
    orphaned: (names) => `orphaned: ${names}`,
    commandsHint: 'run this:',
    restartHint: 'restart dsh',
    restartBlock: (command) => '# 1. stop dsh web\n' + command,
    uninstall: {
      title: 'what changes',
      automaticTitle: 'automatic',
      automatic: ['gone: the registry entry', 'gone: its stylesheet'],
      commandTitle: 'by the command',
      command: ['gone: the package directory'],
      keptTitle: 'kept',
      kept: ['kept: your switch', 'kept: this package settings'],
    },
    maintenanceTitle: (name) => `maintaining ${name}`,
    maintenanceHint: 'acts on the package',
    cmdSnapshotWhy: 'snapshot why',
    cmdUpdateWhy: 'update why',
    cmdRollbackWhy: 'rollback why',
    cmdRollbackList: 'list them',
    noSnapshots: 'no snapshots',
    snapshotNames: (count) => `${count} versions`,
    restartReminder: 'restart dsh',
    kinds: { bundle: 'bundle' },
  }
  const render = (state) => renderSection({ store: { state: () => state, refresh: async () => {} }, t: { plugins: flatCopy }, state, React: react })

  /*
   * The two columns share no state: a listing that cannot be read must not take the page down with
   * it. Asserted on the projects page's own render, which is the half that would break.
   */
  const harness = await boot()
  harness.registry.register({ id: 'still-there', name: 'Still there' })
  const failing = createInstalledStore({
    request: async () => {
      throw new Error('connection refused')
    },
  })
  await failing.refresh()
  equal(failing.state().status, 'failed', 'the listing column is in its failed state')
  contains(harness.render(), 'still-there', 'and the projects page renders exactly as before')
})

await test('the installed store reads on demand, and remembers nothing', async () => {
  let calls = 0
  const payload = { schemaVersion: 1, scan: { profileName: 'web', dependencies: [], uiProjectBundle: true } }
  const store = createInstalledStore({
    request: async () => {
      calls += 1
      return payload
    },
  })
  equal(store.state().status, 'idle', 'nothing is read until something asks')
  await store.refresh()
  equal(calls, 1, 'a refresh asks the host once')
  equal(store.state().status, 'ready', 'and a scan makes the state ready')
  equal(store.state().scan.profileName, 'web', 'with the profile the host named')
  await Promise.all([store.refresh(), store.refresh(), store.refresh()])
  equal(calls, 2, 'three concurrent refreshes share one request: the in-flight guard holds')
})

await test('a failed read is a state with a reason, not a silent empty list', async () => {
  const store = createInstalledStore({
    request: async () => {
      throw new Error('connection refused')
    },
  })
  await store.refresh()
  equal(store.state().status, 'failed', 'the failure is a state the column can render')
  equal(store.state().error, 'connection refused', 'with the reason, which is the difference between broken and empty')
  const hostReported = createInstalledStore({ request: async () => ({ schemaVersion: 1, error: { message: 'no profile' } }) })
  await hostReported.refresh()
  equal(hostReported.state().error, 'no profile', 'and a failure the HOST reported travels the same way')
})

await test('the plugins column renders each state, and never pretends to be empty', () => {
  const flatCopy = {
    title: 'UI plugins',
    intro: 'intro',
    loading: 'Reading…',
    failed: (reason) => `Cannot read: ${reason}`,
    failedHint: 'hint',
    refresh: 'Read again',
    empty: 'Nothing installed',
    composed: 'composed',
    notComposed: 'not composed',
    framework: 'framework',
    project: (id) => `project id: ${id}`,
    orphaned: (names) => `orphaned: ${names}`,
    commandsHint: 'run this:',
    restartHint: 'restart dsh',
    restartBlock: (command) => '# 1. stop dsh web\n' + command,
    uninstall: {
      title: 'what changes',
      automaticTitle: 'automatic',
      automatic: ['gone: the registry entry', 'gone: its stylesheet'],
      commandTitle: 'by the command',
      command: ['gone: the package directory'],
      keptTitle: 'kept',
      kept: ['kept: your switch', 'kept: this package settings'],
    },
    maintenanceTitle: (name) => `maintaining ${name}`,
    maintenanceHint: 'acts on the package',
    cmdSnapshotWhy: 'snapshot why',
    cmdUpdateWhy: 'update why',
    cmdRollbackWhy: 'rollback why',
    cmdRollbackList: 'list them',
    noSnapshots: 'no snapshots',
    snapshotNames: (count) => `${count} versions`,
    restartReminder: 'restart dsh',
    kinds: { bundle: 'bundle', 'ui-project': 'UI project' },
  }
  const render = (state) => renderSection({ store: { state: () => state, refresh: async () => {} }, t: { plugins: flatCopy }, state, React: react })

  contains(render({ status: 'idle' }), 'Reading…', 'an unread column says it is reading')
  contains(render({ status: 'loading' }), 'Reading…', 'and so does one mid-request')
  contains(render({ status: 'failed', error: 'no profile' }), 'Cannot read: no profile', 'a failure names the reason')
  contains(render({ status: 'failed', error: 'no profile' }), 'Read again', 'and offers the control that tries again')

  const ready = render({
    status: 'ready',
    scan: {
      profileName: 'web',
      dependencies: [
        { name: 'dsh-ui-projects', version: '0.1.0', kind: 'bundle', bundled: true, problems: [] },
        { name: 'dsh-ui-project-skeleton', version: '0.1.0', kind: 'ui-project', bundled: true, projectId: 'skeleton', problems: [] },
        { name: 'zod', version: '3.23.8', kind: 'library', bundled: false, problems: [] },
      ],
      orphanedBindings: [],
    },
  })
  contains(ready, 'dsh-ui-project-skeleton@0.1.0', 'a row names the package and its version')
  contains(ready, 'project id: skeleton', 'and the project it contributes')
  contains(ready, 'not composed', 'and whether it is actually in the layer stack')
  contains(ready, 'dsh plugin --profile web remove dsh-ui-project-skeleton', 'and the exact command that would remove it')
  contains(ready, 'restart dsh', 'and the half of the instruction that is easy to forget: a command alone changes nothing until dsh restarts')
  contains(ready, 'framework', 'the framework row is marked')
  equal(ready.includes('remove dsh-ui-projects'), false, 'and carries no command that would remove the thing rendering the list')

  const orphans = render({
    status: 'ready',
    scan: { profileName: 'web', dependencies: [], orphanedBindings: ['dsh-orphan'] },
  })
  contains(orphans, 'orphaned: dsh-orphan', 'a package that declares a bundle but is not composed is reported')
})

await test('the column reads the dictionary it is actually given', async () => {
  /*
   * THE BUG THESE EXIST FOR. The component read its copy one level too high: the dictionary nests
   * this page under `plugins`, as it nests `storage`, `perf` and `tests`. One of the misplaced reads
   * was dynamic — `t.kinds[dependency.kind]` — and dynamic access on undefined THROWS, which is where
   * "Cannot read properties of undefined (reading 'bundle')" came from: `bundle` is the VALUE of
   * dependency.kind, not a property name in any file, which is why grepping for `.bundle` found
   * nothing. The other fifteen keys rendered as nothing at all.
   *
   * These render the REAL dictionaries. A fixture is a dictionary that does not exist, and this file
   * was tested against one while production threw.
   */
  const READ_KEYS = ['title', 'intro', 'loading', 'failed', 'failedHint', 'refresh', 'empty', 'composed',
    'notComposed', 'framework', 'project', 'orphaned', 'commandsHint', 'restartHint', 'restartBlock', 'kinds', 'uninstall',
    'maintenanceTitle', 'maintenanceHint', 'cmdSnapshotWhy', 'cmdUpdateWhy', 'cmdRollbackWhy', 'cmdRollbackList',
    'noSnapshots', 'snapshotNames', 'restartReminder']
  const readyScan = {
    profileName: 'web',
    dependencies: [{ name: 'dsh-ui-project-x', version: '1.0.0', kind: 'bundle', bundled: true, problems: [] }],
    orphanedBindings: [],
  }
  for (const locale of ['en', 'zh']) {
    const dictionary = strings(locale)
    const markup = renderSection({ store: { state: () => ({ status: 'ready', scan: readyScan }), refresh: async () => {} }, t: dictionary, React: react })
    truthy(markup.length > 0, 'the ' + locale + ' dictionary renders the column without throwing')
    contains(markup, dictionary.plugins.title, 'and the title comes from the dictionary (' + locale + ')')
    contains(markup, dictionary.plugins.kinds.bundle, 'and a package kind is translated (' + locale + ')')
    contains(markup, dictionary.plugins.commandsHint, 'and the command instruction comes from the dictionary (' + locale + ')')

    /* A key the component reads but the dictionary lacks renders as nothing rather than as an error,
     * which is how fifteen of them survived a green suite. */
    const page = dictionary.plugins ?? {}
    const missing = READ_KEYS.filter((key) => page[key] === undefined)
    equal(missing, [], 'every key the column reads exists in the ' + locale + ' dictionary')
    const unread = Object.keys(page).filter((key) => !READ_KEYS.includes(key))
    if (unread.length > 0) process.stdout.write('         note  ' + locale + ': keys nothing reads yet: ' + unread.join(', ') + '\n')
  }

  /* A dictionary older than a project kind shows the raw kind instead of a blank badge. */
  const withoutKinds = { plugins: { ...strings('en').plugins, kinds: undefined } }
  const fallback = renderSection({ store: { state: () => ({ status: 'ready', scan: readyScan }), refresh: async () => {} }, t: withoutKinds, React: react })
  contains(fallback, 'bundle', 'a missing kinds table falls back to the raw kind instead of throwing')
})

/*
 * THE BLOCK A PERSON COPIES REPEATS THAT ROW'S OWN COMMAND — the 8d hotfix.
 *
 * The bug, found by the user reading the page and not by any suite: the command on its own line was
 * built from the row's name, and the block four lines below it came from a dictionary LITERAL with
 * `dsh-ui-projects` typed into it. Every row therefore offered two different removal commands, and the
 * second one was always the framework's. It was invisible while a profile held one removable package —
 * the framework's row is the one row that renders no removal command at all — and it became visible the
 * first time three packages shared the template.
 *
 * IT USES THE REAL DICTIONARIES, and that is why it is its own test rather than an assertion added to the
 * one above. The flat fixture in this file supplies its own `restartBlock`, so the literal never entered
 * the markup it rendered: the fixture replaced exactly the string under test, and the assertion that
 * would have caught the literal ("carries no command that would remove the thing rendering the list")
 * was passing on a stand-in. That is the same lesson `the column reads the dictionary it is actually
 * given` records one test earlier — it exists because this file was once tested against a dictionary that
 * does not exist — and this is its second incident.
 *
 * Both languages, because the literal was written twice: once for English and once for Chinese.
 */
await test('the restart block repeats each row’s own command, in both languages', async () => {
  const scan = {
    profileName: 'web',
    dependencies: [
      { name: 'dsh-ui-projects', version: '0.1.0', kind: 'bundle', bundled: true, problems: [] },
      { name: '@scope/example-skin', version: '1.0.0', kind: 'ui-project', bundled: true, projectId: 'example', problems: [] },
      { name: 'dsh-cost-meter', version: '0.2.0', kind: 'ui-project', bundled: true, projectId: 'cost-meter', problems: [] },
    ],
    orphanedBindings: [],
  }
  const state = { status: 'ready', scan }
  for (const locale of ['en', 'zh']) {
    const dictionary = strings(locale)
    const markup = renderSection({ store: { state: () => state, refresh: async () => {} }, t: dictionary, state, React: react })
    /* The standalone command is the one `<pre>` with no attributes of its own; the other two carry hooks. */
    const printed = [...markup.matchAll(/<pre>([^<]*)<\/pre>/g)].map((match) => match[1])
    const blocks = [...markup.matchAll(/<pre data-uip-restart="block">([\s\S]*?)<\/pre>/g)].map((match) => match[1])
    equal(printed.length, 2, `${locale}: one command line per removable row, and none for the framework's row`)
    equal(blocks.length, printed.length, `${locale}: and one block to copy per command, not one per page`)
    for (const command of printed) {
      truthy(
        blocks.some((block) => block.includes(command)),
        `${locale}: the copied block repeats "${command}" instead of a second, hard-coded one`,
      )
    }
    equal(
      blocks.some((block) => block.includes('remove dsh-ui-projects')),
      false,
      `${locale}: and no block names the framework, whose row carries no removal command at all`,
    )
  }
})

/*
 * WHERE THE MAINTENANCE COMMANDS ARE RUN (9b).
 *
 * Every row of the plugins column prints `install.ps1 -Snapshot`, and the framework's own card prints the
 * same three lines — but a package only has that script in its directory if it SHIPS one (the skin does;
 * the two example packages deliberately do not, and neither does any ordinary third-party plugin). A
 * person who pastes the command in such a directory gets "not recognized", which reads as a broken tool
 * rather than as a command run in the wrong place.
 *
 * So the hint says where to run it, in both languages and in both places the commands appear. Asserted
 * rather than trusted because copy is exactly what a later edit drops: the sentence is not decoration, it
 * is the instruction that makes the printed command work.
 */
await test('the maintenance hint says where the command has to be run, in both languages', async () => {
  for (const locale of ['en', 'zh']) {
    const dictionary = strings(locale)
    const card = dictionary.maintenanceHint
    const column = dictionary.plugins.maintenanceHint
    contains(card, '-Package', `${locale}: the card’s hint names the fallback for a package with no wrapper`)
    contains(column, '-Package', `${locale}: and so does the column’s`)
  }
})

await test('the uninstall block answers all three questions, in both languages', async () => {
  /*
   * Step 6b. Two of the three groups describe things a person could work out by trying them; the third
   * cannot be discovered at all — that the switch survives, that this package's settings survive, and
   * that the source tree is not touched — and it is the only place inside the interface where the two
   * decisions about user data are visible. So all three are asserted, in both languages, against the
   * dictionaries the panel is really given.
   */
  const readyScan2 = {
    profileName: 'web',
    dependencies: [{ name: 'dsh-ui-project-x', version: '1.0.0', kind: 'bundle', bundled: true, problems: [] }],
    orphanedBindings: [],
  }
  for (const locale of ['en', 'zh']) {
    const dictionary = strings(locale)
    const copy = dictionary.plugins.uninstall
    const markup = renderSection({
      store: { state: () => ({ status: 'ready', scan: readyScan2 }), refresh: async () => {} },
      t: dictionary,
      React: react,
    })
    for (const group of ['automatic', 'command', 'kept']) {
      contains(markup, 'data-uip-uninstall="' + group + '"', 'the ' + group + ' group renders, and carries its hook (' + locale + ')')
    }
    contains(markup, copy.automaticTitle, 'the automatic group is headed from the dictionary (' + locale + ')')
    contains(markup, copy.automatic[0], 'and lists what goes on its own (' + locale + ')')
    contains(markup, copy.commandTitle, 'the command group is headed from the dictionary (' + locale + ')')
    contains(markup, copy.command[0], 'and what the command does (' + locale + ')')
    contains(markup, copy.keptTitle, 'the kept group is headed from the dictionary (' + locale + ')')
    contains(markup, copy.kept[0], 'and what is deliberately left alone (' + locale + ')')
    equal(copy.automatic.length, 6, 'six things the framework removes by itself (' + locale + ')')
    equal(copy.command.length, 2, 'two the command removes (' + locale + ')')
    equal(copy.kept.length, 5, 'five it never touches, the version snapshots among them (' + locale + ')')
  }
  /*
   * The two decisions, in the words the interface itself uses. Asserted on the copy rather than on the
   * markup because these are the sentences that make the decision visible to a user, and a reworded
   * version that dropped either one would leave the block looking complete.
   */
  const keptEn = strings('en').plugins.uninstall.kept.join(' | ')
  const keptZh = strings('zh').plugins.uninstall.kept.join(' | ')
  contains(keptEn, 'comes back on', 'English says the switch survives a reinstall')
  contains(keptZh, '重装后仍然是开的', 'and Chinese says the same')
  contains(keptEn, 'recorded verification', "English says a recorded verification is the user's data, not the package's")
  contains(keptZh, '验收确认', 'and Chinese says the same')
})

/**
 * Strip comments so a guard reads CODE, not the prose that explains the bug.
 *
 * No regular expression is used, and that is deliberate: a backslash pattern written inside a patch
 * script's template literal has been eaten twice in this project, once silently. Splitting on the
 * markers cannot be mangled on the way through a string.
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  const withoutBlocks = source
    .split('/*')
    .map((chunk, index) => (index === 0 ? chunk : chunk.slice(chunk.indexOf('*/') + 2)))
    .join('')
  return withoutBlocks
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith('//'))
    .join(String.fromCharCode(10))
}

await test('the column reads its copy through the plugins namespace, and a guard keeps it that way', async () => {
  /* The root cause was a read one level too high. A source guard fails earlier than a behaviour test
   * can: it fails the moment someone writes `t.title` here again. */
  const source = await readFile(join(packageRoot, 'src', 'client', 'panel-plugins.js'), 'utf8')
  /*
   * Comments are stripped first, and this is not tidiness: the doc comment at the top of that file
   * explains the bug using the very expressions this guard looks for, so without stripping it the
   * guard fails on its own documentation — which is exactly what happened when it was first written.
   */
  const code = stripComments(source)
  const IDENTIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$"
    const direct = []
    for (let at = code.indexOf("t."); at >= 0; at = code.indexOf("t.", at + 1)) {
      const before = at === 0 ? "" : code.charAt(at - 1)
      const after = code.charAt(at + 2)
      const boundary = before === "" || !IDENTIFIER.includes(before)
      // `React.` contains `t.`, which is how the first version of this guard flagged five
      // `React.createElement` calls as copy reads. The boundary check is the whole fix, and `t.plugins`
      // is the one legitimate read at that level.
      if (boundary && IDENTIFIER.slice(0, 52).includes(after) && !code.startsWith("plugins", at + 2)) {
        direct.push(code.slice(at, at + 24))
      }
    }
  equal(direct, [], 'no direct `t.<key>` read: every key comes from the `plugins` namespace')
})

/* ── retirement, adoption, and a record of intent ──────────────────────────── */

await test('the registry can be emptied two ways, and the guard between them holds', () => {
  const registry = new Registry()
  const first = registry.register({ id: 'proj-a', name: 'A' })
  const revision = registry.getVersion()
  first()
  equal(registry.ids(), [], 'the disposer register() returned removes its own registration')
  equal(registry.getVersion(), revision + 1, 'and bumps the revision exactly once')

  const stale = registry.register({ id: 'proj-b', name: 'B old' })
  registry.register({ id: 'proj-b', name: 'B new' })
  stale()
  equal(registry.ids(), ['proj-b'], 'a STALE disposer cannot remove a newer registration')
  equal(registry.get('proj-b').name, 'B new', 'and the newer definition is the one that stands')

  equal(registry.unregister('proj-b'), true, 'unregister(id) removes whatever is registered under it')
  equal(registry.unregister('proj-b'), false, 'and reports false when there was nothing to remove')
  equal(registry.status('proj-b'), 'unavailable', 'a removed id reports unavailable, not inactive')

  registry.register({ id: 'proj-c', name: 'C' })
  registry.markActive('proj-c')
  let refused
  try {
    registry.unregister('proj-c')
  } catch (error) {
    refused = error
  }
  /*
   * `name`, not `instanceof`: the registry runs inside the suite's vm sandbox, so the TypeError it
   * throws is the SANDBOX's constructor, and `instanceof` against this realm's is false — a harness
   * artifact that reads exactly like a failure of the check itself.
   */
  truthy(refused?.name === 'TypeError', 'unregister REFUSES an applied id rather than leaking its stylesheets')
  equal(registry.ids(), ['proj-c'], 'and the registry is left exactly as it was')
})

await test('retire deactivates a project and leaves the user\'s record alone', async () => {
  const harness = await boot()
  let cleaned = 0
  harness.registry.register({
    id: 'retirable',
    name: 'Retirable',
    type: 'skin',
    apply(ctx) {
      ctx.insertCss('body[data-ui-project-retirable="on"]{ --retirable: 1 }')
    },
    cleanup() {
      cleaned += 1
    },
  })
  await harness.runtime.enable('retirable')
  equal(harness.registry.isEnabled('retirable'), true, 'the project is applied')
  truthy(harness.dom.allCss().includes('--retirable: 1'), 'and its stylesheet is in the document')
  equal(harness.runtime.persist.read().enabled, ['retirable'], 'enabling records the choice')

  await harness.runtime.retire('retirable')
  equal(cleaned, 1, "retire runs the project's cleanup")
  equal(harness.registry.isEnabled('retirable'), false, 'and the project is no longer applied')
  equal(harness.runtime.persist.read().enabled, ['retirable'], "while the user's record still names it")
  equal(harness.dom.allCss().includes('--retirable: 1'), false, 'its stylesheet is gone from the document')
  equal(harness.dom.body.getAttribute('data-ui-project-retirable'), null, 'along with its body marker')
  await harness.runtime.retire('retirable')
  equal(cleaned, 1, 'and retiring twice is a no-op')
})

await test("a project's timer and the runtime's own observer are gone once the package is retired", async () => {
  /*
   * Item 9 of the uninstall list, in the two halves it actually has — and they are different contracts.
   *
   * 1. A PROJECT's interval is the project's to clear: the runtime promises that `cleanup()` runs
   *    (`retire runs the project's cleanup`, above), and what this half adds is the consequence a
   *    reader cares about — nothing ticks once the package is gone.
   * 2. The runtime's OWN observer and backstop interval come from `ctx.markColumns()`
   *    (`runtime.js:561`), whose disposer the runtime keeps in its own owned list (`:754`). That
   *    disposal is this half's real subject: it is not the project's bookkeeping.
   *
   * PERIOD-SCOPED, NOT COUNTED, and the premise is pinned rather than assumed. The runtime arms
   * periods of its own — 500 ms for the boot-page watch and 250 ms for the marking backstop — and an
   * existing test already asserts exactly that pair (`the column-marking retry stops once it
   * succeeds`, which reads `runningPeriods.join(',') === '500,250'`). An absolute count would
   * therefore drift with the runtime's internals; a 5 ms period belongs to this test and nothing else.
   * The first assertion below fails loudly if that ever stops being true.
   */
  /*
   * `detachedFrame` for the same reason the two existing timer tests use it: with the sandbox's
   * timers in charge, a boot that expects the frame to be there already waits on a timer nobody is
   * going to fire, and the run hangs rather than failing. This boot starts without the frame, mounts
   * it by hand, and therefore also exercises the path where the observer does the marking.
   */
  const harness = await boot({ detachedFrame: true, fakeTimers: true })
  equal(harness.timers.runningPeriods.includes(5), false, 'no 5 ms interval runs before this project exists')

  let ticks = 0
  /** @type {any} */
  let timer
  harness.registry.register({
    id: 'busy',
    name: 'Busy',
    apply(ctx) {
      ctx.markColumns()
      /*
       * `sandbox.setInterval`, not the bare global, and this is not a style choice: a project defined
       * in THIS file is a host-realm function, so a bare `setInterval` would be Node's real one — the
       * fake timer ledger would never see it, the tick assertions would fail, and the real handle would
       * hold the process open so the run looked like a hang instead of a failure. Using the sandbox's
       * functions is what a package gets for free in a browser, where its own realm IS the page's.
       */
      timer = sandbox.setInterval(() => {
        ticks += 1
      }, 5)
    },
    cleanup() {
      sandbox.clearInterval(timer)
    },
  })

  const observersBefore = FakeMutationObserver.instances.length
  await harness.runtime.enable('busy')

  const markedColumns = () =>
    harness.dom.document.body.querySelectorAll('div').filter((el) => el.hasAttribute('data-ui-skin-column'))
  equal(harness.timers.runningPeriods.includes(5), true, 'the project armed its own interval while applied')
  harness.timers.tickIntervals()
  equal(ticks, 1, 'and it really ticks')
  equal(markedColumns().length, 0, 'nothing is marked yet: the shell has not mounted the frame')
  const projectObservers = FakeMutationObserver.instances.slice(observersBefore)
  truthy(
    projectObservers.some((observer) => observer.callbacks.length > 0),
    'and an observer this application created is connected, waiting for the frame',
  )

  // The shell mounts the application: this is the mutation the runtime waits for.
  harness.dom.mountFrame()
  FakeMutationObserver.flushAll()
  equal(markedColumns().length, 3, 'the columns are marked once the frame appears')
  equal(harness.timers.runningPeriods.includes(250), false, 'and the marking backstop is gone, its job done')

  await harness.runtime.retire('busy')
  equal(harness.timers.runningPeriods.includes(5), false, 'retire clears the interval the project armed')
  harness.timers.tickIntervals()
  equal(ticks, 1, 'so nothing ticks any more')
  equal(markedColumns().length, 0, 'the column marks the runtime put on the frame are gone with it')
  equal(
    projectObservers.filter((observer) => observer.callbacks.length > 0).length,
    0,
    'and every observer this application created is disconnected',
  )
})

await test('retiring the active skin returns the shipped interface, not a half-applied one', async () => {
  /*
   * Item 11 of the uninstall list, from the page's side.
   *
   * THE ROOT MARKER IS NOT ASSERTED HERE, and that is a decision rather than an omission:
   * `data-ui-projects` is set in `start()` and cleared in `dispose()` (`runtime.js:233`, `:457`), so
   * it means "this plugin is mounted", not "a project is applied" — retiring the last project leaves
   * it in place on purpose. Its removal is asserted where it belongs, in `dispose() removes every
   * effect it owns`.
   */
  const harness = await boot({ device: { cores: 8 } })
  await harness.runtime.enable('test-skin')
  equal(harness.dom.body.getAttribute('data-ui-project-test-skin'), 'on', 'the skin marker is on while it is applied')
  equal(harness.dom.body.getAttribute('data-ui-perf'), 'high', 'and the tier this device allows is published')
  truthy(
    harness.allCss().includes('data-ui-project-test-skin'),
    'with its scoped stylesheet in the document',
  )

  await harness.runtime.retire('test-skin')
  equal(harness.registry.activeIds().length, 0, 'nothing is applied any more')
  equal(harness.dom.body.getAttribute('data-ui-project-test-skin'), null, 'the skin marker is gone')
  equal(
    harness.dom.body.getAttribute('data-ui-perf'),
    null,
    'and the tier goes with it, so no rule keyed on it can keep matching a project that is not applied',
  )
  equal(
    harness.allCss().includes('data-ui-project-test-skin'),
    false,
    'its stylesheet is out of the document, which is what the shipped interface is made of',
  )
})

await test('disable records the removal; retire does not', async () => {
  const harness = await boot()
  harness.registry.register({ id: 'pair', name: 'Pair' })
  await harness.runtime.enable('pair')
  await harness.runtime.disable('pair')
  equal(harness.runtime.persist.read().enabled, [], 'disable removes the id: that is the user turning it off')
  await harness.runtime.enable('pair')
  await harness.runtime.retire('pair')
  equal(harness.runtime.persist.read().enabled, ['pair'], 'retire keeps it: that is a package going away')
})

await test('the record is intent, so an id that is wanted but absent survives other toggles', async () => {
  const harness = await boot()
  harness.registry.register({ id: 'gone-package', name: 'Gone' })
  harness.registry.register({ id: 'other', name: 'Other' })
  await harness.runtime.enable('gone-package')
  await harness.runtime.retire('gone-package')
  await harness.runtime.enable('other')
  equal(
    harness.runtime.persist.read().enabled,
    ['gone-package', 'other'],
    'enabling another project keeps the retired id, so a reinstall can restore it',
  )
  await harness.runtime.disable('other')
  equal(harness.runtime.persist.read().enabled, ['gone-package'], 'and disabling it keeps the retired id too')
})

await test('a project whose apply fails stays in the record, and says so on its card', async () => {
  const harness = await boot()
  harness.registry.register({
    id: 'broken',
    name: 'Broken',
    apply() {
      throw new Error('nope')
    },
  })
  harness.registry.register({ id: 'fine', name: 'Fine' })
  await harness.runtime.enable('broken')
  equal(harness.runtime.persist.read().enabled, ['broken'], 'the choice is recorded even though the apply failed')
  equal(typeof harness.registry.error('broken'), 'string', 'and the card has a reason to show')
  await harness.runtime.enable('fine')
  equal(
    harness.runtime.persist.read().enabled,
    ['broken', 'fine'],
    'toggling another project does not drop the failed one — a transient failure is not a change of mind',
  )
})

await test('adopt applies exactly what the record asks for', async () => {
  const harness = await boot()
  harness.registry.register({ id: 'late', name: 'Late' })
  await harness.runtime.adopt('late')
  equal(harness.registry.isEnabled('late'), false, 'a project nobody asked for is not adopted')

  harness.registry.register({ id: 'default-on-a', name: 'A', defaultEnabled: true })
  harness.registry.register({ id: 'default-on-b', name: 'B', defaultEnabled: true })
  await harness.runtime.adopt('default-on-a')
  await harness.runtime.adopt('default-on-b')
  equal(harness.registry.isEnabled('default-on-b'), true, 'a default-on project IS adopted while the record is uninitialized')
  await harness.runtime.disable('default-on-b')
  equal(
    harness.runtime.persist.read().enabled.includes('default-on-a'),
    true,
    'and the first write is seeded from what is applied, so the other default-on project survives',
  )

  harness.registry.register({ id: 'wanted', name: 'Wanted' })
  await harness.runtime.enable('wanted')
  await harness.runtime.retire('wanted')
  harness.registry.unregister('wanted')
  await harness.runtime.start()
  equal(
    harness.registry.activeIds().includes('wanted'),
    false,
    'a record naming an id no package registers is tolerated by start(), and retire-then-unregister is the order that works',
  )
})

/*
 * WHAT AN UNINSTALL LEAVES BEHIND — the rule in the fallback store, and the inventory it rests on.
 *
 * `load-check.mjs` asserts the same split against the real service on the real Cordis, in the
 * settings document: a package going away removes what the PACKAGE owns (its registration, its
 * stylesheets, its markers, its CSS variables) and keeps what the USER owns (the id in `enabled`,
 * and its entry in `settings`). These two tests are the half that file cannot reach — the
 * `localStorage` fallback record, which stores the same shape and therefore follows the same rule,
 * and the reason a package-owned key needs no cleanup: a package gets no key of its own.
 */
await test("a departed package's settings survive in the fallback record too", async () => {
  const storage = createStorage()
  storage.map.set(
    LOCAL_STORAGE_KEY,
    JSON.stringify({
      v: 1,
      initialized: true,
      touched: true,
      enabled: ['ghost', 'keeper'],
      settings: {
        ghost: { checks: { version: '1.0.0', items: { one: true } }, strength: 7 },
        keeper: { strength: 3 },
      },
    }),
  )
  const harness = await boot({ withStorage: storage })
  equal(harness.persistKind, 'local', 'this boot keeps its record in localStorage, so this is that store')
  harness.registry.register({ id: 'keeper', name: 'Keeper', version: '1.0.0', testItems: [{ id: 'one', label: 'One' }] })
  await harness.runtime.start()

  // The package that owned `ghost` is gone: the client half of an uninstall, in the fallback store.
  await harness.runtime.retire('ghost')
  harness.registry.unregister('ghost')

  const record = JSON.parse(String(storage.map.get(LOCAL_STORAGE_KEY)))
  equal(
    JSON.stringify(record.settings?.ghost),
    JSON.stringify({ checks: { version: '1.0.0', items: { one: true } }, strength: 7 }),
    "the departed package's entry is still there: settings are the user's data in this store as in the document",
  )
  equal(record.enabled.includes('ghost'), true, 'and its id is still in the switch record beside it')
  equal(
    JSON.stringify(record.settings?.keeper),
    '{"strength":3}',
    "while the installed package's entry was never in question",
  )
})

await test('a UI project gets no localStorage key of its own, so an uninstall has none to clean', async () => {
  /*
   * The cleanup half of the decision, made checkable. `withdraw` would remove a package-owned key if
   * one existed; this asserts that none does, and names the inventory so that the day a fifth key
   * appears the suite fails here instead of leaving a key behind on every uninstall.
   *
   * Both halves are PARSED from the sources rather than restated: the key constants are read out of
   * the modules that declare them, and the sweep list out of `LEGACY_LOCAL_KEYS`. A hand-typed copy
   * of a storage key has already been wrong once in this file (see `LOCAL_STORAGE_KEY` above).
   */
  const { readdir } = await import('node:fs/promises')
  const dir = join(packageRoot, 'src', 'client')
  const files = (await readdir(dir, { recursive: true })).filter((name) => String(name).endsWith('.js'))
  /** @type {Set<string>} */
  const declared = new Set()
  /** @type {string[]} */
  const inlineKeys = []
  for (const name of files) {
    const code = stripComments(await readFile(join(dir, String(name)), 'utf8'))
    for (const match of code.matchAll(/const (?:LOCAL_KEY|DEBUG_KEY) = '([^']+)'/g)) declared.add(match[1])
    const legacy = code.match(/LEGACY_LOCAL_KEYS = \[([^\]]*)\]/)
    if (legacy !== null) for (const entry of legacy[1].matchAll(/'([^']+)'/g)) declared.add(entry[1])
    for (const match of code.matchAll(/localStorage\s*\.\s*(?:get|set|remove)Item\(\s*'([^']+)'/g)) inlineKeys.push(match[1])
  }
  equal(
    [...declared].sort().join(','),
    'dsh-liquid-glass.settings,dsh-liquid-glass.settings.version,dsh.ui-projects.debug,dsh.ui-projects.v1',
    'the declared keys are one record, one debug flag, and the two leftovers that are swept on sight',
  )
  equal(
    inlineKeys.join(','),
    '',
    'and no storage call takes a key written inline, which is how a per-project key would arrive unnoticed',
  )
})

await test('a failed write is reported globally, not blamed on a project', async () => {
  const harness = await boot()
  harness.registry.register({ id: 'will-fail-write', name: 'W' })
  const realWrite = harness.runtime.persist.write
  harness.runtime.persist.write = async () => {
    throw new Error('disk full')
  }
  await harness.runtime.enable('will-fail-write')
  const reported = harness.runtime.diagnostics().persistError
  truthy(reported !== undefined, 'a write failure is recorded, not only logged')
  contains(reported.message, 'disk full', 'with the message that says what happened')
  harness.runtime.persist.write = realWrite
  await harness.runtime.disable('will-fail-write')
  equal(harness.runtime.diagnostics().persistError, undefined, 'and a later successful write clears it')
})

await test('a failed write is shown at the top of the section, not blamed on a project', async () => {
  const harness = await boot()
  harness.registry.register({ id: 'banner', name: 'Banner' })
  const realWrite = harness.runtime.persist.write
  harness.runtime.persist.write = async () => {
    throw new Error('quota exceeded')
  }
  await harness.runtime.enable('banner')
  equal(harness.runtime.diagnostics().persistError.message, 'quota exceeded', 'the runtime records the failure')
  const markup = harness.render()
  contains(markup, 'quota exceeded', 'and the section renders it')
  contains(markup, 'uip-error', 'as an error row')
  harness.runtime.persist.write = realWrite
  await harness.runtime.disable('banner')
  excludes(harness.render(), 'quota exceeded', 'and a later successful write takes the banner away')
})

/*
 * THE UNINSTALL SCRIPT'S CHECKS, GUARDED AGAINST DELETION.
 *
 * `install.ps1` writes $DSH_HOME, so no suite runs it — that is the user's to do, and the discipline
 * this project runs under besides. The consequence was that nothing read the file at all: every check
 * Round 38 added (the settings-block comparison, the tombstone scan, the neighbours check, the lockfile
 * probe, the source-integrity hashes) could have been deleted with every suite still green.
 *
 * WHAT THIS GUARD IS AND IS NOT: it catches a check being DELETED, RENAMED or MOVED. It cannot catch
 * one being WEAKENED — a comparison replaced by something that always passes reads the same to a
 * source scan. The real verification is a real uninstall, which is why the manual acceptance steps
 * live in `docs/uninstall.md`.
 */
await test('the uninstall script still contains every check it promises, where it promises it', async () => {
  const source = await readFile(join(packageRoot, 'install.ps1'), 'utf8')
  const branchStart = source.indexOf("Write-Head 'Uninstall plan'")
  // The slice ends where the UPDATE branch begins, not where INSTALL does: with three branches in the
  // file, an end anchor that skips one would let the update mode's text satisfy the uninstall guard.
  const branchEnd = source.indexOf('# =================================================================== UPDATE ===')
  truthy(
    branchStart > 0 && branchEnd > branchStart,
    `the uninstall branch is where this guard looks for it (start=${branchStart}, end=${branchEnd})`,
  )
  const branch = source.slice(branchStart, branchEnd)
  truthy(branch.length > 2000, `the slice is the uninstall branch rather than a fragment (${branch.length} chars)`)

  const required = [
    ['compares the settings block before and after', ['$settingsBlockBefore', '$settingsBlockAfter']],
    ['hashes the source tree before and after', ['sourceManifestSha', 'sourceBundleSha']],
    ['looks for a pnpm tombstone', ['.ignored_*', '$tombstones']],
    ['compares the node_modules inventory', ['$inventoryBefore', '$unexpectedGone']],
    ['probes the lockfile', ['Select-String -LiteralPath $LockPath']],
    ['removes a leftover link through the guard', ['Remove-DirectoryLink']],
    ['asserts the bundle layer is gone', ['dsh.profile.bundles']],
  ]
  for (const [what, needles] of required) {
    const missing = needles.filter((needle) => !branch.includes(needle))
    equal(JSON.stringify(missing), '[]', `the branch still ${what} (missing: ${JSON.stringify(missing)})`)
  }

  const promises = ['the source tree', 'settings.yaml', 'other packages', 'the checklist record', 'version snapshots']
  const unkept = promises.filter((promise) => !branch.includes(promise))
  equal(
    JSON.stringify(unkept),
    '[]',
    `the things the dry run promises not to touch are still named (missing: ${JSON.stringify(unkept)})`,
  )

  /*
   * The position, which is what keeps a dry run dry: the plan, then the exit, then the work. An edit
   * that moved the removal above the exit would turn `-DryRun` into a real uninstall, and that is the
   * one change here whose consequence nobody would notice until it had already happened.
   */
  const dryRunAt = branch.indexOf('if ($DryRun)')
  const exitAt = branch.indexOf('exit 0')
  const removingAt = branch.indexOf("Write-Head 'Removing'")
  equal(
    [dryRunAt, exitAt, removingAt].filter((at) => at <= 0).length,
    0,
    `the dry run, its exit and the removal are all inside the branch (${dryRunAt}, ${exitAt}, ${removingAt})`,
  )
  truthy(dryRunAt < exitAt && exitAt < removingAt, 'and the dry run still exits before anything is removed')
  equal(
    branch.split('if ($DryRun)').length - 1,
    1,
    'exactly one dry-run gate in the branch, so the position compared above is unambiguous',
  )
})

/*
 * THE UPDATE MODE'S PROMISE, GUARDED THE SAME WAY.
 *
 * `-Update` verifies and reports; it writes nothing at all — not the source tree, not the install
 * record, not the profile. That is a promise about ABSENCE, and absence is what a later edit undoes
 * quietly: one `Write-TextFile` slipped in beside a new check would turn a read-only mode into a
 * writing one and leave every suite green. So the absence is asserted directly, over the branch's own
 * source text. When 7c implements the recording step it will have to change this test on purpose,
 * which is the point: permission to write should be granted in the same edit that starts writing.
 */
await test('the update mode is a read-only plan, and refuses to pretend otherwise', async () => {
  const source = await readFile(join(packageRoot, 'install.ps1'), 'utf8')
  const start = source.indexOf("Write-Head 'Update plan'")
  // The end anchor follows the file's own section order: UPDATE stops where SNAPSHOT begins. Leaving it
  // at INSTALL would have let the snapshot mode's text satisfy this guard -- the same trap the uninstall
  // guard's anchor was moved out of when UPDATE was added.
  const end = source.indexOf('# =================================================================== SNAPSHOT ===')
  truthy(start > 0 && end > start, `the update branch is where this guard looks for it (start=${start}, end=${end})`)
  const branch = source.slice(start, end)
  truthy(branch.length > 2000, `the slice is the update branch rather than a fragment (${branch.length} chars)`)

  /*
   * 7c gave this mode permission to write exactly one file, and this is where that permission is
   * granted: the allowlist below is the whole contract. `$StateNew` is the `.new` file the record is
   * written to and read back from; `$StatePath` is the record it then replaces. A write anywhere else in
   * this branch is a write nobody approved.
   */
  const writeVerbs = ['Invoke-Dsh', 'Remove-Item', 'Copy-Item', 'New-Item', 'Set-Content', 'Add-Content', 'Write-TextFile', 'Move-Item']
  const allowedTargets = ['$StateNew', '$StatePath']
  const offenders = []
  for (const line of branch.split('\n')) {
    const verb = writeVerbs.find((candidate) => line.includes(candidate))
    if (verb === undefined) continue
    if (!allowedTargets.some((target) => line.includes(target))) offenders.push(`${verb} -> ${line.trim()}`)
  }
  equal(
    JSON.stringify(offenders),
    '[]',
    `the update branch writes only the install record (offenders: ${JSON.stringify(offenders)})`,
  )
  truthy(branch.includes('$StateNew = "$StatePath.new"'), 'the .new file is the record path, not somewhere else')
  truthy(branch.includes("Write-Head 'Preconditions'"), 'and the preconditions are a section of their own')
  equal(branch.split('if ($DryRun)').length - 1, 1, 'exactly one dry-run gate in the branch')
  const preconditionsAt = branch.indexOf("Write-Head 'Preconditions'")
  const recordWriteAt = branch.indexOf('Write-TextFile $StateNew')
  truthy(
    preconditionsAt > 0 && recordWriteAt > preconditionsAt,
    `they are reported before anything is written (${preconditionsAt} < ${recordWriteAt})`,
  )
  truthy(branch.includes('lastVerified'), 'and the field it writes is the one that was approved')

  // What it does promise, and the four things it promises not to touch.
  const required = [
    ['reads the recorded ui-projects block', ['Get-SettingsBlock']],
    ['fingerprints the source tree with the three exclusions', ["'.git', 'node_modules', 'lib'"]],
    ['reports the registry capability instead of querying', ['link:*', 'no registry version to query']],
    ['records the revision without calling git', ['this mode never calls git']],
    ['prints the newest changelog section(s)', ['CHANGELOG (newest ']],
  ]
  for (const [what, needles] of required) {
    const missing = needles.filter((needle) => !branch.includes(needle))
    equal(JSON.stringify(missing), '[]', `the update branch still ${what} (missing: ${JSON.stringify(missing)})`)
  }
  const promises = ['the source tree', 'settings.yaml', 'other packages', 'the checklist record']
  const unkept = promises.filter((promise) => !branch.includes(promise))
  equal(
    JSON.stringify(unkept),
    '[]',
    `the four things the update plan promises not to touch are named (missing: ${JSON.stringify(unkept)})`,
  )

  /*
   * DEFINITION BEFORE USE, which is where the first manual dry run of this mode died: `$sourceBundle`
   * was defined in the UNINSTALL branch and read here, and `Set-StrictMode -Version 2.0` turned that
   * into `VariableIsUndefined` — the whole run stopped before printing anything. A guard that only
   * asserts a check EXISTS cannot see it; this one compares positions, because the order is the defect.
   */
  const definedAt = branch.indexOf('$sourceBundle = Join-Path')
  const usedAt = branch.indexOf('Get-Sha256 $sourceBundle')
  truthy(definedAt > 0, 'the update branch defines $sourceBundle itself rather than assuming the uninstall branch did')
  truthy(usedAt > 0, 'and uses it for the bundle hash')
  truthy(definedAt < usedAt, `the definition comes first (defined at ${definedAt}, used at ${usedAt})`)

  /*
   * And the same crash from the other direction: `'n/a'.Substring(0, 16)` throws, and the places that
   * print a short hash are exactly the places that can be handed a placeholder — a tree that is not
   * there, a file that was never hashed. Every short hash goes through `Get-ShortSha`, so a raw
   * Substring in this branch is that crash waiting for a different input.
   */
  equal(branch.split('.Substring(0, 16)').length - 1, 0, 'no short hash is taken with a raw Substring')
  truthy(branch.includes('Get-ShortSha'), 'and the helper is what takes them')

  /*
   * A label printed twice: the `settings:` line already carries its own label, and prefixing it printed
   * `settings: settings: {}`. Only a real run shows the output, so this pins the construction — the
   * manual dry run is what proves the line itself, which is the same split Round 40 learned the hard way.
   */
  equal(
    branch.includes('"  settings: $($settingsLine'),
    false,
    'the recorded settings line is not labelled twice',
  )
  truthy(
    branch.includes('Write-Note "  $($settingsLine[0].Trim())"'),
    'and its label is taken from the line itself',
  )
})

/*
 * THE LOCAL SHORT-CIRCUIT IN THE UPDATE BRANCH, AS ITS OWN TEST.
 *
 * The branch's `Preconditions` block already refuses a missing record — through a counter shared with two
 * other preconditions — so the line this test guards is unreachable today. That is the point: the loop
 * that walks `$recorded.PSObject.Properties` must not depend on a reader reconstructing a connection to a
 * counter three sections up. Locking the ORDER makes the invariant local and visible.
 *
 * Its own `test()` rather than three assertions inside the update guard, for the rule in CONTRIBUTING: an
 * assertion added inside an existing test prints nothing of its own, so the count moving is the only
 * evidence it ran.
 */
await test('the update mode cannot walk a record it does not have', async () => {
  const source = await readFile(join(packageRoot, 'install.ps1'), 'utf8')
  const start = source.indexOf("Write-Head 'Update plan'")
  const end = source.indexOf('# =================================================================== SNAPSHOT ===')
  truthy(start > 0 && end > start, `the update branch is where this guard looks for it (start=${start}, end=${end})`)
  const branch = source.slice(start, end)

  const lines = branch.split('\n')
  /*
   * CODE lines only: comment-only lines and `<# … #>` blocks are not code, and this guard's own
   * explanatory comment names `$recorded.PSObject.Properties` while saying why the short-circuit exists.
   * The first version of this test scanned the raw text and failed on that comment — a guard reading its
   * own documentation, which is the same mistake the column's copy guard records in Round 43.
   */
  /** @type {string[]} */
  const code = []
  let inBlockComment = false
  for (const line of lines) {
    let text = line
    if (inBlockComment) {
      const close = text.indexOf('#>')
      if (close < 0) continue
      text = text.slice(close + 2)
      inBlockComment = false
    }
    const open = text.indexOf('<#')
    if (open >= 0) {
      inBlockComment = true
      text = text.slice(0, open)
    }
    if (text.trim().startsWith('#')) continue
    code.push(text)
  }

  let guardAt = -1
  let firstRecordUse = -1
  for (let index = 0; index < code.length; index += 1) {
    if (code[index].includes('there is no install record to extend')) guardAt = index
    if (firstRecordUse < 0 && /\$recorded\.\w/.test(code[index])) firstRecordUse = index
  }
  truthy(guardAt > 0, 'the branch refuses a missing record in its own words, where a reader can find them')
  truthy(
    branch.slice(Math.max(0, branch.indexOf('there is no install record to extend') - 160), branch.indexOf('there is no install record to extend')).includes('if ($recorded -eq $null)'),
    'and that refusal is a short-circuit on the record itself, not a warning that carries on',
  )
  truthy(
    firstRecordUse > guardAt,
    `every read of a record field happens after it (short-circuit on line ${guardAt}, first $recorded.<field> on line ${firstRecordUse})`,
  )
  const recordWriteAt = code.findIndex((line) => line.includes('Write-TextFile $StateNew'))
  truthy(recordWriteAt > guardAt, `and the record is written only after it (${guardAt} < ${recordWriteAt})`)
})

/*
 * `-Package`, THE LAYOUT RULE, AND THE RECORD NAME — the four things that make this script maintain more
 * than one package. Source-level, because install.ps1 cannot be executed by a suite; the parity test below
 * is what turns the one behavioural claim (the mapping) into an executed one.
 */
await test('install.ps1 takes a package name, and the version store keeps one directory per package', async () => {
  const source = await readFile(join(packageRoot, 'install.ps1'), 'utf8')

  truthy(source.includes("[string]$Package = ''"), 'the package can be named on the command line')
  truthy(
    source.includes('no package.json in the source directory, so -Package is the only way'),
    'and when it is not, the source directory has to answer — with a message that says so',
  )

  /*
   * The name must be settled BEFORE any path derived from it. `$LinkPath` is where a scoped package's
   * extra directory level appears, and the version store's directory is spelled from the name; both are
   * built in the path block, so an ordering mistake here would silently address the wrong package.
   */
  const nameSettledAt = source.indexOf('$PackageName = $Package')
  const linkPathAt = source.indexOf('$LinkPath = Join-Path $NodeModulesDir')
  const versionsAt = source.indexOf('$PackageVersionsDir = Join-Path $VersionsDir')
  truthy(nameSettledAt > 0, 'the name is resolved in one place')
  truthy(
    nameSettledAt < linkPathAt && nameSettledAt < versionsAt,
    `and before the paths built from it (${nameSettledAt} < ${linkPathAt}, ${versionsAt})`,
  )
  equal(
    source.includes("$PackageName = 'dsh-ui-projects'"),
    false,
    'the hard-coded package name is gone: nothing may re-pin this script to one package',
  )

  truthy(source.includes('function Get-VersionsDirName('), 'the name-to-directory rule is a function, so it can be executed and compared')
  const rule = source.slice(source.indexOf('function Get-VersionsDirName('), source.indexOf('function Get-VersionsDirName(') + 400)
  truthy(rule.includes("StartsWith('@')"), 'which only rewrites a SCOPED name')
  truthy(rule.includes("Replace('/', '+')"), "using `+`, the separator npm forbids in a name and pnpm's lockfile already uses")
  truthy(
    source.includes('$PackageVersionsDir = Join-Path $VersionsDir $VersionsDirName'),
    'the store directory comes from that rule rather than from the raw name',
  )
  truthy(source.includes('$LinkPath = Join-Path $NodeModulesDir ($PackageName.Replace(\'/\', \'\\\'))'), 'while the node_modules path uses the REAL name, one level deeper for a scope')

  truthy(source.includes("'.dsh-ui-projects-install.json'"), "the framework keeps its record's historical name, so its baseline is not thrown away")
  truthy(
    source.includes('".dsh-ui-projects-install.$VersionsDirName.json"'),
    'and every other package gets a record named after itself',
  )
  truthy(source.includes('REFUSED  -Package names $PackageName, but'), 'a name that disagrees with the source manifest is refused')
  truthy(source.includes('declares $sourceName.'), 'naming both documents, because the usual cause is a -SourceDir one level too high')
})

/**
 * Run `Get-VersionsDirName` OUT of `install.ps1` and against the given names.
 *
 * WHY THIS EXISTS AT ALL. Every other install.ps1 guard reads the script's text, and text can only be
 * judged by its shape: a comparison can be replaced by something that always passes and read identically
 * to a source scan. That limit is written down in `docs/uninstall.md`. The mapping is the one rule in this
 * round that BOTH halves of the system implement — PowerShell writes the directory, the host half reads
 * the store — so it is the one rule that can be checked by running both and comparing.
 *
 * The function's text is sliced out of the script and evaluated in a fresh PowerShell. Nothing else from
 * install.ps1 is executed: no mode runs, no file is touched.
 *
 * THE ANSWER COMES BACK THROUGH A FILE, not through stdout. A piped child fails outright under the
 * sandbox this project's tooling runs in (`spawnSync ... EPERM`, the documented no-named-pipes boundary),
 * and a check that only works when nobody is looking is not a check. PowerShell writes JSON to a file in
 * the OS temp directory and this side reads it — which also survives a PowerShell that decides to write
 * a warning to stdout.
 * @param {string} source install.ps1's text
 * @param {string[]} names package names to map
 * @returns {Promise<Array<{ name: string, dir: string }>>}
 */
async function runPowerShellVersionsDirName(source, names) {
  const start = source.indexOf('function Get-VersionsDirName(')
  if (start < 0) throw new Error('install.ps1 no longer defines Get-VersionsDirName')
  const end = source.indexOf('\n}\n', start)
  if (end < 0) throw new Error('the Get-VersionsDirName function has no end')
  const body = source.slice(start, end + 2)
  const literals = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(', ')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-uipmapping-'))
  const outFile = join(dir, 'mapping.json')
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
  const script = [
    'Set-StrictMode -Version 2.0',
    body,
    `$names = @(${literals})`,
    'try {',
    '    $rows = foreach ($name in $names) { [pscustomobject]@{ name = $name; dir = (Get-VersionsDirName $name) } }',
    `    $text = ($rows | ConvertTo-Json -Compress -Depth 3)`,
    '} catch {',
    '    $text = "ERROR " + $_.Exception.Message',
    '}',
    `[System.IO.File]::WriteAllText(${quote(outFile)}, $text, (New-Object System.Text.UTF8Encoding($false)))`,
  ].join('\n')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' })
    const text = await readFile(outFile, 'utf8')
    if (text.startsWith('ERROR ')) throw new Error(text.trim())
    const parsed = JSON.parse(text.trim())
    return Array.isArray(parsed) ? parsed : [parsed]
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/*
 * THE PARITY ITSELF: the same four names, mapped by both halves, compared.
 *
 * The expected values come from the host half's own function — not from a second literal table — so this
 * asserts AGREEMENT rather than re-asserting one spelling twice. `verify.mjs` is the right home because
 * install.ps1's guards live here; the general contract of the JS function (injectivity, legality as a
 * directory segment) is asserted in `check-installed.test.mjs`, next to the scanner that reads the store.
 */
await test('the version-store layout rule is the same in install.ps1 and in the host half', async () => {
  const { versionsDirNameOf } = await import('../src/host/profile-scan.js')
  const source = await readFile(join(packageRoot, 'install.ps1'), 'utf8')
  // `@a/b/c` is not a legal npm name; it is here because the two implementations must agree on ANY input,
  // and the first version of the JS half replaced only the first separator while PowerShell replaces them
  // all. A parity check that cannot fail on the difference is not a parity check.
  const names = ['dsh-ui-projects', '@xjl-resources/dsh-plugin-liquid-glass', '@scope/name', '@a/b/c']
  let rows
  try {
    rows = await runPowerShellVersionsDirName(source, names)
  } catch (error) {
    throw new Error(`install.ps1's Get-VersionsDirName could not be run: ${String(error?.message ?? error)}`)
  }
  equal(rows.length, names.length, `PowerShell mapped every name it was given (${JSON.stringify(rows)})`)
  for (const row of rows) {
    equal(
      row.dir,
      versionsDirNameOf(row.name),
      `both halves agree on ${row.name} (powershell ${JSON.stringify(row.dir)}, host ${JSON.stringify(versionsDirNameOf(row.name))})`,
    )
  }
  equal(rows[0].dir, 'dsh-ui-projects', "and the framework's own name still maps to itself, as it did before the split")
})

/* ── the wrapper's parameter surface (8e-1) ───────────────────────────────── */

/** The package whose `install.ps1` is a wrapper around this one. Same convention as `load-check.mjs`. */
const skinRoot = resolve(packageRoot, '..', 'dsh-plugin-liquid-glass')

/**
 * Read both scripts' parameter surfaces, from PowerShell's own parser, in a fresh powershell.exe.
 *
 * The tool is a FILE rather than a `-Command` string on purpose: a PowerShell script assembled inside a
 * JavaScript string has to survive two levels of quoting, and building one by hand during the 8e-1
 * planning destroyed the parser on the first attempt (`Unexpected token '\'`). The paths are passed as
 * SCALARS for the same reason in the other direction: a comma-separated list does not survive the Node →
 * powershell.exe boundary as an array (it arrives as one string), and PowerShell 5.1 refuses a repeated
 * `-Path` for a `[string[]]`.
 *
 * The answer comes back through a file, not through stdout: a piped child fails under this project's
 * sandbox (`spawnSync ... EPERM`, the documented no-named-pipes boundary). Same arrangement, and the same
 * reason, as `runPowerShellVersionsDirName` above.
 * @returns {Promise<{ framework: Record<string, string>, wrapper: Record<string, string>, frameworkParamBlock: string }>}
 */
async function runPowerShellParamSurface(frameworkPath, wrapperPath) {
  const tool = join(packageRoot, 'scripts', 'param-surface.ps1')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-uiparams-'))
  const outFile = join(dir, 'surface.json')
  try {
    try {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tool,
          '-Framework', frameworkPath, '-Wrapper', wrapperPath, '-Out', outFile],
        { stdio: 'ignore' },
      )
    } catch (error) {
      throw new Error(`scripts/param-surface.ps1 failed (exit ${error?.status ?? '?'}): ${String(error?.message ?? error)}`)
    }
    const parsed = JSON.parse((await readFile(outFile, 'utf8')).trim())
    if (parsed.framework === undefined || parsed.wrapper === undefined || typeof parsed.frameworkParamBlock !== 'string') {
      throw new Error(`the tool reported no comparable surface: ${JSON.stringify(parsed)}`)
    }
    return parsed
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Write a FAKE framework `install.ps1` into its own temporary directory.
 *
 * It declares the framework's REAL parameter block — handed over by the tool above, so the binding rules
 * under test are the framework's own rather than a stub's idea of them — and its whole body writes one
 * JSON file inside the directory it lives in. **It contains no statement that reads or writes
 * `$DSH_HOME`, a profile, a settings document or any other path**: the two lines below are the complete
 * list of what it does. `-SourceDir` and everything else come from the wrapper.
 * @param {string} dir @param {string} paramBlock
 */
async function writeFakeFramework(dir, paramBlock) {
  const body = [
    paramBlock,
    'Set-StrictMode -Version 2.0',
    '$bound = [ordered]@{}',
    'foreach ($key in ($PSBoundParameters.Keys | Sort-Object)) { $bound[$key] = "$($PSBoundParameters[$key])" }',
    "$path = Join-Path $PSScriptRoot 'bound.json'",
    '[System.IO.File]::WriteAllText($path, ($bound | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))',
    'exit 0',
  ].join('\n')
  await writeFile(join(dir, 'install.ps1'), body, 'utf8')
}

/** Key order is not part of the claim, so both sides are canonicalized before they are compared. */
const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort()))

/**
 * Run a wrapper script against a fake framework and report what the fake was handed.
 * @param {string} wrapperPath @param {string} fakeDir @param {string[]} args
 * @returns {Promise<Record<string, string>>}
 */
async function runWrapperAgainstFakeFramework(wrapperPath, fakeDir, args) {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath, '-FrameworkDir', fakeDir, ...args],
    { stdio: 'ignore' },
  )
  return JSON.parse((await readFile(join(fakeDir, 'bound.json'), 'utf8')).trim())
}

/*
 * TWO SUITES' WORTH OF GUARD, FOR THE ONE THING THAT MADE A MAINTENANCE COMMAND RUN AN INSTALL.
 *
 * `install.ps1 -Snapshot`, run in a UI project package's directory, used to run the framework's script
 * with `$To = '-Snapshot'` and no verb at all — and the framework's mode selection falls through to
 * INSTALL when no verb is bound. It did not fail; it installed. The cause was the wrapper's forwarding:
 * `[Parameter(ValueFromRemainingArguments)] $Rest` collects a switch as the STRING `'-Snapshot'`, and
 * `@Rest` splats that string POSITIONALLY, where it binds to the first positional parameter.
 *
 * So there are two claims to hold, and they are different in kind: the wrapper must DECLARE the whole
 * surface (static, read from the parser), and it must FORWARD what it was given by name (behavioural, and
 * only a real run can show it). Hence two tests.
 */
await test('the wrapper accepts the framework’s whole parameter surface, with the same types', async () => {
  const surface = await runPowerShellParamSurface(join(packageRoot, 'install.ps1'), join(skinRoot, 'install.ps1'))
  const expected = Object.fromEntries(Object.entries(surface.framework).filter(([name]) => name !== 'SourceDir'))
  const missing = Object.keys(expected).filter((name) => surface.wrapper[name] === undefined)
  const spurious = Object.keys(surface.wrapper).filter((name) => name !== 'FrameworkDir' && surface.framework[name] === undefined)
  const wrongType = Object.keys(expected)
    .filter((name) => surface.wrapper[name] !== undefined && surface.wrapper[name] !== expected[name])
    .map((name) => `${name}: wrapper ${surface.wrapper[name]} vs framework ${expected[name]}`)

  equal(missing, [], 'the wrapper declares every parameter the framework accepts, except the source directory it sets itself')
  equal(spurious, [], 'and declares nothing the framework itself would refuse')
  equal(
    surface.framework.Snapshot,
    'SwitchParameter',
    'the parse reads TYPES rather than names: the framework’s -Snapshot is a switch, not a string',
  )
  equal(wrongType, [], 'each declared parameter has the same TYPE, so a switch cannot silently become a string')
  equal(surface.wrapper.Rest, undefined, 'the wrapper declares no positional remainder any more')
  equal(surface.wrapper.FrameworkDir, 'String', 'and the one parameter that is the wrapper’s own is declared')
})

await test('every argument the card prints arrives at the framework as the parameter it names', async () => {
  /*
   * Runs the REAL wrapper from the sibling package, against a FAKE install.ps1 written into mkdtemp. The
   * iron rule forbids running the FRAMEWORK's install.ps1 (it writes $DSH_HOME); this test executes only
   * the wrapper's forwarding path, whose target is a stub that writes to its own temp dir and nothing
   * else. The real file is the subject — a stub of the wrapper would prove only that a stub can forward.
   */
  const surface = await runPowerShellParamSurface(join(packageRoot, 'install.ps1'), join(skinRoot, 'install.ps1'))
  const fakeDir = await mkdtemp(join(tmpdir(), 'dsh-uipwrapper-'))
  try {
    await writeFakeFramework(fakeDir, surface.frameworkParamBlock)
    /*
     * THE SAFETY OF THE PROBE, AS A GUARD RATHER THAN AS A PROMISE. The fake is the only thing this test
     * executes besides the wrapper, so what it can reach is worth pinning: no environment variable, no
     * profile, no settings document, no version store, and not a single absolute path — the one path it
     * writes is built from its own directory, which is the mkdtemp this test removes in `finally`.
     * A future edit that reached for `$env:DSH_HOME` to "make the fake more realistic" fails here.
     */
    const fakeSource = await readFile(join(fakeDir, 'install.ps1'), 'utf8')
    equal(
      ['DSH_HOME', '$HOME', 'profiles', 'settings', 'Remove-Item', 'New-Item', 'Set-Content', 'Start-Process']
        .filter((token) => fakeSource.includes(token)),
      [],
      'the fake framework names no environment variable, profile, settings document or store',
    )
    equal(
      [...fakeSource.matchAll(/[A-Za-z]:\\/g)].map((match) => match[0]),
      [],
      'and contains no absolute path at all: the file it writes is built from $PSScriptRoot',
    )
    const wrapper = join(skinRoot, 'install.ps1')
    const cases = [
      ['a snapshot', ['-Snapshot'], { Snapshot: 'True' }],
      ['a rollback to a named version', ['-Rollback', '-To', '03-v1.0.0'], { Rollback: 'True', To: '03-v1.0.0' }],
      ['an update', ['-Update'], { Update: 'True' }],
      ['a version listing', ['-ListVersions'], { ListVersions: 'True' }],
      ['a dry run of an uninstall', ['-DryRun', '-Uninstall'], { DryRun: 'True', Uninstall: 'True' }],
      ['an override of two framework defaults', ['-Profile', 'desktop', '-Keep', '5'], { Profile: 'desktop', Keep: '5' }],
      ['nothing at all', [], {}],
    ]
    for (const [what, args, expected] of cases) {
      const received = await runWrapperAgainstFakeFramework(wrapper, fakeDir, args)
      equal(
        canonical(received),
        canonical({ ...expected, SourceDir: skinRoot }),
        `the framework receives ${what} (${JSON.stringify(received)})`,
      )
    }
    /*
     * `-FrameworkDir` is the wrapper's OWN parameter: the framework script has never heard of it, so
     * forwarding it is a refusal rather than a no-op. Every case above passes it (it is how the fake is
     * found) and none of them may see it arrive — the equality assertions already imply that, and this
     * one says it out loud so a failure reads as "the wrapper forwarded its own switch".
     */
    const received = await runWrapperAgainstFakeFramework(wrapper, fakeDir, ['-Snapshot'])
    equal(
      Object.keys(received).includes('FrameworkDir'),
      false,
      'and the wrapper excludes its own -FrameworkDir from what it forwards',
    )
    /*
     * THE OTHER DIRECTION, so this probe is known to be able to fail. The old shape is written here
     * rather than patched into the package: a probe proven only against the fixed file proves that the
     * probe runs, not that it would have caught anything.
     */
    const oldShapeDir = await mkdtemp(join(tmpdir(), 'dsh-uipoldwrapper-'))
    try {
      const oldShape = [
        '[CmdletBinding()]',
        'param(',
        "    [string]$FrameworkDir = '',",
        '    [Parameter(ValueFromRemainingArguments = $true)]',
        '    $Rest',
        ')',
        "& (Join-Path $FrameworkDir 'install.ps1') -SourceDir $PSScriptRoot @Rest",
        'exit $LASTEXITCODE',
      ].join('\n')
      const oldShapePath = join(oldShapeDir, 'install.ps1')
      await writeFile(oldShapePath, oldShape, 'utf8')
      const misbound = await runWrapperAgainstFakeFramework(oldShapePath, fakeDir, ['-Snapshot'])
      equal(
        misbound.To,
        '-Snapshot',
        'and the probe can see the old shape fail: the positional remainder binds the switch into -To',
      )
    } finally {
      await rm(oldShapeDir, { recursive: true, force: true })
    }
  } finally {
    await rm(fakeDir, { recursive: true, force: true })
  }
})

/*
 * EVERY FIRST-CLASS PACKAGE IS IN THE SNAPSHOT ROOTS.
 *
 * `tools/snapshot.mjs` protects the trees that are NOT under version control, and its `ROOTS` list is a
 * description of this workspace that nothing was checking. Two packages were missing from it when this test
 * was written: `dsh-ui-project-skeleton` (uncovered since it was created) and `dsh-plugin-liquid-glass` (a
 * package as of step 8b). Both had git, so neither was one edit from being unrecoverable — but a package
 * with no history and no backup would be, and this project has lost a source tree twice.
 *
 * ASSERTED AS A PROPERTY OF THE DIRECTORY, not as a list of three names: every `plugins/dsh-*` directory
 * must be covered. A package added tomorrow fails this test until its root is added, which is the failure
 * the skeleton went without for several rounds.
 *
 * The tool is a SCRIPT, so it cannot be imported without running it — the roots are read out of its source,
 * and the same reading is asserted in both directions (a root that points at nothing protects nothing).
 */
await test('every package under plugins/ is covered by a snapshot root', async () => {
  const workspaceRoot = resolve(packageRoot, '..', '..')
  const toolPath = join(workspaceRoot, 'tools', 'snapshot.mjs')
  const source = await readFile(toolPath, 'utf8')
  const roots = [...source.matchAll(/dir:\s*path\.join\(ROOT,\s*'plugins',\s*'([^']+)'\)/g)].map((match) => match[1])
  truthy(roots.length >= 2, `the snapshot tool lists the plugin packages it protects (${JSON.stringify(roots)})`)

  const packages = (await readdir(join(workspaceRoot, 'plugins'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('dsh-'))
    .map((entry) => entry.name)
    .sort()
  truthy(packages.length >= 2, `and there are packages to protect (${JSON.stringify(packages)})`)

  const uncovered = packages.filter((name) => !roots.includes(name))
  equal(uncovered, [], `every package has a snapshot root (uncovered: ${JSON.stringify(uncovered)})`)
  const dangling = []
  for (const name of roots) {
    try {
      await stat(join(workspaceRoot, 'plugins', name))
    } catch {
      dangling.push(name)
    }
  }
  equal(dangling, [], `and every root points at a directory that exists (dangling: ${JSON.stringify(dangling)})`)
  truthy(
    source.includes("path.join(ROOT, 'tools')"),
    'with tools/ still covered, where the unversioned scripts (this test’s subject among them) live',
  )
})

/*
 * THE SNAPSHOT SECTION, WHICH HAS ONE WRITING HALF AND ONE READ-ONLY HALF.
 *
 * `-Snapshot` writes version copies under the profile's `.dsh-ui-projects-versions\`; `-ListVersions`
 * only reads them. The guard therefore splits the section at the listing header: above it, every write
 * verb must be addressed into the version store; below it, there must be no write verb at all. That is a
 * line-scoped check because a destination is the only thing a source scan can honestly judge — and the
 * variables are named `$SnapshotDir` / `$SnapshotPayload` / `$OldSnapshotDir` so the invariant is
 * checkable rather than merely intended.
 */
await test('the snapshot mode writes only inside the version store, and verifies what it wrote', async () => {
  const source = await readFile(join(packageRoot, 'install.ps1'), 'utf8')
  const start = source.indexOf('# =================================================================== SNAPSHOT ===')
  // The end anchor follows the file's own section order: SNAPSHOT stops where ROLLBACK begins.
  const end = source.indexOf('# =================================================================== ROLLBACK ===')
  truthy(start > 0 && end > start, `the snapshot section is where this guard looks for it (start=${start}, end=${end})`)
  const section = source.slice(start, end)
  truthy(section.length > 2000, `the slice is the whole section rather than a fragment (${section.length} chars)`)

  /*
   * The pair refusal moved to the mode matrix in 7c, on purpose: a preflight failure (no `dsh`, no
   * profile) must not be reported instead of two modes being named. So the matrix is checked here rather
   * than the section -- and the section must NOT still carry a second, unreachable copy of the same check.
   */
  const matrixStart = source.indexOf('$modeSwitches = @()')
  const matrixEnd = source.indexOf('$mode = if ($Uninstall)')
  truthy(matrixStart > 0 && matrixEnd > matrixStart, 'the mode matrix is where this guard looks for it')
  const matrix = source.slice(matrixStart, matrixEnd)
  for (const mode of ['-Uninstall', '-Update', '-Snapshot', '-ListVersions', '-Rollback']) {
    truthy(matrix.includes(`'${mode}'`), `the matrix lists ${mode}`)
  }
  truthy(matrix.includes("$modeSwitches -join ' and '"), 'and refuses any two of them together, naming both')
  equal(
    section.includes('if ($Snapshot -and $ListVersions)'),
    false,
    'the snapshot section no longer carries a second, unreachable copy of that refusal',
  )

  truthy(section.includes("'^[A-Za-z0-9._-]+$'"), 'a snapshot name is validated as a directory name')

  const splitAt = section.indexOf('Write-Head "Versions (newest')
  truthy(splitAt > 0, 'the read-only listing half is inside this section')
  const writing = section.slice(0, splitAt)
  const listing = section.slice(splitAt)

  const verbs = ['Copy-Item', 'New-Item', 'Remove-Item', 'Write-TextFile', 'Set-Content', 'Add-Content', 'Invoke-Dsh']
  // Tightened in 7c: the parent directory is NOT an allowed destination, only the snapshot's own paths.
  const allowed = ['$SnapshotDir', '$SnapshotPayload', '$OldSnapshotDir']
  const offenders = []
  for (const line of writing.split('\n')) {
    const verb = verbs.find((candidate) => line.includes(candidate))
    if (verb === undefined) continue
    if (!allowed.some((name) => line.includes(name))) offenders.push(`${verb} -> ${line.trim()}`)
  }
  equal(
    JSON.stringify(offenders),
    '[]',
    `every write in the snapshot half names the version store (offenders: ${JSON.stringify(offenders)})`,
  )
  equal(
    writing.split('\n').filter((line) => verbs.some((verb) => line.includes(verb)) && line.includes('$SourceDir')).length,
    0,
    'and no write is addressed at the source tree',
  )
  equal(writing.includes('Write-TextFile $StatePath'), false, 'the snapshot mode does not rewrite the install record')

  for (const [what, needle] of [
    ['verifies the copy by reading it back', 'read-back: comparing every written file against the manifest'],
    ['removes an unverified snapshot instead of registering it', 'the incomplete snapshot was removed'],
    ['names what it pruned, and only what it wrote', 'not written by this tool, so left alone'],
    ['announces the retention decision', 'nothing would be pruned'],
  ]) {
    truthy(writing.includes(needle), `and ${what}`)
  }

  /*
   * THE READ-ONLY HALF NAMES THE SNAPSHOTS NOBODY CAN ATTRIBUTE.
   *
   * The version store keys its directories by a package name spelled for a filesystem, and the page reads
   * each snapshot's own `manifest.package` rather than decoding that spelling back. A directory whose
   * snapshots record no package therefore belongs to no card — so the listing warns about it and the
   * summary counts it, which is the CLI half of the outlet `check-installed.mjs` provides for a scan.
   */
  truthy(
    listing.includes('records no package, so Settings > UI plugins cannot show it against a card'),
    'the listing warns about a snapshot whose manifest records no package',
  )
  truthy(
    listing.includes('$unattributed -gt 0'),
    'and counts those in the summary, rather than leaving a warning among the rows to be missed',
  )

  /*
   * The order, which is the safety property: the dry run exits first, the copy is read back second, and
   * only then can anything be removed. Pruning after the verification is what keeps a failed snapshot
   * from costing an old one.
   */
  const dryRunAt = writing.indexOf('if ($DryRun)')
  const readBackAt = writing.indexOf('read-back: comparing')
  const firstRemoveAt = writing.indexOf('Remove-Item')
  truthy(
    dryRunAt > 0 && readBackAt > dryRunAt && firstRemoveAt > readBackAt,
    `the dry run exits, then the copy is read back, and only then can anything be removed (${dryRunAt} < ${readBackAt} < ${firstRemoveAt})`,
  )

  const listingWrites = verbs.filter((verb) => listing.includes(verb))
  equal(
    JSON.stringify(listingWrites),
    '[]',
    `the listing half contains no write verb at all (found: ${JSON.stringify(listingWrites)})`,
  )
})

/*
 * THE ONE MODE THAT WRITES THE SOURCE TREE, GUARDED ACCORDINGLY.
 *
 * `-Rollback -To` restores `package.json` and `lib/**`, and nothing else, in a fixed order: verify the
 * snapshot, copy the current tree out of the way, read that copy back, then write, then re-verify. All of
 * it is asserted here because a rollback is the most dangerous thing in this file — the project has lost
 * its source tree twice, and one earlier rollback deleted a file instead of writing the backup back.
 */
await test('the rollback mode writes only the two source files it promises to, in the order it promises', async () => {
  const source = await readFile(join(packageRoot, 'install.ps1'), 'utf8')
  const start = source.indexOf('# =================================================================== ROLLBACK ===')
  const end = source.indexOf('# =================================================================== INSTALL ===')
  truthy(start > 0 && end > start, `the rollback section is where this guard looks for it (start=${start}, end=${end})`)
  const section = source.slice(start, end)
  truthy(section.length > 2000, `the slice is the whole section rather than a fragment (${section.length} chars)`)

  const splitAt = section.indexOf('Write-Head "Restorable snapshots')
  truthy(splitAt > 0, 'the read-only listing half is the second half of this section')
  const writing = section.slice(0, splitAt)

  // -To becomes a directory name, so it is validated exactly as -Snapshot -Name is.
  truthy(writing.includes("'^[A-Za-z0-9._-]+$'"), 'the snapshot name is validated against the same strict pattern')
  truthy(writing.includes('REFUSED  -To must match'), 'and the refusal names the flag and the pattern')

  const verbs = ['Copy-Item', 'New-Item', 'Remove-Item', 'Write-TextFile', 'Move-Item', 'Set-Content', 'Add-Content', 'Invoke-Dsh']
  const allowed = ['$SnapshotPayload', '$SnapshotDir', '$RollbackBackupPayload', '$RollbackBackupDir', '$OldSnapshotDir', '$sourceManifest', '$sourceLib', '$StateNew', '$StatePath']
  const offenders = []
  for (const line of writing.split('\n')) {
    const verb = verbs.find((candidate) => line.includes(candidate))
    if (verb === undefined) continue
    if (!allowed.some((target) => line.includes(target))) offenders.push(`${verb} -> ${line.trim()}`)
  }
  equal(JSON.stringify(offenders), '[]', `every write names an approved destination (offenders: ${JSON.stringify(offenders)})`)

  // Non-vacuous: the two writes into the tree are really there, and nothing touches .git.
  truthy(
    writing.split('\n').some((line) => line.includes('Copy-Item') && line.includes('$sourceManifest')),
    'the write to package.json is there',
  )
  truthy(
    writing.split('\n').some((line) => line.includes('Copy-Item') && line.includes('$sourceLib')),
    'and so is the write under lib/',
  )
  equal(
    writing.split('\n').filter((line) => verbs.some((verb) => line.includes(verb)) && line.includes('.git')).length,
    0,
    'and nothing in this mode writes inside .git',
  )

  // The backup is a SIBLING of the package directories, never inside them: -ListVersions walks those, and
  // a backup parked there would be listed as a version somebody could roll back to.
  const backupDef = writing.split('\n').find((line) => line.includes('$RollbackBackupDir = Join-Path'))
  truthy(backupDef !== undefined, 'the backup directory is defined in this mode')
  truthy(backupDef.includes('$VersionsDir'), 'under the versions directory')
  equal(
    backupDef.includes('$PackageVersionsDir'),
    false,
    'and NOT inside the package directory that the version listing walks',
  )

  for (const [what, needle] of [
    ['says the backup comes first', 'backup before writing'],
    ['refuses a snapshot that does not verify', 'does not verify, so it will not be restored'],
    ['reports a differing patch rather than restoring it quietly', 'patch differs'],
    ['stops and keeps both copies when the restore does not verify', 'stopped: nothing further was written'],
    ['records what it did', 'lastRollback'],
  ]) {
    truthy(writing.includes(needle), `it ${what}`)
  }

  /*
   * THE NAME USED FOR THE COPY AND THE NAME RECORDED IN THE MANIFEST MUST BE ONE NAME.
   *
   * They were two: the copy dropped the `lib/` prefix that the manifest carried, so every file in the
   * backup read back as "missing" while sitting on disk one level up. The verification was right and the
   * layout was wrong. A guard cannot run the copy — but it can assert that those two lines cannot drift
   * apart, which IS the defect.
   */
  truthy(
    writing.split('\n').some((line) => line.includes("$relFull = 'lib/'")),
    'the backup builds one name per file, prefixed with lib/',
  )
  truthy(
    writing.split('\n').some(
      (line) => line.includes('Copy-Item') && line.includes('$RollbackBackupPayload') && line.includes('$relFull'),
    ),
    'the copy destination uses that one name',
  )
  truthy(writing.split('\n').some((line) => line.includes('rel = $relFull')), 'and so does the manifest entry')
  equal(writing.includes('rel = "lib/$rel"'), false, 'the form that prefixed the manifest but not the copy is not back')

  /*
   * And the order inside the backup is explicit: copy, then write the manifest, then verify it. Written
   * the other way round, the manifest would describe files that had not been copied yet.
   */
  const copyAt = writing.indexOf('Copy-Item -LiteralPath $entry.FullName')
  const manifestAt = writing.indexOf("Write-TextFile (Join-Path $RollbackBackupDir 'manifest.json')")
  const backupVerifyAt = writing.indexOf('Test-VersionSnapshot $RollbackBackupDir')
  truthy(
    copyAt > 0 && manifestAt > copyAt && backupVerifyAt > manifestAt,
    `the backup copies, then writes its manifest, then verifies it (${copyAt} < ${manifestAt} < ${backupVerifyAt})`,
  )

  /*
   * The order, which IS the safety property: refuse a bad snapshot, back the tree up, read that backup
   * back, only then write, and re-verify afterwards. Pruning and the record come after the re-verification.
   */
  const verifyAt = writing.indexOf('does not verify, so it will not be restored')
  const backupAt = writing.indexOf("Write-Head 'Backup'")
  const backupReadBackAt = writing.indexOf('the backup did not verify')
  const restoreAt = writing.indexOf("Write-Head 'Restoring'")
  const reVerifyAt = writing.indexOf("Write-Head 'Re-verify'")
  truthy(
    verifyAt > 0 && backupAt > verifyAt && backupReadBackAt > backupAt && restoreAt > backupReadBackAt && reVerifyAt > restoreAt,
    `the order is refuse, back up, read the backup back, write the tree, re-verify (${verifyAt} < ${backupAt} < ${backupReadBackAt} < ${restoreAt} < ${reVerifyAt})`,
  )
})

await test('the rollback listing half is read-only', async () => {
  const source = await readFile(join(packageRoot, 'install.ps1'), 'utf8')
  const start = source.indexOf('Write-Head "Restorable snapshots')
  const end = source.indexOf('# =================================================================== INSTALL ===')
  truthy(start > 0 && end > start, `the listing half is where this guard looks for it (${start}, ${end})`)
  const listing = source.slice(start, end)
  truthy(listing.length > 200, `and it is a real slice (${listing.length} chars)`)
  const verbs = ['Copy-Item', 'New-Item', 'Remove-Item', 'Write-TextFile', 'Move-Item', 'Set-Content', 'Add-Content', 'Invoke-Dsh']
  const found = verbs.filter((verb) => listing.includes(verb))
  equal(JSON.stringify(found), '[]', `the listing half contains no write verb at all (found: ${JSON.stringify(found)})`)
  truthy(listing.includes('can be restored'), 'and it says how many snapshots can be restored')
})

/*
 * THE MAINTENANCE COMMANDS IN THE PLUGINS COLUMN (7d-1).
 *
 * Printed, never run — the whole file's rule — and addressed at a PACKAGE, which the heading has to say
 * because the framework and the built-in skin ship in one package today: a person reading the Liquid
 * Glass card would otherwise take `install.ps1 -Update` for Liquid Glass maintenance.
 */
await test('the plugins column prints the maintenance commands, addressed at the package', async () => {
  const readyScan = {
    profileName: 'web',
    /*
     * BOTH KINDS OF ROW, because they are not rendered by the same code: the framework's row skips the
     * REMOVAL block — it is the thing rendering the list — and it must not skip this one. The first
     * version of the maintenance block lived inside that removal block, and the framework row lost it.
     */
    dependencies: [
      { name: 'dsh-ui-projects', version: '0.1.0', kind: 'ui-project', bundled: true, problems: [] },
      { name: 'dsh-ui-project-x', version: '1.0.0', kind: 'bundle', bundled: true, problems: [] },
    ],
    orphanedBindings: [],
  }
  for (const locale of ['en', 'zh']) {
    const dictionary = strings(locale)
    const copy = dictionary.plugins
    const markup = renderSection({
      store: { state: () => ({ status: 'ready', scan: readyScan }), refresh: async () => {} },
      t: dictionary,
      React: react,
    })
    contains(markup, 'data-uip-maintenance="dsh-ui-project-x"', 'the row carries the maintenance block (' + locale + ')')
    /*
     * And the FRAMEWORK's row carries it too. This is the assertion whose absence let a real bug ship: the
     * block was inside the removal block, which the framework row skips by design, so the one package whose
     * ordinary case is updating-and-rolling-back had no maintenance commands at all.
     */
    contains(markup, 'data-uip-maintenance="dsh-ui-projects"', 'and so does the framework row (' + locale + ')')
    contains(
      markup,
      copy.maintenanceTitle('dsh-ui-projects'),
      'whose heading names the framework package (' + locale + ')',
    )
    const rows = markup.split('data-uip-maintenance="').length - 1
    equal(rows, 2, 'one maintenance block per row, with no row skipped (' + locale + ')')
    contains(markup, copy.maintenanceTitle('dsh-ui-project-x'), 'whose heading names the package (' + locale + ')')
    for (const verb of ['snapshot', 'update', 'rollback']) {
      contains(
        markup,
        'data-uip-command-maintenance="' + verb + '"',
        'and the ' + verb + ' command is printed with its hook (' + locale + ')',
      )
    }
    contains(markup, 'install.ps1 -Snapshot', 'the snapshot command is the exact one (' + locale + ')')
    contains(markup, 'install.ps1 -Update', 'so is the update command (' + locale + ')')
    contains(markup, 'install.ps1 -Rollback -To', 'and the rollback command (' + locale + ')')
    contains(markup, copy.restartReminder, 'with the restart reminder (' + locale + ')')
    contains(markup, copy.cmdRollbackList, 'and how to list the restorable names (' + locale + ')')
  }
  // The fifth "not touched" item is rendered, not merely present in the dictionary.
  contains(
    renderSection({
      store: { state: () => ({ status: 'ready', scan: readyScan }), refresh: async () => {} },
      t: strings('en'),
      React: react,
    }),
    'version snapshots',
    'and the fifth thing a removal leaves alone is on the page',
  )
})

/*
 * THE HOST HALF'S READ-ONLY PROMISE, GUARDED BY SOURCE.
 *
 * `readVersions` walks a directory the user owns and reads manifests out of it. A write there would be a
 * write to `$DSH_HOME` from a code path nobody runs by hand — the same technique the conformance suite
 * uses for `check-installed.mjs`, applied to the module that now touches the version store.
 */
await test('the host modules that read the version store contain no write API', async () => {
  const writeApis = ['writeFile', 'appendFile', 'mkdir', 'rmdir', 'unlink', 'rename', 'copyFile', 'createWriteStream', 'truncate']
  for (const file of ['profile-scan.js', 'installed-endpoint.js']) {
    const text = await readFile(join(packageRoot, 'src', 'host', file), 'utf8')
    const found = writeApis.filter((api) => text.includes(api))
    equal(JSON.stringify(found), '[]', `${file} writes nothing (found: ${JSON.stringify(found)})`)
  }
  const scan = await readFile(join(packageRoot, 'src', 'host', 'profile-scan.js'), 'utf8')
  truthy(scan.includes('VERSIONS_DIR_NAME'), 'and the version store is named in one place')
  truthy(scan.includes('VERSIONS_MAX'), 'with a bounded number of snapshots crossing the wire')
})

/*
 * THE VERSION SENTENCE ON A PROJECT'S CARD (7d-2a).
 *
 * Four states, and only three of them are claims about the profile: the fourth is the page saying nothing
 * because it has read nothing. The card's maintenance block is rendered through the section WITH props,
 * which is the only way to reach the optional `installed` store — the registered section is a
 * zero-argument closure, so a test through it could not exercise any of this.
 */
const renderProjectsWith = (harness, installed) =>
  server.renderToStaticMarkup(
    react.createElement(UiProjectsSection, {
      store: harness.store,
      t: strings('en'),
      installed,
    }),
  )
const installedStoreLike = (state) => ({ state: () => state })
const scanWith = (versions, version = '0.1.0') => ({
  profileName: 'web',
  dependencies: [{ name: 'dsh-ui-projects', version, kind: 'ui-project', bundled: true, problems: [] }],
  orphanedBindings: [],
  ...(versions === undefined ? {} : { versions }),
})

await test('the card says which state the version information is in, and never more than it knows', async () => {
  const harness = await boot()
  /*
   * WHICH NAME THE CARD LOOKS UP. A card asks for `project.package` (falling back to this package's
   * own name), so the fixture has to key `versions` by THAT string and also list that same name in
   * `dependencies` — the comparison in the card is between the newest snapshot's version and the
   * version the scan reports for the same package.
   *
   * This test used to read the name off `projects[0]` and rely on `scanWith`'s hard-coded
   * `dsh-ui-projects`: it passed only because the first project was the skin this package shipped,
   * which has no `package` field, so the fallback produced a name that matched. Step 8c removed that
   * skin, `projects[0]` became the fixture (whose package is `test-skin-package`), the lookup fell to
   * "no entries" and the state below came out `different` — a fixture that had been agreeing with the
   * product by accident. `scanFor` states both halves of the pair explicitly.
   */
  const packageName = harness.store.snapshot().projects[0]?.package
  /*
   * THE PRECONDITION, STATED. It used to be `?? 'dsh-ui-projects'` — a silent fallback that made the
   * fixture agree with the product no matter which of them was wrong, and that is the exact shape of
   * fallback step 8e-2 removed from the product. A fixture that cannot name a package has nothing to
   * test here, so it says so instead of inventing a name.
   */
  truthy(
    typeof packageName === 'string' && packageName.length > 0,
    'the fixture names a package, which every case below is about',
  )
  const scanFor = (versions, version = '0.1.0') => ({
    ...scanWith(versions, version),
    dependencies: [{ name: packageName, version, kind: 'ui-project', bundled: true, problems: [] }],
  })

  // No `versions` field at all: the host that answered has no such code.
  const stale = renderProjectsWith(harness, installedStoreLike({ status: 'ready', scan: scanFor(undefined) }))
  contains(stale, 'data-uip-version-state="host-stale"', 'a host without the field is reported as needing a restart')
  contains(stale, strings('en').snapshotHostStale, 'in words that say so')

  // The field is there and this package has none recorded: a fact about the profile.
  const none = renderProjectsWith(harness, installedStoreLike({ status: 'ready', scan: scanFor({ [packageName]: [] }) }))
  contains(none, 'data-uip-version-state="none"', 'an empty list is a different state from a missing field')
  contains(none, strings('en').snapshotNone, 'with its own sentence')

  // Entries, matching what is installed. The stamp is the shape the host really sends — .NET's
  // round-trip format, seven fractional digits and all — because that is the value a reader was shown.
  const same = renderProjectsWith(
    harness,
    installedStoreLike({
      status: 'ready',
      scan: scanFor({
        [packageName]: [{ name: '01-v0.1.0', version: '0.1.0', createdAt: '2026-09-27T08:15:00.1234567Z' }],
      }),
    }),
  )
  contains(same, 'data-uip-version-state="same"', 'a snapshot matching the installed version says so')
  contains(same, '01-v0.1.0', 'and names the snapshot')
  contains(same, '2026-09-27 08:15 UTC', 'and shows when it was taken, as a reader can read it (7e)')
  excludes(same, '2026-09-27T08:15:00.1234567Z', 'never as the raw host stamp, whose precision is noise on a card')

  // Entries that differ: the state the badge exists for.
  const different = renderProjectsWith(
    harness,
    installedStoreLike({
      status: 'ready',
      scan: scanFor({ [packageName]: [{ name: '01-v0.0.9', version: '0.0.9', createdAt: '2026-09-20T08:15:00Z' }] }),
    }),
  )
  contains(different, 'data-uip-version-state="different"', 'a snapshot that differs is its own state')
  contains(different, 'data-uip-maintenance-badge="different"', 'and the folded summary carries the badge, so the state is visible unexpanded')
  contains(different, strings('en').snapshotDifferent('01-v0.0.9', '0.0.9', '0.1.0'), 'with a sentence naming both versions, and no guess about which is newer')
})

/*
 * A PROJECT WITH NO PACKAGE MUST NOT BORROW THE FRAMEWORK'S NAME (8e-2).
 *
 * `registry.register(definition)` is a public seam — `__internals.Registry`, one argument, no manifest —
 * and it is the shape every built-in project used to take before step 8c deleted the last one. The
 * registry does not require `source`, so a definition registered that way has NO package identity, and
 * three places answered the absence by naming `dsh-ui-projects`: the store's snapshot field, the card's
 * version lookup, and the maintenance heading. So a future built-in project would have been shown as the
 * framework's own — its card would print the framework's maintenance commands, look up the framework's
 * snapshot list, and compare the framework's installed version against it. That is not a cosmetic
 * fallback: it is a confident false statement about which package a card is about, which is the same
 * defect this round's other half fixes in the host log.
 *
 * `null` rather than a placeholder string, because these values flow into a heading and, per the comment
 * in `store.js`, into the `-SourceDir` argument of a command: something that LOOKS like a package name
 * would eventually be used as one.
 *
 * The scan below is built so the bug is loud if it returns: `versions` holds ONE key, the framework's, so
 * a card that looked up the wrong name would render the framework's snapshot sentence — and 'dsh-ui-projects'
 * would appear on the page. It appears nowhere else legitimately: this is the projects page, whose copy
 * names no package, and the only string in the dictionary that does is in the plugins column's uninstall
 * text, which this component never renders.
 */
await test('a project registered without a source does not borrow the framework’s name', async () => {
  const harness = await boot()
  // The raw API: a definition, no manifest, so nothing stamped a package on it.
  harness.registry.register({ id: 'anonymous', name: 'Anon' })
  const entry = harness.store.snapshot().projects.find((project) => project.id === 'anonymous')
  truthy(entry !== undefined, 'the registry accepts a definition with no package identity')
  equal(entry.package, null, 'and the snapshot reports NO package instead of the framework’s name')

  const markup = renderProjectsWith(
    harness,
    installedStoreLike({
      status: 'ready',
      scan: scanWith({
        'dsh-ui-projects': [{ name: '01-v0.1.0', version: '0.1.0', createdAt: '2026-09-27T08:15:00Z' }],
      }),
    }),
  )
  /*
   * THE CLAIM IS ABOUT THE HEADING, not about the page's vocabulary. This used to assert that the string
   * `dsh-ui-projects` appeared NOWHERE in the rendered page, which was true only while nothing else named
   * the framework — and step 9b's maintenance hint legitimately does ("run them from dsh-ui-projects with
   * -Package <name>"), which turned a proxy into a false failure. What the test is about is that no card is
   * PRESENTED as maintaining the framework, and that is what it now asserts.
   */
  excludes(
    markup,
    strings('en').maintenanceTitle('dsh-ui-projects'),
    'so no card is presented as maintaining the framework',
  )
  contains(
    markup,
    strings('en').maintenanceTitleUnknown,
    'and its card says the project did not name the package it belongs to',
  )
  contains(
    markup,
    strings('en').maintenanceTitle('test-skin-package'),
    'while a project that DID name one keeps its own heading — the negative control',
  )
})

/*
 * A STAMP A PERSON CAN READ (7e).
 *
 * The card used to print what the host records: `2026-09-27T04:47:12.2663764Z`. Recording that precision
 * is right; showing it is not, and the user read it on their own screen before this was fixed. The
 * assertions are deliberately two-sided — the readable form must be there AND the raw one must not be —
 * because a formatter that silently did nothing satisfies either half on its own.
 *
 * Its own `test()`, for the rule recorded in `CONTRIBUTING.md`: an assertion added inside an existing
 * test prints nothing of its own, so the count moving is the only evidence it ran.
 */
await test('a host timestamp is shown without its fractional seconds, and relabelled only when it is really UTC', async () => {
  const real = '2026-09-27T04:47:12.2663764Z'
  const shown = formatStamp(real)
  equal(shown, '2026-09-27 04:47 UTC', 'the stamp a reader actually saw becomes a readable one')
  excludes(shown, 'T04:47', 'with no ISO separator left in it')
  equal(/\.\d{7}/.test(shown), false, 'and none of the seven fractional digits the host records')
  equal(/\d{2}:\d{2}:\d{2}/.test(shown), false, 'nor the seconds, which add nothing at this scale')

  // Only a value that SAYS it is UTC is labelled UTC.
  equal(formatStamp('2026-09-27T08:15:00Z'), '2026-09-27 08:15 UTC', 'seconds without a fraction are the same shape')
  equal(formatStamp('2026-09-27T08:15Z'), '2026-09-27 08:15 UTC', 'and so is a stamp without seconds')
  equal(
    formatStamp('2026-09-27T08:15:00+08:00'),
    '2026-09-27T08:15:00+08:00',
    'an offset is NOT relabelled as UTC — it is left exactly as it arrived',
  )
  equal(formatStamp('2026-09-27'), '2026-09-27', 'a date with no time is already readable')
  equal(formatStamp('not a date'), 'not a date', 'a value that is not a date is shown as itself, never as Invalid Date')
  equal(formatStamp(''), '', 'nothing stays nothing')
  equal(formatStamp(undefined), '', 'and an absent stamp does not become the word "undefined"')

  // Both dictionaries go through the one formatter, so a reader in either language sees the same stamp.
  contains(
    strings('zh').snapshotNewer('01-v0.1.0', '0.1.0', real),
    '2026-09-27 04:47 UTC',
    'the Chinese sentence formats it identically',
  )
})

/*
 * THE DOCUMENT THAT DESCRIBES THE THREE COMMANDS (7e).
 *
 * Deliberately narrow: it asserts that the document exists and that the three commands a reader arrives
 * looking for are named in it. It does not lock the prose, because a documentation guard that fails on a
 * reworded sentence teaches the next person to edit the guard instead of the document.
 */
await test('the maintenance workflow is written down, and names the three commands', async () => {
  const text = await readFile(join(packageRoot, 'docs', 'update-and-rollback.md'), 'utf8')
  truthy(text.length > 2000, `the document has content (${text.length} bytes)`)
  for (const command of ['install.ps1 -Snapshot', 'install.ps1 -Update', 'install.ps1 -Rollback -To']) {
    contains(text, command, `${command} is named in it`)
  }
})

await test('the card makes no version claim when nothing has been read', async () => {
  const harness = await boot()
  const cases = [
    ['the listing failed', installedStoreLike({ status: 'failed', error: 'connection refused' })],
    ['the listing is still loading', installedStoreLike({ status: 'loading' })],
    ['the listing is idle', installedStoreLike({ status: 'idle' })],
    ['no store was passed in at all', undefined],
  ]
  for (const [what, installed] of cases) {
    const markup = renderProjectsWith(harness, installed)
    contains(markup, 'data-uip-maintenance-panel=', `${what}: the card still renders its maintenance block`)
    contains(markup, 'install.ps1 -Snapshot', `${what}: and the commands are still printed`)
    excludes(markup, 'data-uip-version-state=', `${what}: and no version state is claimed, not even "none"`)
  }
  // The positive control: with a ready listing the element DOES appear, so the four exclusions above are
  // not passing because the marker can never be rendered.
  const ready = renderProjectsWith(
    harness,
    installedStoreLike({ status: 'ready', scan: scanWith({ 'dsh-ui-projects': [] }) }),
  )
  contains(ready, 'data-uip-version-state=', 'with a ready listing the marker is there, so those exclusions mean something')
})

await test('a project that declares no checklist still gets the maintenance disclosure, and only that', async () => {
  const harness = await boot()
  harness.registry.register({ id: 'bare', name: 'Bare', version: '1.0.0' })
  const markup = renderProjectsWith(harness, undefined)
  contains(markup, 'data-uip-maintenance-panel="bare"', 'a card with no checklist still offers the commands')
  /*
   * And no empty CHECKLIST is rendered for it — asserted on this card's own fragment rather than on the
   * page, because the page also holds the built-in skin's card, which legitimately has one. (The property
   * itself is asserted where it belongs: `a project with no items gets no empty checklist disclosure`.)
   */
  const bareCard = markup.slice(markup.indexOf('data-uip-maintenance-panel="bare"'))
  excludes(
    bareCard.slice(0, bareCard.indexOf('</details>')),
    'data-uip-action="confirm-checks"',
    'and no checklist controls are rendered inside it',
  )
})

/*
 * OPENING THIS PAGE IS WHAT ASKS THE HOST (7d-2c).
 *
 * Every wiring test above passes `installed` in BY HAND, which is precisely how the gap this test covers
 * stayed green for a whole round: the prop was always there in a test, and the question of who starts the
 * read was never asked. Here the section is rendered the way the shell renders it — the registered,
 * zero-argument renderer — and the only thing standing in for the host is `fetch`.
 *
 * The trigger is a side effect in a render, because this slot API has no mount hook and a listing fetched
 * at boot would be a request for a page most sessions never open. What that buys is worth stating
 * precisely, and it is measured here rather than assumed: the FIRST render asks, and asking is guarded on
 * `idle`, so a React double render, a remount or a second visit asks nothing more. That is why the
 * browser test can assert "once" instead of "at least once".
 */
await test('opening the settings section is what asks the host for the listing, and only once', async () => {
  const harness = await boot()
  /** @type {string[]} */
  const asked = []
  /*
   * `fetch` is installed on the BUNDLE'S OWN global, not on Node's: the module factories were created
   * inside the vm context, so a bare `fetch` in the client half resolves there — patching
   * `globalThis.fetch` reaches nothing, which is how the first version of this test measured zero
   * requests while the code under it was already correct.
   */
  const realFetch = sandbox.fetch
  sandbox.fetch = async (input) => {
    asked.push(typeof input === 'string' ? input : String(input?.url ?? input))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        schemaVersion: 1,
        scan: {
          profileName: 'web',
          dependencies: [
            { name: 'dsh-ui-projects', version: '0.1.0', kind: 'ui-project', bundled: true, problems: [] },
          ],
          orphanedBindings: [],
          versions: {},
        },
      }),
    }
  }
  try {
    const first = harness.render()
    equal(asked.length, 1, `the section's own render asks the host for the listing (${JSON.stringify(asked)})`)
    equal(asked[0], '/api/ui-projects/installed.json', 'at the path the host mounted, under the fenced /api prefix')
    excludes(first, 'data-uip-version-state=', 'and the first paint claims nothing: no answer has arrived yet')

    harness.render()
    harness.render()
    equal(asked.length, 1, 'a second and a third render ask nothing more — the store is no longer idle')

    /*
     * The answer is applied by the store, and the render AFTER it is the one that can use it. This half is
     * only about the read reaching a render; that the arrival itself re-renders the card is a hook, and
     * `--no-write` in the browser suite is where that is proved.
     */
    let settled = ''
    for (let attempt = 0; attempt < 10 && !settled.includes('data-uip-version-state='); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      settled = harness.render()
    }
    contains(settled, 'data-uip-version-state="none"', 'once the listing lands, the next render states the version situation')
    equal(asked.length, 1, 'and the whole exchange was still one request')
  } finally {
    if (realFetch === undefined) delete sandbox.fetch
    else sandbox.fetch = realFetch
  }
})

/*
 * The other half of the same question, and it cannot be checked by rendering: a component that reads a
 * store once and never subscribes to it cannot learn that the answer arrived. A static render re-reads
 * everything from scratch, so `renderToStaticMarkup` would pass either way — which is exactly the shape of
 * the bug. Prose in the file is not evidence, hence `stripComments`: this guard reads the code, not the
 * explanation of why the code matters.
 */
await test('the panel subscribes to the listing it reads, so an answer arriving later still reaches the card', async () => {
  const code = stripComments(await readFile(join(packageRoot, 'src', 'client', 'panel.js'), 'utf8'))
  contains(
    code,
    'source.subscribe(() => setInstalledState(source.state()))',
    'the installed store is subscribed to, and re-read on every change it reports',
  )
})

process.stdout.write(`\n${checks} assertions, ${failures} failing\n`)
if (onlyTest !== '') {
  process.stdout.write(`[filter] DSH_TEST_ONLY=${JSON.stringify(onlyTest)} skipped ${skipped} test(s)\n`)
}
if (failures > 0) process.exitCode = 1
