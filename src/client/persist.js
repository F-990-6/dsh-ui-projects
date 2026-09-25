/**
 * Where UI project state lives.
 *
 * One adapter interface, two backends, chosen once at plugin load:
 *
 *  1. `settings` — the dsh settings document (`$DSH_HOME/settings.yaml`), read
 *     and written through the client's `ctx.settingsScope` service. Preferred,
 *     because it is the project's existing settings storage, it is backed by the
 *     Host, and it survives a browser-profile reset.
 *  2. `local` — `window.localStorage`. Fallback for a non-loopback page (where
 *     the Host disables durable settings and every scope reports
 *     `unavailable`) or a client that has no `settingsScope` service at all.
 *
 * ## The record, and why it stores what it stores
 *
 *   { v: 1, initialized: true, enabled: ["liquid-glass"], settings: {}, touched: true }
 *
 * `enabled` is the **complete** set of projects the user wants on — not a list of
 * overrides, and not a list of what is off. That matters because a project may
 * default either way: a skin ships off and must stay on after a reload once the
 * user turns it on, while an enhancement may ship on and must stay off once the
 * user turns it off. Storing "what is on" answers both with one field, and the
 * runtime simply makes the document match it.
 *
 * `initialized` distinguishes "no record yet, use each project's default" from
 * "the user turned everything off", which is an empty `enabled` list.
 *
 * `settings` holds project-private options, keyed by project id.
 */

/** Settings namespace owned by this plugin. */
export const SETTINGS_NS = 'ui-projects'

/** localStorage key used by the fallback adapter. */
export const LOCAL_KEY = 'dsh.ui-projects.v1'

/**
 * localStorage keys written by a generation of this plugin that no longer exists.
 *
 * Nothing in this codebase reads or writes them, and nothing ever should: they are the
 * leftovers of a per-project storage scheme that predates the shared `ui-projects`
 * settings record. They are swept on sight because a stale key that looks authoritative
 * costs a future reader real time — "is the skin reading this?" is a question that should
 * not need answering twice.
 *
 * The list is data rather than two inline literals only so the sweep reads as a policy
 * with a name, and so a future removal is one line rather than a rewritten function.
 */
const LEGACY_LOCAL_KEYS = ['dsh-liquid-glass.settings', 'dsh-liquid-glass.settings.version']

/**
 * Delete the leftover keys from a previous generation, once per load.
 *
 * Kept here rather than in `skin.js` on purpose: this module is the ONLY place in the
 * plugin that touches `localStorage`, which is what keeps "where does state live" a
 * one-file question. A skin reaching for storage directly is exactly the drift this
 * centralisation exists to prevent.
 *
 * Best-effort and silent. `localStorage` can throw on access (disabled, sandboxed,
 * quota-exhausted) and a stale key is never worth failing a plugin load over.
 */
function sweepLegacyLocalKeys() {
  if (typeof window === 'undefined' || window.localStorage === undefined || window.localStorage === null) return
  for (const key of LEGACY_LOCAL_KEYS) {
    try {
      if (window.localStorage.getItem(key) !== null) window.localStorage.removeItem(key)
    } catch {
      /* storage unavailable; the keys are inert either way */
    }
  }
}

/**
 * @typedef {object} UiProjectRecord
 * @property {number} v Record version, for a future migration.
 * @property {boolean} initialized Whether a user choice has ever been recorded.
 * @property {string[]} enabled Ids the user wants active.
 * @property {Record<string, Record<string, unknown>>} settings Project-private options.
 * @property {boolean} touched Whether the user changed anything.
 */

/** @returns {UiProjectRecord} */
function emptyRecord() {
  return { v: 1, initialized: false, enabled: [], settings: {}, touched: false }
}

/**
 * @typedef {object} PersistAdapter
 * @property {'settings'|'local'} kind
 * @property {() => UiProjectRecord} read
 * @property {(next: UiProjectRecord) => Promise<void>} write
 * @property {() => void} dispose
 */

/**
 * Coerce anything that came off the wire or out of storage into the record shape.
 * Never throws: a corrupt record must not disable the whole settings page.
 * Unknown keys are dropped, unknown ids are kept (a project may be temporarily
 * uninstalled and come back).
 * @param {unknown} raw
 * @returns {UiProjectRecord}
 */
