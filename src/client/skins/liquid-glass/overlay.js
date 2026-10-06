/**
 * Liquid Glass — the runtime overlay, as the framework's built-in copy of it.
 *
 * This is a sheet inserted into `<head>` from the plugin's own `apply`, alongside the scoped stylesheets
 * the runtime inserts for the project. It arrived from `@fn-x/dsh-plugin-liquid-glass`, where it was the
 * whole of that package's browser entry; the four sheets below are that file's own strings, unchanged,
 * because the two copies have to stay identical and a rewrite here would be the first place they drift.
 *
 * Nothing here may `require` React or another plugin at module scope: that is the load-time contract
 * every client half in this system keeps, and the framework's suite asserts it for the framework's own
 * entry.
 *
 * ── THE RUNTIME OVERLAY, AND WHY IT IS NOT ANOTHER STYLESHEET RULE ──────────────────────────────
 *
 * Everything this package ships through `ctx.insertCss` is rewritten by the framework's scoper and
 * inserted as a project sheet, and a project sheet is only inserted while the project is ENABLED. That
 * is the right design for a look, and the wrong instrument for two jobs this file has:
 *
 *   1. VALUES THAT SURVIVE A MISSING TOKEN SHEET. Every var() below carries a literal fallback, so the
 *      overlay paints correctly even when `tokens.css` was never inserted.
 *
 *   2. A SHEET THAT CANNOT BE OUT-SPECIFIED. The shell styles its own dialogs with a two-class
 *      selector, and this file's stylesheet rules are scoped with :where(), which contributes no
 *      specificity at all. Inserting the sheet here — directly into `<head>`, from `apply` — keeps it
 *      out of that contest, and `!important` settles it. Measured: the add-plugins dialog, the settings
 *      panel and the add-source dropdown all changed appearance the first time this ran.
 *
 * The marker is spelled out in the strings below ON PURPOSE. Nothing rewrites them: they are inserted
 * by `installOverlay` rather than handed to `ctx.insertCss`, so the scoper never sees them and its
 * guard against a doubled marker never fires. In the stylesheet FILES that rule still holds: never
 * write the marker there.
 *
 * ── HOW THESE STRINGS ARE WRITTEN, AND WHY IT IS A RULE ─────────────────────────────────────────
 *
 * AN EARLIER VERSION OF THIS FILE BROKE THE WHOLE APPLICATION, and the cause is worth keeping: the CSS
 * constants below carried an explanatory comment INSIDE the template literal, and that comment used
 * backticks for emphasis. A template literal does not care that the text is a comment — the first
 * backtick ENDS THE STRING — so the rest of the sentence became JavaScript, and dsh failed to boot
 * with `SyntaxError: Unexpected identifier 'data'`.
 *
 * Therefore: inside these template literals there is CSS and nothing else. No backticks, no dollar
 * braces, no backslashes. Every explanation lives OUT HERE, and the CSS inside stays plain.
 */
const OVERLAY_ID = 'lg-overlay'

/**
 * The project this overlay belongs to, for the one attribute it stamps on its own style element.
 *
 * Required rather than written out: the id lives in the manifest, and a second copy of it here is a
 * second thing to keep right. `manifest.js` is a plain data module with no dependency of its own, so
 * requiring it at load time keeps this file's load-time contract (§ above).
 */
const manifest = require('./manifest.js')

/**
 * The CSS for the overlay, in three parts.
 *
 * All three load: dialogs and the settings modal take the PANEL tier — the thinnest of the three,
 * matching the composer by request, with a text halo to pay for it; menus, listboxes and the
 * add-source dropdown take the denser fill, because a list is read item by item over whatever
 * happens to be behind it; the embedded IDE's dock panes take the code tier.
 *
 * Every var() has a literal fallback, the values match the tokens in glass.css, and every declaration
 * that has to beat a shipped rule carries `!important`.
 *
 * Note for the next editor: no character in these strings may be a backtick. The comment you are
 * reading is outside them on purpose — see the header.
 */
