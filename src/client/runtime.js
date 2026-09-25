/**
 * UI project runtime — the only place that touches the DOM, storage and the
 * theme service on behalf of a project.
 *
 * Responsibilities, in order of importance:
 *
 *  1. **Reversibility.** Everything a project does is registered as an owned
 *     disposable here: inserted stylesheets, theme-token layers, the root
 *     `data-ui-project-*` / `data-ui-skin` markers, and the project's own
 *     `cleanup()`. Disabling a project therefore cannot leave residue behind.
 *  2. **Policy.** Skins are mutually exclusive: enabling one disables every
 *     other active skin first, so the document never carries two global looks.
 *  3. **Persistence.** The enabled set is the durable record; runtime state is
 *     always derived from it, never the other way round.
 *
 * The apply order per project is: cleanup any previous attempt → set markers →
 * apply() → record the new disposers. On failure the partial effects are rolled
 * back and the project reports `error` on its settings card instead of showing
 * as enabled.
 */

import { scopeCss } from './scope-css.js'

/**
 * The attribute the runtime stamps on the application's layout columns.
 *
 * Exported, and shared with the cleanup below, because it has to be REMOVED as well as added:
 * leaving it behind on a live page would keep every `[data-ui-skin-column]` rule matching after
 * the project was switched off.
 */
const LAYOUT_COLUMNS_ATTRIBUTE = 'data-ui-skin-column'

/**
 * How much taller than the viewport `#root` must be before the boot page is judged to be in the
 * way. A slack of a few pixels is normal layout rounding; the boot page is a whole screen.
 */
const OVERSIZE_THRESHOLD_PX = 4

/**
 * The skin type value. Declared here rather than imported so the runtime does not
 * depend on the registry module for a constant: the registry is passed in as a
 * collaborator, and a cycle through a value would be a needless coupling.
 * `project-constants.js` is the single source of truth for the vocabulary.
 */
const TYPE_SKIN = 'skin'

const ROOT_MARKER = 'data-ui-projects'

/**
 * How long the two retry loops below may poll before they give up.
 *
 * Both wait for something nobody can report to the plugin: the shell mounting the application,
 * a grid that exists but has not been laid out yet, a boot page that only becomes stale once
 * the app is standing beside it. A `MutationObserver` catches every DOM change — but NOT a
 * change in layout. A stylesheet applying, a font finishing, a transition ending: each makes an
 * element measurable while mutating nothing, and all of them happen in the first moments after
 * a project is enabled.
 *
 * So the intervals are kept, with a deadline. Past it the interval is cleared and the observer
 * stays connected — the observer is the half that has to keep working for the life of the
 * project (a re-render can replace the marked columns), and the interval is the half that would
 * otherwise poll forever. Five seconds is generous for a window measured in hundreds of
 * milliseconds: a frame that has not appeared by then is not waiting on layout, it is on a page
 * that has no frame at all.
 */
const RETRY_BUDGET_MS = 5000
/** The column-marking bridge. Slow enough to be invisible, fast enough to beat a paint. */
const RETRY_INTERVAL_MS = 250
/** The boot-page bridge. Boot is over in well under this, or there is no boot page to remove. */
const BOOT_RETRY_INTERVAL_MS = 500

/**
 * @typedef {object} RuntimeDeps
 * @property {import('./registry.js').UiProjectRegistry} registry
 * @property {import('./persist.js').PersistAdapter} persist
 * @property {import('@deepseek-ai/cordis').Context} ctx
 * @property {(ownerId: string, css: string) => () => void} insertCss
 *   Inserts one owned `<style>` element for a project and returns its disposer.
 *   The runtime scopes the CSS to the project's marker before handing it over.
 */

export class UiProjectRuntime {
  /**
   * @param {RuntimeDeps} deps
   */
  constructor(deps) {
    this.registry = deps.registry
    this.persist = deps.persist
    this.ctx = deps.ctx
    this.insertCss = deps.insertCss
    /** @type {Map<string, Array<() => void>>} owned disposers, per active project */
    this.disposers = new Map()
    /**
     * What the column-marking retry last saw, per project.
     *
     * A diagnostic, not state the plugin reads back: the marking either happened or it did
     * not, and this records which — plus the measurements that decided it — so a silent
     * failure can be read off a screen instead of inferred.
     * @type {Map<string, Record<string, unknown>>}
     */
    this.markingState = new Map()
    /** @type {Map<string, string>} per-project persisted settings */
    this.settings = new Map()
    /** @type {HTMLElement | undefined} */
    this.root = undefined
    this.disposed = false
    this.serial = Promise.resolve()
  }

