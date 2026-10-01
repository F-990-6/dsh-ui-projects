/**
 * What the host says is installed, as the page sees it.
 *
 * THREE STATES, and the reason each exists rather than a spinner and a list:
 *
 *   `loading`  the request is in flight
 *   `ready`    a scan arrived; `scan.problems` may still be non-empty, and every problem is rendered
 *              against the package it belongs to
 *   `failed`   the request did not produce a scan. The column says so WITH THE REASON, because
 *              "cannot read the listing" and "there is nothing installed" look identical otherwise,
 *              and only one of them is the user's problem
 *
 * NOTHING IS PERSISTED, deliberately. A stored listing is a claim about a profile at a moment that
 * has passed: install something and the stored copy is a lie with no invalidation point. The scan
 * lives in memory for the session and is re-read whenever the column opens, after an action, or on
 * the refresh control — all of which are cheap, because the host side is one directory read.
 */

/** @param {{ request: (path: string) => Promise<any> }} deps */
export function createInstalledStore({ request, channelMap = () => ({}) }) {
  /** @type {Set<() => void>} */
  const listeners = new Set()
  /** @type {{ status: 'idle'|'loading'|'ready'|'failed', scan?: any, error?: string, fetchedAt?: string }} */
  let state = { status: 'idle' }
  /** The in-flight request, so two refreshes cannot race each other into an older answer. */
  let inFlight
  let generation = 0
  /**
   * One package's changelog, per package, keyed by name.
   *
   * A CACHE, unlike the listing, and the difference is what each one claims: a stored LISTING would be
   * a statement about a profile at a moment that has passed, while a changelog belongs to the version
   * that is installed and does not move unless the package does. It is still not kept forever — see
   * `refresh()`, its one invalidation point.
   * @type {Map<string, { status: 'loading'|'ready'|'failed', payload?: any, error?: string }>}
   */
  const changelogs = new Map()
  /** @type {Map<string, Promise<void>>} one request per package, shared by concurrent asks */
  const changelogInFlight = new Map()
  /**
   * What the registry said, and whether it has been asked yet.
   *
   * NOT CACHED ACROSS A REFRESH, unlike a changelog: a changelog belongs to the installed version, while
   * "there is a newer one" is a claim about the registry at a moment — and the refresh control exists
   * because the profile may have moved under this page.
   * @type {{ status: 'idle'|'loading'|'ready'|'failed', payload?: any, error?: string }}
   */
  let updatesState = { status: 'idle' }
  /** @type {Promise<void> | undefined} */
  let updatesInFlight

  /** Tell every listener that something they read may have changed. */
  const notify = () => {
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-ui-projects] installed-store listener failed', error)
      }
    }
  }

  /** @type {{ dispose: () => void } | undefined} Armed by `deferUpdateCheck`; the idempotence keys on it. */
  let deferral

  /** What the deferred trigger saw and did — read-only diagnostics (C). Nothing reads this to decide anything. */
  const deferralState = { schedule: 'unset', whenIdle: 'unset', hasGlobalThisSetTimeout: 'unset', fired: false }

  const publish = (next) => {
    state = next
    notify()
  }

  /**
   * Ask the host again.
   *
   * Concurrent calls share one request, and a result that arrives after a newer one has started is
   * DROPPED rather than applied: the column shows what was true at the last refresh, not whichever
   * response happened to land last.
   * @returns {Promise<void>}
   */
  async function refresh() {
    if (inFlight !== undefined) return inFlight
    const mine = generation + 1
    generation = mine
    /*
     * The ONE invalidation point for the changelog cache. A changelog belongs to the version that is
     * installed, so it does not go stale on its own — but a refresh exists precisely because the
     * PROFILE may have moved under this page, and a package that was updated or removed carries a
     * different changelog. One place, because a second one would be a second truth.
     */
    changelogs.clear()
    updatesState = { status: 'idle' }
    publish({ status: 'loading', scan: state.scan })
    inFlight = (async () => {
      try {
        const payload = await request(INSTALLED_PATH)
        if (payload?.error !== undefined) throw new Error(payload.error.message ?? 'the host reported an unspecified failure')
        if (payload?.scan === undefined) throw new Error('the host returned no scan')
        if (generation === mine) publish({ status: 'ready', scan: payload.scan, fetchedAt: new Date().toISOString() })
      } catch (error) {
        if (generation === mine) {
          publish({
            status: 'failed',
            error: typeof error?.message === 'string' ? error.message : String(error),
          })
        }
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }

  /**
   * Ask for ONE package's changelog, once.
   *
   * ON DEMAND, because this is the one field with real content behind it — the framework's own file is
   * 284 KB — and rows ask when a reader opens one rather than when the column opens.
   *
   * Three rules the suite pins:
   *
   *   a READY answer is terminal   `no-file` included: the host answered, and asking again would get
   *                                the same sentence
   *   a FAILED one is not          a transport that was down may be up now, so the next open retries
   *   concurrent asks share        one request per package, exactly as `refresh()` does for the listing
   *
   * A result that arrives after a `refresh()` is DROPPED and forgotten, the same rule the listing
   * follows and for the same reason.
   * @param {string} name
   * @returns {Promise<void>}
   */
  async function loadChangelog(name) {
    const cached = changelogs.get(name)
    if (cached?.status === 'ready' || cached?.status === 'loading') return
    const flying = changelogInFlight.get(name)
    if (flying !== undefined) return flying
    const mine = generation
    const promise = (async () => {
      changelogs.set(name, { status: 'loading' })
      notify()
      try {
        const payload = await request(CHANGELOG_PATH + '?name=' + encodeURIComponent(name))
        if (generation !== mine) {
          changelogs.delete(name)
          return
        }
        if (payload?.error !== undefined) throw new Error(payload.error.message ?? 'the host reported an unspecified failure')
        changelogs.set(name, { status: 'ready', payload })
      } catch (error) {
        if (generation !== mine) {
          changelogs.delete(name)
          return
        }
        changelogs.set(name, {
          status: 'failed',
          error: typeof error?.message === 'string' ? error.message : String(error),
        })
      } finally {
        changelogInFlight.delete(name)
        notify()
      }
    })()
    changelogInFlight.set(name, promise)
    return promise
  }

  /**
   * ASK THE HOST FOR A CHANGELOG DRAFT (`UI第三阶段.txt:59-69`).
   *
   * THE STORE ONLY TALKS TO THE NETWORK. It does not write the record and does not `notify()`: the draft
   * lives in the user's settings record, whose ONE writer is the `channels` adapter the panel already
   * holds (`props.channels.writeDraft`). Returning the payload and letting the panel store it keeps a
   * single write path — the reason this method takes no `channels` dependency at all (measured
   * 2026-09-30: `createInstalledStore` receives only `request` and `channelMap`).
   *
   * FAILURES COME BACK AS PAYLOADS, never as throws: the panel renders what happened, and an unhandled
   * rejection inside a click handler is a console error nobody reads.
   * @param {string} name @param {string | null} version
   * @returns {Promise<any>}
   */
  async function generateDraft(name, version) {
    try {
      return (
        (await request('/api/ui-projects/changelog-draft', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ packageName: name, currentVersion: version ?? null, previousVersion: null, gitLog: null }),
        })) ?? { status: 'insufficient', entries: [], suggestedBump: null, reason: 'the host answered nothing' }
      )
    } catch (error) {
      return {
        status: 'insufficient',
        entries: [],
        suggestedBump: null,
        reason: typeof error?.message === 'string' ? error.message : String(error),
      }
    }
  }

  /**
   * HAND THE CONFIRMED DRAFT TO THE ONE MODULE THAT MAY WRITE IT.
   *
   * `checklistRecord` is passed IN, by the panel, from the same `channels` adapter everything else uses —
   * the host refuses an incomplete checklist regardless (`writeChangelog` owns that gate), so this
   * parameter is what makes the refusal a second opinion rather than the only one.
   * @param {string} name @param {Array<{ category: string, text: string }>} entries
   * @param {string} version @param {Record<string, unknown> | null} checklistRecord
   * @returns {Promise<any>}
   */
  async function commitChangelog(name, entries, version, checklistRecord) {
    try {
      return (
        (await request('/api/ui-projects/changelog-write', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            packageName: name,
            version,
            date: new Date().toISOString(),
            entries,
            checklistRecord: checklistRecord ?? null,
          }),
        })) ?? { written: false, error: { message: 'the host answered nothing' } }
      )
    } catch (error) {
      return { written: false, error: { message: typeof error?.message === 'string' ? error.message : String(error) } }
    }
  }

  /**
   * Arm ONE deferred update check, after the first frame (D2).
   *
   * The spec asks for a check "after dsh starts" and forbids blocking the first screen
   * (`UI第三阶段.txt:23-24`). A deadline-bearing idle callback is the reconciliation: it runs when the
   * page is quiet, and the deadline means a busy page still gets checked. THE TIMER IS THE GUARANTEE, and
   * the idle callback only the OPPORTUNITY: measured on the desktop (2026-09-30), `requestIdleCallback`
   * EXISTS in the renderer — `typeof requestIdleCallback` answered `"function"` — but a window that is not
   * in the foreground starves its idle callbacks, deadline and all, so the check never ran and the user's
   * first sight of the request was the column's own ask. A `setTimeout(fn, 0)` cannot be starved, and what
   * it runs is a request, so no frame is blocked either. Where NEITHER scheduler exists, nothing is armed
   * and nothing is thrown — the column's own on-demand path still works, which is what the composition had
   * before this existed.
   *
   * IDEMPOTENT: the second call returns the same disposer and arms nothing. A `ctx.effect` that re-runs
   * must not be able to stack deadlines, and a reviewer asking "what if it is called twice" deserves a
   * property rather than a promise. (The suite pins the once-only behaviour of the CHECK itself in the
   * test that flushes this deadline twice; this idempotence is stated here and covered by that same
   * flush, since a second arming would be a second request.)
   *
   * A FIRED REQUEST IS NOT CANCELLED by the disposer: once `loadUpdates` has been called, the answer is
   * state the column renders, and a disposal that dropped it would leave a row saying nothing.
   * @param {{ whenIdle?: ((fn: () => void, options: { timeout: number }) => any) | null, cancelIdle?: ((handle: any) => void) | null, schedule?: ((fn: () => void, ms: number) => any) | null, cancelSchedule?: ((handle: any) => void) | null, idleTimeoutMs?: number }} [options]
   * @returns {() => void} disposer: cancels an armed deadline, and does nothing to a fired one.
   */
  function deferUpdateCheck({
    whenIdle = ambientIdle(),
    cancelIdle = ambientCancelIdle(),
    schedule = ambientSchedule(),
    cancelSchedule = ambientCancelSchedule(),
    idleTimeoutMs = IDLE_TIMEOUT_MS,
  } = {}) {
    if (deferral !== undefined) return deferral.dispose
    const fire = () => {
      deferralState.fired = true
      console.info('[dsh-ui-projects] deferred check firing')
      void loadUpdates()
    }
    /*
     * BOTH ARE ARMED, AND THEY ARE NOT EQUALS.
     *
     * The timer comes first and unconditionally: it is the one that cannot be starved, so it is what makes
     * "the check runs after startup" TRUE rather than likely. The idle callback is armed as well, purely as
     * an EARLIER opportunity on a quiet page — never as the thing the deadline depends on, which is exactly
     * the mistake this replaced. `fire` needs no flag of its own: `loadUpdates()` refuses once an answer has
     * arrived, so whichever scheduler wins, the host is asked once.
     */
    /** @type {Array<() => void>} */
    const cancels = []
    /*
     * DIAGNOSTICS (C), for the desktop application where the check never ran.
     *
     * The question a closed Console could not answer — "was a TIMER available to arm at all?" — is
     * RECORDED here as well as logged, so the suite can hold it and so a later round can carry it out
     * through a channel that is always visible (the column's own request). Recording changes no behaviour:
     * nothing reads these fields to decide anything.
     */
    deferralState.schedule = typeof schedule
    deferralState.whenIdle = typeof whenIdle
    deferralState.hasGlobalThisSetTimeout = typeof globalThis?.setTimeout
    console.info('[dsh-ui-projects] deferred check armed', {
      schedule: typeof schedule,
      whenIdle: typeof whenIdle,
      hasGlobalThisSetTimeout: typeof globalThis?.setTimeout,
    })
    if (typeof schedule === 'function') {
      const handle = schedule(fire, 0)
      cancels.push(() => {
        if (typeof cancelSchedule === 'function' && handle !== undefined) cancelSchedule(handle)
      })
    }
    if (typeof whenIdle === 'function') {
      const handle = whenIdle(fire, { timeout: idleTimeoutMs })
      cancels.push(() => {
        if (typeof cancelIdle === 'function' && handle !== undefined) cancelIdle(handle)
      })
    }
    const dispose = () => {
      for (const cancel of cancels) cancel()
    }
    deferral = { dispose }
    return dispose
  }

  /**
   * Ask the host to check the registry, once.
   *
   * Guarded the way `refresh()` is: concurrent calls share one request, and an answer that arrives after
   * a newer `refresh()` is DROPPED rather than applied. A failure is a STATE with its reason, never a
   * throw — a registry this machine cannot reach must not take the column down with it.
   *
   * A CLOSURE DECLARATION rather than a method on the returned object, which is what `deferUpdateCheck`
   * needs: `fire` runs from a timer, and a method shorthand lives in the object literal, not in this
   * scope — measured, the timer threw `ReferenceError: loadUpdates is not defined` and killed the process
   * the suite was running in. `refresh` and `loadChangelog` are declared the same way, so this is also
   * the file's own shape rather than a new one.
   * @returns {Promise<void>}
   */
  async function loadUpdates() {
    /*
     * AN ANSWER ALREADY ARRIVED, SO THERE IS NOTHING TO ASK.
     *
     * This guard used to live in the COLUMN's caller (`src/client/panel-plugins.js:120`), which made
     * "the check runs once" a property of that caller rather than of the check — and there are two
     * callers now: the column, and the deferred trigger D2 adds (`deferUpdateCheck`). The policy
     * belongs where both of them share it.
     *
     * `refresh()` resets the state to `idle` as a WHOLE OBJECT (the `updatesState = { status: 'idle' }`
     * line above), so a refreshed listing can still be checked again — the guard keys on the current
     * status, not on a flag that would outlive it.
     */
    if (updatesState.status !== 'idle') return updatesInFlight
    if (updatesInFlight !== undefined) return updatesInFlight
    const mine = generation
    updatesState = { status: 'loading' }
    notify()
    updatesInFlight = (async () => {
      try {
        /*
         * THE CHANNELS TRAVEL WITH THE REQUEST (B1).
         *
         * The host decides which npm dist-tag each package is compared against, and it reads that from
         * the settings document — which, in the desktop application, never receives our write at all
         * (branch A). Without this parameter the user's choice is invisible to the check and every
         * package is compared against `stable`: measured, a dot on a package that had a newer `latest`
         * and nothing for a package the user had switched to `beta`.
         *
         * Same source as the selector (`channelMap` is fed from the same record read), same route, and
         * nothing is added when there is nothing to say — an absent parameter is today's behaviour.
         */
        const payload = await request(UPDATES_PATH + channelsQuery(channelMap()))
        if (generation !== mine) return
        if (payload?.error !== undefined) throw new Error(payload.error.message ?? 'the host reported an unspecified failure')
        updatesState = { status: 'ready', payload }
      } catch (error) {
        if (generation !== mine) return
        updatesState = {
          status: 'failed',
          error: typeof error?.message === 'string' ? error.message : String(error),
        }
      } finally {
        updatesInFlight = undefined
        notify()
      }
    })()
    return updatesInFlight
  }

  return {
    refresh,
    deferUpdateCheck,
    loadUpdates,
    /** @returns {typeof deferralState} what the deferred trigger saw — diagnostics (C), read-only. */
    deferralState: () => deferralState,
    /** @returns {typeof updatesState} a snapshot, for a render */
    updates: () => updatesState,
    /** @returns {typeof state} a snapshot; the panel reads this during render */
    state: () => state,
    loadChangelog,
    generateDraft,
    commitChangelog,
    /**
     * What is known about one package's changelog right now, for a render.
     * @param {string} name
     * @returns {{ status: 'idle'|'loading'|'ready'|'failed', payload?: any, error?: string }}
     */
    changelog: (name) => changelogs.get(name) ?? { status: 'idle' },
    /** @param {() => void} listener @returns {() => void} */
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** The path the host mounts, duplicated here because the two halves are separate bundles. */
/*
 * UNDER `/api`, which is not cosmetic: that prefix is where the Host/Origin fence and the browser
 * session live (`API_PATH = "/api"`, "the /api URL prefix — single source for both halves of the web
 * transport"), and every shipped fetch route is registered there — `/api/file`,
 * `/api/session.uploadFileBinary`, `/api/present.open`, `/api/session.export`. A route registered
 * outside it is served with no authentication at all.
 */
export const INSTALLED_PATH = '/api/ui-projects/installed.json'

/**
 * How long the deferred update check waits before it is run anyway (D2).
 *
 * `requestIdleCallback` WITHOUT a deadline can be starved by a busy page — which is exactly the moment a
 * user is waiting for the column — so the trigger always passes one, and this is the value. Named, so
 * the suite can hold it: measured on 2026-09-30, a bare `{ timeout }` in a design note is one edit away
 * from being `undefined` in the code.
 */
export const IDLE_TIMEOUT_MS = 2000

/** `requestIdleCallback`, or `null` where the composition has none. Never a bare global read. */
function ambientIdle() {
  try {
    return typeof requestIdleCallback === 'function' ? requestIdleCallback : null
  } catch {
    return null
  }
}

/** @returns {typeof cancelIdleCallback | null} */
function ambientCancelIdle() {
  try {
    return typeof cancelIdleCallback === 'function' ? cancelIdleCallback : null
  } catch {
    return null
  }
}

/** The fallback deadline, for a composition with no idle callback at all. */
function ambientSchedule() {
  try {
    return typeof setTimeout === 'function' ? setTimeout : null
  } catch {
    return null
  }
}

/** @returns {typeof clearTimeout | null} */
function ambientCancelSchedule() {
  try {
    return typeof clearTimeout === 'function' ? clearTimeout : null
  } catch {
    return null
  }
}

/**
 * The second route: one package's changelog, asked for when a reader opens its row (step 56b).
 *
 * Same fence, same duplication: the host half holds the other copy, and the two are separate bundles
 * that cannot import from one another.
 */
export const CHANGELOG_PATH = '/api/ui-projects/changelog.json'

/**
 * The third route: the on-demand update check (phase 3, step 1).
 *
 * Same fence, same duplication, and the same rule as the listing: NOTHING IS PERSISTED and it is asked
 * for when the column is open — never from the first frame. What it costs is one registry query per open,
 * which is why the page asks only after the listing has arrived.
 */
export const UPDATES_PATH = '/api/ui-projects/updates.json'

/**
 * The channel map as ONE query parameter, or `''` when there is nothing to carry.
 *
 * `?channels=<pkg>:<ch>,<pkg>:<ch>` — the same shape this file already uses for `?name=`
 * (`CHANGELOG_PATH + '?name=' + encodeURIComponent(name)`), one parameter rather than one per package,
 * the whole value URI-encoded because package names carry `@` and `/`. The host parses it in
 * `src/host/installed-endpoint.js` with `URLSearchParams`, the same way it parses `?name=`; the two
 * ends are pinned together by the suite, which asserts the exact string one side writes and the other
 * side reads.
 *
 * Entries that are not a non-empty string pair are DROPPED here and validated again on the host: a
 * malformed record must not be able to make the wire format ambiguous.
 * @param {unknown} map
 * @returns {string}
 */
export function channelsQuery(map) {
  const pairs = []
  if (map !== null && typeof map === 'object') {
    for (const [name, channel] of Object.entries(map)) {
      if (typeof name === 'string' && name !== '' && typeof channel === 'string' && channel !== '') {
        pairs.push(`${name}:${channel}`)
      }
    }
  }
  return pairs.length === 0 ? '' : '?channels=' + encodeURIComponent(pairs.join(','))
}
