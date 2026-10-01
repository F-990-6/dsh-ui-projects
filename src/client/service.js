/**
 * dsh-ui-projects — client-plane service: `uiProjects`.
 *
 * This is the one way a UI project package registers itself. The registry below it is unchanged
 * from phase 1 (id-keyed, 1:N, per-project state); what is new here is everything a registry of
 * *one* package never needed:
 *
 *   WHO registered it — `source`, stamped from the manifest, so a project can be traced to the
 *   package that owns it and an uninstall knows what it is removing.
 *
 *   HOW LONG it lives — bound to the CALLER's fiber, so unloading a package withdraws its
 *   projects automatically. Cordis makes this exact thing available: a service method runs with
 *   the consumer's context (`@deepseek-ai/cordis/src/reflect.ts` — the traceable wrapper returns
 *   the caller's ctx for the `ctx` property), and `ctx.effect` disposers run when that fiber
 *   unloads (`fiber.ts` — `_unload()` clears and runs every collected disposable, on normal
 *   unload, on dependency loss, and after a failed `apply` alike).
 *
 *   WHAT THE CALLER MUST PROVE — an explicit manifest. Caller identity stops at the fiber: it
 *   carries a display name (`Fiber.name`, inherited, possibly `'root'`) and no package identity
 *   or version at all, so it is used for lifetime and as a diagnostic, never as the authority.
 *
 * The state a project's OWNER may want does not live here: `enabled`, its settings record and
 * its verification checklist are the user's, keyed by project id, and survive the package being
 * uninstalled so that reinstalling restores them.
 */

/** Same shape `registry.js` enforces. Kept as a local copy: this module must not assume order. */
const ID_PATTERN = /^[a-z][a-z0-9-]{1,47}$/

/**
 * Fields that describe the CONTRACT rather than the project, and therefore must not be merged
 * into the project definition the registry sees.
 */
const CONTRACT_FIELDS = ['schemaVersion', 'pluginApiVersion', 'package']

/**
 * The plugin API versions this CLIENT can host.
 *
 * A MIRROR, like the channel list (`channels.js`) and the three route paths (`installed.js`): the two
 * halves are separate bundles and cannot import one another, so the host's `SUPPORTED_PLUGIN_API`
 * (`src/host/manifest-schema.js:30`) is copied here — and the suite holds the two copies equal, which is
 * what makes a rename or a bump impossible to do on one side only.
 *
 * Locally: `[1]`, the same single version the host reads.
 */
export const SUPPORTED_PLUGIN_API = [1]

/**
 * Turn one manifest into the project fields it defines.
 *
 * The manifest is the single source for everything except behaviour: `definition` carries
 * `apply` / `cleanup` and nothing else. That split is why there is no "does the definition match
 * the manifest" check anywhere — there is nothing to compare, because nothing is written twice.
 * @param {Record<string, any>} manifest
 */
function projectFields(manifest) {
  /** @type {Record<string, any>} */
  const fields = {}
  for (const [key, value] of Object.entries(manifest)) {
    if (CONTRACT_FIELDS.includes(key)) continue
    if (key === 'version') continue
    fields[key] = value
  }
  // The version comes from the package itself (`package.json`), not from the project's own
  // numbering: it is what the checklist record is stamped with, and a stamp that could disagree
  // with the installed package would make a stale checklist unreadable.
  fields.version = manifest.version
  return fields
}

/**
 * @param {object} deps
 * @param {{ register: (definition: any) => any, ids: () => string[] }} deps.registry the live registry
 * @param {() => string[]} deps.enabledIds the ids the user has on, from the same record the host reads
 * @param {readonly string[] | null} deps.hostRowsAtBoot the host's announcement, frozen at apply
 * @param {(id: string) => Promise<void>} [deps.retire] deactivate one project without touching the
 *   user's record — the runtime's `retire`
 * @param {(id: string) => Promise<void>} [deps.adopt] apply a project that registered after the
 *   record was restored — the runtime's `adopt`
 * @param {() => boolean} deps.bootFragmentPresent per-project first-paint fragment probe
 * @param {() => boolean} deps.bodyMarkerPresent per-project marker probe
 * @param {() => void} deps.notify asked to re-render the panel after a registration change
 */
