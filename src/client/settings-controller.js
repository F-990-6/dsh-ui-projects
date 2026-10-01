/**
 * The settings adapter for the seam 0.2.0-rc.2 leaves behind.
 *
 * ## Why this file exists
 *
 * The web profile's dsh (0.1.5-rc.3) offers the client a `settingsScope` service, and `persist.js` binds it.
 * The desktop application's dsh (0.2.0-rc.2) does not: the service-name table has no `settingsScope`, and the
 * settings client surface there is `remote.settings` (`describe` to read, `update`/`mutate`/`replace` to write),
 * `settingsSchema` and `configForms`. Nothing was renamed — what disappeared is the WRAPPER, because the
 * 0.1.5 scope is itself built on the remote it wraps: `@deepseek-ai/dsh-client-ui-settings/lib/client.js:1333`
 * declares `const inject = ["remote", "remote.settings"]`, and `:1045` writes through
 * `this.ctx.remote.settings.mutate(...)`.
 *
 * That is what makes one adapter serve both versions: talking to `remote.settings` directly is supported by
 * the older dsh too, so this is not a compatibility shim bolted beside the old path — it is the same seam,
 * one layer lower, and the composition decides which one we get.
 *
 * ## The document, as the host describes it
 *
 * `describe` answers a LIST of descriptors, each projected as `{ ns, schema, value, applies, secrets,
 * revision }` by `@deepseek-ai/dsh-api-settings-controller/lib/index.js:275-287`, and the controller itself
 * looks one up by `candidate.ns` (`:544`). So finding our section is a `find`, and the `revision` that comes
 * with it is what `update` wants back:
 *
 *   `expectedRevision` — revision the caller read; `undefined` writes unconditionally.   (`:443`, `:454`, `:467`)
 *
 * ## What this adapter does NOT do
 *
 *  - **No polling, and no push.** `settings/updated` is a HOST-side service event (`@deepseek-ai/dsh-settings`),
 *    and it has no client-side counterpart in either version: in 0.2.0 the string does not appear in the
 *    application bundle at all. Listeners here are told about OUR writes, which is the only change this page
 *    can be certain of; a change made elsewhere is picked up by the next read, exactly like the scope path.
 *  - **No second record.** The section is the record; there is no mirror to reconcile.
 *  - **No writes from a non-loopback page.** The Host keeps preferences process-local there
 *    (`dsh-client-ui-settings/lib/client.js:1345`: `ctx.remote.$host.isLoopback ? "host" : "memory"`), which is
 *    why the factory declines in that case and `persist.js` falls through to localStorage.
 */

/**
 * Build the adapter, or answer `undefined` when this composition cannot host one.
 *
 * Returning `undefined` rather than a degraded adapter is the whole point: `persist.js` chooses ONCE, and an
 * adapter that silently did nothing would look like a working settings document while the page wrote nowhere.
 *
 * @param {{ remote?: any, get?: (name: string) => any }} ctx
 * @param {{ coerce?: (section: any) => any, namespace?: string, describeTimeoutMs?: number }} [deps] `coerce`
 *   is injected by `persist.js` (the module that owns the record shape) so this file never imports it back
 *   and no cycle exists between the two; `namespace` is for a test that wants to own its keys; and
 *   `describeTimeoutMs` is the bounded wait below, injectable so a test does not wait it out.
 * @returns {import('./persist.js').PersistAdapter | undefined}
 */
export const DESCRIBE_TIMEOUT_MS = 3000

