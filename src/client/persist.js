/**
 * Where UI project state lives.
 *
 * One adapter interface, two backends, chosen once at plugin load:
 *
 *  1. `settings` — the dsh settings document (`$DSH_HOME/settings.yaml`), read
 *     and written through the client's `ctx.settingsScope` service. Authoritative,
 *     and what a running instance uses: it is the project's existing settings
 *     storage, it is backed by the Host, and it survives a browser-profile reset.
 *  2. `local` — `window.localStorage`. Fallback for the one case the settings
 *     document cannot serve: a page that is not loopback, where the Host keeps
 *     preferences process-local. A bound scope reports that as `mode: 'memory'` —
 *     **`mode` is the field this file checks.** The same condition also leaves the
 *     mirror's `status` at `'unavailable'`, because ui-settings derives both from
 *     one persistence value; a reader comparing the two will see them move
 *     together, and only `mode` is load-bearing here.
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
 * How long `ready()` waits for the settings document before giving up.
 *
 * WHAT A TIMEOUT LOOKS LIKE — recorded here so the next reader does not file it as a bug. The
 * record cannot be read yet, so `read()` returns the empty record, `runtime.start()` sees
 * `initialized: false` and falls back to each project's `defaultEnabled`. For the shipped skin
 * that means Liquid Glass does NOT come back on that load, and the user sees "my skin was on and
 * now it is off".
 *
 * That is a DEGRADATION, NOT A FAILURE, and the window closes by itself: `write()` still goes
 * through the settings document as soon as the scope reports ready, so flipping the switch by
 * hand persists correctly to `settings.yaml`. Nothing is lost and nothing is corrupted — one
 * load simply starts from the defaults. The alternative is worse in every way: waiting forever
 * would let a settings transport that never answers keep the skin off permanently, instead of
 * for a single page load.
 *
 * `persistReady` in the diagnostics overlay reports `'timeout'` when this fires, so the reason
 * is readable off a screen rather than inferred.
 */
const READY_TIMEOUT_MS = 2000

/**
 * @typedef {object} PersistAdapter
 * @property {'settings'|'local'} kind
 * @property {boolean} diverged
 *   Whether a `localStorage` record exists AND disagrees with the settings record. Only ever
 *   true during the one-time handover to the settings backend: the first successful settings
 *   write removes the local copy, so the two cannot drift into competing records afterwards.
 * @property {'idle'|'ready'|'unavailable'|'error'|'timeout'|'n/a'} readiness
 *   How far `ready()` got. Read by the diagnostics overlay; `'timeout'` is the one worth seeing.
 * @property {() => Promise<void>} ready
 *   Resolves once the record can be trusted. Never hangs — see `READY_TIMEOUT_MS`.
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
    /** @type {PersistAdapter['readiness']} */
    let readiness = 'idle'
    /** @type {boolean} */
    let diverged = false
    let settled = false
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline
    /** @type {Set<() => void>} */
    const waiting = new Set()

    const current = () => {
      const snapshot = scope.getSnapshot()
      if (snapshot.status === 'ready') cached = coerce(snapshot.value)
      return cached ?? emptyRecord()
    }

    /**
     * The readiness a snapshot implies, or undefined while the read is still in flight.
     *
     * A failed read is a terminal state even though the status stays `idle`: ui-settings keeps
     * the last good view and puts the reason in `error`, so `error` has to be checked too or a
     * broken transport would always burn the full timeout.
     * @param {{ status?: string, error?: unknown }} snapshot
     * @returns {PersistAdapter['readiness'] | undefined}
     */
    const terminalOf = (snapshot) => {
      if (snapshot.status === 'ready') return 'ready'
      if (snapshot.status === 'unavailable') return 'unavailable'
      if (snapshot.error !== null && snapshot.error !== undefined) return 'error'
      return undefined
    }

    /** @param {PersistAdapter['readiness']} next */
    const settle = (next) => {
      if (settled) return
      settled = true
      readiness = next
      if (deadline !== undefined) {
        clearTimeout(deadline)
        deadline = undefined
      }
      /*
       * Divergence is decided HERE, not at bind time. Until the settings document has actually
       * been read there is no record to compare a leftover local one against, so a comparison
       * made earlier would report "no divergence" for the only case that matters.
       */
      if (next === 'ready') {
        diverged = disagreesWithLocal(current())
        if (diverged) {
          console.warn(
            `[dsh-ui-projects] a "${LOCAL_KEY}" localStorage record disagrees with the "${SETTINGS_NS}" ` +
              'settings document; the settings document wins, and the local copy is removed on the next write',
          )
        }
      }
      const pending = [...waiting]
      waiting.clear()
      for (const resolve of pending) resolve()
    }

    const observe = () => {
      if (settled) return
      const terminal = terminalOf(scope.getSnapshot())
      if (terminal !== undefined) settle(terminal)
    }

    scope.subscribe(() => {
      cached = undefined
      observe()
      current()
    })

    /**
     * Resolve once the settings document can be read.
     *
     * The bound scope's snapshot starts as `idle` and only becomes `ready` after the first
     * `settings.describe` read settles — a wire round-trip that the provider starts without
     * awaiting it (ui-settings calls `mirror.ensure()` and then publishes the service in the
     * binder's constructor). Reading before that returns the empty record, and the empty record
     * means "the user has never chosen anything", so `runtime.start()` would restore the shipped
     * defaults and silently ignore the user's set.
     *
     * Settles on the first terminal snapshot, and otherwise on `READY_TIMEOUT_MS`; it never
     * hangs. A timeout is a degradation rather than a failure — see the constant.
     * @returns {Promise<void>}
     */
    const ready = () => {
      if (settled) return Promise.resolve()
      return new Promise((resolve) => {
        waiting.add(resolve)
        observe()
        if (settled) return
        if (deadline === undefined && typeof setTimeout === 'function') {
          const timer = setTimeout(() => settle('timeout'), READY_TIMEOUT_MS)
          // `unref` so a pending deadline cannot hold a Node process open; the same note appears
          // beside the runtime's retries.
          timer?.unref?.()
          deadline = timer
        }
      })
    }

    return {
      kind: 'settings',
      get diverged() {
        return diverged
      },
      get readiness() {
        return readiness
      },
      ready,
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
        /*
         * The settings document has just accepted a write, so it is authoritative from here and
         * any localStorage copy is a stale duplicate of a choice the user has already superseded.
         * Removing it is what stops the two from becoming competing records — the state this
         * plugin was in before the dependency declaration was fixed.
         */
        if (clearLocalRecord()) {
          diverged = false
          console.info(
            `[dsh-ui-projects] "${SETTINGS_NS}" is stored in the dsh settings document; the "${LOCAL_KEY}" localStorage copy was removed`,
          )
        }
      },
      dispose: () => {
        // Release anyone waiting on `ready()`: a plugin being torn down must not leave a promise
        // pending forever behind it.
        settled = true
        if (deadline !== undefined) {
          clearTimeout(deadline)
          deadline = undefined
        }
        const pending = [...waiting]
        waiting.clear()
        for (const resolve of pending) resolve()
        scope.dispose?.()
      },
    }
  } catch (err) {
    console.error('[dsh-ui-projects] settings-backed persistence unavailable, using localStorage', err)
    return undefined
  }
}