const OVERLAY_DIALOG = `
body[data-ui-project-liquid-glass="on"] [role='dialog'] {
  background: var(--lg-glass-panel, rgb(255 255 255 / 6%)) !important;
  text-shadow: var(--lg-glass-panel-text-shadow, 0 1px 0 rgb(255 255 255 / 100%)) !important;
  --dsw-alias-bg-layer-1: var(--lg-glass-panel-inner, rgb(255 255 255 / 46%));
  --dsw-alias-bg-layer-2: var(--lg-glass-panel-inner, rgb(255 255 255 / 46%));
  --dsw-alias-bg-layer-3: var(--lg-glass-panel-inner-strong, rgb(255 255 255 / 50%));
  --dsw-alias-bg-overlay: var(--lg-glass-panel-inner-strong, rgb(255 255 255 / 50%));
  backdrop-filter: blur(var(--lg-glass-blur-menu, 24px)) saturate(var(--lg-glass-saturate, 140%)) !important;
  -webkit-backdrop-filter: blur(var(--lg-glass-blur-menu, 24px)) saturate(var(--lg-glass-saturate, 140%)) !important;
  border-radius: var(--lg-glass-radius, 24px) !important;
  box-shadow: var(--lg-glass-shadow, 0 24px 60px rgb(0 0 0 / 6%)),
    inset 0 1px 0 rgb(255 255 255 / 14%), inset 0 -1px 0 rgb(0 0 0 / 4%) !important;
}
body[data-ui-project-liquid-glass="on"][data-shortcut-modal='settings'] [role='dialog'] {
  background: var(--lg-glass-panel, rgb(255 255 255 / 6%)) !important;
}
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [role='dialog'],
html[data-ds-dark-theme] body[data-ui-project-liquid-glass="on"] [role='dialog'] {
  background: var(--lg-glass-panel-dark, rgb(28 28 30 / 10%)) !important;
  text-shadow: var(--lg-glass-panel-text-shadow-dark, 0 1px 0 rgb(0 0 0 / 85%)) !important;
  --dsw-alias-bg-layer-1: var(--lg-glass-panel-inner, rgb(30 33 42 / 50%));
  --dsw-alias-bg-layer-2: var(--lg-glass-panel-inner, rgb(30 33 42 / 50%));
  --dsw-alias-bg-layer-3: var(--lg-glass-panel-inner-strong, rgb(30 33 42 / 54%));
  --dsw-alias-bg-overlay: var(--lg-glass-panel-inner-strong, rgb(30 33 42 / 54%));
}
body[data-ui-project-liquid-glass="on"] [data-ui-skin-column] {
  --dsw-alias-bg-module-platform: rgb(237 234 228 / 92%);
}
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [data-ui-skin-column] {
  --dsw-alias-bg-module-platform: rgb(32 35 39 / 92%);
}
body[data-ui-project-liquid-glass="on"] > :is(div, section):not(#root) {
  --dsw-alias-bg-layer-3: rgb(255 255 255 / 72%);
  --dsw-alias-bg-overlay: rgb(255 255 255 / 72%);
}
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] > :is(div, section):not(#root) {
  --dsw-alias-bg-layer-3: rgb(30 33 42 / 76%);
  --dsw-alias-bg-overlay: rgb(30 33 42 / 76%);
}
body[data-ui-project-liquid-glass="on"] [data-ui-skin-column]:hover {
  --dsw-alias-bg-layer-1: rgb(237 234 228 / 92%);
  --dsw-alias-bg-layer-2: rgb(237 234 228 / 92%);
  --dsw-alias-bg-layer-3: rgb(237 234 228 / 92%);
  --dsw-alias-bg-overlay: rgb(237 234 228 / 92%);
}
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [data-ui-skin-column]:hover {
  --dsw-alias-bg-layer-1: rgb(32 35 39 / 92%);
  --dsw-alias-bg-layer-2: rgb(32 35 39 / 92%);
  --dsw-alias-bg-layer-3: rgb(32 35 39 / 92%);
  --dsw-alias-bg-overlay: rgb(32 35 39 / 92%);
}
`