  /**
   * The context of a currently applied project, for a surface that needs to read or write
   * its settings while it is running — the settings card's controls, today.
   *
   * The context is rebuilt on demand rather than retained: it must always read the CURRENT
   * project definition and settings, and a retained copy would go stale the moment the
   * project was re-registered by a hot reload.
   * @param {string} id
   * @returns {import('./registry.js').UiProjectContext | undefined}
   */
  contextFor(id) {
    if (!this.registry.isEnabled(id)) return undefined
    const project = this.registry.get(id)
    if (project === undefined) return undefined
    return this.#context(id, project, [])
  }

  /** @returns {HTMLElement} the element carrying the UI project markers (the document element). */
  get rootElement() {
    if (this.root !== undefined) return this.root
    const doc = typeof document !== 'undefined' ? document : undefined
    this.root = doc?.documentElement ?? /** @type {any} */ ({ dataset: {} })
    return this.root
  }

  /**
   * Bring the document in line with the persisted record, and enable every
   * `defaultEnabled` project the user has not explicitly turned off.
   *
   * Never memoizes the root element here: tests (and any host that swaps the
   * document) re-point the global, and a cached node would silently leave effects
   * on the previous one.
   * @returns {Promise<void>}
   */
  async start() {
    /*
     * Wait for the record before reading it.
     *
     * The settings adapter's snapshot starts as `idle` and only becomes `ready` after the first
     * `settings.describe` read settles — a wire round-trip the provider starts without awaiting.
     * Reading before that yields the EMPTY record, which means "the user has never chosen
     * anything", so the fallback below would restore the shipped defaults and quietly ignore the
     * user's set — for the shipped skin, the skin would not come back on a reload that the
     * settings document says it should.
     *
     * `start()` reads once and there is no second chance, so the wait belongs here rather than in
     * a retry. `?.()` because only the settings adapter has anything to wait for: the local one
     * resolves immediately, and an adapter that omits the method is treated the same way.
     */
    await this.persist.ready?.()
    const record = this.persist.read()
    this.settings = new Map(Object.entries(record.settings ?? {}))
    this.#markRoot()
    // An untouched record means each project follows its own default; an
    // initialized one means the user's set is authoritative, empty included.
    const wanted = record.initialized
      ? record.enabled
      : this.registry.list().filter((project) => project.defaultEnabled).map((project) => project.id)
    for (const id of wanted) await this.#enable(id, { persist: false })
  }

