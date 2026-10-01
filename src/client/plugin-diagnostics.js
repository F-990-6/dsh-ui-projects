/**
 * THE DIAGNOSTIC TEXT, BUILT IN THE CLIENT (`UI第三阶段.txt:71-77`, decision 2026-09-30).
 *
 * A reader whose plugin is broken wants something they can PASTE — into a bug report, into a message to
 * whoever maintains the package. This module assembles that text from the facts the page already holds:
 * the row's own fields, its problems, its update result and its version-snapshot history.
 *
 * WHY NOT THE HOST. Everything here is already on the page; a host builder would need a new endpoint to
 * send back what the page could have written itself. The host's own warnings go to a terminal this plugin
 * cannot read, so nothing here pretends to collect them.
 *
 * NAMED `plugin-diagnostics.js` ON PURPOSE: `diagnostics.js` beside it is the instrumentation toggle (the
 * debug switch `persist.js` mentions), a different job that must not be overwritten by this one.
 *
 * PURE, ZERO DEPENDENCIES, NO `window`, NO `localStorage`: a function of its arguments, which is what makes
 * it testable without a DOM.
 *
 * INSTALL TIME IS A FALLBACK CHAIN: the newest snapshot's `createdAt`, else nothing — and nothing renders
 * as "unknown" rather than as an empty cell, because an empty cell reads as "instant".
 */

/** The sentence used when a fact is genuinely not known — never an empty string. */
export const UNKNOWN = 'unknown'

/**
 * The newest snapshot in a package's history, or `null` when there is none.
 *
 * SORTED HERE rather than trusted: the scan already sorts newest-first (`profile-scan.js:653`), and a
 * caller that passes them in another order must not change what "installed when" means.
 * @param {Array<{ createdAt?: string }> | null | undefined} versions
 */
function newestSnapshot(versions) {
  const list = Array.isArray(versions) ? versions.filter((entry) => entry !== null && typeof entry === 'object') : []
  if (list.length === 0) return null
  return list.reduce((newest, entry) => (String(entry.createdAt ?? '') > String(newest.createdAt ?? '') ? entry : newest))
}

/**
 * One `label: value` pair, and the line it becomes. THE SAME PAIR FEEDS BOTH OUTPUTS, so the text a person
 * copies and the rows a panel renders cannot disagree.
 * @param {string} label @param {unknown} value
 */
const pair = (label, value) => ({
  label,
  value: value === null || value === undefined || value === '' ? UNKNOWN : String(value),
})

/**
 * Build the diagnostics for one row.
 * @param {any} dependency the row, as the panel received it
 * @param {Array<{ name?: string, version?: string, createdAt?: string, files?: number, bytes?: number }> | null} [versions]
 *        that package's version snapshots, in any order — this function sorts
 * @returns {{ text: string, lines: Array<{ label: string, value: string }>, unknown: string }}
 */
export function buildDiagnostics(dependency, versions) {
  const row = dependency !== null && typeof dependency === 'object' ? dependency : {}
  const history = Array.isArray(versions) ? versions : []
  const newest = newestSnapshot(history)
  const problems = Array.isArray(row.problems) ? row.problems : []
  const update = row.update !== null && typeof row.update === 'object' ? row.update : null
  const failures = Array.isArray(row.updateFailures) ? row.updateFailures : []

  /** @type {Array<{ label: string, value: string }>} */
  const lines = [
    pair('package', row.name),
    pair('version', row.version),
    pair('source', row.spec),
    pair('resolved', row.via),
    pair('kind', row.kind),
    /* THE CHAIN in one expression: the newest snapshot, else nothing — and nothing is "unknown". */
    pair('installed', newest?.createdAt ?? null),
    pair(
      'last update check',
      update === null
        ? null
        : update.error
          ? `check failed: ${update.error}`
          : update.available === true
            ? `update available: ${update.latest ?? UNKNOWN}`
            : 'up to date',
    ),
  ]

  for (const problem of problems) {
    lines.push(pair('problem', `${problem?.code ?? UNKNOWN}: ${problem?.message ?? UNKNOWN}`))
  }
  for (const failure of failures.slice(-5)) {
    lines.push(
      pair('update failure', `${failure?.at ?? UNKNOWN} ${failure?.version ?? UNKNOWN}: ${failure?.reason ?? UNKNOWN}`),
    )
  }
  if (history.length > 0) {
    lines.push(
      pair(
        'snapshots',
        history.map((entry) => `${entry?.name ?? UNKNOWN}@${entry?.version ?? UNKNOWN} (${entry?.createdAt ?? UNKNOWN})`).join(', '),
      ),
    )
  }

  const text = [`${row.name ?? UNKNOWN}@${row.version ?? UNKNOWN}`, ...lines.map((line) => `${line.label}: ${line.value}`)].join('\n')
  return { text, lines, unknown: UNKNOWN }
}
