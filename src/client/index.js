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
const {
  createPersist,
  LOCAL_KEY,
  SETTINGS_NS,
  chooseRecord,
  mirrorToLocal,
  shouldOfferBack,
} = require('./persist.js')
const { createRemoteSettingsPersist } = require('./settings-controller.js')
const { registerIntoSlot } = require('./slot-registration.js')
const { createUiProjectsService, SUPPORTED_PLUGIN_API } = require('./service.js')
const { createInstalledStore } = require('./installed.js')
const { readHostRowsAtBoot, bootFragmentPresent, bodyMarkerPresent } = require('./boot-presence.js')
const { createRuntime, markTimingRecorder, markTiming } = require('./runtime.js')
const { createStore, detectLocale, onLocaleChange } = require('./store.js')
const { collectDiagnostics, mountDiagnostics } = require('./diagnostics.js')
const { strings, formatStamp } = require('./locale.js')
const { scopeCss } = require('./scope-css.js')
const channels = require('./channels.js')
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
   * WHAT HAPPENED WHEN WE ASKED FOR A SLOT, in order, for a diagnosis to read.
   *
   * The interesting case is not success: it is the fallback, or a refusal. Both mean this page's shell
   * declared `settings.section` before our bundle arrived (0.2.0 runs third-party client packages in a
   * later application batch than its own), which is a shell behaviour no test in this repository can
   * observe — so the evidence is kept where a person can reach it.
   */
  const slotOutcomes = []

  /**
   * Contribute something to `settings.section`, once, whatever order the shell loads in.
   *
   * ONE helper for both contributions below, because they must not be able to drift apart — and
   * because the reason for the bounded fallback belongs in one place: `slot-registration.js`.
   */
  const contributeSection = (options, renderSection) => {
    const slots = ctx.get('slots')
    if (slots === undefined || typeof slots.inject !== 'function') {
      console.error('[dsh-ui-projects] the client has no `slots` service; Settings › UI cannot mount')
      return () => {}
    }
    return registerIntoSlot({
      slots,
      name: 'settings.section',
      options,
      render: renderSection,
      record: (entry) => slotOutcomes.push(entry),
    })
  }

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

  /*
   * THE SAME SERVICE NAME AS THE HOST, with the part the client can honestly answer: the client cannot read
   * the framework package's version — that would drag `node:fs` into a browser bundle — so its `judge`
   * answers `ok` / `unsupported` from its own mirrored list, and the DEPRECATION WARNING is the host's to
   * send. Two halves, one name, and the mirror is held equal by the suite.
   */
  ctx.provide('dshPluginApiVersion', {
    current: SUPPORTED_PLUGIN_API[SUPPORTED_PLUGIN_API.length - 1],
    supported: [...SUPPORTED_PLUGIN_API],
    judge: (declared) => (SUPPORTED_PLUGIN_API.includes(declared) ? 'ok' : 'unsupported'),
  })

  ctx.provide(
    'uiProjects',
    createUiProjectsService({
      registry: target,
      /*
       * `?? []` because the record is UNDEFINED while the settings transport is still in flight, and
       * this reader feeds the panel's three-state diagnosis. Empty means "nothing is known to be on",
       * which is the honest answer at that moment; the alternative — letting it throw inside a panel
       * render — was the cost of teaching `persist.read()` to distinguish "not told yet" from "the
       * user chose nothing".
       */
      enabledIds: () => persist.read()?.enabled ?? [],
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
    /*
     * What the HOST plane said, handed over rather than re-read: `presenceAtBoot` was frozen at the
     * top of this apply for the reason recorded there, and this is the second reader of it. The
     * marker probe is the live half of the pair — "did the host paint this project on?" is a question
     * about the document as SERVED, while the runtime's own markers change as the user does things.
     *
     * The runtime needs both for one case: `persist.read()` returns undefined while the settings
     * transport is still in flight, and the answer to "what should be on?" is then the frame that is
     * already on screen rather than the shipped defaults.
     */
    bootEvidence: { announced: presenceAtBoot, markerPresent: bodyMarkerPresent },
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
  LOADED_PLUGIN = { registry: target, store, runtime, persist, ready: () => ready, slotOutcomes, markTiming }

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
   * Through `slots.inject`, with a bounded fallback: `settings.section` is DECLARED by the settings shell
   * (`ui-settings-general`), a registration for an undeclared slot is rejected loudly, and 0.2.0 declares
   * it in an EARLIER application batch than the one our bundle rides — so a subscription that never gets
   * the declaration has to be backed by a direct registration. See `slot-registration.js`.
   */
  ctx.effect(
    () =>
      contributeSection(
        { id: SECTION_ID, order: SECTION_ORDER, label: () => strings(detectLocale(ctx)).sectionLabel },
        render,
      ),
    'ui-projects: settings section',
  )

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
     * THE CHANNELS THE PANEL IS SHOWING, so the host can compare against the tag the user chose (B1).
     *
     * Read from the SAME record the selector reads (`persist.read()`), which in the desktop application
     * is answered by the browser copy while the settings document never receives the write at all
     * (branch A). Without this, the host compared every package against `stable`: measured, a dot on a
     * package with a newer `latest` and nothing for a package the user had switched to `beta`.
     */
    channelMap: () => {
      const record = persist.read() ?? { settings: {} }
      /** @type {Record<string, string>} */
      const out = {}
      for (const [name, entry] of Object.entries(record.settings ?? {})) {
        if (typeof entry?.channel === 'string' && channels.CHANNELS.includes(entry.channel)) out[name] = entry.channel
      }
      return out
    },
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

  /*
   * THE DEFERRED UPDATE CHECK (D2, `UI第三阶段.txt:23-24`).
   *
   * The column can ask first; this arms ONE check for after the first frame so that a session which
   * never opens the column still learns about a newer version — which is what the spec asks for, and
   * what "reachable only on demand" did not provide. The listing keeps its own on-demand semantics
   * untouched: the two are separate calls in separate files, and this one never touches the listing.
   *
   * The store owns the idempotence and the deadline (see `installed.js`); the disposer here cancels an
   * armed deadline that has not fired, and deliberately leaves a fired request alone.
   */
  ctx.effect(() => installedStore.deferUpdateCheck(), 'ui-projects: deferred update check')

  ctx.effect(() => {
    const slots = ctx.get('slots')
    if (slots === undefined || typeof slots.inject !== 'function') return () => {}
    return contributeSection(
      { id: PLUGINS_SECTION_ID, order: PLUGINS_SECTION_ORDER, label: () => strings(detectLocale(ctx)).pluginsLabel },
      () => {
          // Opening the column is what asks the host, and asking twice is what the store's in-flight
          // guard prevents. A side effect in a render is a smell, and it is the only seam this slot
          // API offers: there is no mount hook, and a listing fetched at boot would be a request for
          // a page most sessions never open.
          if (installedStore.state().status === 'idle') void installedStore.refresh()
          const { UiPluginsSection } = require('./panel-plugins.js')
          /*
           * The PROJECTS store goes along for the ride, read-only: §五's 启用开关 is a MIRROR here, not a
           * second switch. The projects page receives the installed store the same way, so this is one
           * page reading the other's snapshot rather than a new source of truth.
           */
          return UiPluginsSection({
            store: installedStore,
            projects: store,
            t: strings(detectLocale(ctx)),
            React: require('react'),
            /*
             * THE CHANNEL ADAPTER (phase 3, step 1). `record()` hands the section the settings record to
             * merge against, and `write()` is the ONLY way a channel changes: it copies the record, sets
             * `settings['<pkg>'].channel` through the channel store (which refuses a value it does not
             * know), and writes it back through the persistence adapter this plugin already owns — so a
             * channel lives in the same document as everything else the user has chosen.
             */
            channels: {
              record: () => persist.read() ?? { settings: {} },
              read: (name) => channels.read(persist.read() ?? { settings: {} }, name),
              write: async (name, value) => {
                const current = persist.read() ?? { v: 1, initialized: false, enabled: [], settings: {}, touched: false }
                const next = { ...current, settings: { ...(current.settings ?? {}) } }
                channels.write(next, name, value)
                await persist.write(next)
              },
              /*
               * THE CHECKLIST GOES THROUGH THE SAME DOOR (step 4). `readChecklist` is a plain read beside
               * `read`; `writeChecklist` clones the record, sets one item through the channel store's own
               * module (which refuses an id it does not know — `src/client/channels.js`), and hands the
               * whole document back to the persistence adapter this plugin already owns.
               *
               * THAT IS THE POINT: the checklist is not a second store. It lives in the same settings
               * document as the channel, so it is the user's data, it survives the package being removed,
               * and it re-renders by whatever path the channel selector already uses — one mechanism, two
               * fields.
               */
              readChecklist: (name) => channels.readChecklist(persist.read() ?? { settings: {} }, name),
              writeChecklist: async (name, itemId, checked) => {
                const current = persist.read() ?? { v: 1, initialized: false, enabled: [], settings: {}, touched: false }
                const next = { ...current, settings: { ...(current.settings ?? {}) } }
                channels.writeChecklist(next, name, itemId, checked)
                await persist.write(next)
              },
              /*
               * THE AUTHOR'S TWO OTHER PIECES OF STATE, through the same door as the checklist: a draft and
               * the mark that says which version was tested. Cloning the record before touching it is what
               * keeps `channel`, `checklist`, `changelogDraft` and `testedAt` from overwriting one another
               * — they are four fields of ONE per-package entry (`src/client/channels.js`).
               */
              readDraft: (name) => channels.readDraft(persist.read() ?? { settings: {} }, name),
              writeDraft: async (name, draft) => {
                const current = persist.read() ?? { v: 1, initialized: false, enabled: [], settings: {}, touched: false }
                const next = { ...current, settings: { ...(current.settings ?? {}) } }
                channels.writeDraft(next, name, draft)
                await persist.write(next)
              },
              /*
               * ONE ENTRY OF THE DRAFT, edited where it belongs. The panel asks for a change; this method
               * reads the draft that is actually stored, applies the change to a COPY, and writes the whole
               * draft back through the channel store — so "what the panel saw" and "what gets written" can
               * never drift, and a stale index cannot corrupt the record.
               *
               * `patch` is either `{ category?, text? }` (edit those fields) or `{ remove: true }` (drop the
               * entry). An index nobody can reach changes nothing: the panel's own list is the only source of
               * indices, and a stale one must not delete a neighbour.
               */
              writeDraftEntry: async (name, index, patch) => {
                const current = persist.read() ?? { v: 1, initialized: false, enabled: [], settings: {}, touched: false }
                const next = { ...current, settings: { ...(current.settings ?? {}) } }
                const draft = channels.readDraft(next, name)
                if (draft === null) return undefined
                const position = Number.isInteger(index) ? index : -1
                /** @type {Array<{ category: string, text: string }>} */
                const entries = draft.entries.map((entry) => ({ ...entry }))
                if (patch !== null && typeof patch === 'object' && patch.remove === true) {
                  if (position >= 0 && position < entries.length) entries.splice(position, 1)
                } else if (patch !== null && typeof patch === 'object') {
                  const entry = position >= 0 && position < entries.length ? entries[position] : { category: 'Changed', text: '' }
                  if (typeof patch.category === 'string') entry.category = patch.category
                  if (typeof patch.text === 'string') entry.text = patch.text
                  if (position < 0 || position >= entries.length) entries.push(entry)
                  else entries[position] = entry
                }
                channels.writeDraft(next, name, { ...draft, entries, savedAt: new Date().toISOString() })
                await persist.write(next)
                return entries
              },
              readTestedAt: (name) => channels.readTestedAt(persist.read() ?? { settings: {} }, name),              writeTestedAt: async (name, version, at) => {
                const current = persist.read() ?? { v: 1, initialized: false, enabled: [], settings: {}, touched: false }
                const next = { ...current, settings: { ...(current.settings ?? {}) } }
                /* The stamp defaults HERE, at the edge that knows what "now" is — the store stays a plain
                 * function of its arguments (decision 2026-09-30). */
                channels.writeTestedAt(next, name, version, at ?? new Date().toISOString())
                await persist.write(next)
              },
            },
          })
        },
    )
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
   *
   * `settingsScope` IS NO LONGER DECLARED (phase 3 follow-up), and that is the same bug seen from the other
   * side: 0.2.0-rc.2 — the dsh inside the desktop application — does not provide the service at all, so a
   * hard dependency on it would park this plugin for ever and the column would simply not exist. What is
   * declared instead is the seam BOTH versions have, `remote` + `remote.settings`: the 0.1.5 scope is built
   * on that remote and names it in its own `inject` (`dsh-client-ui-settings/lib/client.js:1333`), so
   * parking on the remote still guarantees the settings service is there before `apply` binds — and
   * `persist.js` keeps preferring the scope whenever the composition hands it one.
   */
  inject: ['slots', 'remote', 'remote.settings'],
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
     * The changelog toggle, exported so the suite can drive it directly: the wiring between "a reader
     * opens a row" and "the store is asked" is one function, and a browser is not needed to check it.
     */
    createChangelogToggle: require('./panel-plugins.js').createChangelogToggle,
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
    persistKeys: { localKey: LOCAL_KEY, settingsNamespace: SETTINGS_NS, chooseRecord, mirrorToLocal, shouldOfferBack },
    /**
     * The update channel of a package, and the composition of a row's channel/update facts (phase 3).
     *
     * Exported so the suite can hold the two properties that are easiest to lose: a channel nobody chose
     * reads as `stable`, and a check that FAILED is not an update.
     */
    channels,
    mergeUpdates: channels.mergeUpdates,
    /**
     * The settings adapters, so the suite can hold the CHOICE itself (phase 3 follow-up: the desktop-app
     * adaptation): which backend a composition gets, that only one is ever used, and that the remote path
     * reads with one `describe` and writes with one `update`.
     */
    settingsController: { createPersist, createRemoteSettingsPersist },
    /**
     * The slot-contribution helper (phase-3 follow-up: the desktop application).
     *
     * Exported so the suite can hold the two properties a shell cannot be asked to guarantee: the
     * declaration is subscribed to first, and a declaration that never arrives still ends in exactly one
     * registration — recorded, never thrown, never retried.
     *
     * WHAT IT RECORDED IS NOT HERE. `slotOutcomes` is per-INSTANCE state and lives on the plugin handle
     * (`LOADED_PLUGIN`) beside `registry`/`store`/`runtime`/`persist`, which is where the diagnostics
     * overlay reads this page's live handles from. Putting it in this module-scope literal was the bug
     * that made the bundle throw on load: the variable it named is declared inside `apply`.
     */
    slotRegistration: { registerIntoSlot },
    /**
     * The marker clock (phase-3 follow-up: the desktop application).
     *
     * TWO writers stamp the body marker, and only the host can be first at paint; this recorder holds
     * WHEN the runtime wrote its own — first write wins — so a reading taken long after load can be
     * compared with the frame instead of guessed at. Exported so the assertions can pin those two
     * properties, and so the handle at `LOADED_PLUGIN` can carry the times themselves (step 2).
     */
    markTimingRecorder,
    /**
     * The recorded times themselves (`{ rootAt, projectAt }`), for a probe that cannot reach the plugin
     * handle. The same object the runtime fills and the Console line prints once per page load.
     */
    markTiming,
  },
}
