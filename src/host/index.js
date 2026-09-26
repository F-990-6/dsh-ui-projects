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
 *  4. **The first-paint contract.** It provides `uiProjectsHost`, the service every
 *     UI project package asks for its `webserver/index-inject` rows. The contract
 *     itself — the marker attribute, the presence announcement, the fragment tag,
 *     and "read the settings document at emit time" — lives in `./service.js`, so
 *     it is written once for every package rather than once per package.
 *
 * The project shipped inside this package uses that same service rather than a private copy of
 * the contract. When it moves out to its own package (the extraction that makes this framework
 * skin-agnostic), this file keeps reasons 1–4 and loses every mention of a project id.
 */

import z from '@deepseek-ai/schemastery'

import { join } from 'node:path'
import { homedir } from 'node:os'

import { BOOT_CSS } from './boot-css.js'
import { registerInstalledEndpoint } from './installed-endpoint.js'
import { UI_PROJECTS_SETTINGS_NAMESPACE, createHostService } from './service.js'

export { UI_PROJECTS_SETTINGS_NAMESPACE }

/** The browser bundle this row makes reachable. */
export const CLIENT_MODULE_ID = 'dsh-ui-projects'

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
 * The project shipped inside this package.
 *
 * The host half needs exactly one id, and only for the first paint: a package's own host half
 * names its own project, and everything else here is generic. This is the one place this package
 * names a project, and it disappears with the project when the skin moves out.
 */
const SHIPPED_SKIN_ID = 'liquid-glass'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.logger?.info?.(
    `[dsh-ui-projects] host row mounted; the UI project registry and its settings page are served to the web client as "${CLIENT_MODULE_ID}"`,
  )

  /*
   * Provided unconditionally, before anything that could fail. Every UI project package's host
   * half declares `inject: ['uiProjectsHost']`, so a service that appeared late — or not at all,
   * because an optional dependency was missing — would park those rows and cost the page its
   * first-paint CSS. `service.js` explains why at length.
   */
  const hostService = createHostService(ctx)
  ctx.provide('uiProjectsHost', hostService)

  /*
   * The installed-package listing, over the Connection service's authenticated channel.
   *
   * WHICH PROFILE. A row knows its composition but not, through any service this package can see,
   * the directory it was composed from — so the endpoint scans what the CLI would scan by default:
   * the profile named "web" if it exists, otherwise the only one. That is a real limitation rather
   * than a hidden one: the payload carries the profile's NAME, and the column shows it, so a
   * deployment with several profiles shows which one is being described instead of guessing
   * silently. A composition with no profiles at all yields an error payload the column renders.
   */
  ctx.effect(() => {
    const scan = async () => {
      const { discoverProfiles, scanProfile } = await import('./profile-scan.js')
      const dshHome = resolveDshHome(ctx)
      const names = await discoverProfiles({ dshHome })
      const name = names.includes('web') ? 'web' : names[0]
      if (name === undefined) throw new Error(`no dsh profile under ${join(dshHome, 'profiles')}`)
      return scanProfile({ profileDir: join(dshHome, 'profiles', name) })
    }
    return registerInstalledEndpoint(ctx, { scan })
  }, 'ui-projects: installed-package endpoint')

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
   * First paint — see reason 4 in the file header, and `service.js` for the contract.
   *
   * This package is its own first client of the service, which is deliberate: it is the same
   * three lines a third-party UI project package writes, so the framework cannot quietly depend
   * on anything a package does not have.
   */
  ctx.on('webserver/index-inject', (table) => {
    table.push(...hostService.bootRows(SHIPPED_SKIN_ID, BOOT_CSS))
  })
}

/**
 * Where dsh keeps its profiles.
 *
 * `dshHomePath` is a service, so it may be a string or a function; anything else falls back to
 * `DSH_HOME` and then to the conventional home directory, which is what the CLI does.
 * @param {{ get: (name: string) => any }} ctx
 * @returns {string}
 */
function resolveDshHome(ctx) {
  const provided = ctx.get('dshHomePath')
  const value = typeof provided === 'function' ? provided() : provided
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

/** Cordis row metadata. */
export const name = 'ui-projects'
