/**
 * UI project registry — the single extension point of the UI project system.
 *
 * An "UI project" is a self-contained, reversible contribution to the dsh Web
 * client's appearance or behaviour: a skin (mutually exclusive global look) or
 * an enhancement (composable layer). Anything registered here shows up in
 * Settings › UI automatically, is toggleable at runtime, and must be able to
 * clean up after itself completely.
 *
 * This module owns NO DOM and NO storage: `apply`/`cleanup` of each project
 * are invoked by `runtime.js`, and enabled state is persisted by `store.js`.
 * `panel.js` renders whatever is in here, so adding a project never means
 * touching the settings page.
 */

import {
  TYPE_SKIN,
  TYPE_ENHANCEMENT,
  FEATURE_LIGHT,
  FEATURE_DARK,
  FEATURE_MOBILE,
  PROJECT_TYPES,
  PERF_MEDIUM,
  PROJECT_PERF_LEVELS,
  PROJECT_REGIONS,
  DEFAULT_PRIORITY,
  rankOf,
} from './project-constants.js'

export { TYPE_SKIN, TYPE_ENHANCEMENT, FEATURE_LIGHT, FEATURE_DARK, FEATURE_MOBILE }

/**
 * Project ids are deliberately CSS-identifier-safe.
 *
 * The runtime builds an attribute selector from the id
 * (`html[data-ui-project-<id>="on"]`) and scopes the project's stylesheet to it,
 * so an id containing a character a stylesheet cannot match — a question mark, for
 * instance, which is legal in an HTML attribute name but not in a CSS selector —
 * would produce a project whose CSS silently never applies. Rejecting that at
 * registration is much cheaper than debugging it in a browser.
 */
const ID_PATTERN = /^[a-z][a-z0-9-]{1,47}$/

/**
 * @typedef {object} UiProjectDefinition
 * @property {string} id Stable key: lowercase, digits and dashes. Drives the root
 *   `data-ui-project-<id>` marker and the persisted record, so it must not change.
 * @property {string} name Display name shown on the project's settings card.
 * @property {string} description One-sentence user-facing description.
 * @property {string} version Project version, e.g. `1.0.0`.
 * @property {'skin'|'enhancement'} [type] Defaults to `enhancement`.
 * @property {boolean} [defaultEnabled] Enable the moment the plugin loads. A skin
 *   must opt out explicitly (`false`), because a skin replaces the whole look.
 * @property {'global'|'layout'|'component'} [scope] How wide the project reaches;
 *   `global` implies it may rebind design tokens.
 * @property {string[]} [supports] Any of `light`, `dark`, `mobile`.
 * @property {'low'|'medium'|'high'} [perfLevel] The heaviest effect tier this project was designed
 *   for. Defaults to `medium`. The runtime publishes the heaviest tier among active projects,
 *   capped by what the device can afford, as `data-ui-perf` on the body — so a stylesheet degrades
 *   itself by reading that attribute rather than by measuring anything.
 * @property {string} [preview] Preview descriptor: a CSS gradient for a generated
 *   thumbnail, or a path/URL to an image. Optional.
 * @property {string} [previewLabel] Alt text for the generated thumbnail.
 * @property {(ctx: UiProjectContext) => void} [apply] Side effects while active.
 *   Receives a hermetic context whose `styles.insert()` and `theme` layers are
 *   torn down by the runtime on cleanup, so a project never removes its own CSS.
 * @property {(ctx: UiProjectContext) => void} [cleanup] Optional extra teardown for
 *   side effects the runtime cannot own. Must be idempotent.
 * @property {number} [priority] Execution order among composable projects: a LOWER number is
 *   applied FIRST, ties broken by registration order. Defaults to `100`. Only meaningful between
 *   projects that can be active together — a skin is alone by policy, and a dependency still runs
 *   before whatever requires it regardless of the numbers.
 * @property {string[]} [requires] Ids that must be active too; the runtime keeps
 *   them consistent and refuses to enable a project whose dependency is missing.
 * @property {string[]} [modifies] Surfaces this project changes, from `PROJECT_REGIONS`. Used to
 *   warn when two projects that can be active together claim the same one — advisory only, because
 *   two projects may touch the same region compatibly, and the warning must not become noise.
 * @property {Array<{ id: string, label: string }>} [testItems] What a human should check before
 *   calling this project verified. Rendered as a checklist on the card; a confirmation is recorded
 *   against the project's `version`, so shipping a new version asks to be confirmed again.
 */