  /**
   * Turn one project on: repair the skin policy, apply it, then persist.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async enable(id) {
    return this.#serialize(async () => {
      await this.#enable(id, { persist: false })
      await this.#remember()
    })
  }

  /**
   * Turn one project off and remove every trace of it.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async disable(id) {
    return this.#serialize(async () => {
      await this.#disable(id, { persist: false })
      await this.#remember()
    })
  }

  /**
   * Flip one project.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async toggle(id) {
    return this.registry.isEnabled(id) ? this.disable(id) : this.enable(id)
  }

  /**
   * Restore the shipped default: forget every user choice, then apply exactly the
   * projects that declare `defaultEnabled`.
   * @returns {Promise<void>}
   */
  async resetAll() {
    return this.#serialize(async () => {
      for (const id of this.registry.activeIds()) await this.#disable(id, { persist: false })
      await this.#write({ ...this.persist.read(), initialized: false, enabled: [], touched: false })
      for (const project of this.registry.list()) {
        if (project.defaultEnabled) await this.#enable(project.id, { persist: false })
      }
    })
  }

  /**
   * Return one project to its shipped default: on for a `defaultEnabled` project,
   * off otherwise. The user's choice for it is forgotten.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async resetOne(id) {
    return this.#serialize(async () => {
      const project = this.registry.get(id)
      if (project === undefined) return
      if (project.defaultEnabled) await this.#enable(id, { persist: false })
      else await this.#disable(id, { persist: false })
      const record = this.persist.read()
      const enabled = record.enabled.filter((entry) => entry !== id)
      if (project.defaultEnabled && !enabled.includes(id)) enabled.push(id)
      await this.#write({ ...record, initialized: true, enabled })
    })
  }

  /** Tear down every project; called when the client plugin unloads. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const id of Array.from(this.disposers.keys())) {
      this.#release(id)
      this.registry.markInactive(id)
    }
    this.#unmarkRoot()
    this.root = undefined
  }

  /**
   * @param {string} id
   * @param {{ persist: boolean }} options
   */
  async #enable(id, options) {
    const project = this.registry.get(id)
    if (project === undefined || this.disposed) return
    if (this.registry.isEnabled(id)) return
    // Skin policy: at most one global look, so the previous one goes first.
    for (const conflict of this.registry.conflictIds(id)) {
      await this.#disable(conflict, { persist: false })
    }
    for (const dependency of project.requires) {
      if (!this.registry.isEnabled(dependency)) await this.#enable(dependency, { persist: false })
    }
    const owned = []
    const context = this.#context(id, project, owned)
    try {
      this.#markProject(id, 'on')
      if (project.type === TYPE_SKIN) this.#setRootAttribute('data-ui-skin', id)
      if (typeof project.apply === 'function') project.apply(context)
    } catch (err) {
      console.error(`[dsh-ui-projects] project "${id}" failed to apply`, err)
      releaseAll(owned)
      this.#unmarkProject(id)
      if (project.type === TYPE_SKIN && this.rootElement.getAttribute?.('data-ui-skin') === id) {
        this.#setRootAttribute('data-ui-skin', undefined)
      }
      this.registry.markError(id, err)
      return
    }
    this.disposers.set(id, owned)
    this.registry.markActive(id)
    void options
  }

  /**
   * @param {string} id
   * @param {{ persist: boolean }} options
   */
  async #disable(id, options) {
    const project = this.registry.get(id)
    this.#release(id)
    this.#unmarkProject(id)
    if (project !== undefined && project.type === TYPE_SKIN && this.rootElement.getAttribute?.('data-ui-skin') === id) {
      this.#setRootAttribute('data-ui-skin', undefined)
    }
    this.registry.markInactive(id)
    void options
  }

  /** Remove every owned effect of one project. */
  #release(id) {
    const owned = this.disposers.get(id)
    this.disposers.delete(id)
    if (owned === undefined) return
    releaseAll(owned)
    const project = this.registry.get(id)
    if (project !== undefined && typeof project.cleanup === 'function') {
      try {
        project.cleanup(this.#context(id, project, []))
      } catch (err) {
        console.error(`[dsh-ui-projects] project "${id}" cleanup failed`, err)
      }
    }
  }

  /**
   * The hermetic context handed to a project's apply/cleanup. Every capability
   * that must be undone is pushed onto `owned`; nothing else is exposed.
   * @param {string} id
   * @param {import('./registry.js').UiProjectDefinition} project
   * @param {Array<() => void>} owned
   * @returns {import('./registry.js').UiProjectContext}
   */
  #context(id, project, owned) {
    const marker = this.#marker(id)
    return {
      id,
      selector: marker,
      root: this.rootElement,
      /**
       * Mark the application's top-level layout columns, and return the disposer.
       *
       * A skin needs to frost the columns — and only the columns — but the shipped
       * layout paints them from CSS-module class names and exposes no attribute on the
       * column elements themselves. Guessing at a selector from structure is what
       * produced two silent failures in this package: `[data-rightbar-col] > *` and then
       * `> :last-child` both matched a 0x0 slot wrapper instead of a column, so the skin
       * applied no frost at all and said nothing about it.
       *
       * So the runtime asks the DOM the answer instead: the frame is the one grid whose
       * children are its columns, and those children get marked. The contract lives here,
       * in the plugin, rather than in a selector that depends on how the shipped markup
       * happens to nest its wrappers today.
       * @returns {() => void}
       */
      markColumns: () => {
        const attr = LAYOUT_COLUMNS_ATTRIBUTE
        /**
         * Mark the frame's children as columns.
         *
         * This RETRIES, because timing is the whole difficulty: a project is applied when the
         * plugin loads, and at that moment the shell has not yet mounted the application —
         * `#root` is empty and there is no frame to find. A one-shot lookup therefore failed
         * silently, and the skin lost its frost entirely while every other part of it worked.
         *
         * A missing decoration must never delay anything, so neither way in blocks the plugin —
         * and the retry is now BOUNDED. It runs until the columns are marked or `RETRY_BUDGET_MS`
         * has passed, whichever comes first, and is then cleared. Every attempt is recorded in
         * `markingState`, an expired deadline included, so the diagnostics overlay can report what
         * it actually saw. The first version of this retry failed for reasons invisible from the
         * outside, and reasoning about them cost a round.
         */
        let cancelled = false
        let marked = /** @type {Element[]} */ ([])
        const state = { project: id, attempts: 0, frame: null, columns: 0, widest: 0, marked: 0, note: 'started' }
        this.markingState.set(id, state)

        /**
         * One attempt. Driven by the observer for as long as the project is active, and by the
         * interval only until that interval is cleared.
         *
         * The set of columns is recomputed every time and only WRITTEN when it differs from what is
         * already marked — so a repeated attempt on an unchanged frame costs a grid lookup and
         * nothing else, while a re-render that replaces the columns is caught and repaired. Writing
         * unconditionally would mean touching the DOM on every observed mutation.
         * @returns {boolean} whether the columns are marked now
         */
        const attempt = () => {
          if (cancelled) return true
          state.attempts += 1
          const frame = this.#frameElement()
          if (frame === undefined) {
            state.note = 'no frame found'
            return false
          }
          state.frame = `${frame.tagName.toLowerCase()}.${String(frame.className || '').split(' ')[0].slice(0, 20)}`
          state.children = frame.children.length
          const columns = this.#columnElements(frame)
          state.columns = columns.length
          if (columns.length === 0) {
            // Record WHY they were rejected: a zero-area child means the grid has not laid
            // out yet, which is a wait; a positioned child means it is the overlay
            // container, which is a different problem entirely.
            state.note = `no eligible columns among ${frame.children.length} children`
            state.sizes = Array.from(frame.children).map((child) => {
              const rect = child.getBoundingClientRect()
              const style = typeof getComputedStyle === 'function' ? getComputedStyle(child) : undefined
              return `${Math.round(rect.width)}x${Math.round(rect.height)}/${style?.position ?? '?'}`
            })
            return false
          }
          state.widest = Math.round(Math.max(...columns.map((column) => column.getBoundingClientRect().width)))

          const unchanged = columns.length === marked.length && columns.every((column, index) => column === marked[index])
          if (unchanged) {
            state.note = 'marked'
            return true
          }

          // The frame's children changed, so the old attributes belong to elements that are no
          // longer on the page. Clear first: leaving them would keep matching `[data-ui-skin-column]`
          // against detached nodes, which is invisible in a stylesheet and confusing in a
          // diagnostic that counts attributes.
          for (const column of marked) column.removeAttribute?.(attr)
          marked = columns
          for (const column of marked) column.setAttribute?.(attr, '')
          state.marked = marked.length
          state.note = state.attempts === 1 ? 'marked' : 're-marked after a re-render'
          return true
        }

        /*
         * Two ways in, because the timing is genuinely uncertain and neither alone is enough.
         *
         * A MutationObserver fires when the shell mounts the application or re-renders it —
         * the moment the frame actually appears — and unlike a timer it cannot be throttled
         * by a backgrounded tab, which is exactly when a project may be enabled.
         *
         * The interval is the backstop for the case the observer cannot see: the frame is
         * present but has not been laid out yet, so it exists with zero-area children and
         * starts satisfying the filter a paint or two later, with no DOM mutation to observe.
         * An observer watches nodes; layout changes without any node changing.
         *
         * THE OBSERVER NEVER STOPS, and that is the fix for a real report: marking was observed
         * working once (`columnClasses: ["pI_x6G_sidebarCol", "pI_x6G_centerCol"]` on one probe)
         * and absent later (`columnsMarked: 0` on another), with no toggle in between. The shell
         * re-renders — opening the right panel, collapsing the sidebar, changing a session — and a
         * re-render replaces the frame's children with NEW elements that carry no attribute. A
         * one-shot marking is therefore not a marking; it is a marking that happens to be correct
         * until the next render. Repairing that is the observer's job, and it costs nothing while
         * the DOM is still: an event-driven observer that never fires does no work.
         *
         * THE INTERVAL STOPS. It used to run forever, four times a second, for the life of every
         * active project — and its one useful window is the first moments after activation. So it
         * is cleared as soon as the columns are marked, whichever way in did the marking, and
         * unconditionally once `RETRY_BUDGET_MS` has passed. The observer stays connected past
         * that deadline: giving up on the timer is not giving up on the project, and a frame that
         * appears later is still marked.
         *
         * Deliberately NOT re-armed by a later failed attempt. An attempt driven by the observer
         * runs after a mutation, and reading a rect forces layout, so the newly inserted columns
         * are already measurable; a repeat of the loading-time zero-area case is not something
         * this timer would be waiting for, and re-arming it would rebuild the forever-poll.
         */
        /** @type {ReturnType<typeof setInterval> | undefined} */
        let retry
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let deadline

        /** Stop the interval and the deadline that bounds it. Safe to call repeatedly. */
        const stopRetry = () => {
          if (retry !== undefined) {
            clearInterval(retry)
            retry = undefined
          }
          if (deadline !== undefined) {
            clearTimeout(deadline)
            deadline = undefined
          }
        }

        /**
         * Mark if possible, and end the retry window if that worked.
         *
         * Both ways in go through this, and it has to be both. In the field the OBSERVER is the
         * one that usually does the marking — the shell mounts the application and that is a
         * mutation — so a retry cleared only by the interval's own attempt would keep ticking
         * away behind a page that had been correctly marked the whole time. The test that drives
         * both paths is what found that.
         * @returns {boolean} whether the columns are marked now
         */
        const attemptAndSettle = () => {
          if (!attempt()) return false
          stopRetry()
          return true
        }

        const observer =
          typeof MutationObserver === 'function'
            ? new MutationObserver(() => {
                attemptAndSettle()
              })
            : undefined
        observer?.observe(typeof document === 'undefined' ? {} : document.documentElement, {
          childList: true,
          subtree: true,
        })

        const startRetry = () => {
          if (retry !== undefined || typeof setInterval !== 'function') return
          const handle = setInterval(() => {
            if (cancelled) {
              stopRetry()
              return
            }
            // Marked: the bridge has done its job and the observer takes it from here.
            attemptAndSettle()
          }, RETRY_INTERVAL_MS)
          // `unref` so a waiting retry cannot hold a Node process open. See the same note
          // in `watchBootPage`.
          handle?.unref?.()
          retry = handle
          if (typeof setTimeout !== 'function') return
          const limit = setTimeout(() => {
            stopRetry()
            state.note = `${state.note} — stopped retrying after ${RETRY_BUDGET_MS}ms`
            state.timedOut = true
          }, RETRY_BUDGET_MS)
          limit?.unref?.()
          deadline = limit
        }

        // A first synchronous try covers the common case where the app mounted before the
        // project was enabled (toggling the switch on a running application) — and because it
        // runs first, the common case never creates a timer at all.
        if (!attemptAndSettle()) startRetry()
        if (observer === undefined && typeof setInterval !== 'function') {
          state.note = 'no observer and no timer in this host'
        }

        const disposer = () => {
          cancelled = true
          observer?.disconnect()
          stopRetry()
          for (const column of marked) column.removeAttribute?.(attr)
          marked = []
          this.markingState.set(id, { ...state, note: `${state.note} → disposed` })
        }
        owned.push(disposer)
        return disposer
      },
      insertCss: (css) => {
        if (typeof css !== 'string' || css.length === 0) return
        // Scoped before insertion: a project stylesheet is inert without its own
        // marker, so ordering between apply and marker writes cannot matter.
        const dispose = this.insertCss(id, scopeCss(marker, css))
        owned.push(dispose)
      },
      /**
       * Remove the shell's stale boot page, if it is still occupying the container.
       *
       * A shell concern rather than a skin one, but the boot page doubles `#root`'s height and
       * every visible consequence of that lands on the interface this package is responsible
       * for: a page that scrolls to a second screen, and an application layout measured against
       * a box twice the size of the window. Returns whether a page was actually removed —
       * `watchBootPage` retries, because the page only becomes stale once the application
       * mounts beside it.
       * @returns {boolean}
       */
      dismissBootPage: () => this.dismissBootPage(),
      overrideTokens: (source, tokens) => {
        const theme = this.ctx.get('theme')
        if (theme === undefined || typeof theme.overrideTokens !== 'function') return
        const dispose = theme.overrideTokens(source, tokens)
        owned.push(dispose)
      },
      fail: (err) => {
        console.error(`[dsh-ui-projects] project "${id}" reported a problem`, err)
        this.registry.markError(id, err)
      },
      isActive: () => this.registry.isEnabled(id),
      readSetting: (key) => this.settings.get(id)?.[key],
      writeSetting: async (key, value) => {
        const next = { ...(this.settings.get(id) ?? {}) }
        if (value === undefined) delete next[key]
        else next[key] = value
        this.settings.set(id, next)
        await this.#write({ ...this.persist.read(), settings: this.#allSettings() })
      },
    }
  }

  /** @returns {Record<string, Record<string, unknown>>} */
  #allSettings() {
    /** @type {Record<string, Record<string, unknown>>} */
    const all = {}
    for (const [id, values] of this.settings) {
      if (Object.keys(values).length > 0) all[id] = values
    }
    return all
  }

  /**
   * Write the current active set as the user's choice. Recording the whole set
   * (not a per-project delta) is what makes a project that defaults off stay on
   * after a reload, and one that defaults on stay off.
   */
  async #remember() {
    const record = this.persist.read()
    await this.#write({
      ...record,
      v: 1,
      initialized: true,
      enabled: this.registry.activeIds(),
      settings: this.#allSettings(),
      touched: true,
    })
  }

  /** @param {import('./persist.js').UiProjectRecord} record */
  async #write(record) {
    try {
      await this.persist.write(record)
    } catch (err) {
      console.error('[dsh-ui-projects] cannot persist UI project state', err)
    }
  }

  /**
   * The boot page, if it is still occupying the application's container.
   *
   * `index-*.js` in the shipped frontend ends with:
   *
   *     const root = document.getElementById("root")
   *     new Boot(root).run()
   *
   * and `run()` awaits the plugin boot and then mounts the application — but it never removes
   * the page it built. The boot element is `height: 100%` and `#root` is `height: 100%`, so
   * while both are present `#root` holds two full-height children and its content is about
   * twice the viewport. The shell then measures a container far taller than the window, and the
   * visible result is a page that scrolls to a second screen — with the application's own
   * layout (a sidebar that decides between wide and rail from a measurement) misbehaving,
   * because it is being measured against the wrong box.
   *
   * It is removed only when the container is genuinely oversized, so a slow boot is never
   * touched: during boot the page is the only child, `#root` fits, and this does nothing.
   * @returns {Element | undefined}
   */
  #staleBootPage() {
    if (typeof document === 'undefined') return undefined
    const root = document.getElementById('root')
    if (root === null || typeof root.querySelector !== 'function') return undefined
    const page = root.querySelector('[data-dsh-boot]')
    if (page === null || page === undefined) return undefined
    // The application must actually be in the container beside it.
    if (root.children.length < 2) return undefined
    const viewport = typeof window === 'undefined' ? 0 : window.innerHeight
    if (viewport <= 0) return undefined
    if (root.scrollHeight <= viewport + OVERSIZE_THRESHOLD_PX) return undefined
    return page
  }

  /**
   * Remove the stale boot page, and report whether one was found.
   *
   * Not reversible on purpose: the element belongs to the boot sequence, which has finished,
   * and re-inserting another package's node would be inventing state rather than restoring it.
   * Disabling the project therefore leaves the page removed — which is the correct end state
   * anyway, and the reason this only ever fires when the boot page is genuinely in the way.
   * @returns {boolean}
   */
  dismissBootPage() {
    const page = this.#staleBootPage()
    if (page === undefined) return false
    page.remove()
    return true
  }

  /**
   * Watch for the boot page becoming stale, and remove it when it does.
   *
   * Retries for the same reason column marking does: at plugin-load time the boot page is the
   * only child of the container and must be left alone, and it only becomes stale once the
   * application mounts beside it — an event, not a moment the plugin can predict.
   *
   * The retry USED to be unbounded, and uselessly so: `attempt` returns immediately once the
   * page has been removed, so the interval went on firing twice a second for the rest of the
   * session, doing nothing at all. Two things bound it now. Removal tears the whole watcher down,
   * because `removed` already makes every later attempt a no-op and there is no second page to
   * wait for. And an interval that never does find a page — the normal case in a session with no
   * boot page at all, where this is not an error — stops at `RETRY_BUDGET_MS`, leaving the
   * observer connected so a page that appears later is still seen the moment it mutates.
   * @returns {() => void}
   */
  watchBootPage() {
    if (typeof document === 'undefined') return () => {}
    let stopped = false
    let removed = false
    /** @type {MutationObserver | undefined} */
    let observer
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let retry
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline

    const stopRetry = () => {
      if (retry !== undefined) {
        clearInterval(retry)
        retry = undefined
      }
      if (deadline !== undefined) {
        clearTimeout(deadline)
        deadline = undefined
      }
    }

    const attempt = () => {
      if (stopped || removed) return
      if (this.dismissBootPage()) {
        removed = true
        this.bootPageRemoved = true
        stopped = true
        stopRetry()
        observer?.disconnect()
      }
    }

    observer = typeof MutationObserver === 'function' ? new MutationObserver(attempt) : undefined
    observer?.observe(document.documentElement, { childList: true, subtree: true })
    // `unref` so this watcher never keeps a Node process alive on its own. A plugin that holds
    // the event loop open is indistinguishable from a plugin that has hung, and it made this
    // package's own test suite stop exiting — passing assertions, no way to finish.
    if (typeof setInterval === 'function') {
      const handle = setInterval(attempt, BOOT_RETRY_INTERVAL_MS)
      handle?.unref?.()
      retry = handle
      if (typeof setTimeout === 'function') {
        const limit = setTimeout(() => stopRetry(), RETRY_BUDGET_MS)
        limit?.unref?.()
        deadline = limit
      }
    }
    attempt()
    return () => {
      stopped = true
      observer?.disconnect()
      stopRetry()
    }
  }

  /** @param {() => Promise<void>} task */
  #serialize(task) {
    const next = this.serial.then(task, task)
    this.serial = next.catch(() => {})
    return next
  }

  /**
   * The application frame: the one grid element whose children are the layout columns.
   *
   * Found by asking the DOM what it is (a computed `display: grid` with a multi-track
   * `grid-template-columns` and more than one child) rather than by naming a CSS-module
   * class, so a frontend rebuild that rehashes the class names does not silently
   * disable the skin. Returns undefined in any document without such a frame, and every
   * caller tolerates that.
   * @returns {Element | undefined}
   */
  #frameElement() {
    if (typeof document === 'undefined') return undefined
    const root = document.getElementById('root') ?? document.body
    if (root === null) return undefined
    for (const element of root.querySelectorAll('div')) {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : undefined
      if (style?.display !== 'grid') continue
      if (element.children.length < 2) continue
      if (String(style.gridTemplateColumns).split(' ').length < 2) continue
      return element
    }
    return undefined
  }

  /**
   * The layout columns inside a frame — and nothing else.
   *
   * A frame has more children than columns, and marking them all was a real mistake: the
   * set included the frame-wide overlay layer, a full-viewport box whose blur softens the
   * entire application, and the column-resize handle. Only the columns are surfaces; the
   * overlay is a container, and a container must never be frosted.
   *
   * So a column is defined by what it is, not by its position: an element that actually
   * occupies the grid — non-zero width and height. The overlay is absolutely positioned
   * and the handle is a zero-area sliver, so both drop out. Before the first paint
   * everything measures 0×0, which is why the caller retries rather than marking nothing.
   * @param {Element} frame
   * @returns {Element[]}
   */
  #columnElements(frame) {
    return Array.from(frame.children).filter((child) => {
      const rect = typeof child.getBoundingClientRect === 'function' ? child.getBoundingClientRect() : undefined
      if (rect === undefined) return false
      if (Math.round(rect.width) < 1 || Math.round(rect.height) < 1) return false
      // An absolutely positioned child fills the frame rather than occupying a track:
      // that is the overlay layer, and it is a container.
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(child) : undefined
      return style?.position !== 'absolute'
    })
  }

  /**
   * The marker selector a project's stylesheets are scoped to.
   *
   * Public because it is part of the contract a project author has to reason about: every
   * selector they write is turned into `<marker> …`, and knowing the exact form is what turns
   * "my rule looks right" into "my rule can be checked". The bug that cost the most rounds in
   * this package was an authored selector demanding an attribute the marker does not carry.
   * @param {string} id
   * @returns {string}
   */
  markerFor(id) {
    return this.#marker(id)
  }

  /** @param {string} id @returns {string} the root marker selector for one project. */
  #marker(id) {
    // The selector every project stylesheet is scoped to: the BODY marker.
    //
    // Not `:root`/`html`, and that is a load-bearing choice. The shipped client
    // declares its design tokens on `body` (the static palettes and the alias
    // layer both), and a token declared on an element always wins for that element
    // over an inherited value — so an override placed on an ancestor is silently
    // ignored. Binding to `body` puts a project's declarations on the very element
    // the shipped ones are on, where specificity decides, and `body[…]…` (0,1,1)
    // beats the shipped `body` (0,0,1).
    //
    // Descendant rules still work unchanged: `body[…="on"] .card` is (0,1,1) plus
    // the selector's own weight, which is what a skin wants. The body element exists
    // in every document, so there is no "marker not there yet" window to handle.
    return `body[data-ui-project-${id}="on"]`
  }

  #markRoot() {
    const root = this.rootElement
    if (root.dataset === undefined) return
    root.setAttribute?.(ROOT_MARKER, 'on')
  }

  #unmarkRoot() {
    this.rootElement.removeAttribute?.(ROOT_MARKER)
  }

  /** @param {string} id @param {'on'|'off'} value */
  #markProject(id, value) {
    // On the body, because that is the element every project stylesheet is scoped
    // to (see `#marker`) and the element the shipped design tokens are declared on.
    this.#setAttribute(this.bodyElement(), `data-ui-project-${id}`, value)
    this.#setAttribute(this.rootElement, 'data-ui-projects-version', '1')
  }

  /** @param {string} id */
  #unmarkProject(id) {
    this.#removeAttribute(this.bodyElement(), `data-ui-project-${id}`)
  }

  /**
   * The body element, or undefined where there is none (a non-browser host, or a
   * document still parsing). Every caller tolerates undefined.
   * @returns {HTMLElement | undefined}
   */
  bodyElement() {
    return typeof document !== 'undefined' ? document.body ?? undefined : undefined
  }

  /** @param {any} element @param {string} name @param {string} value */
  #setAttribute(element, name, value) {
    if (element?.setAttribute === undefined) return
    element.setAttribute(name, value)
  }

  /** @param {any} element @param {string} name */
  #removeAttribute(element, name) {
    if (element?.removeAttribute === undefined) return
    element.removeAttribute(name)
  }

  /** @param {string} name @param {string | undefined} value */
  #setRootAttribute(name, value) {
    if (value === undefined) this.#removeAttribute(this.rootElement, name)
    else this.#setAttribute(this.rootElement, name, value)
  }
}

/** @param {Array<() => void>} owned */
function releaseAll(owned) {
  for (const dispose of owned.splice(0).reverse()) {
    try {
      dispose()
    } catch (err) {
      console.error('[dsh-ui-projects] disposer failed', err)
    }
  }
}

/**
 * @param {RuntimeDeps} deps
 * @returns {UiProjectRuntime}
 */
export function createRuntime(deps) {
  return new UiProjectRuntime(deps)
}
