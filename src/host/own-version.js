/**
 * THE FRAMEWORK PACKAGE'S OWN VERSION, in one place.
 *
 * WHY THIS FILE EXISTS. `plugin-api.js` decides whether a declared `pluginApiVersion` is `ok`,
 * `deprecated` or `unsupported` by comparing the running framework version against the deprecation
 * schedule (`plugin-api.js`, decision 2026-09-30). That version must come from ONE place, or the schedule
 * and the judgement drift apart — so it is read here, once, and handed to every caller.
 *
 * HOST-ONLY, AND NODE-ONLY. `node:fs` must never reach the browser bundle: `plugin-api.js` itself has no
 * node dependency at all for exactly that reason, and the client half re-derives what it needs from its
 * own mirror (`src/client/service.js`). This module is imported by the host half only.
 *
 * READ ONCE, THEN CACHED. `manifest-schema.js` validates synchronously, so an async read would force the
 * whole check to become async for a value that cannot change while the process runs. The first call reads
 * `package.json` beside this module; every later call returns the same string.
 */

import { readFileSync } from 'node:fs'

/** @type {string | null} */
let cached = null

/**
 * The version of the running dsh-ui-projects package, as `package.json` reports it.
 *
 * Falls back to `'0.0.0'` when the file cannot be read — a build that ships without its manifest is
 * broken in a way this function must not turn into a crash, and `'0.0.0'` is older than every schedule
 * entry, so the effect is "no deprecation warning yet" rather than a false refusal.
 * @returns {string}
 */
export function readOwnVersion() {
  if (cached !== null) return cached
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    cached = typeof manifest?.version === 'string' && manifest.version.length > 0 ? manifest.version : '0.0.0'
  } catch {
    cached = '0.0.0'
  }
  return cached
}