/**
 * @typedef {object} UiProjectContext
 * @property {string} id The project id.
 * @property {string} selector Root selector for this project, `html[data-ui-project-<id>="on"]`.
 * @property {HTMLElement} root The document element carrying `data-ui-*` markers.
 * @property {(css: string) => void} insertCss Inject project-owned CSS; removed on cleanup.
 * @property {(source: string, tokens: Record<string, { light: string, dark: string }>) => void} overrideTokens
 *   Stack alias-token overrides over the active theme; removed on cleanup.
 * @property {(err: unknown) => void} fail Record a non-fatal project problem for the settings card.
 * @property {() => boolean} isActive Re-read whether this project is still active.
 * @property {(key: string) => unknown} readSetting Project-private persisted value.
 * @property {(key: string, value: unknown) => Promise<void>} writeSetting Project-private persisted value.
 *   Project settings are stored in this plugin's own settings document.
 */

export class UiProjectRegistry {
  constructor() {
    /** @type {Map<string, UiProjectDefinition>} */
    this.projects = new Map()
    /** @type {Set<string>} */
    this.active = new Set()
    /** @type {Map<string, string>} */
    this.errors = new Map()
    /** @type {Set<() => void>} */
    this.listeners = new Set()
    this.revision = 0
  }

  /**
   * Register a project. Idempotent per id: re-registering replaces the definition
   * (used by hot reload) and keeps its current activation state.
   * @param {UiProjectDefinition} definition
   * @returns {() => void} unregister
   */
  register(definition) {
    const project = normalize(definition)
    this.projects.set(project.id, project)
    this.#bump()
    return () => {
      const current = this.projects.get(project.id)
      if (current !== project) return
      this.projects.delete(project.id)
      this.active.delete(project.id)
      this.errors.delete(project.id)
      this.#bump()
    }
  }

  /**
   * Remove one project by id, whatever registered it.
   *
   * TWO WAYS TO REMOVE A PROJECT, and they are not interchangeable:
   *
   *   the disposer `register()` returns   only the caller that registered it can withdraw it: a
   *                                       stale disposer — one held across a hot reload — finds
   *                                       `current !== project` and does nothing. That is what
   *                                       makes re-registration safe: a reload replaces the
   *                                       definition and the outgoing instance cannot delete its
   *                                       successor's work.
   *
   *   `unregister(id)`                    removes whatever is registered under that id right now.
   *                                       There is no caller to compare against, so there is no
   *                                       identity to check: it is the explicit operation for a
   *                                       caller that means "this id goes away" — the panel, a test,
   *                                       or the loader-facing code in step 5.
   *
   * NEITHER PATH TOUCHES THE USER'S RECORD. `enabled` lives in the settings document and is written
   * by `runtime.js`, never here: a package being uninstalled is not the user changing their mind,
   * and the record has to outlive it so that a reinstall restores the choice.
   *
   * AND NEITHER PATH DEACTIVATES. This module owns no DOM and no context (see the header), so a
   * project that is currently applied must be retired through the runtime FIRST. An active id is
   * therefore refused rather than removed: deleting the definition of an applied project would
   * leave its stylesheets and its `data-ui-*` markers on the page with nothing left that knows they
   * exist — the leak this method exists to prevent, arriving through the back door.
   * @param {string} id
   * @returns {boolean} whether something was registered under that id
   * @throws {TypeError} when the id is currently applied
   */
  unregister(id) {
    const project = this.projects.get(id)
    if (project === undefined) return false
    if (this.active.has(id)) {
      throw new TypeError(
        `[dsh-ui-projects] project "${id}" is applied: retire it through the runtime (runtime.retire) before unregistering, ` +
          'or its stylesheets and markers outlive the definition that owned them',
      )
    }
    this.projects.delete(id)
    this.errors.delete(id)
    this.#bump()
    return true
  }

  /** @returns {string[]} every registered id, in registration order. */
  ids() {
    return Array.from(this.projects.keys())
  }

  /**
   * @param {string} id
   * @returns {UiProjectDefinition | undefined}
   */
  get(id) {
    return this.projects.get(id)
  }

