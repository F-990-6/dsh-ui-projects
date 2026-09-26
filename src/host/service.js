/**
 * dsh-ui-projects — host-plane service: `uiProjectsHost`.
 *
 * WHY A SERVICE AND NOT PER-PACKAGE CODE. The first frame happens before any client bundle
 * exists, so every UI project package has to answer `webserver/index-inject` from its own host
 * half. What it must NOT do is own the answer's details: the marker attribute name, the
 * `<script>` that writes it, the fragment tag the client scans for, and the rule that the
 * settings document is read at EMIT time rather than cached at mount. Those are one contract,
 * and this service is the one place it lives — a skin asks for its rows and gets them.
 *
 * WHY `bootRows` TAKES THE CSS. The first-paint stylesheet is a derived subset of each package's
 * own skin CSS (`derive-boot-css.mjs --package <dir>`), and the package that owns the CSS is the
 * only thing that can hand it over. The service formats rows; it does not know what is in them.
 *
 * WHY IT IS PROVIDED UNCONDITIONALLY, even though it reads settings. An earlier sketch provided
 * it inside `ctx.inject(['settings'], …)`, which reads well until you ask what happens in a
 * composition that never provides `settings`: the service would never appear, every skin's host
 * row would sit in `waiting` forever, and the page would lose its first-paint CSS entirely —
 * a much worse outcome than losing the marker, which is all the settings document actually
 * decides. So the service is always there, and `readEnabledIds` fails soft to "nothing is on".
 */

/** Durable settings namespace. The browser half keeps its own copy in `persist.js`. */
export const UI_PROJECTS_SETTINGS_NAMESPACE = 'ui-projects'

/**
 * The global every host half appends its own project id to, so the browser half can tell which
 * packages the HOST plane actually mounted on this page load.
 *
 * It exists because the two halves can fail independently and neither can see the other
 * directly: the host rows run in Node, the client modules run in the page, and there is no
 * shared service between the planes (a service store lives on one Cordis root — see
 * `@deepseek-ai/cordis/src/reflect.ts`, where the isolation key is minted on `ctx.root`). The
 * only thing both planes already share is the rendered document, so the host announces itself
 * there. `src/client/boot-presence.js` holds the same literal and `scripts/load-check.mjs`
 * asserts the two agree.
 */
export const PRESENCE_GLOBAL = '__dshUiProjectRows'

/**
 * The tag the browser half looks for to answer "did my first-paint fragment reach this page?".
 *
 * The tag is prepended by `bootRows`, not written into `boot.css`, because the build strips
 * comments from the payload it inlines — a tag in the source file would never reach the page.
 * @param {string} projectId
 */
export const fragmentTag = (projectId) => `/* ui-project:${projectId} boot-fragment v1 */`

/** The body attribute the client scoper stamps every project rule with. Must match `runtime.js`. */
export const markerAttribute = (projectId) => `data-ui-project-${projectId}`

/** The `<html>` attribute the runtime reads back. Must match `runtime.js`. */
export const SKIN_ATTRIBUTE = 'data-ui-skin'

/**
 * The project ids the settings document currently says are on.
 *
 * Read through the same document the browser half writes, so the first frame and the runtime
 * cannot disagree about what is enabled. Every failure mode returns an empty list rather than
 * throwing: no settings service composed, no section yet (the normal first run), or a section
 * written by an older version. In all of those the answer "nothing is on" is safe — the first
 * frame paints the default look, exactly as it did before this existed.
 *
 * Read at EMIT time rather than cached at mount: the injection table is collected fresh for every
 * index render, so a toggle is reflected by the next reload with nothing to invalidate.
 * @param {{ get: (name: string) => any }} ctx
 * @returns {string[]}
 */
export function readEnabledIds(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.get !== 'function') return []
  const section = settings.get(UI_PROJECTS_SETTINGS_NAMESPACE)
  if (section === null || typeof section !== 'object') return []
  return Array.isArray(section.enabled) ? section.enabled : []
}

/**
 * The row that records this package's presence for THIS page load.
 *
 * `placement: 'body'` is required, not stylistic: body rows are rendered immediately after the
 * opening body tag, which is strictly before the boot tail that loads any client bundle. The
 * browser half therefore reads the global synchronously in `apply` and gets a complete answer.
 * @param {string} projectId
 * @returns {import('@deepseek-ai/dsh-host-webserver').IndexInjection}
 */
function presenceRow(projectId) {
  return {
    kind: 'script',
    placement: 'body',
    text: `(window.${PRESENCE_GLOBAL} = window.${PRESENCE_GLOBAL} || []).push(${JSON.stringify(projectId)})`,
  }
}

/**
 * The first-paint marker, written while the parser is still opening `<body>`.
 *
 * It fails soft by construction: if the settings document cannot be read, the row is never
 * pushed, no attribute is set, and the page paints the default look.
 * @param {string} projectId
 * @returns {import('@deepseek-ai/dsh-host-webserver').IndexInjection}
 */
function markerRow(projectId) {
  return {
    kind: 'script',
    placement: 'body',
    text: `(() => {
  document.body.setAttribute(${JSON.stringify(markerAttribute(projectId))}, 'on')
  document.documentElement.setAttribute(${JSON.stringify(SKIN_ATTRIBUTE)}, ${JSON.stringify(projectId)})
})()`,
  }
}

/**
 * The host-plane service one UI project package asks for its first-paint rows.
 *
 * A package's host half is then three lines: listen, ask, push. See `cordis.patch.yml` and
 * `src/host/index.js` of `dsh-ui-project-skeleton`.
 * @param {{ get: (name: string) => any }} ctx
 */
export function createHostService(ctx) {
  return {
    /**
     * Every row this project contributes to one index render.
     *
     * Order is the contract: presence first (the browser half reads the global in `apply`),
     * then the stylesheet, then the marker. The stylesheet goes in unconditionally — every
     * selector in it carries the project marker, so with the project off the sheet is inert and
     * the host needs no branch, which is one less way for "the skin is off" to go wrong.
     * @param {string} projectId
     * @param {string} [cssText] this package's derived first-paint fragment
     * @returns {import('@deepseek-ai/dsh-host-webserver').IndexInjection[]}
     */
    bootRows(projectId, cssText) {
      /** @type {import('@deepseek-ai/dsh-host-webserver').IndexInjection[]} */
      const rows = [presenceRow(projectId)]
      if (typeof cssText === 'string' && cssText.length > 0) {
        rows.push({ kind: 'style', text: `${fragmentTag(projectId)}\n${cssText}` })
      }
      if (readEnabledIds(ctx).includes(projectId)) rows.push(markerRow(projectId))
      return rows
    },
  }
}
