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
 * Adding a UI project means adding a PACKAGE — a client half that declares
 * `inject: ['uiProjects']` and calls `ctx.uiProjects.register(manifest, definition)`.
 * This file ships no project of its own, and its settings registration never changes.
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
 * `require('react')` at load time is a module-table miss that makes the whole plugin
 * fail to load. React is therefore deferred to first use (see the section renderer
 * below). No project module is required at all any more: a project arrives as a
 * package's own client half, through the `uiProjects` service.
 */
const { UiProjectRegistry } = require('./registry.js')
const { createPersist, LOCAL_KEY, SETTINGS_NS } = require('./persist.js')
const { createUiProjectsService } = require('./service.js')
const { createInstalledStore } = require('./installed.js')
const { readHostRowsAtBoot, bootFragmentPresent, bodyMarkerPresent } = require('./boot-presence.js')
const { createRuntime } = require('./runtime.js')
const { createStore, detectLocale, onLocaleChange } = require('./store.js')
const { collectDiagnostics, mountDiagnostics } = require('./diagnostics.js')
const { strings, formatStamp } = require('./locale.js')
const { scopeCss } = require('./scope-css.js')
const perf = require('./perf.js')
const cssFilter = require('./css-filter.js')
const coreCss = require('./styles/core.css')

/** The settings slot this plugin occupies. */
const SECTION_ID = 'ui'
/** Navigation position inside Settings, after the shipped sections. */
const SECTION_ORDER = 25
/** The package column, after the projects page: the skin is what people come for. */
const PLUGINS_SECTION_ID = 'ui-plugins'
const PLUGINS_SECTION_ORDER = 26


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
  /*
   * What the host plane announced for THIS page load, read once, here, before anything else.
   *
   * It has to be read synchronously and only once: the host's presence rows are body rows, which
   * the server renders immediately after `<body>` opens and therefore strictly before the boot
   * tail that loads this bundle. Everything downstream — the panel's three-state diagnosis, the
   * "host half did not mount" warning — is a statement about the document that was just served,
   * so a later re-read would be evidence about something else.
   */
  const presenceAtBoot = readHostRowsAtBoot()
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

  /*
   * The registration surface every UI project package uses.
   *
   * Provided before the persisted state is applied, so a package whose client half mounts later
   * in the same composition finds it immediately rather than waiting for a second boot. A skin's
   * client entry declares `inject: ['uiProjects']` and calls `register(manifest, { apply,
   * cleanup })`; `service.js` owns what that means, including the lifetime binding that makes an
   * unloaded package withdraw its projects.
   *
   * `enabledIds` reads the same record the host half reads at emit time — the settings document —
   * so a diagnosis of "the document says it is on, but nothing registered it" is a comparison of
   * two views of one truth rather than of two caches.
   */
  /*
   * The runtime is built a few lines below, and the service has to reach it. A registration can
   * arrive before that assignment runs — composition order is not ours to choose — so the closures
   * read the binding at CALL time instead of capturing a value that does not exist yet. Before the
   * assignment they are no-ops, and `start()` performs the same restore for anything that
   * registered early enough to be seen by it.
   */
  let runtime

  ctx.provide(
    'uiProjects',
    createUiProjectsService({
      registry: target,
      enabledIds: () => persist.read().enabled,
      hostRowsAtBoot: presenceAtBoot,
      bootFragmentPresent,
      bodyMarkerPresent,
      retire: (id) => runtime?.retire(id),
      adopt: (id) => runtime?.adopt(id),
      notify: () => {
        panelRevision += 1
        sharedRegistry.notify()
      },
    }),
  )

  runtime = createRuntime({
    registry: target,
    persist,
    ctx,
    insertCss: (id, css) => insertStyle(`dsh-ui-projects-${id}`, css),
  })

  /*
   * NO PROJECT IS REGISTERED HERE, and the ordering problem this comment used to describe is gone
   * with the registration that caused it.
   *
   * The framework used to register its own skin right here, BEFORE `start()` — because `start()`
   * walks the registry, so a project added after it missed the restore that happens on that very
   * boot, and a skin enabled in a previous session came back off after a reload. That ordering was
   * the framework's to control only while the framework owned the project.
   *
   * A project now arrives from its own package, whenever that package's fiber applies, and the
   * service closes the gap rather than the composition: `service.register()` calls `deps.adopt(id)`
   * after the definition lands, and `runtime.adopt()` applies a project the restored record already
   * asks for without persisting anything. So both orders are correct, and neither is the framework's
   * business — `scripts/verify.mjs` pins the late one by name ("a record that arrives after the bind
   * is still restored").
   */

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
    /*
     * `installed` is passed here because nothing else can: the shell calls a registered section renderer
     * with NO arguments, so a section can reach only what its own closure holds. Without this line the
     * version sentence on the cards never rendered — four states existed, three of them claims about the
     * profile, and production only ever reached the fourth. The unit tests passed because they call the
     * section with props directly; the wiring between the two was never asserted, and now is.
     *
     * `installedStore` is declared below and read only when this runs, which is after apply has finished.
     */
    /*
     * OPENING THIS PAGE IS ALSO WHAT ASKS THE HOST, by the same rule the plugins column uses at the
     * bottom of this file: a side effect in a render, because this slot API has no mount hook, and a
     * listing fetched at boot would be a request for a page most sessions never open.
     *
     * It was missing here, and the four version states were reachable only from the OTHER page: a
     * session that opened Settings › UI and nothing else left the store `idle` for its whole life, so
     * every card's maintenance block stayed silent and the feature looked, from the only page the
     * reader was on, like it had never been built. The suite did not catch it because the suite opens
     * the plugins column first and visits this page second — the one order in which the store happens
     * to be ready already.
     *
     * Guarded rather than assumed. `installedStore` is created further down this same function body,
     * and a missing or half-built store must not turn a render into a thrown error that takes the whole
     * settings page down: without `state`/`refresh` there is simply nothing to ask, the panel renders
     * exactly what it renders today when nothing has been read, and the browser suite is where that
     * shows up as a failure rather than as silence.
     */
    if (
      installedStore !== undefined &&
      installedStore !== null &&
      typeof installedStore.state === 'function' &&
      typeof installedStore.refresh === 'function' &&
      installedStore.state().status === 'idle'
    ) {
      void installedStore.refresh()
    }
    return UiProjectsSection({ store, t: strings(detectLocale(ctx)), installed: installedStore })
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

  /*
   * Settings › UI plugins: what is INSTALLED, from the host, read-only.
   *
   * The request goes through the Connection service's fetch registry — the same authenticated
   * `/api` channel the host mounted the endpoint on — so the page never hand-builds a URL and the
   * Host/Origin fence stays in play. This binding is the one line in this round that could not be
   * confirmed from the shipped types (the client bundle is minified): if its shape differs, the
   * column renders "cannot read the listing" WITH the reason, which is the same thing it does when
   * the host is old, so the failure is legible rather than mysterious.
   */
  const installedStore = createInstalledStore({
    /*
     * A plain fetch to a full `/api/...` path, which is how every shipped page reaches a host route
     * (`dsh-session-log-export/client.js` builds `/api/session.export` and fetches it; the upload and
     * deliverable pages do the same). Authentication is the browser session cookie the fence
     * established, so nothing here has to carry a token — and nothing here may hand-build a path
     * outside `/api`, because that is the part with no fence around it.
     */
    request: async (path) => {
      const response = await fetch(path, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (response.ok !== true) throw new Error(`the host answered ${response.status}`)
      return await response.json()
    },
  })

  ctx.effect(() => {
    const slots = ctx.get('slots')
    if (slots === undefined || typeof slots.inject !== 'function') return () => {}
    const injection = slots.inject('settings.section', () => {
      const registered = slots.register(
        {
          name: 'settings.section',
          id: PLUGINS_SECTION_ID,
          order: PLUGINS_SECTION_ORDER,
          label: () => strings(detectLocale(ctx)).pluginsLabel,
        },
        () => {
          // Opening the column is what asks the host, and asking twice is what the store's in-flight
          // guard prevents. A side effect in a render is a smell, and it is the only seam this slot
          // API offers: there is no mount hook, and a listing fetched at boot would be a request for
          // a page most sessions never open.
          if (installedStore.state().status === 'idle') void installedStore.refresh()
          const { UiPluginsSection } = require('./panel-plugins.js')
          return UiPluginsSection({ store: installedStore, t: strings(detectLocale(ctx)), React: require('react') })
        },
      )
      return typeof registered === 'function' ? registered : () => {}
    })
    return () => {
      if (typeof injection === 'function') injection()
    }
  }, 'ui-projects: settings plugins section')

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
    /**
     * The installed-package store and the plugins section, so the suite can drive both without a
     * browser and without React: the section renders through whatever `React` it is handed, which a
     * test can supply as a `createElement` that returns plain data.
     */
    createInstalledStore,
    UiPluginsSection: require('./panel-plugins.js').UiPluginsSection,
    /*
     * The projects section, exported for the same reason its sibling is: the suite has to be able to
     * render it WITH props. The registered section is a zero-argument closure over the live store, so a
     * test that went through it could never exercise the optional `installed` prop — and the four states
     * of the version sentence on a card are exactly what needs testing.
     *
     * A GETTER, not a value, and that is a load-time contract rather than a style choice: `panel.js`
     * requires React, and the entry module must reach neither React nor a project while it loads. A plain
     * `require` here broke exactly that, and two contract tests said so by name.
     */
    get UiProjectsSection() {
      return require('./panel.js').UiProjectsSection
    },
    scopeCss,
    strings,
    /**
     * How a host timestamp is shown to a reader, exported so the suite can assert the shapes directly
     * rather than only through a rendered sentence. Pure string surgery over a UTC stamp: seven
     * fractional digits and a `T` in, `2026-09-27 04:47 UTC` out, and anything unrecognized unchanged.
     */
    formatStamp,
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
    /** Whether a stylesheet installs a blur, and where — pure string work over project CSS. */
    cssFilter,
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
}
