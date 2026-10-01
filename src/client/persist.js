/**
 * Where UI project state lives.
 *
 * One adapter interface, THREE backends, chosen once at plugin load, in this order:
 *
 *  1. `settingsScope` — the dsh settings document (`$DSH_HOME/settings.yaml`) through the client's
 *     `ctx.settingsScope` service (0.1.5-rc.3, the web profile). Authoritative, backed by the Host,
 *     and it survives a browser-profile reset.
 *  2. `remote.settings` — the SAME document, one layer lower, for a dsh that leaves the wrapper out
 *     (0.2.0-rc.2, the desktop application): the scope above is itself built on this remote, so one
 *     adapter serves both versions. See `settings-controller.js`.
 *  3. `local` — `window.localStorage`. Fallback for the one case the settings document cannot serve:
 *     a page that is not loopback, where the Host keeps preferences process-local. The scope path
 *     reports that as `mode: 'memory'` — **`mode` is the field this file checks for it** — and the same
 *     condition also leaves the mirror's `status` at `'unavailable'`, because ui-settings derives both
 *     from one persistence value; a reader comparing the two will see them move together, and only
 *     `mode` is load-bearing there. The remote path asks `remote.$host.isLoopback` instead, which is
 *     the field ui-settings itself branches on.
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

import { createRemoteSettingsPersist } from './settings-controller.js'

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
 * Kept here rather than in `skin.js` on purpose: this module is the only place that touches the
 * plugin's own STATE record, which is what keeps "where does state live" a one-file question. A
 * skin reaching for storage directly is exactly the drift this centralisation exists to prevent.
 * (`diagnostics.js` reads one key of its own — the debug switch — and that is an instrumentation
 * toggle, never state. This sentence used to claim this module was the only place in the plugin
 * that touched `localStorage` at all, which was false the whole time it was written there.)
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

/*
 * ── THE RECORD HAS TWO HOMES, AND ONLY ONE OF THEM ANSWERS ───────────────────────────────────────
 *
 * MEASURED, on the desktop application (0.2.0-rc.2; "branch A" in the phase-3 notes): the client's
 * `ctx.remote.settings.update(...)` accepts a write and reports nothing, while the host half — reading
 * through `ctx.get('settings')` at emit time — still finds no section for this plugin. Two settings
 * surfaces in one application, with no shared document, so a preference the user expressed in the panel
 * is forgotten by the next start. The shell report covers that divergence itself.
 *
 * These three functions are OUR half of the consequence, and they are deliberately PURE: no `ctx`, no
 * module state, no I/O of their own. `storage` and `key` arrive as arguments, which is what lets the
 * decision be tested without a browser, a document, or a running application.
 *
 * ABSENT IS NOT EMPTY, and this is the distinction the whole policy rests on. `coerce(undefined)`
 * yields the empty record, whose meaning is "the user has NEVER CHOSEN ANYTHING". The remote adapter
 * returns exactly that today for a document that does not mention this namespace at all — so
 * `documentRecord: undefined` below means ABSENCE, and a coerced empty record means a CHOICE. Collapsing
 * the two is precisely how a stale copy would resurrect a skin the user had turned off.
 */

/**
 * Which home answers: the settings document, or the browser's own copy.
 *
 * A document that CARRIES the record outranks the copy in both directions — including when it carries
 * `enabled: []`, which is a user who turned everything off. The copy answers SILENCE, never
 * disagreement.
 *
 * @param {{ documentRecord?: UiProjectRecord, localRecord?: UiProjectRecord }} input
 * @returns {{ source: 'document'|'local'|'empty', record: UiProjectRecord }}
 */
export function chooseRecord({ documentRecord, localRecord }) {
  if (documentRecord !== undefined) return { source: 'document', record: documentRecord }
  if (localRecord !== undefined) return { source: 'local', record: localRecord }
  return { source: 'empty', record: emptyRecord() }
}

/**
 * Write the browser's own copy of the record.
 *
 * Called after every document write, accepted or refused: when the document refuses (branch A: it
 * accepts and keeps nothing), the copy is the only place the choice survives — and when it refuses
 * loudly, the error still has to be reported by the DOCUMENT write, not by this one. Hence: never
 * throws, and reports what happened in its return value.
 *
 * @param {{ storage?: { setItem?: (key: string, value: string) => void }, key: string, record: UiProjectRecord }} input
 * @returns {{ stored: boolean, error?: string }}
 */
export function mirrorToLocal({ storage, key, record }) {
  try {
    if (storage === undefined || typeof storage.setItem !== 'function') {
      return { stored: false, error: 'this page offers no storage to keep a copy in' }
    }
    storage.setItem(key, JSON.stringify(record))
    return { stored: true }
  } catch (error) {
    return { stored: false, error: String(error?.message ?? error) }
  }
}

/**
 * Whether a copy adopted from the browser should be offered back to the document.
 *
 * ONCE, and never over a document that already carries the record: a document that keeps not taking the
 * write must not be written to on every read, and a document that has the section is a user choice
 * rather than silence.
 *
 * @param {{ documentRecord?: UiProjectRecord, localRecord?: UiProjectRecord, alreadyOffered?: boolean }} input
 * @returns {boolean}
 */
