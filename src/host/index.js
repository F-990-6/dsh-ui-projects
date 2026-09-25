/**
 * dsh-ui-projects — host half.
 *
 * The UI project system lives in the browser: the registry, the runtime and the
 * Settings › UI section are all client-side, so this row exists for these reasons
 * only:
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
 *
 * It deliberately touches nothing else: no Service of its own, no Event, no
 * route, no business state. The client half is where the product lives.
 */

import z from '@deepseek-ai/schemastery'

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
}

/** Cordis row metadata. */
export const name = 'ui-projects'
