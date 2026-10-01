/**
 * THE PLUGIN API VERSION, declared once.
 *
 * `UI第三阶段.txt:43-49` (step 3) asks for five things, and the decisions taken 2026-09-30 fix their
 * shape. This module is the single source of the first four; the fifth — that ONE FIELD decides — is a
 * rule about the other files rather than data in this one:
 *
 *   1. dsh exposes `dshPluginApiVersion` (a Cordis service in both halves, built on this module).
 *   2. Compatibility inside one major version is backwards compatible. Kept as a LIST OF INTEGERS, not
 *      semver: several majors may be supported at once (`[1, 2]`), and each integer IS a major version.
 *   3. A breaking change warns one minor BEFORE it lands and is removed only at a major. `DEPRECATIONS`
 *      holds that schedule, and `judge` compares it against the running dsh's own version.
 *   4. A manifest declares `pluginApiVersion` (`manifest-schema.js` enforces the field).
 *   5. `pluginApiVersion` alone decides; `dshVersionHint` stays advisory and must never get a vote here —
 *      the schema says so (`manifest-schema.js:78`) and the update check says so (`update-check.js:16`).
 *
 * WHY THE VERSION IS A PARAMETER. `judge(declared, dshVersion)` takes the running version rather than
 * reading `package.json` itself: a pure function can be tested against any host version, including the
 * ones that do not exist yet — which is the only way the "warn one minor early, remove at the major" rule
 * can be pinned before either release happens.
 *
 * NO SEMVER LIBRARY. The comparison is the one semver promises that matters here — numeric order of
 * dot-separated parts — and it is small enough to keep honest by hand.
 */

/**
 * The plugin API version THIS build speaks. Plugins declare it as `pluginApiVersion` in their manifest.
 * A bump here is a statement about the interface, not about the package's own version.
 */
export const PLUGIN_API_VERSION = 1

/**
 * Every plugin API version this build can run — a list, because one dsh may host more than one major
 * while plugins migrate (decision 2). An integer IS a major version; there is no minor or patch here.
 */
export const SUPPORTED_PLUGIN_API = [1]

/**
 * The deprecation schedule: when a breaking change starts warning, and when it becomes a refusal.
 *
 * `deprecatedInDsh` is the dsh version that starts printing the warning — ONE MINOR BEFORE the removal,
 * so an author has a release to react in. `removedInDsh` is the dsh version whose support is gone; at
 * that point `judge` answers `unsupported`, which is what stops a project from being registered at all
 * (`src/client/service.js` refuses a declared, unsupported version).
 *
 * Measured 2026-09-30: version 1 is current, so this entry describes the migration that has NOT happened
 * yet — it exists so the mechanism is testable now rather than discovered during a breaking change.
 *
 * THE DATES ARE THIS PACKAGE'S OWN VERSIONS (`package.json:3` = `0.1.0`, decision 2026-09-30), not the dsh
 * runtime's: `SUPPORTED_PLUGIN_API` and this table both describe the framework package's release cadence,
 * so `dshVersion` means "the installed dsh-ui-projects version" everywhere `judge` is called. Hence
 * `0.2.0` — the NEXT MINOR, one release of warning — and `1.0.0`, this package's first major.
 * @type {ReadonlyArray<{ version: number, deprecatedInDsh: string, removedInDsh: string }>}
 */
export const DEPRECATIONS = [{ version: 1, deprecatedInDsh: '0.2.0', removedInDsh: '1.0.0' }]

/**
 * Compare two dot-separated numeric versions. Missing parts count as zero, so `'1.3'` and `'1.3.0'` are
 * the same version — which is what "one minor" means in a schedule written by people, not by a parser.
 * @param {string} left
 * @param {string} right
 * @returns {number} negative when `left` is older, positive when newer, 0 when equal
 */
function compareVersions(left, right) {
  const parts = (value) =>
    String(value ?? '')
      .split('.')
      .map((part) => {
        const number = Number.parseInt(part, 10)
        return Number.isFinite(number) ? number : 0
      })
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Can this dsh run a plugin that declares `declared`, given the running dsh version `dshVersion`?
 *
 *   `unsupported`  never spoke this API, or its removal version has arrived
 *   `deprecated`   supported, but scheduled for removal and the warning window has opened
 *   `ok`           supported and not scheduled, or still before its warning window
 *
 * A MISSING DECLARATION IS NOT THIS FUNCTION'S BUSINESS: `undefined` is not in the list, so it answers
 * `unsupported`, and the CALLERS decide what absence means — the host requires the field, and the client
 * refuses only a DECLARED, unsupported value so that packages written before the field existed keep
 * working (`src/client/service.js`, "a missing field is allowed, by decision"). Keeping that judgement at
 * the call sites is what lets the two halves differ on purpose.
 * @param {unknown} declared the `pluginApiVersion` a manifest declares
 * @param {string} dshVersion the running dsh version, as `package.json` reports it
 * @returns {'ok' | 'deprecated' | 'unsupported'}
 */
export function judge(declared, dshVersion) {
  if (!SUPPORTED_PLUGIN_API.includes(declared)) return 'unsupported'
  const schedule = DEPRECATIONS.find((entry) => entry?.version === declared)
  if (schedule === undefined) return 'ok'
  if (compareVersions(dshVersion, schedule.removedInDsh) >= 0) return 'unsupported'
  if (compareVersions(dshVersion, schedule.deprecatedInDsh) >= 0) return 'deprecated'
  return 'ok'
}

/**
 * The value both halves register as the `dshPluginApiVersion` service (decision 1).
 * @param {string} dshVersion the running dsh version
 * @returns {{ current: number, supported: number[], judge: (declared: unknown) => 'ok' | 'deprecated' | 'unsupported' }}
 */
export function createPluginApiService(dshVersion) {
  return {
    current: PLUGIN_API_VERSION,
    supported: [...SUPPORTED_PLUGIN_API],
    judge: (declared) => judge(declared, dshVersion),
  }
}
