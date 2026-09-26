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

  const publish = (next) => {
    state = next
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-ui-projects] installed-store listener failed', error)
      }
    }
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

  return {
    refresh,
    /** @returns {typeof state} a snapshot; the panel reads this during render */
    state: () => state,
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