export function shouldOfferBack({ documentRecord, localRecord, alreadyOffered }) {
  if (alreadyOffered === true) return false
  if (documentRecord !== undefined) return false
  return localRecord !== undefined
}

/**
 * How long `ready()` waits for the settings document before giving up.
 *
 * WHAT A TIMEOUT LOOKS LIKE NOW — recorded here because this is the one place the decision is
 * visible, and because the previous version of this comment described the OPPOSITE behaviour as
 * intended. The record cannot be read yet, so `read()` returns `undefined`, which means UNKNOWN:
 * not "the user has never chosen anything", which is what the empty record means and what it used
 * to be confused with. The runtime answers an unknown record from the HOST's first frame — the
 * marker the host stamped on `<body>` after reading the same document at emit time — and reconciles
 * against the real record the moment it arrives (`runtime.js`, `#reconcile`).
 *
 * That is a DEGRADATION, NOT A FAILURE, and the window closes by itself: `write()` still goes
 * through the settings document as soon as the scope reports ready, so flipping the switch by hand
 * persists correctly to `settings.yaml`. Nothing is lost and nothing is corrupted — one load simply
 * starts from what the first frame already painted, and is corrected if the document disagrees. The
 * alternative is worse in every way: waiting forever would let a settings transport that never
 * answers hold a page's boot open, instead of costing it one degraded first frame.
 *
 * `persistReady` in the diagnostics overlay reports `'timeout'` when this fires, and `persistAdopted`
 * names what the first frame was trusted for, so the reason is readable off a screen rather than
 * inferred.
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
 * @property {() => UiProjectRecord | undefined} read
 *   The record, or UNDEFINED WHILE IT IS UNKNOWN. `undefined` is not the empty record: the empty
 *   record says "the user has never chosen anything", which is a fact about the user, while
 *   `undefined` says "this page has not been told yet", which is a fact about the transport. Only
 *   the settings backend can be in that state — the `localStorage` one reads synchronously and
 *   therefore always answers, so a fallback record either exists or means what the empty record
 *   means. A reader that treats the two alike reintroduces the bug this field exists to end: a slow
 *   read becoming "the user turned it off".
 * @property {(listener: () => void) => () => void} subscribe
 *   Called when the underlying record may have changed: the settings document answering for the
 *   first time, or a write landing. NOT called with the record — a listener re-reads through
 *   `read()`, so there is one way to see state and no stale copy can be handed out by accident. The
 *   returned function unsubscribes.
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
  /*
   * THE SECOND SETTINGS BACKEND, for a dsh that leaves the wrapper out (0.2.0-rc.2). It is tried before
   * localStorage because a settings document the user can see beats a per-browser copy, and `undefined`
   * from the factory means "this composition cannot host one" — not "it tried and failed".
   */
  const fromRemote = createRemoteSettingsPersist(ctx, { coerce })
  if (fromRemote !== undefined) return withLocalCopy(fromRemote, { key: LOCAL_KEY })
  return createLocalPersist()
}

/*
 * ── THE BROWSER'S COPY, FOR A DOCUMENT THAT DOES NOT ANSWER ──────────────────────────────────────
 *
 * MEASURED on the desktop application (0.2.0-rc.2; "branch A" in the phase-3 notes): the remote settings
 * controller ACCEPTS a write and reports nothing, while the host half — reading through
 * `ctx.get('settings')` at emit time — never finds our section. A preference the user expressed in the
 * panel is therefore forgotten by the next start. The only trace of it was the in-memory record, which
 * is why the skin worked until the window closed; no error is raised on either side, `settings.yaml` is
 * never created by that write, and the browser's own storage is provably durable in that application
 * (twelve third-party keys live there, and the shell writes its own).
 *
 * So the DOCUMENT stays the first choice and the source of truth whenever it carries the record —
 * including when it carries `enabled: []`, which is a user who turned everything off. The COPY answers
 * only silence, and every write is mirrored into it, so the copy is never staler than the document.
 * Those rules live in `chooseRecord` / `mirrorToLocal` / `shouldOfferBack`, which are pure and tested on
 * their own; this function is only the wiring, and it is deliberately narrow:
 *
 *   · it wraps the REMOTE adapter alone — the settings-scope backend already keeps a copy of its own and
 *     reports `diverged` when the two disagree (`disagreesWithLocal`), and the local backend IS the copy;
 *   · a document write that throws still throws (the runtime's visible `persistError` banner depends on
 *     it) and is mirrored anyway, so a refused write costs durability, never the in-session state;
 *   · the one write-back the copy is allowed is offered ONCE, from `ready()`, and its failure is logged
 *     rather than raised: it is background repair, not part of any read.
 *
 * @param {PersistAdapter} adapter the document-backed adapter this wraps.
 * @param {{ key: string, storage?: Storage }} options `storage` is injectable for tests.
 * @returns {PersistAdapter}
 */
