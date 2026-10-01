/**
 * THE TEN-ITEM TEST CHECKLIST, client-side mirror.
 *
 * WHY A MIRROR. The two halves are separate bundles and cannot import one another: the client bundle is
 * built from `src/client/**` alone, and reaching into `src/host/**` would either fail the build or drag a
 * host module into the browser. `CHANNELS` (`channels.js`) and `SUPPORTED_PLUGIN_API` (`service.js`) are
 * mirrors for exactly this reason, and a suite assertion holds each pair equal — this file is the third,
 * and the suite holds its `id`s and `labelKey`s against `src/host/test-checklist.js` item by item.
 *
 * WHY `labelKey` AND NO TEXT: the sentence for each item lives in `src/client/locale.js`, in both
 * languages, so a translation cannot drift away from the list it labels — and this file cannot grow a
 * second, untranslated copy of the ten sentences.
 *
 * PURE DATA, ZERO DEPENDENCIES, on purpose: the client bundle carries it as-is.
 *
 * The ORDER is the spec's (`UI第三阶段.txt:51-57`): 亮色 / 暗色 / 移动端 / 弹窗 / 下拉 / 输入框 /
 * 首帧无闪烁 / 关闭无残留 / 焦点态 / 对比度.
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

/** The ids alone, for the write path's whitelist — derived, never a second list to keep in step. */
export const CHECKLIST_IDS = CHECKLIST_ITEMS.map((item) => item.id)

/**
 * Has every item been confirmed? The CLIENT-side mirror of `isComplete` in `src/host/test-checklist.js`,
 * with the same strictness: only `value === true` counts. The two must agree, because the panel uses this
 * one to disable a button while the host uses that one to refuse the write — a panel that thought the
 * checklist was complete when the host disagreed would offer an action that cannot succeed.
 * @param {Record<string, unknown> | null | undefined} record
 * @returns {boolean}
 */
export function isComplete(record) {
  if (record === null || typeof record !== 'object') return false
  return CHECKLIST_ITEMS.every((item) => record[item.id] === true)
}