export function createUiProjectsService(deps) {
  /** Every project registered through this service, by id. */
  const owned = new Map()
  /** Registrations that were refused, newest last. Plain data: the panel renders it. */
  const refusals = []
  /** Bumped on every change the panel cannot observe through the registry alone. */
  let revision = 0

  /**
   * Register one UI project on behalf of the calling plugin.
   *
   * THE ORDER OF THE FOUR STEPS IS THE CONTRACT, and it is the only order that leaves no
   * half-state behind:
   *
   *   1. validate            — a bad manifest registers nothing
   *   2. refuse conflicts    — an id owned by another package registers nothing
   *   3. bind the lifetime   — `caller.effect` THROWS `INACTIVE_EFFECT` if the caller's fiber is
   *                            already disposed or unloading; at this point the table is still
   *                            empty, which is exactly right
   *   4. register            — and roll the lifetime binding back if this throws
   *
   * Doing 4 before 3 would leave a project in the registry with nothing that can ever remove it.
   * @param {Record<string, any>} manifest
   * @param {{ apply?: Function, cleanup?: Function }} definition behaviour only
   */
  function register(manifest, definition) {
    let source
    try {
      source = validate(manifest)
    } catch (error) {
      /*
       * A REFUSAL THE PANEL CAN SEE.
       *
       * `refusals` is documented as "registrations that were refused … plain data: the panel renders it"
       * (the declaration above), and a manifest refused for its declared API version IS a refused
       * registration — but until now only the CONFLICT branch recorded one, so that refusal was invisible
       * to the very panel that has to explain it. Measured 2026-09-30: the R-E2 test could see the throw
       * and not the record.
       *
       * The THROW is unchanged, and so is every key a reader already depends on: `id`, `attempted` and
       * `message` are what the conflict entry carries, minus `heldBy`, which only a conflict can have.
       */
      refusals.push({
        id: typeof manifest?.id === 'string' ? manifest.id : null,
        attempted: { package: manifest?.package ?? null, version: manifest?.version ?? null },
        message: String(error?.message ?? error),
      })
      throw error
    }
    const caller = this?.ctx
    if (caller === undefined || typeof caller.effect !== 'function') {
      // Called off a context — `const { register } = ctx.uiProjects` on a plain object, or a
      // service reached without the traceable wrapper. Without the caller's context there is no
      // lifetime to bind to, and registering anyway would create an entry nothing can remove.
      throw new TypeError(
        'uiProjects.register() must be called as ctx.uiProjects.register(...): the calling ' +
          'context is what the registration is bound to, and it is unavailable here',
      )
    }

    const owner = owned.get(manifest.id)
    if (owner !== undefined && owner.source.package !== source.package) {
      const message =
        `ui project id "${manifest.id}" is already registered by package ` +
        `"${owner.source.package}"@${owner.source.version} (fiber <${owner.source.registeredBy}>); ` +
        `refusing to replace it with "${source.package}"@${source.version} (fiber <${source.registeredBy}>)`
      refusals.push({ id: manifest.id, heldBy: owner.source, attempted: source, message })
      throw new TypeError(message)
    }

    // Bound BEFORE the registry sees anything, so an unload racing this call can never leave an
    // orphan behind. The label is what makes the binding identifiable in `fiber.getEffects()`.
    const unbind = caller.effect(() => () => withdraw(manifest.id), `uiProjects.register(${manifest.id})`)

    try {
      const committed = { ...projectFields(manifest), ...definition, source }
      /*
       * The disposer is KEPT, and that is the whole of the first fix. `registry.register` has
       * always returned one — identity-guarded, so a stale copy cannot remove a newer registration
       * — and this call used to throw it away and "withdraw" by re-registering an empty definition
       * with `type: 'retired'`. That type is not in the registry's vocabulary, so the call threw
       * inside a Cordis disposer, where `_unload` isolates it into a log line: retirement failed
       * silently and the project stayed registered and rendered. See the CHANGELOG for all three
       * bugs that one line hid.
       */
      const off = deps.registry.register(committed)
      owned.set(manifest.id, { committed, source, off })
      revision += 1
      deps.notify()
      /*
       * A project that registers AFTER the runtime restored the record is one the restore never
       * saw, and with projects arriving from separate packages that is the normal case rather than
       * an edge. Not awaited — `register` is synchronous by contract and the runtime serializes
       * its own work — but not silent either: a failure lands on the project's card, because the
       * user's next question would be "I had it on, why is it off?".
       */
      Promise.resolve(deps.adopt?.(manifest.id)).catch((error) => {
        deps.registry.markError(manifest.id, error)
      })
      return { id: manifest.id }
    } catch (error) {
      unbind()
      throw error
    }
  }

  /**
   * Drop one registration, in the order the two halves require.
   *
   * RETIRE FIRST, THEN UNREGISTER. The definition must still be in the registry while the runtime
   * tears the project down: `#release` reads it to obtain `cleanup`, and a project that owned a
   * `<style>` element or an observer would otherwise leak exactly what this call exists to remove.
   * Only then does the registry entry go.
   *
   * The user's record is touched by neither half: `retire` deactivates with `persist: false`, and
   * the registry never writes `enabled` at all. BOTH things the record holds for this id stay — the
   * id in `enabled`, and its entry in `settings` (a recorded verification, a control's value). They
   * are the user's data, not the package's cache: a package going away removes what the package owns
   * — its registration, its stylesheets, its markers, its CSS variables — and nothing else.
   * Reinstalling then restores the configuration the user had, which is the whole reason the two are
   * treated the same way here.
   *
   * (The specification originally said to clear `settings[id]` at this point. That predates the
   * checklist: the entry held nothing but a package's cached state then, and it holds user data now.)
   *
   * A package-owned `localStorage` key would be cleaned up here as well. There is none to clean: the
   * framework writes one record key plus a debug flag, and a project gets no key of its own — the
   * suite asserts that inventory, so a future key convention arrives with a failing test rather than
   * with a leak.
   * @param {string} id
   */
  async function withdraw(id) {
    const entry = owned.get(id)
    if (entry === undefined) return
    owned.delete(id)
    try {
      await deps.retire?.(id)
    } catch (error) {
      // Loud, then carry on: the definition still has to leave the table, or the panel keeps a card
      // for a package that is gone. A failed retirement leaves stylesheets behind, which is bad — a
      // phantom card is worse, because it is the thing the user sees and cannot explain.
      console.error(`[dsh-ui-projects] retiring "${id}" failed; its definition is being removed anyway`, error)
    }
    entry.off()
    revision += 1
    deps.notify()
  }

  /**
   * Normalize and check one manifest.
   *
   * Deliberately shallow in this build: the full schema check (unknown fields, `pluginApiVersion`
   * negotiation, the four package-level conformance refusals) is the loader's job and lands with
   * it. What is checked here is what a registration cannot proceed without.
   * @param {Record<string, any>} manifest
   * @returns {{ package: string, version: string, registeredBy: string }}
   */
  function validate(manifest) {
    if (manifest === null || typeof manifest !== 'object') {
      throw new TypeError('uiProjects.register() needs a manifest object as its first argument')
    }
    if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
      throw new TypeError(`ui project id ${JSON.stringify(manifest.id)} does not match ${ID_PATTERN}`)
    }
    if (typeof manifest.package !== 'string' || manifest.package.length === 0) {
      throw new TypeError(`ui project "${manifest.id}" has no manifest.package; every project is owned by a package`)
    }
    if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
      throw new TypeError(`ui project "${manifest.id}" has no manifest.version`)
    }
    /*
     * A DECLARED API VERSION THIS BUILD CANNOT RUN IS REFUSED HERE, so the project is never enableable —
     * the first case of the compatibility matrix (`UI第三阶段.txt:29-31`).
     *
     * A MISSING FIELD IS ALLOWED, BY DECISION: the host enforces `pluginApiVersion` as required
     * (`src/host/manifest-schema.js:62`), and this client refuses only a DECLARED value it cannot run, so a
     * package written before the field existed keeps working instead of turning unenableable overnight.
     * Measured 2026-09-30: the desktop shell has no `pluginApiVersion` concept of its own (an asar scan
     * found zero occurrences), so nothing upstream of this service protects the page either.
     */
    if (manifest.pluginApiVersion !== undefined && !SUPPORTED_PLUGIN_API.includes(manifest.pluginApiVersion)) {
      throw new TypeError(
        `[dsh-ui-projects] UI project "${manifest.id}" declares pluginApiVersion ${JSON.stringify(manifest.pluginApiVersion)}; this build hosts ${SUPPORTED_PLUGIN_API.join(', ')}`,
      )
    }
    if (manifest.package === undefined) throw new TypeError('unreachable')
    return { package: manifest.package, version: manifest.version, registeredBy: currentFiberName(this?.ctx) }
  }

  return {
    /*
     * WHY THIS OBJECT DECLARES A CORDIS TRACKER.
     *
     * The registration's lifetime is bound to its CALLER's fiber, so `register` has to be able to
     * name that caller — and a service only sees it if the service says it is traceable. Cordis
     * wraps a value for the caller's context in `getTraceable` (utils.ts) only when the value
     * carries `Symbol.for('cordis.tracker')`; without it the value is returned untouched and
     * `this.ctx` is undefined. Its own services declare exactly the shape below
     * (`Service` in service.ts, `ReflectService` in reflect.ts), and the symbol is registered
     * globally — `Symbol.for`, not a module-private `Symbol()` — precisely so that code which
     * cannot import Cordis, like this browser bundle, can still take part.
     *
     * `noShadow: true` matches Cordis's own reflect service: the caller's context is used as it
     * is, rather than being read through a shadow.
     *
     * The failure mode is loud rather than silent: `register` throws a TypeError naming the
     * misuse if `this.ctx` is missing, and `scripts/load-check.mjs` proves the marking works
     * against the real framework, including the disposal path it exists for.
     */
    [Symbol.for('cordis.tracker')]: { property: 'ctx', noShadow: true },
    register,

    /**
     * Every project registered through this service, as plain data.
     *
     * Built from this service's own table rather than from the registry, because the registry
     * knows nothing about ownership — and ownership is what an uninstall needs.
     */
    list() {
      return [...owned.values()].map(({ committed, source }) => ({
        id: committed.id,
        name: committed.name ?? committed.id,
        version: committed.version,
        type: committed.type,
        source: { ...source },
      }))
    },

    /** Registrations refused, most recent last. */
    refusals() {
      return refusals.map((entry) => ({ ...entry }))
    },

    /** Monotonic counter, bumped whenever `list()` or `refusals()` would answer differently. */
    revision() {
      return revision
    },

    /**
     * The three states a project can be in, computed fresh.
     *
     * Nothing here is persisted, and that is the point: "the host half did not mount on this page
     * load" is a fact about one rendered document, so a stored copy of it would be a claim about
     * a page that no longer exists. `hostRowsAtBoot` is the frozen per-load snapshot (see
     * `boot-presence.js`); everything else is a live query, which is cheap enough to redo on
     * every panel render.
     *
     * The states:
     *   `ok`                 registered, enabled, and this page's first frame had it
     *   `no-boot-injection`  registered and enabled, but no host half announced it this load —
     *                        the project works and flashes once
     *   `orphan-enabled`     the document says it is on and nothing registered it — the package's
     *                        client half is missing, or its package is gone
     *   `off`                the ordinary state: not enabled
     */
    diagnostics() {
      const rows = deps.hostRowsAtBoot
      const enabled = deps.enabledIds()
      const registered = new Set(owned.keys())
      const ids = [...new Set([...registered, ...enabled])].sort()
      return {
        hostPlane: rows === null ? 'absent' : 'present',
        hostRows: rows === null ? [] : [...rows],
        projects: ids.map((id) => {
          const isEnabled = enabled.includes(id)
          const isRegistered = registered.has(id)
          return {
            id,
            registered: isRegistered,
            enabled: isEnabled,
            announcedByHost: rows !== null && rows.includes(id),
            bootFragment: deps.bootFragmentPresent(id),
            marker: deps.bodyMarkerPresent(id),
            state: !isEnabled ? 'off' : !isRegistered ? 'orphan-enabled' : !(rows !== null && rows.includes(id)) ? 'no-boot-injection' : 'ok',
          }
        }),
      }
    },
  }
}

/**
 * The display name of the fiber behind a context, for diagnostics only.
 *
 * `Fiber.name` is inherited from the nearest named ancestor and falls back to `'root'`, so it
 * identifies a plugin in a log line and nothing more. Ownership is decided by `manifest.package`
 * — a name that the installer checked against the tarball's own `package.json`.
 * @param {any} ctx
 */
function currentFiberName(ctx) {
  const name = ctx?.fiber?.name
  return typeof name === 'string' && name.length > 0 ? name : 'root'
}
