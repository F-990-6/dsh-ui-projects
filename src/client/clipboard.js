/**
 * COPYING TEXT, in one place (2026-09-30).
 *
 * This function used to live inside `panel-plugins.js` — the "UI plugins" column, which is being removed.
 * The copy button is one of the three things that SURVIVE that removal (uninstall, view CHANGELOG, copy
 * diagnostics), so the function moves out rather than dying with the file that held it.
 *
 * NOTHING IS EVER EXECUTED: the text is copied to the clipboard, and no code path here reaches a shell.
 * The suite asserts that this module contains no `spawn`/`exec` at all.
 *
 * TWO PATHS, in this order, because the modern one is not always available and the old one is not always
 * allowed:
 *   1. `navigator.clipboard.writeText` — the supported API, and available on the origins this page is
 *      served from.
 *   2. a hidden `<textarea>` plus `document.execCommand('copy')` — for the case where the API exists but
 *      refuses (permissions, focus).
 *
 * `'failed'` IS A REAL ANSWER and must be rendered: a copy button that says nothing when the clipboard
 * refused is a button the reader will press again, and again.
 */

/**
 * Copy one string, and report which of two things happened.
 * @param {string} source
 * @returns {Promise<'copied'|'failed'>}
 */
export async function copyCommandText(source) {
  try {
    if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(source)
      return 'copied'
    }
  } catch {
    /* the API exists and refused (permissions, focus): try the legacy path before giving up */
  }
  try {
    const area = document.createElement('textarea')
    area.value = source
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied === true ? 'copied' : 'failed'
  } catch {
    return 'failed'
  }
}
