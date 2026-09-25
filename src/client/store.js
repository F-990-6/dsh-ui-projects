/**
 * The settings section's state bridge: one external store over the UI project
 * registry plus the small synchronous action API the panel drives.
 *
 * The store lives at plugin level (created in `apply`), not per component, so
 * subscriptions are owned by the plugin fiber and survive a panel remount.
 */

/**
 * @typedef {object} UiProjectCardModel
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} version
 * @property {'skin'|'enhancement'} type
 * @property {'global'|'layout'|'component'} scope
 * @property {readonly string[]} supports
 * @property {'low'|'medium'|'high'} perfLevel the tier this project was designed for
 * @property {number} priority execution order among composable projects; lower runs first
 * @property {readonly string[]} regions the surfaces this project declares it changes
 * @property {ReadonlyArray<{ id: string, label: string }>} testItems the manual checklist, if any
 * @property {{ version: string, items: Record<string, boolean> } | undefined} checks
 *   the stored confirmation, or undefined when none was ever recorded
 * @property {boolean} checksCurrent whether that confirmation was made against THIS version
 * @property {string | undefined} preview
 * @property {string | undefined} previewLabel
 * @property {boolean} enabled
 * @property {'active'|'inactive'|'error'|'unavailable'} status
 * @property {string | undefined} error
 * @property {boolean} removable
 * @property {UiProjectControl[]} controls live controls, already bound to the project
 */

/**
 * One control the settings card renders, resolved against the live runtime.
 *
 * A project DECLARES the numeric shape (id, type, range) alongside its metadata; the
 * runtime supplies the live `value` and the `onChange` write path, because only the
 * runtime holds the active project's context. That split is what lets a project's
 * controls be declared statically while still reading and writing per-activation state.
 * @typedef {object} UiProjectControl
 * @property {string} id
 * @property {'slider'} type
 * @property {string} labelKey copy key, resolved by the settings page
 * @property {number} min
 * @property {number} max
 * @property {number} step
 * @property {number} value the current value
 * @property {(value: number) => void} onChange
 */

/**
 * @typedef {object} UiProjectsSnapshot
 * @property {UiProjectCardModel[]} projects
 * @property {Array<{ ids: string[], names: string[], regions: string[], nested: boolean }>} regionConflicts
 * @property {string | undefined} outOfOrderId
 * @property {'low'|'medium'|'high'|undefined} perfLevel the tier in force for the page
 * @property {string} locale
 * @property {'settings'|'local'} storageKind
 * @property {number} revision
 * @property {boolean} anyActive
 * @property {number} activeCount
 */

/**
 * Bind a project's declared controls to the live runtime.
 *
 * Only a project that is actually applied has a context to read and write, so an inactive
 * project's controls report their default and do nothing when moved — which is honest:
 * there is no material for them to change. The runtime exposes the active context through
 * `contextFor`, and a project opts in by declaring `controls`.
 * @param {import('./registry.js').UiProjectDefinition} project
 * @param {import('./runtime.js').UiProjectRuntime} runtime
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {UiProjectControl[]}
 */
function resolveControls(project, runtime, ctx) {
  const declared = Array.isArray(project.controls) ? project.controls : []
  if (declared.length === 0) return []
  const context = typeof runtime.contextFor === 'function' ? runtime.contextFor(project.id) : undefined
  return declared.map((control) => {
    // A control carries its own default and storage key, so this function needs no
    // vocabulary of its own: it resolves whatever the project declared.
    const defaultValue = typeof control.defaultValue === 'number' ? control.defaultValue : control.min
    const key = typeof control.storageKey === 'string' ? control.storageKey : control.id
    const read = () => {
      const stored = context?.readSetting?.(key)
      return typeof stored === 'number' ? stored : defaultValue
    }
    return {
      id: control.id,
      type: control.type,
      labelKey: control.labelKey ?? control.id,
      min: control.min,
      max: control.max,
      step: control.step,
      value: read(),
      onChange: (value) => {
        if (context === undefined) return
        // Persist first, then move the material: the stored value is what the next boot
        // reads, and a drag must never leave the two out of step.
        context.writeSetting?.(key, value)
        // A control may declare a value it has to be stored alongside — a scale revision, say,
        // so that a value the user just chose is not later mistaken for a stale one.
        if (control.companion !== undefined) {
          context.writeSetting?.(control.companion.key, control.companion.value)
        }
      },
    }
  })
}

