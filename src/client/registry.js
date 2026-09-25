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
 * @property {string} [preview] Preview descriptor: a CSS gradient for a generated
 *   thumbnail, or a path/URL to an image. Optional.
 * @property {string} [previewLabel] Alt text for the generated thumbnail.
 * @property {(ctx: UiProjectContext) => void} [apply] Side effects while active.
 *   Receives a hermetic context whose `styles.insert()` and `theme` layers are
 *   torn down by the runtime on cleanup, so a project never removes its own CSS.
 * @property {(ctx: UiProjectContext) => void} [cleanup] Optional extra teardown for
 *   side effects the runtime cannot own. Must be idempotent.
 * @property {string[]} [requires] Ids that must be active too; the runtime keeps
 *   them consistent and refuses to enable a project whose dependency is missing.
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
  return Object.freeze({
    id,
    name,
    description: typeof description === 'string' ? description : '',
    version: typeof definition.version === 'string' && definition.version.length > 0 ? definition.version : '0.0.0',
    type,
    defaultEnabled: definition.defaultEnabled === true,
    scope: definition.scope ?? 'component',
    supports: Object.freeze(Array.isArray(definition.supports) ? definition.supports.slice() : []),
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