  /** @returns {UiProjectDefinition[]} every registered project, in registration order. */
  list() {
    return this.ids().map((id) => /** @type {UiProjectDefinition} */ (this.projects.get(id)))
  }

  /** @returns {UiProjectDefinition[]} registered projects of one type, in registration order. */
  listByType(type) {
    return this.list().filter((project) => project.type === type)
  }

  /**
   * @param {string} id
   * @returns {boolean} whether the project is registered and currently applied.
   */
  isEnabled(id) {
    return this.active.has(id)
  }

  /**
   * @param {string} id
   * @returns {string | undefined} the last non-fatal failure recorded for the project.
   */
  error(id) {
    return this.errors.get(id)
  }

  /**
   * @param {string} id
   * @returns {'active'|'inactive'|'error'|'unavailable'} the card's status summary.
   */
  status(id) {
    const project = this.projects.get(id)
    if (project === undefined) return 'unavailable'
    if (this.errors.has(id)) return 'error'
    return this.active.has(id) ? 'active' : 'inactive'
  }

  /** @returns {string[]} ids of every currently applied project, sorted. */
  activeIds() {
    return Array.from(this.active).sort()
  }

  /**
   * The heaviest `perfLevel` among the projects that are currently applied, or undefined when none
   * is applied.
   *
   * Declared demand only — the device half of the decision lives in `perf.js`, and the runtime is
   * what combines the two. Returning `undefined` rather than a default is what lets "nothing is
   * active" travel as "no tier at all" all the way to the attribute being removed.
   * @returns {'low'|'medium'|'high'|undefined}
   */
  highestPerfLevel() {
    let highest
    for (const id of this.active) {
      const level = this.projects.get(id)?.perfLevel
      if (typeof level !== 'string') continue
      if (highest === undefined || rankOf(level) > rankOf(highest)) highest = level
    }
    return highest
  }

  /** @param {string} id @returns {boolean} */
  #setActive(id) {
    if (this.active.has(id)) return false
    this.active.add(id)
    return true
  }

  /** @param {string} id */
  #clearActive(id) {
    this.active.delete(id)
  }

  /** @internal — used by runtime.js only. */
  markActive(id) {
    this.#setActive(id)
    this.errors.delete(id)
    this.#bump()
  }

  /** @internal — used by runtime.js only. */
  markInactive(id) {
    this.#clearActive(id)
    this.errors.delete(id)
    this.#bump()
  }

  /**
   * Record a non-fatal failure. The project stays inactive and its card reports
   * the reason instead of pretending it is on.
   * @internal — used by runtime.js only.
   * @param {string} id
   */
  markError(id, error) {
    this.#clearActive(id)
    this.errors.set(id, describeError(error))
    this.#bump()
  }

  /** @internal — used by runtime.js only. */
  clearError(id) {
    if (this.errors.delete(id)) this.#bump()
  }

  /**
   * Projects whose activation contradicts the policy (two skins active), or whose
   * `requires` ids are inactive. Used by the runtime to repair state and by the
   * panel to preview what an enable would turn off.
   * @param {string} id project about to be enabled
   * @returns {string[]} active ids that enabling `id` would deactivate
   */
  conflictIds(id) {
    const project = this.projects.get(id)
    if (project === undefined || project.type !== TYPE_SKIN) return []
    return this.listByType(TYPE_SKIN)
      .filter((other) => other.id !== id && this.active.has(other.id))
      .map((other) => other.id)
  }

  /**
   * The order these projects must be applied in: lower `priority` first, ties by registration.
   *
   * Registration order is the tie-break because it is the only ordering that is both stable and
   * meaningful: it is the order the composition declared its projects in. Sorting the applied set
   * instead — which is what used to happen, since `activeIds()` sorts — produced alphabetical
   * order, so a rename could change when a project ran and nothing recorded that it had.
   *
   * The order is a REQUEST, not a guarantee: `requires` still wins, because a dependency must be
   * applied before the project depending on it regardless of what either one declares here.
   * @param {string[]} [ids] defaults to the applied projects
   * @returns {string[]}
   */
  canonicalOrder(ids = this.activeIds()) {
    const registered = this.ids()
    return [...ids].sort((a, b) => {
      const left = this.projects.get(a)?.priority ?? DEFAULT_PRIORITY
      const right = this.projects.get(b)?.priority ?? DEFAULT_PRIORITY
      if (left !== right) return left - right
      return registered.indexOf(a) - registered.indexOf(b)
    })
  }

  /**
   * Pairs of ACTIVE enhancements whose declared regions overlap.
   *
   * Skins are excluded, and that is the whole reason the warning is worth showing. A skin declares
   * a broad footprint — the shipped one touches tokens, the background, the composer and dialogs —
   * so including skins would make every enhancement conflict with the skin and turn the warning
   * into wallpaper. The specification asks for exactly this scope: warn when several enhancements
   * are active together. Skins are made mutually exclusive by policy instead.
   *
   * Advisory by construction: two projects may touch the same region and still compose perfectly
   * (one sets a colour, another a radius). Nothing here blocks an enable, and nothing should.
   * @returns {Array<{ ids: [string, string], regions: string[] }>}
   */
  regionConflicts() {
    const active = this.listByType(TYPE_ENHANCEMENT).filter((project) => this.active.has(project.id))
    const out = []
    for (let left = 0; left < active.length; left += 1) {
      for (let right = left + 1; right < active.length; right += 1) {
        const shared = active[left].modifies.filter((region) => active[right].modifies.includes(region))
        if (shared.length > 0) out.push({ ids: [active[left].id, active[right].id], regions: shared })
      }
    }
    return out
  }

  /**
   * Subscribe to registry changes (registration, activation, errors).
   * @param {() => void} listener
   * @returns {() => void} disposer
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** @returns {number} monotonically increasing revision, for external-store consumers. */
  getVersion() {
    return this.revision
  }

  /**
   * Publish a change the registry cannot observe by itself (a locale flip, for
   * example) so external-store consumers re-render.
   */
  notify() {
    this.#bump()
  }

  #bump() {
    this.revision += 1
    for (const listener of Array.from(this.listeners)) {
      try {
        listener()
      } catch (err) {
        console.error('[dsh-ui-projects] registry listener failed', err)
      }
    }
  }
}

