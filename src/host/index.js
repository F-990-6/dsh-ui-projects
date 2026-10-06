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
import { createUpdateChecker, DEFAULT_CHANNEL } from './update-check.js'
import { UI_PROJECTS_SETTINGS_NAMESPACE, createHostService } from './service.js'
import { BOOT_CSS } from './boot-css.js'

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

/*
 * THE PLUGIN API VERSION AND WHERE IT COMES FROM (step 3). `plugin-api.js` owns the supported majors, the
 * deprecation schedule and the judgement; `own-version.js` reads THIS package's version once, because the
 * schedule's dates are framework-package releases rather than the dsh runtime's.
 *
 * Declared here rather than at the top of the file only because this is where the changes landed; ESM
 * hoists imports, so the placement has no effect beyond readability.
 */
import { createPluginApiService } from './plugin-api.js'
import { readOwnVersion } from './own-version.js'

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
  /*
   * THE PLUGIN API VERSION, AS A SERVICE (step 3). Both halves register the same name so a plugin asks ONE
   * question — `ctx.get('dshPluginApiVersion').judge(declared)` — and gets `ok` / `deprecated` /
   * `unsupported`, whichever half it lives in. Provided before anything that could fail, like the registry
   * below it: a service that appears late is a service a plugin has already given up on.
   */
  ctx.provide('dshPluginApiVersion', createPluginApiService(readOwnVersion()))
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
  /*
   * HOW LONG THIS ROW WAITS, AND WHAT IT SAYS WHILE IT WAITS.
   *
   * The notice is a SAMPLE, not a verdict, and it used to read like one: "the connection service has
   * not appeared … the endpoint is not mounted". Both halves of that are false a moment later in the
   * composition this normally runs in — the connection row's own `apply` is async and lives in an
   * earlier layer, so the service arrives AFTER this row's `apply` returns, and a real dsh web that
   * printed this line went on to list three packages, which needs a successful authenticated request
   * through that very service. The line is a state now — still waiting, N seconds in — which stays true
   * whether the service is late or absent, plus a sentence naming the symptom the user will see.
   *
   * AND IT GETS AN ENDING. When the service arrives after the notice fired, one more line says so. A log
   * cannot unsay the first line, so the honest form of "retract" is to finish the pair: either nothing at
   * all (a fast arrival), or waiting → arrived. That is also why both lines use the same channel —
   * `console.error`, for the reason below — rather than one of them going to `ctx.logger`, which a
   * composition without a logger exporter swallows.
   */
  const CONNECTION_WAIT_NOTICE_MS = 5000
  const startedAt = Date.now()
  let endpointMounted = false
  let noticeFired = false
  ctx.effect(() => {
    /*
     * If the service never arrives, say so once — as a wait. Not through `ctx.logger`: a composition
     * without a logger exporter leaves it undefined and the optional chaining would swallow the line,
     * which is how this round's silence started. `console.error` reaches stderr in the host process, and
     * a wait that never ends must not be invisible.
     */
    const notice = setTimeout(() => {
      if (endpointMounted) return
      noticeFired = true
      console.error(
        `[dsh-ui-projects] still waiting for the connection service after ${Math.round(CONNECTION_WAIT_NOTICE_MS / 1000)}s: the installed-package endpoint mounts when it arrives, and Settings › UI says it cannot read the listing until then`,
      )
    }, CONNECTION_WAIT_NOTICE_MS)
    return () => clearTimeout(notice)
  }, 'ui-projects: connection wait notice')

  /*
   * THE UPDATE CHECK (phase 3, step 1): which channel each package is on, read out of the same settings
   * document this row registered a namespace for.
   *
   * Read ON DEMAND, per request rather than cached at mount, because the settings document is the user's
   * data: a channel changed a second ago must be the one the next check compares against. A composition
   * with no settings service has no channels, which reads as the default for every package — the check
   * still runs, it just has nothing to prefer.
   */
  const readChannels = (packageName) => {
    try {
      const section = ctx.get('settings')?.get?.(UI_PROJECTS_SETTINGS_NAMESPACE)
      const entry = section?.settings?.[packageName]
      return typeof entry?.channel === 'string' ? entry.channel : DEFAULT_CHANNEL
    } catch {
      return DEFAULT_CHANNEL
    }
  }
  /*
   * ONE CHECKER for the row's lifetime, and constructing it touches nothing: no socket is opened and no
   * request is made until the updates route is asked for, which is what makes "the first frame does no
   * network I/O" a property of the wiring rather than a promise. Its failures go to the host log exactly
   * once each — the "silent but recorded" the spec asks for.
   *
   * `fetchDistTags` is deliberately NOT named here. The registry implementation lives in
   * `update-check.js`, so this file cannot reach a registry even by mistake, and the first-paint path is
   * a file that does not know how.
   */
  const updateChecker = createUpdateChecker({ log: (line) => console.error(line) })

  ctx.inject(['connection'], (connectionCtx) => {
    // The registration is scoped to the CALLER's fiber, so it is withdrawn when this row unloads; the
    // returned disposer is handed back as well, because belt and braces costs nothing here.
    let dispose
    try {
      dispose = registerInstalledEndpoint(connectionCtx, { scan, channels: readChannels, check: updateChecker.check })
    } catch (error) {
      /*
       * ARRIVED, BUT COULD NOT MOUNT — and this used to be the one outcome the row said nothing about:
       * the flag was set before the call, so a throw suppressed the notice AND left it claiming a mount
       * that never happened. The failure is named here and rethrown, so Cordis still handles it exactly
       * as before; what changes is that this row's own pair of facts gets its ending either way.
       */
      console.error(
        `[dsh-ui-projects] the connection service arrived but the installed-package endpoint could not be mounted (${String(error)}); Settings › UI will say it cannot read the listing`,
      )
      throw error
    }
    // AFTER the call, not before: a `register` that throws must not leave a flag claiming a mount.
    // If this ever becomes async, this assignment must move after the `await` for the same reason.
    endpointMounted = true
    if (noticeFired) {
      console.error(
        `[dsh-ui-projects] the connection service arrived after ${((Date.now() - startedAt) / 1000).toFixed(1)}s; the installed-package endpoint is mounted`,
      )
    }
    return dispose
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
   * THE BUILT-IN'S ROWS GO IN HERE, and this is the half that makes the first frame show the skin a reader
   * left on. This half used to push nothing, deliberately, while every project belonged to a package.
   *
   * THE PUSH IS UNCONDITIONAL, which is not a shortcut: `bootRows` owns the judgement — it reads the
   * settings document at emit time and returns nothing for a project that is off — and every rule in the
   * payload is gated by the project's marker, so a reader who has Glass off receives an inert string rather
   * than a branch this file would have to get right.
   *
   * `BUILT_IN_PROJECT_ID` IS A MIRROR, like `SUPPORTED_PLUGIN_API` and the channel list: the two halves are
   * separate bundles and cannot import one another, so `src/client/skins/glass/manifest.js` is the authority
   * and `scripts/check-builtin.test.mjs` holds this copy equal to it. Without that, an id change reaching one
   * side only would leave the host half announcing a project the client half never registers — and the
   * symptom would be a first frame that paints nothing, which looks like a caching problem.
   */
  const BUILT_IN_PROJECT_ID = 'glass'
  ctx.on('webserver/index-inject', (table) => {
    table.push(...ctx.uiProjectsHost.bootRows(BUILT_IN_PROJECT_ID, BOOT_CSS))
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
