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
import { declaresBackdropFilter } from './css-filter.js'
import { combineLevels, createFrameProbe, deviceLevel, minLevel, readSignals } from './perf.js'

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

/*
 * ── WHEN THE MARKERS WERE WRITTEN ────────────────────────────────────────────────────────────────
 *
 * TWO writers stamp `data-ui-project-<id>` on the body, and only one of them can be there at first
 * paint:
 *
 *   · the HOST stamps it while serving the document (`src/host/service.js`, at emit time) — present in
 *     the first frame whenever the settings document carries the record;
 *   · THIS runtime stamps it when it applies a project, and it does so on an ASYNC chain: `start()`
 *     awaits `persist.ready()` (see `:262`) before `#markRoot()` (`:265`) and `#applyWanted()` (`:267`
 *     → `#enable`) — a chain that contains a `describe()` round-trip in the desktop application.
 *
 * A probe taken fourteen seconds after load cannot tell which writer won: both have run. Measured on
 * 2026-09-30: two readings, at `performance.now()` 14262 ms and 39878 ms, both `"on"` — evidence about
 * the end state and nothing about the first frame. So the runtime records WHEN it wrote, and the number
 * is what gets compared with the frame.
 *
 * FIRST WRITE WINS. A later apply re-writes the same attribute and must not overwrite the number that
 * answers the question. And the clock is LOOKED UP, never assumed: a bundled module may reach the
 * ambient clocks but may not require them — a bare `performance.now()` is the same trap the slot
 * fallback hit with `setTimeout`, where a minimal sandbox threw `ReferenceError` before anything ran.
 */

/** @returns {number|null} `performance.now`, or `null` where the composition offers no clock. */
function ambientNow() {
  try {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now.bind(performance)
      : null
  } catch {
    return null
  }
}

/**
 * Record the first write of each marker, and say so ONCE.
 *
 * @param {object} [options]
 * @param {(() => number) | null} [options.now] Injectable clock; a non-function (or an explicit `null`)
 *   means "this composition has no clock", and then nothing is recorded rather than a number invented.
 * @param {(timing: { rootAt: number|null, projectAt: Record<string, number> }) => void} [options.announce]
 *   Called once, from `settle()`. Injectable so a test can hold the "once" property without a console.
 * @returns {{ timing: { rootAt: number|null, projectAt: Record<string, number> }, root: () => void, project: (id: string) => void, settle: () => void }}
 */
export function markTimingRecorder({ now = ambientNow(), announce = defaultAnnounce } = {}) {
  const clock = typeof now === 'function' ? now : null
  const timing = { rootAt: null, projectAt: {} }
  let announced = false
  return {
    timing,
    root() {
      if (clock === null || timing.rootAt !== null) return
      timing.rootAt = clock()
    },
    project(id) {
      if (clock === null || timing.projectAt[id] !== undefined) return
      timing.projectAt[id] = clock()
    },
    /*
     * PRINTED WHEN THE APPLY PASS ENDS, not when the second marker happens to land.
     *
     * `settle()` is called at the end of `#applyWanted()`, which is the one place that knows the pass
     * is over — and it also covers the case that matters most for a diagnosis: a runtime that ran, wrote
     * its ROOT marker and applied NOTHING prints `projectAt: {}`, which is a fact worth having rather
     * than a line that never appears. Once per page load, never per marker.
     */
    settle() {
      if (announced) return
      announced = true
      /*
       * NOTHING TO SAY, NOTHING SAID. Without a clock every field is `null`/empty by construction, so
       * a line reading `{ rootAt: null, projectAt: {} }` is pure noise — measured: two of them in every
       * `verify` run, because the sandbox deliberately offers no `performance`.
       */
      if (clock === null) return
      try {
        /*
         * THE COPY IS MADE HERE, NOT BY THE ANNOUNCER.
         *
         * The contract is what ANY announcer receives. `defaultAnnounce` spread its own copy — so the
         * Console line was safe — but an injected announcer held the LIVE object, and the next
         * `project()` wrote into the snapshot after the fact: measured, an assertion read
         * `dsh-cost-meter: 900` out of a snapshot taken before that project existed. One copy, at the
         * boundary, and the question cannot come back.
         */
        announce({ rootAt: timing.rootAt, projectAt: { ...timing.projectAt } })
      } catch {
        // A diagnostics line must never be able to break an apply.
      }
    },
  }
}

