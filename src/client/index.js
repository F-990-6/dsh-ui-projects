/**
 * dsh-ui-projects — browser half.
 *
 * This module is the composition root of the UI project system:
 *
 *   registry  (what UI projects exist)
 *      +  persist (where the enabled set is remembered)
 *      +  runtime (how a project is applied and cleanly removed)
 *      +  store   (what the settings page reads)
 *      → one `settings.section` contribution, rendered from the registry alone.
 *
 * Adding a UI project means adding an entry to `installBuiltInProjects` (or
 * registering from another plugin through the exported registry) — this file's
 * settings registration never changes.
 *
 * Delivered as a browser bundle: plain CommonJS against the shell's frozen module
 * table, no JSX, no TypeScript.
 */

/**
 * Load-time imports.
 *
 * Only modules that touch neither React nor a UI project may appear here. The dsh
 * loader runs this module with a `require` that answers ONLY the shell's frozen
 * module table, and it materializes the module before it calls `apply` — so a
 * `require('react')` or a project import at load time is a module-table miss that
 * makes the whole plugin fail to load. Both are therefore deferred to first use
 * (see `installBuiltInProjects` and the section renderer below).
 */
const { UiProjectRegistry } = require('./registry.js')
const { createPersist, LOCAL_KEY, SETTINGS_NS } = require('./persist.js')
const { createRuntime } = require('./runtime.js')
const { createStore, detectLocale, onLocaleChange } = require('./store.js')
const { collectDiagnostics, mountDiagnostics } = require('./diagnostics.js')
const { strings } = require('./locale.js')
const { scopeCss } = require('./scope-css.js')
const perf = require('./perf.js')
const coreCss = require('./styles/core.css')

/** The settings slot this plugin occupies. */
const SECTION_ID = 'ui'
/** Navigation position inside Settings, after the shipped sections. */
const SECTION_ORDER = 25


/** Module-level: the shell's loader calls the factory once, at registration. */
let LOADED_PLUGIN

/** The registry every part of the system shares. */
const sharedRegistry = new UiProjectRegistry()
/** Bumped on changes the registry cannot see (locale), to re-render the panel. */
let panelRevision = 0

/**
 * One owned `<style>` element with a stable id, so a leftover element from an
 * earlier session can be identified and removed. Returns a disposer.
 * @param {string} id
 * @param {string} css
 * @returns {() => void}
 */