/**
 * The stored verification for one project, normalized.
 *
 * The version travels INSIDE the record rather than beside it, which is a small departure from the
 * obvious two-key shape and buys one thing worth having: the stamp and the ticks it validates are
 * written in a single operation, so there is no window in which a reader sees a new version's stamp
 * over an old version's ticks. There is also only one key to keep in step.
 * @param {import('./registry.js').UiProjectDefinition} project
 * @param {import('./runtime.js').UiProjectRuntime} runtime
 * @returns {{ version: string, items: Record<string, boolean> } | undefined}
 */
function storedChecks(project, runtime) {
  const stored = typeof runtime.settingsFor === 'function' ? runtime.settingsFor(project.id)?.checks : undefined
  if (stored === null || typeof stored !== 'object') return undefined
  const items = stored.items
  if (items === null || typeof items !== 'object') return undefined
  /** @type {Record<string, boolean>} */
  const kept = {}
  for (const item of project.testItems) {
    if (items[item.id] === true) kept[item.id] = true
  }
  return { version: typeof stored.version === 'string' ? stored.version : '', items: kept }
}

/**
 * Whether a confirmation was made against the version now registered.
 *
 * A project that ships a new version has changed the very thing the checklist verified, so an old
 * confirmation is not merely stale — it is a claim about code that no longer exists. It is reported
 * rather than deleted, because "confirmed for 3.0.0, needs re-confirming" is more useful to a
 * reader than an empty checkbox they cannot explain.
 * @param {import('./registry.js').UiProjectDefinition} project
 * @param {import('./runtime.js').UiProjectRuntime} runtime
 * @returns {boolean}
 */
function isChecksCurrent(project, runtime) {
  return storedChecks(project, runtime)?.version === project.version
}

/**
 * @typedef {object} UiProjectsStore
 * @property {() => number} getVersion
 * @property {(listener: () => void) => () => void} subscribe
 * @property {() => UiProjectsSnapshot} snapshot
 * @property {(id: string) => Promise<void>} enable
 * @property {(id: string) => Promise<void>} disable
 * @property {(id: string) => Promise<void>} toggle
 * @property {(id: string) => Promise<void>} resetOne
 * @property {() => Promise<void>} resetAll
 * @property {(id: string, itemIds: string[]) => Promise<void>} confirmChecks
 * @property {import('./persist.js').PersistAdapter['kind']} storageKind
 */

/**
 * @param {object} input
 * @param {import('./runtime.js').UiProjectRuntime} input.runtime
 * @param {() => string} input.locale
 * @param {() => number} [input.revision] extra revision source (locale, for example)
 * @returns {UiProjectsStore}
 */