/**
 * Surfaces a reader works THROUGH: menus, listboxes, and the add-source dropdown. The dense pair, so a
 * list of names is never read over somebody's sentence. No tooltip here: the shipped tooltip is a
 * near-opaque dark plate on purpose.
 */
const OVERLAY_DENSE = `
body[data-ui-project-liquid-glass="on"] [role='menu'],
body[data-ui-project-liquid-glass="on"] [role='listbox'],
body[data-ui-project-liquid-glass="on"] [data-install-registry='true'] {
  background: var(--lg-glass-fill, rgb(255 255 255 / 80%)) !important;
  backdrop-filter: blur(var(--lg-glass-blur-menu, 24px)) saturate(var(--lg-glass-saturate, 140%)) !important;
  -webkit-backdrop-filter: blur(var(--lg-glass-blur-menu, 24px)) saturate(var(--lg-glass-saturate, 140%)) !important;
  border-radius: var(--lg-glass-radius, 24px) !important;
}
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [role='menu'],
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [role='listbox'],
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [data-install-registry='true'] {
  background: var(--lg-glass-fill-dark, rgb(40 44 54 / 84%)) !important;
}
`

/**
 * The embedded IDE's dock content: diff and editor panes, which publish no role, no aria and no
 * shortcut attribute — only the two data-dockit attributes, and build-hashed classes this repository
 * never writes.
 *
 * The FIRST PAIR covers the container: the dock host and the pane itself.
 *
 * IT NOW CARRIES THE CODE TIER, AND THE TIER IS FULLY OPAQUE. The first version gave these panes the
 * dense floating fill, a reader reported the diff as still too transparent, and the pair went to 94%
 * — after which the same report came back unchanged. That is evidence about STRUCTURE, not about
 * alpha: the pane is a host marker, and in that subtree the boxes and their backgrounds belong to the
 * pane's CHILDREN. An opaque fill on a marker element that does not carry the box is invisible, and
 * raising the number again would have been invisible too.
 *
 * HENCE THREE LEVELS: the dock host, the pane, and the pane's direct children. The child combinator
 * is not decoration — a descendant combinator would reach the token spans and line boxes inside the
 * code view and repaint the surfaces the syntax colouring needs, whereas `> *` stops exactly one
 * level below the pane, where the boxes are. A background on a child paints BEHIND that child's own
 * content, so this can make a region readable and cannot hide a glyph.
 */
const OVERLAY_DOCK = `
body[data-ui-project-liquid-glass="on"] [data-dockit-host='dock'],
body[data-ui-project-liquid-glass="on"] [data-dockit-pane-panel] {
  background: var(--lg-glass-code, #EDEAE4) !important;
  backdrop-filter: blur(var(--lg-glass-blur, 24px)) saturate(var(--lg-glass-saturate, 140%)) !important;
  -webkit-backdrop-filter: blur(var(--lg-glass-blur, 24px)) saturate(var(--lg-glass-saturate, 140%)) !important;
}
body[data-ui-project-liquid-glass="on"] [data-dockit-host='dock'] > *,
body[data-ui-project-liquid-glass="on"] [data-dockit-pane-panel] > * {
  background: var(--lg-glass-code, #EDEAE4) !important;
}
body[data-ui-project-liquid-glass="on"] [data-ui-skin-column]:has([data-dockit-pane-panel]) {
  background: var(--lg-glass-code, #EDEAE4) !important;
}
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [data-dockit-host='dock'],
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [data-dockit-pane-panel],
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [data-dockit-host='dock'] > *,
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [data-dockit-pane-panel] > *,
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [data-ui-skin-column]:has([data-dockit-pane-panel]) {
  background: var(--lg-glass-code-dark, #202327) !important;
}
body[data-ui-project-liquid-glass="on"] [slot='tool.call.toolview'] {
  background: rgb(203 199 190) !important;
}
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [slot='tool.call.toolview'] {
  background: rgb(26 29 34) !important;
}
body[data-ui-project-liquid-glass="on"] [slot='conversation.chat.node']:has([slot='tool.call.toolview']) > * {
  background: rgb(246 244 239) !important;
}
body[data-ui-project-liquid-glass="on"][data-ds-dark-theme] [slot='conversation.chat.node']:has([slot='tool.call.toolview']) > * {
  background: rgb(26 29 34) !important;
}
`

