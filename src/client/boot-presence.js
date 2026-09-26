/**
 * What the HOST plane told this page, and what actually reached it.
 *
 * The two halves of a UI project package load independently — the host row in Node, the client
 * module in the page — so neither can observe the other, and one of them being absent is a
 * normal condition rather than an error. This module collects the evidence the browser half has:
 *
 *   presence global   the host's own per-page-load announcement (`src/host/service.js`)
 *   fragment tag      whether this project's first-paint stylesheet is in the document
 *   body marker       whether the host decided this project was on at emit time
 *
 * The literals here are duplicated from the host half on purpose. The two halves are separate
 * bundles and cannot import from one another — the same reason `UI_PROJECTS_SETTINGS_NAMESPACE`
 * has a copy on each side — so `scripts/load-check.mjs` asserts that the copies agree.
 */

/** The global the host appends every mounted package's project id to. */
const PRESENCE_GLOBAL = '__dshUiProjectRows'

/** @param {string} projectId */
const fragmentTag = (projectId) => `/* ui-project:${projectId} boot-fragment v1 */`

/** @param {string} projectId */
const markerAttribute = (projectId) => `data-ui-project-${projectId}`

/**
 * The host's announcement for THIS page load, read once and frozen.
 *
 * Read synchronously, and read only once, because the two facts it carries are both about the
 * moment the document was served: body rows run immediately after `<body>` opens, strictly
 * before the boot tail that loads this bundle. Re-reading later could only pick up a value some
 * other code wrote afterwards, which is not evidence about the first frame.
 *
 * `null` means the global was never created — that is, no host half pushed a presence row, so
 * the host plane contributed nothing to this page. It is NOT an error state: a composition
 * without any UI project package is a valid composition.
 * @returns {readonly string[] | null}
 */
export function readHostRowsAtBoot() {
  if (typeof window === 'undefined') return null
  const raw = window[PRESENCE_GLOBAL]
  if (!Array.isArray(raw)) return null
  return Object.freeze(raw.map((value) => String(value)))
}

/**
 * Whether this project's first-paint fragment is in the document right now.
 *
 * A live DOM query, deliberately not a cached flag: it answers a question about the current
 * document, and a value captured at boot would go stale the moment the host re-renders the
 * index. The cost is a scan of the document's `<style>` elements, which happens once per
 * settings-panel render — a handful of elements, and no layout is forced.
 *
 * Matched on the tag `bootRows` prepends, never on the sheet's text: a project's CSS is free to
 * change, the tag is the contract.
 * @param {string} projectId
 * @returns {boolean}
 */
export function bootFragmentPresent(projectId) {
  if (typeof document === 'undefined' || document.querySelectorAll === undefined) return false
  const tag = fragmentTag(projectId)
  for (const element of document.querySelectorAll('style')) {
    if (typeof element.textContent === 'string' && element.textContent.startsWith(tag)) return true
  }
  return false
}

/**
 * Whether the body marker is set right now.
 *
 * Also live. The marker is written by the host when the settings document said the project was
 * on at emit time, so "enabled in the document but no marker" means the host half did not run —
 * while "marker present but the client state differs" is the ordinary pending-reload state and
 * must not be reported as a failure.
 * @param {string} projectId
 * @returns {boolean}
 */
export function bodyMarkerPresent(projectId) {
  if (typeof document === 'undefined' || document.body === null || document.body === undefined) return false
  return typeof document.body.getAttribute === 'function' && document.body.getAttribute(markerAttribute(projectId)) === 'on'
}

/** Exported for the contract check in `scripts/load-check.mjs`. */
export const __contract = { PRESENCE_GLOBAL, fragmentTag, markerAttribute }