export function createStore(input) {
  const { runtime, locale, ctx } = input
  const registry = runtime.registry
  const extraRevision = input.revision ?? (() => 0)

  /** @type {(listener: () => void) => () => void} */
  const subscribe = (listener) => registry.subscribe(listener)

  /** @returns {UiProjectsSnapshot} */
  const snapshot = () => ({
    projects: registry.list().map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      version: project.version,
      type: project.type,
      scope: project.scope,
      supports: project.supports,
      perfLevel: project.perfLevel,
      priority: project.priority,
      regions: project.modifies,
      testItems: project.testItems,
      checks: storedChecks(project, runtime),
      checksCurrent: isChecksCurrent(project, runtime),
      preview: project.preview,
      previewLabel: project.previewLabel,
      enabled: registry.isEnabled(project.id),
      status: registry.status(project.id),
      error: registry.error(project.id),
      removable: project.defaultEnabled === true,
      controls: resolveControls(project, runtime, ctx),
    })),
    /*
     * `conflicts` used to sit here — the active skin ids — and nothing ever read it: the panel
     * derives the "will replace X" line from the project list it already has. Deleted rather than
     * kept, because a second, silently unread notion of "conflict" is exactly what makes the real
     * one hard to trust.
     */
    /**
     * Active enhancements that claim the same surface, with names resolved for display.
     *
     * `nested` is the escalated form: a nesting needs a filtered element INSIDE another filtered
     * element, so it takes both projects to install a blur — one alone has nothing to nest in. The
     * flag is computed from the retained CSS rather than declared, because a manifest saying "I may
     * blur" is a promise while the stylesheet is the fact.
     */
    regionConflicts: registry.regionConflicts().map((pair) => ({
      ids: pair.ids,
      names: pair.ids.map((id) => registry.get(id)?.name ?? id),
      regions: pair.regions,
      nested:
        typeof runtime.declaresFilter === 'function' && pair.ids.every((id) => runtime.declaresFilter(id) === true),
    })),
    /**
     * The project whose apply position the next load will change, or undefined when the order in
     * force already matches priority order. Reported rather than acted on: a click does not
     * re-order live projects, so the panel says what will move instead of moving it and flickering.
     */
    outOfOrderId: typeof runtime.outOfOrderId === 'function' ? runtime.outOfOrderId() : undefined,
    /**
     * The tier in force for the whole page — the heaviest active demand, capped by the device.
     *
     * Reported rather than used: the stylesheet reads `data-ui-perf` off the body, so this exists
     * for the panel's own copy and for tests. `undefined` means nothing is applied.
     */
    perfLevel: typeof runtime.perfLevel === 'function' ? runtime.perfLevel() : undefined,
    locale: locale(),
    storageKind: runtime.persist.kind,
    revision: registry.getVersion() + extraRevision(),
    anyActive: registry.activeIds().length > 0,
    activeCount: registry.activeIds().length,
  })

  return {
    getVersion: () => registry.getVersion() + extraRevision(),
    subscribe,
    snapshot,
    enable: (id) => runtime.enable(id),
    disable: (id) => runtime.disable(id),
    toggle: (id) => runtime.toggle(id),
    resetOne: (id) => runtime.resetOne(id),
    resetAll: () => runtime.resetAll(),
    /**
     * Record a verification: these items, for the version currently registered.
     *
     * Written through the project's own context, so it lands in the same per-project settings record
     * every other option uses and needs no new storage. Requires the project to be applied, which is
     * not a limitation but the point — a checklist is confirmed by looking at the running thing.
     * @param {string} id
     * @param {string[]} itemIds
     */
    confirmChecks: async (id, itemIds) => {
      const project = registry.get(id)
      const context = typeof runtime.contextFor === 'function' ? runtime.contextFor(id) : undefined
      if (project === undefined || context === undefined) return
      /** @type {Record<string, boolean>} */
      const items = {}
      for (const itemId of itemIds) {
        if (project.testItems.some((item) => item.id === itemId)) items[itemId] = true
      }
      await context.writeSetting?.('checks', { version: project.version, items })
    },
    storageKind: runtime.persist.kind,
  }
}

/**
 * Read the active locale id (`zh`, `en`, …) without depending on a service that a
 * minimal composition may not mount.
 *
 * The field is `active`: the locale snapshot is `{ active, locales, revision }`.
 * An earlier version read `locale`/`id`/`current`, found none of them and silently
 * fell back to English, so the whole section stayed untranslated in a Chinese
 * client. Reading the real field is the fix.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {string}
 */
export function detectLocale(ctx) {
  const service = ctx.get('locale')
  if (service === undefined) return 'en'
  try {
    const snapshot = typeof service.getSnapshot === 'function' ? service.getSnapshot() : service.getLocale?.()
    if (typeof snapshot === 'string' && snapshot.length > 0) return snapshot
    const id = snapshot?.active ?? snapshot?.locale ?? snapshot?.id
    if (typeof id === 'string' && id.length > 0) return id
  } catch {
    /* a locale service that cannot answer is not an error */
  }
  return 'en'
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {() => void} listener
 * @returns {() => void} disposer
 */
export function onLocaleChange(ctx, listener) {
  try {
    return ctx.on('locale/change', listener)
  } catch {
    return () => {}
  }
}