/**
 * Validate and normalize one definition. Throws on a malformed id or type, since
 * a broken registration is a programming error, not a runtime condition.
 * @param {UiProjectDefinition} definition
 * @returns {UiProjectDefinition}
 */
export function normalize(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError('[dsh-ui-projects] a UI project definition must be an object')
  }
  const { id, name, description } = definition
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new TypeError(
      `[dsh-ui-projects] invalid UI project id ${String(id)}: expected lowercase letters, digits and dashes`,
    )
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`[dsh-ui-projects] UI project "${id}" needs a name`)
  }
  const type = definition.type ?? TYPE_ENHANCEMENT
  if (!PROJECT_TYPES.includes(type)) {
    throw new TypeError(`[dsh-ui-projects] UI project "${id}" has unknown type "${String(type)}"`)
  }
  /*
   * A tier is validated the way `type` is, and NOT the way `scope` is.
   *
   * `scope` is currently accepted as-is, which means a typo in it is invisible: the value reaches
   * the card, renders as its own fallback label, and nothing else reads it. A `perfLevel` typo
   * would be worse than invisible — the runtime ranks unknown tiers as `medium`, so a project
   * asking for `low` and spelling it `Low` would silently be given a heavier treatment than it
   * declared. Failing at registration is the only place that costs nothing.
   */
  const perfLevel = definition.perfLevel ?? PERF_MEDIUM
  if (!PROJECT_PERF_LEVELS.includes(perfLevel)) {
    throw new TypeError(
      `[dsh-ui-projects] UI project "${id}" has unknown perfLevel "${String(perfLevel)}": expected one of ${PROJECT_PERF_LEVELS.join(', ')}`,
    )
  }
  /*
   * An integer, not merely a number: the sort is the contract, and a fractional priority would
   * make two projects' relative order depend on float equality in a way no reader could predict.
   */
  const priority = definition.priority ?? DEFAULT_PRIORITY
  if (!Number.isInteger(priority)) {
    throw new TypeError(
      `[dsh-ui-projects] UI project "${id}" has a non-integer priority "${String(priority)}": expected a whole number, lower runs first`,
    )
  }
  /*
   * Regions are validated against the vocabulary for the same reason tiers are: a misspelling
   * (`composer` typed `composr`) would silently never conflict with anything, and the project would
   * look like it had been checked when it had not.
   */
  const modifies = Array.isArray(definition.modifies) ? definition.modifies.slice() : []
  const unknownRegion = modifies.find((region) => !PROJECT_REGIONS.includes(region))
  if (unknownRegion !== undefined) {
    throw new TypeError(
      `[dsh-ui-projects] UI project "${id}" declares an unknown region "${String(unknownRegion)}": expected any of ${PROJECT_REGIONS.join(', ')}`,
    )
  }
  /*
   * Test items are validated rather than passed through, and for a sharper reason than the other
   * lists: a malformed entry here is not a missing feature, it is a checklist that cannot record
   * anything. An item without an id cannot be stored, and an item without a label is a checkbox
   * nobody can read — both would surface as a control that silently does nothing, which is the
   * failure this package has spent the most time removing.
   *
   * UNIQUENESS, and why this is stricter than the project id above it.
   *
   * A project id that arrives twice means REPLACE: that is how hot reload works, and `register` is
   * documented that way, so it is accepted on purpose. A test item id that arrives twice inside ONE
   * definition means the definition contradicts itself. Every part of this system keys a checklist by
   * that id — the tick map, the stored record, the currency rule — so the two rows would share one
   * tick and the record could not tell them apart. "Each declared item was read" would stop being a
   * claim anybody can verify, which is the one thing a checklist is for.
   *
   * Refused rather than warned about, and not de-duplicated at render time either: hiding the second
   * row would leave the definition just as contradictory while making it invisible, and a render-time
   * fix would not reach the store, which is where the collision actually happens.
   */
  const testItems = Array.isArray(definition.testItems) ? definition.testItems : []
  /** @type {Map<string, string>} id → the label it was first declared with, so the message can name both */
  const seen = new Map()
  const items = testItems.map((entry) => {
    const itemId = entry?.id
    const label = entry?.label
    if (typeof itemId !== 'string' || !ID_PATTERN.test(itemId)) {
      throw new TypeError(
        `[dsh-ui-projects] UI project "${id}" has a test item with an invalid id ${String(itemId)}: expected lowercase letters, digits and dashes`,
      )
    }
    if (typeof label !== 'string' || label.length === 0) {
      throw new TypeError(`[dsh-ui-projects] UI project "${id}" test item "${itemId}" needs a label`)
    }
    const first = seen.get(itemId)
    if (first !== undefined) {
      throw new TypeError(
        `[dsh-ui-projects] UI project "${id}" declares the test item id "${itemId}" twice ` +
          `(labels "${first}" and "${label}"): a checklist is keyed by that id, so the two rows would share one tick`,
      )
    }
    seen.set(itemId, label)
    return Object.freeze({ id: itemId, label })
  })
  return Object.freeze({
    id,
    name,
    description: typeof description === 'string' ? description : '',
    version: typeof definition.version === 'string' && definition.version.length > 0 ? definition.version : '0.0.0',
    type,
    defaultEnabled: definition.defaultEnabled === true,
    scope: definition.scope ?? 'component',
    supports: Object.freeze(Array.isArray(definition.supports) ? definition.supports.slice() : []),
    perfLevel,
    priority,
    modifies: Object.freeze(modifies),
    testItems: Object.freeze(items),
    preview: typeof definition.preview === 'string' ? definition.preview : undefined,
    previewLabel: typeof definition.previewLabel === 'string' ? definition.previewLabel : undefined,
    apply: typeof definition.apply === 'function' ? definition.apply : undefined,
    cleanup: typeof definition.cleanup === 'function' ? definition.cleanup : undefined,
    requires: Object.freeze(Array.isArray(definition.requires) ? definition.requires.slice() : []),
    /**
     * The controls the settings card renders for this project, frozen shallowly but passed
     * through as declared.
     *
     * `normalize` is deliberately a whitelist, so a project cannot smuggle arbitrary state
     * into the registry — which means every part of a project's shape has to be named here.
     * Controls were not, and the settings page rendered nothing: the field was silently
     * dropped between the declaration and the card.
     */
    controls: Object.freeze(Array.isArray(definition.controls) ? definition.controls.map((entry) => Object.freeze({ ...entry })) : []),
  })
}

/**
 * @param {unknown} error
 * @returns {string} a short, model-independent message safe to render on a card.
 */
export function describeError(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