function withLocalCopy(adapter, { key, storage = localStore() }) {
  /** One offer per instance, and an instance lives for exactly one `apply` (`createPersist` is called once). */
  let alreadyOffered = false

  const readCopy = () => {
    if (storage === undefined) return undefined
    try {
      const raw = storage.getItem(key)
      return raw === null ? undefined : coerce(JSON.parse(raw))
    } catch (error) {
      console.error('[dsh-ui-projects] unreadable browser copy, ignoring it', error)
      return undefined
    }
  }

  return {
    kind: adapter.kind,
    /*
     * DIVERGENCE, now that there IS a second copy to diverge from. Conservative on purpose: a document
     * that is silent about us is not "disagreeing" — there is nothing to disagree WITH — so this can
     * only become true when the document carries a record and the copy says something else.
     */
    get diverged() {
      if (adapter.diverged === true) return true
      const documentRecord = adapter.read()
      return documentRecord === undefined ? false : disagreesWithLocal(documentRecord)
    },
    get readiness() {
      return adapter.readiness
    },
    ready: async () => {
      await adapter.ready?.()
      /*
       * THE ONE OFFER: a choice that only the copy holds is handed back to the document, once. Not
       * awaited by any caller in a way that matters, and never fatal — on the desktop the document
       * accepts it and keeps nothing, which is precisely the case this whole file is about.
       */
      const documentRecord = adapter.read()
      const localRecord = readCopy()
      if (!shouldOfferBack({ documentRecord, localRecord, alreadyOffered })) return
      alreadyOffered = true
      try {
        await adapter.write(localRecord)
      } catch (error) {
        console.error('[dsh-ui-projects] the browser copy could not be offered to the settings document', error)
      }
    },
    read: () => chooseRecord({ documentRecord: adapter.read(), localRecord: readCopy() }).record,
    subscribe: (listener) => (typeof adapter.subscribe === 'function' ? adapter.subscribe(listener) : () => {}),
    write: async (next) => {
      try {
        await adapter.write(next)
      } finally {
        mirrorToLocal({ storage, key, record: { ...next, initialized: true } })
      }
    },
    dispose: () => adapter.dispose?.(),
  }
}

/** The browser's storage, or `undefined` where the page does not offer one (the same guard `hasLocalStorage` uses). */
function localStore() {
  try {
    return typeof window !== 'undefined' && window.localStorage !== undefined && window.localStorage !== null
      ? window.localStorage
      : undefined
  } catch {
    return undefined
  }
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
    /**
     * Whoever asked to be told that the record may have moved.
     *
     * Held here rather than taken from `scope.subscribe`'s return value on purpose: this adapter
     * already subscribes to the scope for its own bookkeeping, and the disposer that matters is the
     * one `dispose()` below owns. One subscription to the scope, any number of listeners to them.
     * @type {Set<() => void>}
     */
    const listeners = new Set()

    /**
     * The record, or undefined while the read is still in flight.
     *
     * THE ONE MEANING THIS FILE MUST NOT BLUR: `cached === undefined` is "not told yet", and only
     * `coerce()` (a real snapshot, or a `write`) ever produces the empty record that means "the user
     * has never chosen anything". Returning `?? emptyRecord()` here is what made a two-second
     * transport delay indistinguishable from a deliberate choice — see `READY_TIMEOUT_MS`.
     */
    const current = () => {
      const snapshot = scope.getSnapshot()
      if (snapshot.status === 'ready') cached = coerce(snapshot.value)
      return cached
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
      for (const listener of listeners) listener()
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
      subscribe: (/** @type {() => void} */ listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
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
        // Listeners go with the adapter: a fiber that has been disposed must not be called back
        // through a closure it can no longer guard.
        listeners.clear()
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

/**
 * The `localStorage` fallback: synchronous, final, and never unknown.
 *
 * There is no "not told yet" here, and that is a property of the backend rather than a coincidence:
 * the record is in this browser, so reading it either finds one or finds none, and "none" genuinely
 * means "the user has never chosen anything". `read()` therefore always answers, which is why the
 * runtime's unknown-record path cannot be reached through this adapter — the whole reason it needs
 * one is a WIRE that has not come back yet.
 * @returns {PersistAdapter}
 */
export function createLocalPersist() {
  /** @type {UiProjectRecord | undefined} */
  let cached
  /** @type {Set<() => void>} */
  const listeners = new Set()
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
    subscribe: (/** @type {() => void} */ listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    write: async (next) => {
      cached = { ...next, initialized: true }
      if (available) {
        try {
          window.localStorage.setItem(LOCAL_KEY, JSON.stringify(cached))
        } catch (err) {
          console.error('[dsh-ui-projects] cannot persist UI project state', err)
        }
      }
      /*
       * Notified even when storage refused the write: the IN-MEMORY record moved, which is what a
       * listener re-reads, and a listener that only heard about durable writes would be told about
       * a state this session does not have.
       */
      for (const listener of listeners) listener()
    },
    dispose: () => {
      cached = undefined
      listeners.clear()
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