/**
 * THE MODES WHERE THE READER ASKED FOR LESS, ANSWERED AT THE SAME STRENGTH.
 *
 * `glass.css` turns its own blur off under these three queries (`backdrop-filter: none` in each of its
 * suppression blocks) — and it cannot turn the OVERLAY's off. Every blur in this file carries
 * `!important`, and an `!important` declaration beats a normal one whatever the specificity, so the
 * reader who had asked their system for less transparency still got frosted dialogs, menus and dock
 * panes: the FILLS went opaque (that half is what the tier tokens fixed) while the blur stayed on.
 *
 * This sheet makes the same request at the same strength. The selectors are copied from the rules whose
 * blur it has to beat, so specificity ties; `!important` is on both sides, so importance ties; and this
 * block is LAST in `OVERLAY_CSS` — source order is the only lever left once those two are equal.
 *
 * `@supports not (backdrop-filter: …)` IS DELIBERATELY ABSENT: there is nothing to switch off. A browser
 * without the property drops every blur in this file on the floor, which is the outcome that mode asks
 * for.
 */
const OVERLAY_MODES = `
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active) {
  body[data-ui-project-liquid-glass="on"] [role='dialog'],
  body[data-ui-project-liquid-glass="on"] [role='menu'],
  body[data-ui-project-liquid-glass="on"] [role='listbox'],
  body[data-ui-project-liquid-glass="on"] [data-install-registry='true'],
  body[data-ui-project-liquid-glass="on"] [data-dockit-host='dock'],
  body[data-ui-project-liquid-glass="on"] [data-dockit-pane-panel] {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}
`

const OVERLAY_CSS = OVERLAY_DIALOG + OVERLAY_DENSE + OVERLAY_DOCK + OVERLAY_MODES

/**
 * Insert the overlay once, into the document head, with no dependency on any service.
 *
 * Idempotent by id: a second apply — a reload, a re-registration — replaces nothing and stacks nothing.
 * Returns true when a sheet was inserted, so a caller can tell the two cases apart.
 * @returns {boolean}
 */
function installOverlay() {
  if (typeof document === 'undefined' || document === null) return false
  const head = document.head
  if (head === null || head === undefined) return false
  if (document.getElementById(OVERLAY_ID) !== null) return false
  const style = document.createElement('style')
  style.id = OVERLAY_ID
  style.setAttribute('data-ui-project-overlay', manifest.id)
  style.textContent = OVERLAY_CSS
  head.appendChild(style)
  return true
}

/**
 * Remove the sheet `installOverlay` inserted, if it is there.
 *
 * The package this file came from did this from its own `dispose` handler; the framework does it from an
 * effect disposer, which is the same thing at the same moment — the plugin's client half going away.
 * Idempotent, and silent when there is nothing to remove.
 */
function removeOverlay() {
  if (typeof document === 'undefined' || document === null) return
  document.getElementById(OVERLAY_ID)?.remove?.()
}

/*
 * The overlay is a SHEET and the two things that can be done with it — not a plugin. The plugin that
 * owns it is this package's own client half, which registers the project and then installs this; that
 * separation is what lets a built-in skin be a project like any other while the overlay stays the one
 * sheet the system inserts outside the scoped path.
 */
module.exports = { installOverlay, removeOverlay, OVERLAY_ID, OVERLAY_CSS }