/** The one line a person reads out of the Console. `settle()` hands it an already-frozen copy. */
function defaultAnnounce(timing) {
  console.info('[dsh-ui-projects] markers written', timing)
}

/** This page's own first-write times, exported so the diagnostics surface can show them. */
const markerTiming = markTimingRecorder()
export const markTiming = markerTiming.timing

/**
 * The attribute carrying the effect tier in force, and the element it goes on.
 *
 * ON THE BODY, beside the project marker, and that is a correctness requirement rather than a
 * preference. A project stylesheet is scoped by rewriting its first compound: `html…` and `:root`
 * are REPLACED by the marker (`scope-css.js`), so `html[data-ui-perf='low'] .x` compiles to
 * `body[data-ui-project-<id>="on"][data-ui-perf='low'] .x`. Put the attribute on `<html>` and every
 * degradation rule in every project becomes a selector that matches nothing — silently, which is
 * the failure this package has already paid for twice (the dead dark branch, the dead
 * `overflow: clip`).
 */
const PERF_ATTRIBUTE = 'data-ui-perf'

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
 * @property {{ announced: readonly string[] | null, markerPresent: (id: string) => boolean }} bootEvidence
 *   What the HOST plane said before this bundle existed, read once at boot and passed in rather than
 *   queried here (`boot-presence.js` is the reader; `index.js` is the one place that reads it):
 *   `announced` is the frozen list of project ids the host mounted on this page load, `null` when no
 *   host half ran at all, and `markerPresent` answers what the first frame PAINTED for one project —
 *   the body marker the host stamped after reading the settings document at emit time.
 *
 *   It exists for the one case the record cannot answer: `persist.read()` returns undefined while the
 *   settings transport is still in flight, and the empty record means "the user never chose" while
 *   "not told yet" means nothing of the sort. See `#wantedIds()`.
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
    this.bootEvidence = deps.bootEvidence
    /**
     * Which projects this load was told about by the FIRST FRAME rather than by the document.
     *
     * Empty on a healthy load, and a diagnostic rather than state: it says the record had not arrived
     * when the boot finished, so `#wantedIds()` answered from the host's markers. The overlay prints
     * it next to `persistReady`, and the pair is the whole story of a degraded first frame — a
     * `'timeout'` with a non-empty list means the skin stayed on and the document will correct it.
     * @type {string[]}
     */
    this.frameAdopted = []
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
    /**
     * What the device signals said at load, and then the lowest tier anything has since measured.
     *
     * Only ever moves DOWN. A measurement that comes back better than the signals — or better than
     * a previous measurement — is discarded, so the tier cannot oscillate with load and a demoted
     * device is never promoted back by a lucky second of idling.
     * @type {'low'|'medium'|'high'|undefined}
     */
    this.deviceClass = deviceLevel(readSignals())
    /** @type {(() => void) | undefined} */
    this.stopFrameProbe = undefined
    /**
     * The record subscription, present exactly when this load had to start from the first frame.
     *
     * Undefined on a healthy boot: the document was read before anything was applied, so there is
     * nothing to reconcile. See `start()` and `#reconcile()`.
     * @type {(() => void) | undefined}
     */
    this.stopRecordWatch = undefined
    /**
     * The last failure to write the record, or undefined.
     *
     * GLOBAL rather than per project, and deliberately so: a write carries the whole document —
     * five fields, every project's options, the enabled set — so binding the failure to one project
     * would be a lie about what broke. What the user needs to know is "your choice did not reach
     * the document", which is a fact about the document.
     * @type {{ at: string, message: string } | undefined}
     */
    this.persistError = undefined
    /**
     * The order projects were actually applied in, oldest first.
     *
     * Kept because `priority` is a request that a single click deliberately does not enforce: the
     * runtime applies what the user asked for and leaves the session's order as it stands, because
     * re-applying live projects to reorder them would make the interface flicker — the exact thing
     * this package spends its time removing. That trade is only honest if the divergence is
     * DETECTABLE, which is what this list is for; without it, "the order is restored on the next
     * load" would be an unverifiable claim rather than a checked one.
     * @type {string[]}
     */
    this.appliedOrder = []
    /**
     * The scoped CSS each applied project inserted, kept for analysis.
     *
     * Kept because the text is the ONLY complete record of what a project declared. The frost lives
     * on a `::before` pseudo-element, which no `querySelectorAll` can return and no selector can
     * match, so a DOM-only view of "who installs a blur" would miss the skin's own layer entirely.
     * @type {Map<string, string[]>}
     */
    this.insertedCss = new Map()
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

  /**
   * A project's stored options, whether or not it is currently applied.
   *
   * `contextFor` hands out a read/write context only for an ACTIVE project, which is right for a
   * control that changes the material — there is nothing to change while it is off. A recorded
   * verification is different: it is a fact about a past run, and a card should be able to say
   * "confirmed for 3.0.0" while the project is switched off.
   * @param {string} id
   * @returns {Record<string, unknown> | undefined}
   */
  settingsFor(id) {
    return this.settings.get(id)
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
     * Reading before that yields UNDEFINED now. It used to yield the EMPTY record, whose meaning is
     * "the user has never chosen anything" — so a two-second transport delay was answered with the
     * shipped defaults, and a skin the document said was on came back off while the host's first
     * frame had already painted it on. "Not told yet" is not "chose nothing"; `#wantedIds()` answers
     * the first from the frame and the second from the record.
     *
     * `start()` reads once and there is no second chance IN THIS METHOD, so the wait belongs here
     * rather than in a retry — and when the wait ends without an answer, the subscription at the
     * bottom of this method is what makes a second chance exist. `?.()` because only the settings
     * adapter has anything to wait for: the local one resolves immediately, and an adapter that
     * omits the method is treated the same way.
     */
    await this.persist.ready?.()
    const record = this.persist.read()
    this.settings = new Map(Object.entries(record?.settings ?? {}))
    this.#markRoot()
    this.frameAdopted = record === undefined ? this.#frameWantedIds() : []
    await this.#applyWanted()
    /*
     * AN UNKNOWN RECORD GETS A SECOND CHANCE, and it is the only case that needs one: the wait above
     * ends either with a record or with a dead transport, and `persist.read()` starts answering the
     * moment the document does. Without this the boot keeps the frame's answer for the life of the
     * page — the page looks like the skin is on while the record says otherwise, which is exactly
     * the divergence this subscription exists to end.
     *
     * Kept for the life of the runtime rather than until the first answer: a record that moves later
     * (another window, the host writing settings) is the same question, and `#reconcile()` is
     * idempotent and writes nothing, so listening costs a comparison and cannot fight the user.
     */
    if (record === undefined && this.stopRecordWatch === undefined) {
      this.stopRecordWatch = this.persist.subscribe?.(() => {
        void this.#reconcile()
      })
    }
  }

  /**
   * Bring the page in line with the wanted set: enable what is wanted, in the composition's order.
   *
   * ONE place, because `start()` and `#reconcile()` must not be able to disagree about what "wanted"
   * means or about the order it is applied in — the same reason `#wantedIds()` is one place.
   *
   * Persists nothing, and disables nothing: `start()` runs before the user has done anything, and
   * `#reconcile()` owns the disabling because only it knows what the document said.
   * @returns {Promise<void>}
   */
  async #applyWanted() {
    // Sorted: the order projects run in is a request the composition makes, not the order an
    // object's keys happen to come back in. See `canonicalOrder`.
    for (const id of this.registry.canonicalOrder(this.#wantedIds())) await this.#enable(id, { persist: false })
    this.#syncPerfAttribute()
    if (this.registry.activeIds().length > 0) this.#startFrameProbe()
    // Every marker this pass was going to write has been written: say when, once.
    markerTiming.settle()
  }

  /**
   * The document has answered — or moved. Make the page match it.
   *
   * The counterpart to the first-frame adoption in `start()`: what the frame was trusted for is
   * replaced by what the record says, in BOTH directions. A project the frame turned on and the
   * record does not want is disabled here. That is the visible cost of a degraded window, and the
   * correct outcome: the document is newer than the frame it painted.
   *
   * WRITES NOTHING. It is derived from the document, so writing it back would be redundant — and it
   * is triggered BY the document changing, so a write here would be a feedback loop with the
   * transport. `#serialize` keeps it from interleaving with the user's own toggle.
   * @returns {Promise<void>}
   */
  async #reconcile() {
    return this.#serialize(async () => {
      const record = this.persist.read()
      if (record === undefined || this.disposed) return
      this.settings = new Map(Object.entries(record.settings ?? {}))
      const wanted = this.#wantedIds()
      await this.#applyWanted()
      for (const id of this.registry.activeIds()) {
        if (!wanted.includes(id)) await this.#disable(id, { persist: false })
      }
      // Again, and not redundantly: a disable can drop the heaviest applied project, and the tier
      // has to drop with it (`retire()` states the same rule).
      this.#syncPerfAttribute()
      this.frameAdopted = []
      this.registry.notify()
    })
  }

  /**
   * Turn one project on: repair the skin policy, apply it, then persist.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async enable(id) {
    return this.#serialize(async () => {
      await this.#enable(id, { persist: false })
      this.#syncPerfAttribute()
      if (this.registry.isEnabled(id)) this.#startFrameProbe()
      await this.#remember({ add: id })
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
      this.#syncPerfAttribute()
      await this.#remember({ remove: id })
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
   * Deactivate a project because its PACKAGE is going away — not because the user turned it off.
   *
   * Not disable(id): that path calls #remember(), which rewrites `enabled` from the current
   * activeIds — i.e. it erases the user's choice. Retirement is a package's action, not the user's;
   * the record must outlive it so that a reinstall restores the choice. Hence the private
   * #disable(id, { persist: false }).
   *
   * The id is deliberately LEFT in `enabled`. The next boot tolerates it: `#enable` returns
   * immediately for a project the registry does not have, and `canonicalOrder` sorts an
   * unregistered id defensively. What the user chose survives the package that could not honour it.
   *
   * Its `settings` entry stays for the same reason — what the user recorded or configured is theirs,
   * and a reinstall is meant to find it again. `withdraw` in `service.js` states the full split
   * between what a package owns (registration, stylesheets, markers, variables) and what the user
   * owns (both halves of the record).
   *
   * `#syncPerfAttribute` is not optional here: if this project was the heaviest applied one, the
   * body's `data-ui-perf` has to drop with it, or the page keeps a tier with nothing behind it.
   *
   * Idempotent, and safe for an id that was never registered or never applied.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async retire(id) {
    return this.#serialize(async () => {
      await this.#disable(id, { persist: false })
      this.#syncPerfAttribute()
    })
  }

  /**
   * Apply a project that registered AFTER `start()` restored the record.
   *
   * With projects arriving from separate packages, composition order is not ours to choose, so a
   * registration landing after the restore is the normal case rather than an edge. Without this it
   * would come back OFF on every reload — which is the failure this project has already paid for
   * once, when the framework registered its own project before `start()` so that the walk would
   * find it. That is why this method exists at all, and `index.js` records the incident where the
   * call used to be.
   *
   * Persists nothing: `#enable(id, { persist: false })`, exactly as `start()` does, because the
   * record already says what the user wants, and rewriting it here could drop the ids of packages
   * that have not mounted yet. The question "should this be on?" is answered in ONE place,
   * `#wantedIds()`, so this path and the boot path cannot disagree.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async adopt(id) {
    return this.#serialize(async () => {
      if (!this.#wantedIds().includes(id)) return
      await this.#enable(id, { persist: false })
      this.#syncPerfAttribute()
    })
  }

  /**
   * The document's failures, for a card or an overlay to render.
   *
   * Read-only and cheap: it reports what the runtime already knows rather than re-measuring
   * anything, which is what lets a test ask "did the write fail?" without a browser.
   * @returns {{ persistError: { at: string, message: string } | undefined, adoptedFromFrame: string[] }}
   */
  diagnostics() {
    return {
      persistError: this.persistError,
      /**
       * The ids this load took from the first frame rather than from the document.
       *
       * Non-empty only on a degraded boot, and paired with `persistReady: 'timeout'` in the overlay
       * it is the whole story: the transport had not answered when the boot finished, so the host's
       * own markers were the answer, and the record corrects it when it lands. An EMPTY list next to
       * a timeout means the host plane said nothing and the shipped defaults were used instead.
       */
      adoptedFromFrame: this.frameAdopted.slice(),
    }
  }

  /**
   * Restore the shipped default: forget every user choice, then apply exactly the
   * projects that declare `defaultEnabled`.
   * @returns {Promise<void>}
   */
  async resetAll() {
    return this.#serialize(async () => {
      for (const id of this.registry.activeIds()) await this.#disable(id, { persist: false })
      /*
       * Every stored option goes, not only the enabled list.
       *
       * The docstring has always said "forget every user choice" while the code kept `settings`, and
       * the gap was invisible because `settings` held nothing but recorded verifications — a reset
       * that left "confirmed for 3.0.0" on a card whose settings had just been described as restored
       * to the shipped default. Clearing the whole map closes it before a project that declares a
       * real control makes it obvious.
       */
      this.settings.clear()
      await this.#write({ ...this.persist.read(), initialized: false, enabled: [], settings: {}, touched: false })
      for (const project of this.registry.list()) {
        if (project.defaultEnabled) await this.#enable(project.id, { persist: false })
      }
      this.#syncPerfAttribute()
      this.registry.notify()
    })
  }

  /**
   * The first applied project whose position differs from the canonical order, or undefined.
   *
   * Returns the one that is running EARLIER than it should — that is the project whose position the
   * next load will change, so it is the one worth naming on a card. A single click deliberately does
   * not re-order anything (see `appliedOrder`); this is how that trade is made visible instead of
   * silent.
   * @returns {string | undefined}
   */
  outOfOrderId() {
    const applied = this.appliedOrder.filter((id) => this.registry.isEnabled(id))
    const canonical = this.registry.canonicalOrder(applied)
    for (let index = 0; index < applied.length; index += 1) {
      if (applied[index] !== canonical[index]) return applied[index]
    }
    return undefined
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
      /*
       * `?? this.registry.activeIds()`: while the settings read has not answered, the record is
       * unknown, and dereferencing it here was a TypeError inside a button handler — which reads as a
       * broken panel rather than as a record that could not be written. The write below still fails
       * on its own terms (`persist.write()` refuses a scope that is not ready) and `#write` reports
       * it; what must not happen is the crash on the way there. Same seed as `#remember()`, for the
       * same reason.
       */
      const enabled = (record?.enabled ?? this.registry.activeIds()).filter((entry) => entry !== id)
      if (project.defaultEnabled && !enabled.includes(id)) enabled.push(id)
      /*
       * The project's own options go too, which includes any recorded verification.
       *
       * A button that says "restore Liquid Glass to its default" and leaves a confirmation behind is
       * a partial reset wearing the name of a complete one: the card would still claim a version had
       * been verified, by the same person who just asked for the defaults back.
       */
      this.settings.delete(id)
      await this.#write({ ...record, initialized: true, enabled, settings: this.#allSettings() })
      this.#syncPerfAttribute()
      this.registry.notify()
    })
  }

  /**
   * Forget a project's recorded verification, leaving its other options alone.
   *
   * Deliberately NOT routed through the project context, even though `confirmChecks` is. A context
   * exists only for an APPLIED project, and `settingsFor` above already reads a confirmation with the
   * project switched off — a card is expected to say "confirmed for 3.0.0" while the skin is off, so
   * it has to be able to withdraw that claim in the same state. Writing through the context would
   * have made the control do nothing at exactly the moment the record is most likely to be stale, and
   * a button that silently does nothing reports nothing.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async clearChecks(id) {
    return this.#serialize(async () => {
      const values = this.settings.get(id)
      if (values === undefined || !('checks' in values)) return
      const next = { ...values }
      delete next.checks
      this.#applySettings(id, next)
      await this.#write({ ...this.persist.read(), settings: this.#allSettings() })
      this.registry.notify()
    })
  }

  /** Tear down every project; called when the client plugin unloads. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    // Before anything else: a subscription that outlives the runtime would call `#reconcile()` on a
    // disposed object the moment the document moved.
    this.stopRecordWatch?.()
    this.stopRecordWatch = undefined
    for (const id of Array.from(this.disposers.keys())) {
      this.#release(id)
      this.registry.markInactive(id)
    }
    this.stopFrameProbe?.()
    this.stopFrameProbe = undefined
    this.appliedOrder = []
    // The tier goes with the last project: a page with no UI project applied must carry no
    // `data-ui-perf` at all, or every rule keyed on it would keep matching against nothing.
    this.#removeAttribute(this.bodyElement(), PERF_ATTRIBUTE)
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
    if (!this.appliedOrder.includes(id)) this.appliedOrder.push(id)
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
    this.appliedOrder = this.appliedOrder.filter((entry) => entry !== id)
    void options
  }

  /** Remove every owned effect of one project. */
  #release(id) {
    const owned = this.disposers.get(id)
    this.disposers.delete(id)
    this.insertedCss.delete(id)
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
        const scoped = scopeCss(marker, css)
        const kept = this.insertedCss.get(id)
        if (kept === undefined) this.insertedCss.set(id, [scoped])
        else kept.push(scoped)
        const dispose = this.insertCss(id, scoped)
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
        this.#applySettings(id, next)
        await this.#write({ ...this.persist.read(), settings: this.#allSettings() })
        /*
         * Tell the registry, so the panel re-reads.
         *
         * The store renders from a snapshot taken when the registry last changed, and a setting is
         * NOT a registry change — so without this the card kept whatever it had when it was last
         * drawn. It went unnoticed because the only control that writes a setting was the retired
         * opacity slider, whose value the browser's own input element keeps in step; a checklist
         * confirmation has nothing to keep it in step, so it would simply never appear.
         *
         * Called even when the persistence FAILED, and deliberately: the in-memory value has already
         * changed, and that value is what the panel renders from. A durable write that fails is a
         * separate problem, reported by its own path.
         */
        this.registry.notify()
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
   * Replace one project's stored options, dropping the entry entirely when nothing is left in it.
   *
   * `#allSettings()` skips empty records, so an emptied project already vanished from the DOCUMENT —
   * but the in-memory map kept `{ id: {} }`, which meant `settingsFor(id)` answered an empty object
   * rather than nothing, and every reader had to treat "no settings" and "settings that happen to be
   * empty" as the same case. Deleting the entry is what makes the two the same thing, and it is the
   * whole requirement for a withdrawn confirmation: absent, not present-and-empty.
   * @param {string} id
   * @param {Record<string, unknown>} values
   */
  #applySettings(id, values) {
    if (Object.keys(values).length === 0) this.settings.delete(id)
    else this.settings.set(id, values)
  }

  /**
   * The ids that should be on: the user's set once the document is initialized, each project's own
   * default when the document says nobody has ever chosen, and — while the document has not been
   * READ yet — whatever the host's first frame already painted.
   *
   * One place, because `start()` and `adopt()` must not be able to disagree about it, and now also
   * because three different answers live here and a second copy of this decision is a second place
   * for "unknown" to decay into "empty".
   * @returns {string[]}
   */
  #wantedIds() {
    const record = this.persist.read()
    if (record === undefined) {
      /*
       * UNKNOWN, which is not the same as empty, and this branch is the difference.
       *
       * Nothing has been read, so nothing can be inferred about the user — and the one thing that IS
       * known about this page load is the frame already on screen: the host read the same document at
       * emit time and stamped `data-ui-project-<id>="on"` for everything it decided was on.
       * Adopting that set makes the registry agree with what the reader can see, instead of leaving
       * the page skinned while the panel says the skin is off.
       *
       * With NO host plane at all (`announced === null`) there is no frame to trust and nothing to
       * contradict either, so the shipped defaults answer — the pre-existing behaviour, kept for the
       * composition where the client half is the only half.
       */
      if (this.bootEvidence === undefined || this.bootEvidence.announced === null) return this.#defaultWantedIds()
      return this.#frameWantedIds()
    }
    return record.initialized ? record.enabled.slice() : this.#defaultWantedIds()
  }

  /**
   * What the first frame says is on: every REGISTERED project the host marked on the body.
   *
   * Registered rather than marked-only, because the registry is what the runtime can apply and
   * `#enable` ignores an id it does not have — a marker for a package whose client half is missing
   * is the host plane's business, and `service.js`'s three-state diagnosis reports it.
   *
   * Empty when no host half announced itself: `markerPresent` would answer false for everything
   * anyway, but saying so here keeps the absent-host case from looking like a page that painted
   * nothing on purpose.
   * @returns {string[]}
   */
  #frameWantedIds() {
    if (this.bootEvidence === undefined || this.bootEvidence.announced === null) return []
    return this.registry
      .list()
      .filter((project) => this.bootEvidence.markerPresent(project.id))
      .map((project) => project.id)
  }

  /** Every project that ships ON: the answer for a document nobody has chosen in. @returns {string[]} */
  #defaultWantedIds() {
    return this.registry.list().filter((project) => project.defaultEnabled).map((project) => project.id)
  }

  /**
   * Record ONE change to the user's choice, applied to the DOCUMENT rather than derived from live
   * state.
   *
   * WHY THIS IS NOT `activeIds()` ANY MORE, and it is the difference between a record of intent and
   * a record of observation. Deriving `enabled` from what happens to be applied loses every id that
   * is wanted but not currently applicable — a project whose package was uninstalled (retired, and
   * deliberately left in the record so a reinstall restores it) and a project whose `apply` failed
   * (the card shows the error, and the user has not changed their mind). The next toggle of any
   * OTHER project silently dropped both, so a reinstall came back off and a transient failure
   * became permanent.
   *
   * `resetOne()` has always worked this way — it filters the document's own list and only touches
   * its own id — so this is not a new idea, it is `enable`/`disable` being brought in line with the
   * sibling that was already right.
   *
   * THE SEED, for the first write of an uninitialized document: the base is what is currently
   * applied, because that is what the user is looking at. Without it, turning one default-enabled
   * project off would write `enabled: []` and silently switch every other default-on project off
   * on the next load.
   *
   * @param {{ add?: string, remove?: string }} mutation
   */
  async #remember(mutation) {
    const record = this.persist.read()
    /*
     * The seed for the first write of a document nobody has chosen in — and the same seed while the
     * document has not been READ yet, which is the only honest base there is: what is applied is what
     * the user is looking at, and under an unknown record `#wantedIds()` has just made that set agree
     * with the first frame.
     *
     * `record === undefined` must not take the `record.enabled` branch: that would write the empty
     * set and turn "the transport was slow for two seconds" into "the user turned everything off".
     */
    const base = record?.initialized === true ? record.enabled : this.registry.activeIds()
    const enabled = base.filter((id) => id !== mutation.add && id !== mutation.remove)
    if (mutation.add !== undefined) enabled.push(mutation.add)
    await this.#write({
      ...record,
      v: 1,
      initialized: true,
      enabled,
      settings: this.#allSettings(),
      touched: true,
    })
  }

  /** @param {import('./persist.js').UiProjectRecord} record */
  async #write(record) {
    try {
      await this.persist.write(record)
      this.persistError = undefined
    } catch (err) {
      /*
       * Recorded as well as logged. A console line is invisible to the person whose choice just
       * failed to reach the document, and "I turned it on and it came back off" is exactly the
       * symptom that gets blamed on the skin. The failure belongs to the DOCUMENT, not to any one
       * project, which is why it is reported globally rather than through `registry.markError`.
       */
      this.persistError = {
        at: new Date().toISOString(),
        /*
         * Not `err instanceof Error`: a write can be called across a realm boundary — the suite's
         * vm sandbox, a Cordis plugin boundary — where an Error from the other side fails that test
         * and `String(err)` prepends "Error: ", which the banner would then show verbatim.
         */
        message: typeof err?.message === 'string' && err.message.length > 0 ? err.message : String(err),
      }
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

  /**
   * Whether a project's own CSS installs a `backdrop-filter`.
   *
   * Read from the retained text rather than the DOM, for the reason that map exists: the skin's
   * layer is a pseudo-element and therefore invisible to any query. Used to escalate a region
   * overlap into a nesting warning — two projects that both blur the same region can end up with
   * one filtered element inside another, which is expensive and changes what each layer samples.
   * @param {string} id
   * @returns {boolean}
   */
  declaresFilter(id) {
    const sheets = this.insertedCss.get(id)
    if (sheets === undefined) return false
    return sheets.some((css) => declaresBackdropFilter(css))
  }

  /** @param {() => Promise<void>} task */
  #serialize(task) {
    const next = this.serial.then(task, task)
    this.serial = next.catch(() => {})
    return next
  }

  /**
   * The effect tier in force right now, or undefined when nothing is applied.
   *
   * Heaviest declared demand among the active projects, capped by what the device can afford. Read
   * by the diagnostics overlay and by the tests; the stylesheet reads the ATTRIBUTE instead, so
   * this is a reporting surface rather than the mechanism.
   * @returns {'low'|'medium'|'high'|undefined}
   */
  perfLevel() {
    return combineLevels(
      this.registry.list().map((project) => (this.registry.isEnabled(project.id) ? project.perfLevel : undefined)),
      this.deviceClass,
    )
  }

  /**
   * Publish that tier on the body, or remove it when there is none.
   *
   * Called after every operation that can change the active set rather than from inside
   * `#enable`/`#disable`, because those two have early returns on their error paths and a stale
   * attribute is exactly the kind of leftover this package exists to prevent. The public entry
   * points all funnel here once their work has settled.
   */
  #syncPerfAttribute() {
    const level = this.perfLevel()
    if (level === undefined) this.#removeAttribute(this.bodyElement(), PERF_ATTRIBUTE)
    else this.#setAttribute(this.bodyElement(), PERF_ATTRIBUTE, level)
  }

  /**
   * Start measuring frame time, and lower the device class if the measurement says so.
   *
   * Started only once something is actually applied — a page with no UI project on it should not
   * spend a second measuring anything — and idempotent, so `start()` may call it on every restore.
   */
  #startFrameProbe() {
    if (this.stopFrameProbe !== undefined) return
    this.stopFrameProbe = createFrameProbe({
      onLevel: (level) => {
        const next = minLevel(this.deviceClass, level)
        if (next === this.deviceClass) return
        this.deviceClass = next
        this.#syncPerfAttribute()
      },
    })
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
    // The first write only; `markTimingRecorder` ignores every later one.
    markerTiming.root()
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
    // Only the ON marker matters here: it is the one the boot fragment waits for.
    if (value === 'on') markerTiming.project(id)
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
