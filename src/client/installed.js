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
export function createInstalledStore({ request }) {
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

  return {
    refresh,
    /** @returns {typeof state} a snapshot; the panel reads this during render */
    state: () => state,
    loadChangelog,
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
 * The second route: one package's changelog, asked for when a reader opens its row (step 56b).
 *
 * Same fence, same duplication: the host half holds the other copy, and the two are separate bundles
 * that cannot import from one another.
 */
export const CHANGELOG_PATH = '/api/ui-projects/changelog.json'
