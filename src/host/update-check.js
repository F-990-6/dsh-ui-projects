/**
 * The update check: which dist-tag a package's channel means, and what the registry answers for it.
 *
 * WHY THIS IS A MODULE OF ITS OWN, AND WHY THE CLOCK IS INJECTED. Three things can happen to a registry
 * query — it answers, it refuses, it never answers at all — and the third is the one a naive
 * `await fetch(...)` turns into a page that waits forever. All three are branches here, so all three are
 * testable offline: the fetch and the timeout are parameters, and `scripts/verify.mjs` drives them with a
 * resolver, a rejection and a promise that never settles.
 *
 * WHAT IT NEVER DOES. It does not write, does not install, does not retry, and does not throw at its
 * caller: a registry this machine cannot reach is a fact about the network, not a failure of the page, so
 * it is reported as `available: false` with the reason attached and ONE line in the log. Silent would be
 * wrong (a user who never hears about a broken check believes they are up to date) and loud would be
 * worse (an offline laptop would fill the console on every boot).
 *
 * `dshVersionHint` plays no part in any of this. Compatibility is decided by `pluginApiVersion` alone;
 * the check here answers a different question — "is there a newer version of this package?" — and the
 * two must not be mixed up in one sentence.
 */

/** The three channels, in the order the UI offers them. */
export const CHANNELS = ['stable', 'beta', 'canary']

/** What a package is on until its user says otherwise. */
export const DEFAULT_CHANNEL = 'stable'

/** Each channel is an npm dist-tag: choosing a channel chooses which tag is compared against. */
export const DIST_TAG_OF = { stable: 'latest', beta: 'beta', canary: 'canary' }

/**
 * How long a registry query may take.
 *
 * Between the 3 and 5 seconds the phase-3 spec asks for, and it is a CEILING rather than a budget: the
 * query runs after the page is up, so the cost of waiting is a dot that appears late, never a first
 * frame that waits.
 */
export const UPDATE_TIMEOUT_MS = 4000

/** The registry the query goes to. A constant so a test (and a reader) can see where the bytes go. */
export const UPDATE_REGISTRY = 'https://registry.npmjs.org'

/** Whether a string is a channel this build knows. */
export function isChannel(value) {
  return CHANNELS.includes(value)
}

/** The dist-tag a channel means, with anything unknown reading as the default channel. */
export function distTagOf(channel) {
  return DIST_TAG_OF[isChannel(channel) ? channel : DEFAULT_CHANNEL]
}

/**
 * Is `candidate` a newer version than `installed`?
 *
 * DELIBERATELY SHALLOW: a numeric comparison of dot-separated parts, with a prerelease (`-beta.1`)
 * counting as OLDER than the same release without one — which is the rule that keeps `2.0.0-beta.1`
 * from being offered to someone already on `2.0.0`. It understands no ranges, no build metadata and no
 * calendar versions, and where it does not understand something it answers `false`: "I cannot tell" must
 * never turn into "there is an update".
 * @param {unknown} candidate
 * @param {unknown} installed
 */
export function isNewer(candidate, installed) {
  const parse = (value) => {
    if (typeof value !== 'string') return null
    const [core, prerelease = ''] = value.trim().split('-', 2)
    const parts = core.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : NaN))
    if (parts.length === 0 || parts.some((part) => Number.isNaN(part))) return null
    return { parts, prerelease }
  }
  const next = parse(candidate)
  const current = parse(installed)
  if (next === null || current === null) return false
  for (let index = 0; index < Math.max(next.parts.length, current.parts.length); index += 1) {
    const left = next.parts[index] ?? 0
    const right = current.parts[index] ?? 0
    if (left !== right) return left > right
  }
  // Same release: a version WITH a prerelease is older than one without, and two prereleases are not
  // ordered here — "cannot tell" is `false`.
  if (next.prerelease !== '' && current.prerelease === '') return false
  if (next.prerelease === '' && current.prerelease !== '') return true
  return false
}

/** Reject with `timeout` once `timeoutMs` has passed, whatever the promise does. */
function withTimeout(promise, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('timeout')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      },
    )
  })
}

/**
 * The default registry reader: `https://registry.npmjs.org/<name>` → its `dist-tags`.
 *
 * `node:https` rather than a global `fetch`, and the reason is the timeout: this call has to be
 * abortable at 4 seconds, and a request whose socket is left open is a request that keeps the process
 * busy after the answer stopped mattering.
 * @param {string} name
 * @returns {Promise<Record<string, string>>}
 */
export function fetchDistTagsFromRegistry(name) {
  return import('node:https').then(
    ({ default: https }) =>
      new Promise((resolvePromise, rejectPromise) => {
        const request = https.get(
          `${UPDATE_REGISTRY}/${String(name).replace('/', '%2f')}`,
          { headers: { accept: 'application/vnd.npm.install-v1+json, application/json' } },
          (response) => {
            if (response.statusCode !== 200) {
              response.resume()
              rejectPromise(new Error(`registry answered ${response.statusCode}`))
              return
            }
            let body = ''
            response.setEncoding('utf8')
            response.on('data', (chunk) => {
              body += chunk
            })
            response.on('end', () => {
              try {
                const parsed = JSON.parse(body)
                resolvePromise(parsed?.['dist-tags'] ?? {})
              } catch (error) {
                rejectPromise(new Error(`registry answered something that is not JSON (${String(error)})`))
              }
            })
          },
        )
        request.on('error', (error) => rejectPromise(error))
      }),
  )
}

/**
 * Build the checker.
 *
 * @param {{
 *   fetchDistTags?: (name: string) => Promise<Record<string, string>>,
 *   log?: (line: string) => void,
 *   timeoutMs?: number,
 *   now?: () => number,
 * }} [deps]
 */
export function createUpdateChecker({ fetchDistTags = fetchDistTagsFromRegistry, log, timeoutMs = UPDATE_TIMEOUT_MS, now = () => Date.now() } = {}) {
  return {
    /**
     * Ask the registry about every package, one at a time, and never throw.
     *
     * Sequential rather than parallel on purpose: this runs in the background of a page someone is
     * using, and N simultaneous TLS handshakes for a cosmetic dot is a worse trade than a query that
     * takes N times as long in a place nobody is waiting.
     * @param {Array<{ name: string, version?: unknown, channel?: unknown }>} packages
     */
    async check(packages) {
      /** @type {string[]} */
      const logs = []
      const record = (line) => {
        logs.push(line)
        if (typeof log === 'function') log(line)
      }
      const results = []
      for (const entry of packages ?? []) {
        const channel = isChannel(entry?.channel) ? entry.channel : DEFAULT_CHANNEL
        const tag = DIST_TAG_OF[channel]
        try {
          const tags = await withTimeout(Promise.resolve(fetchDistTags(entry.name)), timeoutMs)
          const latest = typeof tags?.[tag] === 'string' ? tags[tag] : null
          results.push({
            name: entry.name,
            channel,
            tag,
            latest,
            available: latest !== null && isNewer(latest, entry?.version),
            error: null,
            timedOut: false,
          })
        } catch (error) {
          const timedOut = error?.message === 'timeout'
          record(`[dsh-ui-projects] update check for ${entry.name} ${timedOut ? 'timed out' : 'failed'}: ${String(error?.message ?? error)}`)
          results.push({
            name: entry.name,
            channel,
            tag,
            latest: null,
            available: false,
            error: timedOut ? 'timeout' : String(error?.message ?? error),
            timedOut,
          })
        }
      }
      return { checkedAt: now(), results, logs }
    },
  }
}
