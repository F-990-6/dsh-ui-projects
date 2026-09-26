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
    const source = validate(manifest)
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
      owned.set(manifest.id, { committed, source })
      deps.registry.register(committed)
      revision += 1
      deps.notify()
      return { id: manifest.id }
    } catch (error) {
      unbind()
      throw error
    }
  }

  /** Drop one registration. Called by the lifetime binding, and never directly. */
  function withdraw(id) {
    if (!owned.delete(id)) return
    revision += 1
    // The registry has no `unregister` in phase 1 — a project is defined by its presence in a
    // map that the runtime walks. Withdrawing therefore means re-registering a definition that
    // declares nothing to apply; the id disappears from the panel because `list()` is built from
    // `owned`, while the user's own records for it are left untouched on purpose.
    deps.registry.register({ id, name: id, type: 'retired', scope: 'global', apply() {}, cleanup() {} })
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
