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
 * The project that used to ship inside this package reaches that same service from its own package
 * now. This file keeps reasons 1–4 and names no project id at all: the extraction is what makes the
 * framework skin-agnostic, and a framework that still named one project would be a framework that
 * had one.
 */

import z from '@deepseek-ai/schemastery'

import { join } from 'node:path'
import { homedir } from 'node:os'

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
  /** @type {() => Promise<any>} */
  const scan = async () => {
    const { discoverProfiles, scanProfile } = await import('./profile-scan.js')
    const dshHome = resolveDshHome(ctx)
    const names = await discoverProfiles({ dshHome })
    const name = names.includes('web') ? 'web' : names[0]
    if (name === undefined) throw new Error(`no dsh profile under ${join(dshHome, 'profiles')}`)
    return scanProfile({ profileDir: join(dshHome, 'profiles', name) })
  }

  /*
   * THE ENDPOINT WAITS FOR THE CONNECTION SERVICE. It used to read it once, synchronously, inside an
   * effect that runs during apply — and a probe printed exactly what that costs:
   *
   *     [dsh-ui-projects] apply entered
   *     [dsh-ui-projects] effect ran; connection=undefined
   *
   * The service belongs to a row in an earlier LAYER, and a layer being inserted is not the same as
   * its row having finished activating — the connection host half's own `apply` is async. So the
   * registration is parked until the service exists, which is the difference between registering and
   * hoping. This is the host-side form of the timing dependency `src/client/index.js` documents for
   * `settingsScope`, where reading the service optimistically found nothing and fell back silently.
   *
   * NOT a top-level `inject: ['connection']` on the row, and the asymmetry with the client fix is the
   * point: that plugin's two jobs both need their services, so it declares both; this row's first job
   * (the settings namespace) needs nothing, and parking the whole row would cost a composition with no
   * connection service — Electron serves the client over `file://`, a headless profile has no browser
   * at all — the namespace it can provider perfectly well. Phase 1 keeps running; only phase 2 waits.
   */
  let endpointMounted = false
  ctx.effect(() => {
    /*
     * If the service never arrives, say so once. Not through `ctx.logger`: a composition without a
     * logger exporter leaves it undefined and the optional chaining would swallow the line, which is
     * how this round's silence started. `console.error` reaches stderr in the host process, and a
     * wait that never ends must not be invisible.
     */
    const notice = setTimeout(() => {
      if (endpointMounted) return
      console.error(
        '[dsh-ui-projects] the connection service has not appeared, so the installed-package endpoint is not mounted; Settings › UI plugins will report that it cannot read the listing',
      )
    }, 5000)
    return () => clearTimeout(notice)
  }, 'ui-projects: connection wait notice')

  ctx.inject(['connection'], (connectionCtx) => {
    endpointMounted = true
    // The registration is scoped to the CALLER's fiber, so it is withdrawn when this row unloads; the
    // returned disposer is handed back as well, because belt and braces costs nothing here.
    return registerInstalledEndpoint(connectionCtx, { scan })
  })

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
   * This half used to be the service's first client: it pushed its own shipped skin's rows into
   * `webserver/index-inject` to prove the contract was writable from outside `service.js`. It now
   * pushes nothing, and deliberately has no `index-inject` subscription at all — a listener whose
   * only statement would be `table.push(...[])` is a line that claims a job it does not do. The
   * rows belong to whichever package owns the stylesheet, and the contract stays tested from both
   * sides: `scripts/host-check.mjs` drives `uiProjectsHost.bootRows` over a fixture sheet with this
   * package's own host half mounted, and `load-check.mjs` mounts a REAL package's rows.
   */
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