/**
 * Whether a leftover `localStorage` record says anything different from the settings one.
 *
 * Only the fields a user can actually change are compared, and `enabled` is compared as a SET:
 * the same choice written in a different order is not a divergence, and reporting one would
 * teach a reader to ignore the warning. An uninitialized local record holds no choice at all,
 * so it cannot diverge either.
 * @param {UiProjectRecord} record the authoritative settings record
 * @returns {boolean}
 */
function disagreesWithLocal(record) {
  const local = readLocalRecord()
  if (local === undefined || !local.initialized) return false
  const mine = [...local.enabled].sort()
  const theirs = [...record.enabled].sort()
  if (mine.length !== theirs.length) return true
  if (mine.some((id, index) => id !== theirs[index])) return true
  return JSON.stringify(local.settings) !== JSON.stringify(record.settings)
}

/**
 * The `localStorage` record, if this browser has one.
 *
 * Reading and writing the fallback key lives in this module and nowhere else — that is what
 * keeps "where does state live" a one-file question. Returns undefined when storage is
 * unavailable, empty, or unreadable; a corrupt record is never worth throwing over.
 * @returns {UiProjectRecord | undefined}
 */
function readLocalRecord() {
  return withLocalStorage((storage) => {
    const raw = storage.getItem(LOCAL_KEY)
    return raw === null ? undefined : coerce(JSON.parse(raw))
  }, undefined)
}

/**
 * Remove the fallback record, reporting whether there was one.
 * @returns {boolean}
 */
function clearLocalRecord() {
  return withLocalStorage((storage) => {
    if (storage.getItem(LOCAL_KEY) === null) return false
    storage.removeItem(LOCAL_KEY)
    return true
  }, false)
}

/**
 * Run one `localStorage` operation, degrading instead of throwing.
 *
 * `localStorage` can throw on mere access (disabled, sandboxed, partitioned), so every caller
 * gets the fallback value rather than an exception. Centralised so the access rules above are
 * stated once.
 * @template T
 * @param {(storage: Storage) => T} run
 * @param {T} fallback
 * @returns {T}
 */
function withLocalStorage(run, fallback) {
  try {
    if (typeof window === 'undefined' || window.localStorage === undefined || window.localStorage === null) {
      return fallback
    }
    return run(window.localStorage)
  } catch {
    return fallback
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
    /*
     * A local-only session has nothing to diverge FROM: the settings document is not in play, so
     * there is no second record to disagree with this one.
     */
    diverged: false,
    // Nothing to wait for either — the record is already in this browser, or there is none.
    readiness: 'n/a',
    ready: () => Promise.resolve(),
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