export function createRemoteSettingsPersist(ctx, deps = {}) {
  const remote = ctx?.remote ?? ctx?.get?.('remote')
  const settings = remote?.settings
  if (settings === undefined || settings === null) return undefined
  if (typeof settings.describe !== 'function' || typeof settings.update !== 'function') return undefined
  /*
   * A page that is not on the loopback keeps its preferences process-local on the Host, so a write here
   * would either be refused or land somewhere this session does not read. Decline, and let the caller use
   * the browser's own storage.
   */
  if (remote?.$host?.isLoopback === false) return undefined

  const namespace = deps.namespace ?? 'ui-projects'
  const coerce = deps.coerce ?? ((section) => section)
  const timeoutMs = deps.describeTimeoutMs ?? DESCRIBE_TIMEOUT_MS

  /** @type {any} */
  let cached
  /** The revision the document was read at, for the next write's conflict check. */
  let revision
  /** @type {'idle'|'ready'|'error'} */
  let readiness = 'idle'
  /** @type {Promise<void> | undefined} */
  let inFlight
  /** @type {Set<() => void>} */
  const listeners = new Set()

  const notify = () => {
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-ui-projects] settings listener failed', error)
      }
    }
  }

  /**
   * Read the document once and keep what belongs to us.
   *
   * `read()` itself stays SYNCHRONOUS, because that is the interface `persist.js` and the runtime are written
   * against: `undefined` means "not told yet" and `ready()` is how a caller waits. A rejected read is a state
   * rather than a throw, so a host that cannot answer leaves the page on its defaults instead of taking the
   * column down with it.
   * @returns {Promise<void>}
   */
  const pull = () => {
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let deadline
      try {
        /*
         * A BOUNDED READ, because the runtime AWAITS this through `persist.ready()` before it applies
         * anything: a `describe` that never settles would leave the page permanently un-applied rather
         * than merely unread. The desktop application is where this was measured — the same
         * custom-protocol transport that left a plain `fetch` pending. There is no abort handle on a
         * remote call, so the only honest instrument is a race; the timer is cleared either way.
         */
        const descriptors = await Promise.race([
          settings.describe(),
          new Promise((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error(`the settings document did not answer within ${timeoutMs} ms`)),
              timeoutMs,
            )
          }),
        ])
        const mine = Array.isArray(descriptors)
          ? descriptors.find((descriptor) => descriptor?.ns === namespace)
          : undefined
        /*
         * ABSENCE IS REPORTED AS ABSENCE.
         *
         * `coerce(undefined)` returns the EMPTY RECORD — "the user has never chosen anything" — so this
         * one line made a document that does not mention our namespace at all indistinguishable from a
         * document that says the user chose nothing. Measured on the desktop application (branch A): the
         * document is silent, while the browser's own copy holds the choice the user made in the panel.
         * With the two collapsed, no policy can tell "ask the copy" from "the user turned it off".
         *
         * `cached` stays `undefined`, the same value a failed read leaves: UNKNOWN, for the caller to
         * resolve (`chooseRecord` in `persist.js`, and `runtime.js`'s first-frame adoption for the boot
         * case). `readiness` is unaffected: this read ANSWERED, so it is `ready` — only a transport that
         * never answers is an `error`.
         */
        cached = mine === undefined ? undefined : coerce(mine?.value)
        revision = mine?.revision
        readiness = 'ready'
      } catch (error) {
        readiness = 'error'
        console.error('[dsh-ui-projects] cannot read the settings document', error)
      } finally {
        if (deadline !== undefined) clearTimeout(deadline)
        inFlight = undefined
      }
    })()
    return inFlight
  }

  return {
    kind: 'settings',
    /*
     * No mirror means nothing to diverge FROM: the record IS the section, so there is no second copy that
     * could disagree with it.
     */
    diverged: false,
    get readiness() {
      return readiness
    },
    ready: () => (readiness === 'idle' ? pull() : Promise.resolve()),
    read: () => cached,
    subscribe: (/** @type {() => void} */ listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /**
     * ONE remote call per write, the whole record as the patch.
     *
     * Five field-at-a-time writes would be five chances to land half a record, and the contract does not need
     * them: `update` takes a patch for one namespace. The revision goes back only when we have read one — with
     * `undefined` the host writes unconditionally, which is the right behaviour for a page that has never
     * read the document, and a `settings/conflict` is the host's way of saying the document moved under us.
     */
    write: async (next) => {
      cached = { ...next, initialized: true }
      try {
        const answer = await settings.update(namespace, cached, revision)
        if (typeof answer?.revision === 'string') revision = answer.revision
      } catch (error) {
        /*
         * Logged and swallowed, the same trade the localStorage adapter makes: the IN-MEMORY record moved,
         * and a caller that only heard about durable writes would be told about a state this session does
         * not have. What is NOT swallowed is the log line — a refused write must be findable afterwards.
         */
        console.error('[dsh-ui-projects] cannot write the settings document', error)
      }
      notify()
    },
    dispose: () => {
      cached = undefined
      listeners.clear()
    },
  }
}
