/**
 * dsh-ui-projects — host half.
 *
 * The UI project system lives in the browser: the registry, the runtime and the
 * Settings › UI section are all client-side, so this row exists for these reasons:
 *
 *  1. **Presence.** A Loader row is what makes the `dsh.client` declaration in
 *     `package.json` real: the client-modules node half scans enabled rows for
 *     that declaration and serves the bundle at `/plugins/dsh-ui-projects/client.js`.
 *     Without this half, the browser half is never delivered.
 *  2. **Diagnostics.** It logs one line when it mounts, so a composition failure
 *     (a typo in the row id, a missing bundle) is visible in the Host log rather
 *     than only in the browser console.
 *  3. **Settings ownership.** It registers the `ui-projects` settings namespace,
 *     so the registry's durable state lives in `$DSH_HOME/settings.yaml` — the
 *     Host document that survives a browser-profile reset. Without this
 *     registration the browser half's preferred transport reports `unavailable`,
 *     and `src/client/persist.js` silently falls back to `localStorage` instead.
 *  4. **First paint.** It answers `webserver/index-inject` with the skin's
 *     first-paint stylesheet and its data attribute. THIS half owns that because
 *     the first frame happens before the client bundle is even fetched: the head
 *     must already carry the critical CSS and the body must already carry the
 *     marker, or the page paints in the default look and then switches — the flash
 *     the specification forbids. The stylesheet is `src/host/boot.css`, a verbatim
 *     subset of what the client emits; `scripts/build.mjs` fails the build if the
 *     two ever disagree.
 *
 * It owns no Service, no route and no business state of its own. The one Event it listens to is
 * the index injection above, and the client half is still where the product lives.
 */

import z from '@deepseek-ai/schemastery'

import { BOOT_CSS } from './boot-css.js'

/** The browser bundle this row makes reachable. */
export const CLIENT_MODULE_ID = 'dsh-ui-projects'

/**
 * Durable settings namespace for the UI project registry.
 *
 * This value is one half of a contract whose other half is `SETTINGS_NS` in
 * `src/client/persist.js` — the browser half binds exactly this namespace
 * through `ctx.settingsScope`. The two exist as separate copies because the two
 * halves are separate bundles that cannot import from one another, which is also
 * why changing one without the other silently moves the durable state to
 * `localStorage` instead of failing loudly.
 */
export const UI_PROJECTS_SETTINGS_NAMESPACE = 'ui-projects'

/**
 * The settings document schema.
 *
 * Field for field, this is the record `src/client/persist.js` reads and writes:
 * it calls `scope.set(...)` once per field, so every field is top-level and
 * resolves independently.
 *
 *   { v: 1, initialized: true, enabled: ["liquid-glass"], settings: {}, touched: true }
 *
 * Every field carries a default, and that is load-bearing rather than tidy. The
 * settings provider resolves a namespace as `schema defaults → composition base
 * → user section`, and it validates the stored section **at registration**,
 * refusing the registration outright if validation fails — at which point there
 * is no last-good value to fall back on. An absent section is the normal
 * first-run state, so defaults are what make "no section yet" a success rather
 * than a plugin that cannot register at all.
 *
 * Exported so the host check can exercise it against real records instead of
 * trusting that it parses.
 */
export const UI_PROJECTS_SETTINGS_SCHEMA = z.object({
  v: z.natural().default(1).description('Record version, so a later migration can recognise an older document.'),
  initialized: z
    .boolean()
    .default(false)
    .description('Whether the user has made an explicit choice; distinguishes "no record yet" from "everything off".'),
  enabled: z
    .array(z.string())
    .default([])
    .description('Ids of every UI project the user wants ON — the complete set, not a list of overrides.'),
  settings: z.dict(z.any()).default({}).description('Per-project options, keyed by project id.'),
  touched: z.boolean().default(false).description('Whether the user has changed anything yet.'),
})

/**
 * The shipped skin's project id.
 *
 * The host half needs exactly one id, and only for the first paint: a project registers its own
 * id in the browser, and everything else here is generic. This is the one place the two halves
 * name a project, so it is named once.
 */
const SHIPPED_SKIN_ID = 'liquid-glass'

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
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {string[]}
 */
function readEnabledIds(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.get !== 'function') return []
  const section = settings.get(UI_PROJECTS_SETTINGS_NAMESPACE)
  if (section === null || typeof section !== 'object') return []
  return Array.isArray(section.enabled) ? section.enabled : []
}

/**
 * The first-paint row that marks the document, as an injection row.
 *
 * `placement: 'body'` is required rather than stylistic: the marker lives on `<body>`, and body
 * rows are rendered immediately after the opening body tag — before the application is mounted
 * and before the first paint. The same placement ui-theme uses for its own bootstrap, for the
 * same reason.
 * @param {string} projectId
 * @returns {import('@deepseek-ai/dsh-host-webserver').IndexInjection}
 */
function bootMarkerRow(projectId) {
  return {
    kind: 'script',
    placement: 'body',
    text: `(() => {
  document.body.setAttribute(${JSON.stringify(`data-ui-project-${projectId}`)}, 'on')
  document.documentElement.setAttribute('data-ui-skin', ${JSON.stringify(projectId)})
})()`,
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.logger?.info?.(
    `[dsh-ui-projects] host row mounted; the UI project registry and its settings page are served to the web client as "${CLIENT_MODULE_ID}"`,
  )

  // `settings` is an OPTIONAL dependency, reached through `ctx.inject` rather
  // than declared in `inject` on the plugin object. Declaring it would hold this
  // row in `waiting` forever in a composition that never provides it, and the
  // browser half already handles absence by falling back to localStorage.
  // `ctx.inject` resolves the dependency whenever it does appear.
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      // The provider registers this under its own `ctx.effect`, so unloading the
      // row unregisters the namespace; there is no disposer to keep here.
      settingsCtx.settings.register(UI_PROJECTS_SETTINGS_NAMESPACE, UI_PROJECTS_SETTINGS_SCHEMA, {
        applies: 'live',
      })
    } catch (err) {
      // Reported, never rethrown. A namespace that cannot be registered costs the
      // user durable state — the browser half degrades to localStorage — and that
      // is a far smaller failure than taking the whole client half down with it.
      ctx.logger?.warn?.(
        `[dsh-ui-projects] could not register the "${UI_PROJECTS_SETTINGS_NAMESPACE}" settings namespace (${String(err)}); UI project state will use localStorage`,
      )
    }
  })

  /*
   * First paint — see reason 4 in the file header.
   *
   * The stylesheet goes in unconditionally. Every selector in it carries the project marker, so
   * with the skin off the whole sheet is inert; pushing it always means the host needs no branch
   * here, and there is one less way for "the skin is off" to go wrong.
   *
   * The marker is written only when the document says the skin is on, by a script that runs while
   * the parser is still opening `<body>`. It fails soft by construction: if the settings document
   * cannot be read, no script is emitted, no marker is set, and the page paints the default look.
   */
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'style', text: BOOT_CSS })
    if (readEnabledIds(ctx).includes(SHIPPED_SKIN_ID)) table.push(bootMarkerRow(SHIPPED_SKIN_ID))
  })
}

/** Cordis row metadata. */
export const name = 'ui-projects'
