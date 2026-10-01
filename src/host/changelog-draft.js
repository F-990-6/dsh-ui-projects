/**
 * THE CHANGELOG DRAFT (`UI第三阶段.txt:59-69`).
 *
 * Collect the changes, classify them, suggest a semver bump, and hand all of it back as a DRAFT for
 * item-by-item confirmation. Nothing here writes a file: the draft is data, and the only module allowed to
 * touch `CHANGELOG.md` and `package.json` is `changelog-write.js` (next segment), behind the checklist
 * gate. Nothing here publishes or commits either — that stays the user's act.
 *
 * THE ONE RULE THAT MATTERS MOST: WITH NO EVIDENCE, SAY SO. `insufficient` with an EMPTY `entries` array
 * is the honest answer, and a generated changelog that invents entries is worse than no changelog at all,
 * because it is wrong in a way the reader has no way to notice. The suite asserts the emptiness, not just
 * the wording.
 *
 * PARSING IS DELIBERATELY FORGIVING (decision 2026-09-30). A line that matches a Conventional Commits
 * prefix is classified precisely; anything else becomes `Changed`, is SHOWN in the draft so a person can
 * judge it, and does NOT move the suggested bump — because "we could not tell what this was" is not
 * evidence of a breaking change, and guessing upward would make the suggestion meaningless.
 *
 * PURE FUNCTIONS, ZERO NODE DEPENDENCIES: this module is imported by the host half and must stay loadable
 * anywhere, the same rule `plugin-api.js` and `test-checklist.js` follow.
 */

/**
 * The six categories, in the spec's order. Category names are the changelog's own vocabulary and are NOT
 * translated: they are the words every CHANGELOG.md in this ecosystem already uses.
 */
export const CHANGELOG_CATEGORIES = ['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'Performance']

/** The bump levels, weakest first — the order IS the comparison. */
const BUMPS = ['patch', 'minor', 'major']

/**
 * The bump a single recognised prefix implies, or `null` when the line does not imply one.
 * @param {string} line
 * @returns {'patch' | 'minor' | 'major' | null}
 */
function bumpOf(line) {
  const text = line.trim()
  if (text.length === 0) return null
  /* A breaking change outranks everything, however it is spelled. */
  if (/^[a-z]+(\([^)]*\))?!:/.test(text) || /BREAKING[ -]CHANGE:/.test(text)) return 'major'
  if (/^feat(\([^)]*\))?:/.test(text)) return 'minor'
  if (/^(fix|perf)(\([^)]*\))?:/.test(text)) return 'patch'
  return null
}

/**
 * Which category a line belongs to. Recognised prefixes are precise; everything else is `Changed`, which
 * is the honest home for "something changed and we cannot say what kind".
 * @param {string} line
 * @returns {string}
 */
function categoryOf(line) {
  const text = line.trim()
  if (/^[a-z]+(\([^)]*\))?!:/.test(text) || /BREAKING[ -]CHANGE:/.test(text)) {
    return /^refactor|^remove|^revert/.test(text) ? 'Removed' : 'Changed'
  }
  if (/^feat(\([^)]*\))?:/.test(text)) return 'Added'
  if (/^fix(\([^)]*\))?:/.test(text)) return 'Fixed'
  if (/^perf(\([^)]*\))?:/.test(text)) return 'Performance'
  if (/^security(\([^)]*\))?:/.test(text)) return 'Security'
  if (/^remove|^revert|^drop/.test(text)) return 'Removed'
  if (/^docs|^style|^chore|^test|^build|^ci|^refactor/.test(text)) return 'Changed'
  return 'Changed'
}

/**
 * Turn one log line into the sentence a changelog shows: the prefix is stripped, the rest kept verbatim.
 * @param {string} line
 * @returns {string}
 */
function textOf(line) {
  const text = line.trim().replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '')
  return text.length > 0 ? text : line.trim()
}

/**
 * Build a changelog DRAFT from whatever evidence exists.
 *
 * @param {{ gitLog?: string | null, snapshotDiff?: object | null, currentVersion?: string, previousVersion?: string | null }} input
 * @returns {{ status: 'ok' | 'insufficient', entries: Array<{ category: string, text: string }>, suggestedBump: 'patch' | 'minor' | 'major' | null, reason: string | null }}
 */
export function draftChangelog(input) {
  const gitLog = typeof input?.gitLog === 'string' && input.gitLog.trim().length > 0 ? input.gitLog : null
  const snapshotDiff = input?.snapshotDiff ?? null

  if (gitLog === null && snapshotDiff === null) {
    return {
      status: 'insufficient',
      entries: [],
      suggestedBump: null,
      reason:
        'insufficient evidence: no git log and no version-snapshot difference were available, so nothing can be ' +
        'classified. Nothing has been written; supply the commit range or the snapshot pair and try again.',
    }
  }

  /** @type {Array<{ category: string, text: string }>} */
  const entries = []
  if (gitLog !== null) {
    for (const line of gitLog.split(/\r?\n/)) {
      if (line.trim().length === 0) continue
      /* A `BREAKING CHANGE:` trailer belongs to the commit above it, not to a line of its own. */
      if (/^BREAKING[ -]CHANGE:/.test(line.trim())) {
        entries.push({ category: 'Changed', text: textOf(line) })
        continue
      }
      entries.push({ category: categoryOf(line), text: textOf(line) })
    }
  }

  /*
   * THE BUMP COMES ONLY FROM RECOGNISED LINES. An unrecognised line is shown and ignored, and when NOTHING
   * was recognised the suggestion is the conservative `patch` with a reason that says a person must look —
   * a silent `patch` would read as a judgement nobody made.
   */
  const bumps = (gitLog ?? '')
    .split(/\r?\n/)
    .map((line) => bumpOf(line))
    .filter((bump) => bump !== null)
  const highest = BUMPS.reduce((best, level) => (bumps.includes(level) ? level : best), null)
  const suggestedBump = highest ?? 'patch'
  const recognised = bumps.length > 0

  return {
    status: 'ok',
    entries,
    suggestedBump,
    reason: recognised
      ? null
      : `no line matched a known prefix, so the ${suggestedBump} suggestion is a placeholder: classify the ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} by hand`,
  }
}

/**
 * Render a version-based section (decision 2026-09-30: version-based sections, coexisting with the older
 * round-based ones that `install.ps1 -Update` prints). Only the confirmed entries are ever rendered — this
 * function is given what a person accepted, never the draft itself.
 * @param {{ version: string, date?: string, entries: Array<{ category: string, text: string }> }} input
 * @returns {string}
 */
export function renderVersionSection({ version, date, entries }) {
  const heading = date === undefined || date === null ? `## [${version}]` : `## [${version}] - ${date}`
  const lines = [heading, '']
  for (const category of CHANGELOG_CATEGORIES) {
    const inCategory = entries.filter((entry) => entry.category === category)
    if (inCategory.length === 0) continue
    lines.push(`### ${category}`, '')
    for (const entry of inCategory) lines.push(`- ${entry.text}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}
