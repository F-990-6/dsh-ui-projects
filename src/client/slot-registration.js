/**
 * Contribute something to a slot the SHELL declares, without depending on load order.
 *
 * ## Why this file exists
 *
 * The settings shell declares `settings.section` and our packages register into it. The documented way
 * to do that — and what dsh's own packages do — is to subscribe first:
 *
 *     ctx.slots.inject("settings.section", () => ctx.slots.register({ name, id, order, label }, C))
 *
 * That is correct while the declaration and the subscription happen in the same application batch, and
 * it is what 0.1.5 does for everyone. In the desktop application (0.2.0-rc.2) it is not enough: the
 * shell's own sections ride the FIRST application batch (57 entries, `ui-settings-general` among them,
 * which is what declares the slot), while third-party client packages ride a LATER one (11 entries,
 * ours included). An inject subscription that does not replay a declaration which has already happened
 * therefore never fires — silently. Measured on the desktop: the section never appeared, our inject
 * callback never ran, and nothing was logged, because the only error this code prints is for a MISSING
 * `slots` service.
 *
 * ## What this does instead
 *
 * Subscribe — and arm a bounded deadline. If the subscription answers first, that is the contribution,
 * exactly as before. If the deadline arrives first, register DIRECTLY, once: by then the slot is
 * declared (that is the case this path exists for), so a plain registration is accepted. A refusal is
 * recorded and logged rather than thrown: the caller is a Cordis effect, and a contribution that cannot
 * be made must not take the plugin down with it.
 *
 * `settle` makes the two paths mutually exclusive, so a late declaration after the deadline — or a
 * deadline after the declaration — still contributes exactly one section.
 *
 * ## Why the scheduler is injectable
 *
 * Tests cannot wait out a real deadline, and this repository's convention is to inject time rather than
 * to sleep (`createUpdateChecker({ now })`, the update check's `timeoutMs`). `schedule` and `cancel`
 * are the whole of the timing surface; production passes nothing and gets `setTimeout`.
 */

/** How long the subscription is given before the direct registration takes over. */
export const SECTION_FALLBACK_MS = 250

/*
 * THE TIMERS ARE LOOKED UP, NEVER ASSUMED.
 *
 * These defaults used to read `setTimeout` / `clearTimeout` directly, and a harness that evaluates this
 * bundle in a minimal sandbox — no timers by design, which is how a test forces the scheduler to be
 * injected — threw `ReferenceError: setTimeout is not defined` before anything could register. A client
 * module may reach the ambient timers; it may not REQUIRE them. With none available the deadline is
 * simply not armed and the subscription is the only path: a lossless degradation, because no timer
 * means nothing to bound.
 *
 * `globalThis` rather than `window`: in the page they are the same object, and in a sandbox that
 * exposes neither, this is `undefined` instead of a thrown ReferenceError.
 */
const ambientSetTimeout = typeof globalThis.setTimeout === 'function' ? globalThis.setTimeout : undefined
const ambientClearTimeout = typeof globalThis.clearTimeout === 'function' ? globalThis.clearTimeout : undefined

/** @param {() => void} fn @param {number} ms @returns {any} the handle, or `undefined` when nothing can arm it */
const defaultSchedule = (fn, ms) => (ambientSetTimeout === undefined ? undefined : ambientSetTimeout(fn, ms))

/** Cancelling is idempotent: an unarmed deadline has no handle, and looking one up must never throw. */
const defaultCancel = (handle) => {
  if (handle === undefined || ambientClearTimeout === undefined) return
  ambientClearTimeout(handle)
}

/**
 * @param {object} deps
 * @param {{ inject?: (name: string, callback: () => void) => any, register: (options: any, render: any) => any }} deps.slots
 * @param {string} deps.name The slot to contribute to.
 * @param {Record<string, unknown>} [deps.options] The registration options, minus `name`.
 * @param {unknown} deps.render What the slot renders.
 * @param {(entry: { source: 'inject'|'fallback', ok: boolean, message?: string }) => void} [deps.record]
 *   Called exactly once, with which path won and whether the shell accepted it.
 * @param {(fn: () => void, ms: number) => any} [deps.schedule]
 * @param {(handle: any) => void} [deps.cancel]
 * @param {number} [deps.fallbackMs]
 * @returns {() => void} disposer: cancels the deadline, withdraws the registration, then unsubscribes.
 */
export function registerIntoSlot({
  slots,
  name,
  options = {},
  render,
  record = () => {},
  schedule = defaultSchedule,
  cancel = defaultCancel,
  fallbackMs = SECTION_FALLBACK_MS,
}) {
  /** @type {(() => void) | undefined} */
  let registered
  let settled = false

  /** @param {'inject'|'fallback'} source */
  const contribute = (source) => {
    if (settled) return
    settled = true
    try {
      const handle = slots.register({ name, ...options }, render)
      registered = typeof handle === 'function' ? handle : () => {}
      record({ source, ok: true })
    } catch (error) {
      record({ source, ok: false, message: String(error?.message ?? error) })
      console.error(`[dsh-ui-projects] the ${name} contribution could not register`, error)
    }
  }

  /*
   * THE DEADLINE IS ARMED ONLY IF THE SUBSCRIPTION HAS NOT ALREADY ANSWERED.
   *
   * Arming it unconditionally left one pending timer behind for every contribution whose declaration
   * arrived first — a no-op when it fired, but a live task all the same, and the suite's fake clock
   * counted it (`pendingTimeouts` expected 1, got 3, with two contribution sites). The disposer still
   * cancels unconditionally: the handle may be `undefined`, and cancelling must be idempotent.
   */
  const injection = typeof slots?.inject === 'function' ? slots.inject(name, () => contribute('inject')) : undefined
  /** @type {any} */
  let timer
  if (!settled) timer = schedule(() => contribute('fallback'), fallbackMs)

  return () => {
    cancel(timer)
    if (registered !== undefined) registered()
    if (typeof injection === 'function') injection()
  }
}