function insertStyle(id, css) {
  if (typeof document === 'undefined') return () => {}
  const element = document.createElement('style')
  element.id = id
  element.textContent = css
  document.head.appendChild(element)
  return () => {
    element.remove()
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function apply(ctx) {
  const target = sharedRegistry
  /** Settlement of the initial state application, published for observers. */
  let ready = Promise.resolve()

  // One stylesheet for the whole system, plus the system's root marker. Both are
  // removed when this plugin unloads.
  ctx.effect(() => {
    const removeCore = insertStyle('dsh-ui-projects-core', coreCss)
    const root = document.documentElement
    root.setAttribute('data-ui-projects', 'on')
    root.setAttribute('data-ui-projects-version', '1')
    return () => {
      removeCore()
      root.removeAttribute('data-ui-projects')
      root.removeAttribute('data-ui-projects-version')
    }
  }, 'ui-projects: core styles')

  const persist = createPersist(ctx)
  const runtime = createRuntime({
    registry: target,
    persist,
    ctx,
    insertCss: (id, css) => insertStyle(`dsh-ui-projects-${id}`, css),
  })

  // Registered BEFORE the persisted state is applied: `start()` walks the registry,
  // so a project added later would miss the restore that happens on this very boot.
  // Deferring this to the settings-section callback (as an earlier version did) meant
  // a skin enabled in a previous session came back off after a reload.
  installBuiltInProjects(target)

  const store = createStore({
    runtime,
    locale: () => detectLocale(ctx),
    revision: () => panelRevision,
    ctx,
  })

  // Published before any effect runs: `ctx.effect` invokes its callback
  // synchronously, so the live handles must exist by then.
  LOADED_PLUGIN = { registry: target, store, runtime, persist, ready: () => ready }

  ctx.effect(() => {
    // `start()` is asynchronous (each project may await its own persistence), so
    // the settlement is published for anyone that needs to observe the applied
    // state — the panel does not, but a test or a host integration does.
    ready = runtime.start()
    return () => {
      runtime.dispose()
      persist.dispose()
    }
  }, 'ui-projects: apply persisted state')

  // A self-diagnosis overlay, off unless `dsh.ui-projects.debug` is set to '1' in
  // localStorage. It exists because a skin can fail in ways no screenshot can distinguish —
  // the sheet inserted but the DOM half never ran, `apply` rolled back, the ambient layer in
  // the wrong parent, or a stale bundle entirely — and reasoning about which from the outside
  // cost several rounds. See `diagnostics.js`.
  ctx.effect(() => {
    // The shell's boot page is never removed once the application mounts, and both share
    // `#root` as full-height children — so the container ends up about twice the viewport and
    // the page scrolls to a second screen. Watched here rather than inside a project because it
    // is a shell concern, and it must clear whether or not any skin happens to be enabled.
    const stop = runtime.watchBootPage()
    return () => stop()
  }, 'ui-projects: dismiss the boot page once the application is up')

  ctx.effect(() => mountDiagnostics(store, runtime), 'ui-projects: diagnostics')

  // Locale is the one input the registry cannot observe; bump the panel revision
  // so the section re-renders with the new copy.
  onLocaleChange(ctx, () => {
    panelRevision += 1
    sharedRegistry.notify()
  })

  // The section renderer, which is also the only place React is reached — at
  // render time, never at load time.
  const render = () => {
    const { UiProjectsSection } = require('./panel.js')
    return UiProjectsSection({ store, t: strings(detectLocale(ctx)) })
  }
  LOADED_PLUGIN.section = render

  /**
   * Register the settings section.
   *
   * Through `slots.inject`, not `slots.register` directly: `settings.section` is
   * DECLARED by the settings shell (`ui-settings-general`), and a registration for
   * an undeclared slot is rejected — loudly, taking the whole plugin down with it.
   * `inject` subscribes to the declaration, so this runs once the shell is present,
   * whatever order the composition happens to load in.
   */
  ctx.effect(() => {
    const slots = ctx.get('slots')
    if (slots === undefined || typeof slots.inject !== 'function') {
      console.error('[dsh-ui-projects] the client has no `slots` service; Settings › UI cannot mount')
      return () => {}
    }
    const injection = slots.inject('settings.section', () => {
      // Idempotent: the projects are already registered by `apply` (before the
      // persisted state is applied); re-registering here only refreshes their
      // definitions if a hot reload changed them.
      installBuiltInProjects(target)
      const registered = slots.register(
        {
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => strings(detectLocale(ctx)).sectionLabel,
        },
        render,
      )
      return typeof registered === 'function' ? registered : () => {}
    })
    return () => {
      if (typeof injection === 'function') injection()
    }
  }, 'ui-projects: settings section')

}

/**
 * Projects shipped inside this package. Registering here is the whole contract:
 * the settings page picks the project up with no further wiring.
 * @param {UiProjectRegistry} target
 */
function installBuiltInProjects(target) {
  target.register(require('./projects/liquid-glass/skin.js'))
}

/**
 * The Cordis plugin contributed to the web client composition.
 */
module.exports = {
  name: 'ui-projects',
  /*
   * Two hard dependencies, for two different reasons.
   *
   * `slots` is functional: without the settings slot system there is nowhere to put the page.
   *
   * `settingsScope` is a TIMING dependency, and leaving it out was a real bug. The service is
   * provided by `@deepseek-ai/dsh-client-ui-settings`, which declares `inject: ["remote",
   * "remote.settings"]` itself — so it appears only after the host handshake completes. This
   * plugin binds the scope synchronously in `apply` (`persist.js` reads
   * `ctx.get('settingsScope')`), so with only `slots` declared the bind ran BEFORE the provider
   * existed, found nothing, and silently fell back to localStorage: the switch persisted
   * per-browser while the settings document kept a stale copy of an earlier choice, and the two
   * records could disagree without anything reporting it. Declaring the dependency makes Cordis
   * park this plugin until the service is genuinely there.
   *
   * Everything else this plugin touches is optional and read with `ctx.get`.
   */
  inject: ['slots', 'settingsScope'],
  apply,

  /** @returns {UiProjectRegistry} the live registry, for other plugins. */
  get registry() {
    return LOADED_PLUGIN?.registry ?? sharedRegistry
  },
  /** @returns {import('./runtime.js').UiProjectRuntime | undefined} the active runtime. */
  get runtime() {
    return LOADED_PLUGIN?.runtime
  },
  /** @returns {import('./store.js').UiProjectsStore | undefined} the active panel store. */
  get store() {
    return LOADED_PLUGIN?.store
  },
  /**
   * Resolves once the persisted state has been applied to the document.
   * @returns {Promise<void>}
   */
  ready() {
    return LOADED_PLUGIN?.ready() ?? Promise.resolve()
  },
  /**
   * The settings section's render handler, for hosts that want to mount the UI
   * project manager somewhere other than Settings (and for tests).
   * @returns {(() => any) | undefined}
   */
  get section() {
    return LOADED_PLUGIN?.section
  },
  /** @returns {string[]} ids of every registered UI project. */
  listProjects() {
    return (LOADED_PLUGIN?.registry ?? sharedRegistry).ids()
  },

  /**
   * Construction seams for tests: the bundle's classes are not individually
   * importable, so tests reach them through the entry module. Nothing here may
   * import React or a project — that would defeat the load-time contract above.
   */
  __internals: {
    Registry: UiProjectRegistry,
    createRuntime,
    scopeCss,
    strings,
    detectLocale,
    /**
     * The diagnostics collector, so the suite can check the instrument itself.
     *
     * It reads `document` from the module's own scope, which inside the browser bundle is the
     * sandbox's document — importing `diagnostics.js` directly from Node would give it Node's
     * global and no document at all, so the check has to go through here.
     */
    collectDiagnostics,
    /**
     * The device half of the effect tier, so the suite can exercise the policy directly.
     *
     * These are pure functions over a signals object, which is the point of keeping them in their
     * own module: the sandbox has no `navigator` and no `requestAnimationFrame`, so every branch
     * below the policy — which tier a core count implies, what a measured median means, how a
     * demand and a device combine — would otherwise be unreachable from a test.
     */
    perf,
    /**
     * The storage key and namespace, so a test can never spell them wrong.
     *
     * This exists because one already did: a test asserted "the key this plugin does use is
     * untouched" against `dsh.ui.projects.v1` while the real key is `dsh.ui-projects.v1` — one
     * character apart — so the assertion proved nothing for as long as it existed, and a new test
     * that copied the literal inherited the same silence. Reading the constants from the module
     * that owns them is what makes a rename safe.
     */
    persistKeys: { localKey: LOCAL_KEY, settingsNamespace: SETTINGS_NS },
  },
  /** @returns {import('./registry.js').UiProjectDefinition} the shipped Liquid Glass project. */
  get liquidGlass() {
    return require('./projects/liquid-glass/skin.js')
  },
}