export function coerce(raw) {
  if (raw === null || typeof raw !== 'object') return emptyRecord()
  const source = /** @type {Record<string, unknown>} */ (raw)
  /** @type {string[]} */
  const enabled = []
  if (Array.isArray(source.enabled)) {
    for (const value of source.enabled) {
      if (typeof value === 'string' && value.length > 0 && !enabled.includes(value)) enabled.push(value)
    }
  }
  /** @type {Record<string, Record<string, unknown>>} */
  const settings = {}
  const rawSettings = source.settings
  if (rawSettings !== null && typeof rawSettings === 'object' && !Array.isArray(rawSettings)) {
    for (const [id, value] of Object.entries(rawSettings)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        settings[id] = { .../** @type {Record<string, unknown>} */ (value) }
      }
    }
  }
  return {
    v: 1,
    initialized: source.initialized === true,
    enabled,
    settings,
    touched: source.touched === true,
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {PersistAdapter} the best available adapter; never throws.
 */
export function createPersist(ctx) {
  // Before choosing an adapter, and regardless of which one wins: the leftovers are in
  // localStorage whether or not this session ends up using it.
  sweepLegacyLocalKeys()

  const fromSettings = createSettingsPersist(ctx)
  if (fromSettings !== undefined) return fromSettings
  return createLocalPersist()
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {PersistAdapter | undefined}
 */
function createSettingsPersist(ctx) {
  const scopeService = ctx.get('settingsScope')
  if (scopeService === undefined) return undefined
  try {
    const scope = scopeService.bind({
      namespace: SETTINGS_NS,
      decode: (section) => coerce(section),
    })
    // A non-loopback page keeps preferences process-local; localStorage is the
    // more useful place for a per-browser preference in that case.
    if (scope.getSnapshot().mode === 'memory') {
      scope.dispose?.()
      return undefined
    }
    /** @type {UiProjectRecord | undefined} */
    let cached
    const current = () => {
      const snapshot = scope.getSnapshot()
      if (snapshot.status === 'ready') cached = coerce(snapshot.value)
      return cached ?? emptyRecord()
    }
    scope.subscribe(() => {
      cached = undefined
      current()
    })
    return {
      kind: 'settings',
      read: current,
      write: async (next) => {
        const snapshot = scope.getSnapshot()
        if (snapshot.status !== 'ready') throw new Error(`settings namespace ${SETTINGS_NS} is ${snapshot.status}`)
        // One ordered mutation: a reader never sees a half-written choice.
        await scope.set('enabled', next.enabled)
        await scope.set('initialized', true)
        await scope.set('settings', next.settings)
        await scope.set('touched', next.touched)
        await scope.set('v', 1)
        cached = { ...next, initialized: true }
      },
      dispose: () => {
        scope.dispose?.()
      },
    }
  } catch (err) {
    console.error('[dsh-ui-projects] settings-backed persistence unavailable, using localStorage', err)
    return undefined
  }
}

/** @returns {PersistAdapter} */
export function createLocalPersist() {
  /** @type {UiProjectRecord | undefined} */
  let cached
  const available = hasLocalStorage()
  const read = () => {
    if (cached !== undefined) return cached
    if (!available) {
      cached = emptyRecord()
      return cached
    }
    try {
      const raw = window.localStorage.getItem(LOCAL_KEY)
      cached = raw === null ? emptyRecord() : coerce(JSON.parse(raw))
    } catch (err) {
      console.error('[dsh-ui-projects] unreadable localStorage record, starting clean', err)
      cached = emptyRecord()
    }
    return cached
  }
  return {
    kind: 'local',
    read,
    write: async (next) => {
      cached = { ...next, initialized: true }
      if (!available) return
      try {
        window.localStorage.setItem(LOCAL_KEY, JSON.stringify(cached))
      } catch (err) {
        console.error('[dsh-ui-projects] cannot persist UI project state', err)
      }
    },
    dispose: () => {
      cached = undefined
    },
  }
}

/** @returns {boolean} */
function hasLocalStorage() {
  try {
    return typeof window !== 'undefined' && window.localStorage !== undefined && window.localStorage !== null
  } catch {
    return false
  }
}
