/**
 * THE TEN-ITEM TEST CHECKLIST (`UI第三阶段.txt:51-57`).
 *
 * Settings ▸ Plugins offers "生成测试清单"; the list has ten items, every one is confirmed individually,
 * and only then may "标记通过" be pressed — a CHANGELOG draft may not be generated before that mark exists.
 *
 * WHY THE GATE IS A REFUSAL, NOT A DISABLED BUTTON. A disabled button is a suggestion: nothing stops a
 * later caller, a second surface, or a script from writing the mark anyway. `markTested` therefore THROWS
 * on an incomplete record, so the rule is enforced at the one place that records a pass — the same shape
 * `src/client/service.js` uses when it refuses a registration it cannot honour.
 *
 * PURE DATA AND PURE FUNCTIONS, ZERO NODE DEPENDENCIES: this module is imported by the host half (which
 * reads and judges) and its constants are mirrored into the client bundle, so nothing here may reach for
 * `node:fs` — the same rule `plugin-api.js` follows, for the same reason.
 *
 * WHERE THE RECORD LIVES: the settings document, at `settings['<pkg>'].checklist`, beside the `channel`
 * the same per-package entry already carries (`src/client/channels.js`). That record is the USER's, not
 * the package's — it survives the package being uninstalled, which is exactly what "you tested this
 * version" has to do to be worth anything.
 */

/**
 * The ten things a person checks before calling a skin tested, in the order the spec lists them.
 *
 * `labelKey` is a key in `src/client/locale.js`, where the sentence for each item lives in both
 * languages — the checklist carries NO display text of its own, so a translation cannot drift from it.
 * @type {ReadonlyArray<{ id: string, labelKey: string }>}
 */
export const CHECKLIST_ITEMS = [
  { id: 'light', labelKey: 'checklistLight' },
  { id: 'dark', labelKey: 'checklistDark' },
  { id: 'mobile', labelKey: 'checklistMobile' },
  { id: 'modal', labelKey: 'checklistModal' },
  { id: 'dropdown', labelKey: 'checklistDropdown' },
  { id: 'input', labelKey: 'checklistInput' },
  { id: 'first-frame-no-flicker', labelKey: 'checklistFirstFrame' },
  { id: 'close-no-residue', labelKey: 'checklistCloseResidue' },
  { id: 'focus', labelKey: 'checklistFocus' },
  { id: 'contrast', labelKey: 'checklistContrast' },
]

/**
 * Has every item been confirmed?
 *
 * STRICTLY: an item counts only when its value is exactly `true`, so a record written by an older build —
 * or by hand — cannot pass by carrying truthy strings, numbers or missing entries. A checklist that can be
 * satisfied accidentally is worse than no checklist, because it produces a mark nobody earned.
 * @param {Record<string, unknown> | null | undefined} record
 * @returns {boolean}
 */
export function isComplete(record) {
  if (record === null || typeof record !== 'object') return false
  return CHECKLIST_ITEMS.every((item) => record[item.id] === true)
}

/**
 * Which items are still unconfirmed, in the spec's order — what the panel shows and the refusal names.
 * @param {Record<string, unknown> | null | undefined} record
 * @returns {string[]} the ids still missing
 */
export function missingItems(record) {
  const given = record !== null && typeof record === 'object' ? record : {}
  return CHECKLIST_ITEMS.filter((item) => given[item.id] !== true).map((item) => item.id)
}

/**
 * Record that this package's current version passed the checklist — the ONLY way to do so.
 *
 * REFUSES AN INCOMPLETE RECORD, and the refusal names what is missing: "you have not finished the
 * checklist" is only actionable when it says which items are left. The package name is included so a
 * reader of a log line knows which row was being marked.
 * @param {Record<string, unknown> | null | undefined} record
 * @param {string} packageName
 * @returns {{ tested: true, package: string, items: string[] }} the state a caller may persist
 * @throws {TypeError} when any item is still unconfirmed
 */
export function markTested(record, packageName) {
  const missing = missingItems(record)
  if (missing.length > 0) {
    throw new TypeError(
      `[dsh-ui-projects] the checklist for "${String(packageName)}" is incomplete: ` +
        `${missing.length} of ${CHECKLIST_ITEMS.length} item(s) are not confirmed (${missing.join(', ')})`,
    )
  }
  return { tested: true, package: String(packageName), items: CHECKLIST_ITEMS.map((item) => item.id) }
}
