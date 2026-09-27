/**
 * Settings › UI section — the settings page for the UI project system.
 *
 * This component renders whatever the registry contains. It has no knowledge of
 * any individual project: no id, name, or option is hard-coded here, so a second,
 * third, or tenth UI project appears automatically as soon as it is registered.
 *
 * Written with `React.createElement` rather than JSX on purpose: the client half
 * is delivered to the browser as a plain bundle and is never passed through a JSX
 * transform.
 */

const React = require('react')
const { rankOf } = require('./project-constants.js')

/**
 * @param {object} props
 * @param {import('./store.js').UiProjectsStore} props.store
 * @param {ReturnType<import('./locale.js').strings>} props.t
 * @param {import('./store.js').UiProjectsSnapshot} [props.snapshot]
 *   A ready snapshot to render. Production passes none and the component
 *   subscribes to the store; a caller that already holds a snapshot (a preview, a
 *   server render) passes one and no subscription is created.
 * @returns {any}
 */
function UiProjectsSection(props) {
  const { store, t } = props
  const React_ = React
  if (typeof React_?.useState !== 'function') {
    // A clear diagnosis beats "cannot read properties of null": this component is
    // only ever reached through the module table, so a missing `react` binding is
    // a bundling fault rather than a render fault.
    throw new Error(
      `[dsh-ui-projects] Settings › UI needs the shell's React runtime, but resolved ${
        React_ === null ? 'null' : typeof React_
      }`,
    )
  }
  // A caller that already holds a snapshot (a preview, a server render) seeds the
  // state instead of subscribing, so rendering never depends on live hooks.
  const [live, setLive] = React_.useState(() => props.snapshot ?? store.snapshot())
  React_.useEffect(() => {
    if (props.snapshot !== undefined) return undefined
    setLive(store.snapshot())
    return store.subscribe(() => setLive(store.snapshot()))
  }, [store, props.snapshot])
  const snapshot = props.snapshot ?? live
  /** @type {[Record<string, boolean>, any]} */
  const [pending, setPending] = React_.useState({})
  const [failure, setFailure] = React_.useState(undefined)

  /** @param {string} id @param {Promise<void>} task */
  const run = (id, task) => {
    setPending((current) => ({ ...current, [id]: true }))
    setFailure(undefined)
    Promise.resolve(task)
      .catch((err) => {
        console.error('[dsh-ui-projects] UI project action failed', err)
        setFailure(err instanceof Error ? err.message : String(err))
      })
      .then(() => {
        setPending((current) => {
          const next = { ...current }
          delete next[id]
          return next
        })
      })
  }

  /*
   * Snapshot information for the maintenance block, read SYNCHRONOUSLY.
   *
   * `props.installed` is the plugins column's store, passed in optionally. This panel never awaits it,
   * never asks it for anything and never depends on it: when it is absent, or still loading, or failed,
   * every card renders exactly as before and the version sentence is simply not there. That is the
   * property the two columns' no-shared-state test protects — a listing that cannot be read must not take
   * this page down — and here it is a decision in the code rather than a hope in a comment.
   *
   * FOUR STATES, and only three of them are claims about the profile:
   *   ready + versions undefined        -> the host has no such code yet: say that, do not say "none"
   *   ready + versions[pkg] === []      -> it looked, and there are none: a fact about the profile
   *   ready + versions[pkg] has entries -> compare the newest with what is installed, without guessing
   *                                        which of the two is newer
   *   anything else (no store, idle, loading, failed) -> SAY NOTHING, not even "no snapshots": nothing has
   *                                        been read yet, and a claim the page cannot support is worse
   *                                        than a sentence that is absent.
   */
  const installedState = typeof props.installed?.state === 'function' ? props.installed.state() : null
  const maintenanceFor = (project) => {
    const packageName = project.package ?? 'dsh-ui-projects'
    /** @type {{ kind: string, name?: string, version?: string, when?: string, current?: string }} */
    let version = { kind: 'unavailable' }
    const scan = installedState !== null && installedState.status === 'ready' ? installedState.scan : undefined
    if (scan !== undefined && scan !== null) {
      if (scan.versions === undefined) {
        version = { kind: 'host-stale' }
      }
      else {
        const list = Array.isArray(scan.versions[packageName]) ? scan.versions[packageName] : undefined
        if (list !== undefined && list.length === 0) {
          version = { kind: 'none' }
        }
        else if (list !== undefined) {
          const newest = list[0]
          const installed = (scan.dependencies ?? []).find((entry) => entry.name === packageName)
          const current = String(installed?.version ?? 'unknown')
          version = {
            kind: String(newest.version) === current ? 'same' : 'different',
            name: String(newest.name ?? ''),
            version: String(newest.version ?? 'unknown'),
            when: String(newest.createdAt ?? ''),
            current,
          }
        }
      }
    }
    return { packageName, version }
  }

  const activeNames = snapshot.projects.filter((project) => project.enabled).map((project) => project.name)
  const skinProjects = snapshot.projects.filter((project) => project.type === 'skin')
  /*
   * Any active project whose DECLARED tier is above the tier in force has been demoted — by the
   * device, since that is the only thing that lowers it. Naming the project and the tier it now
   * runs at is what keeps a cheaper material from reading as a rendering bug.
   */
  const demoted =
    snapshot.perfLevel === undefined
      ? []
      : snapshot.projects.filter(
          (project) => project.enabled && rankOf(project.perfLevel) > rankOf(snapshot.perfLevel),
        )

  /*
   * Active enhancements claiming the same surface. Advisory, and worded that way: two projects can
   * touch one region and still compose, so this states the overlap and lets the reader judge. It
   * only appears when there is something to say — a hint that is always present is not read.
   */
  const regionConflicts = snapshot.regionConflicts ?? []
  const persistError = snapshot.persistError
  const conflictText =
    regionConflicts.length === 0
      ? null
      : regionConflicts
          .map((pair) => (pair.nested ? t.regionNested(pair.names, pair.regions) : t.regionShared(pair.names, pair.regions)))
          .join(' ')

  const children = [
    React_.createElement(
      'div',
      { className: 'uip-head', key: 'head' },
      React_.createElement(
        'div',
        { className: 'uip-headText' },
        React_.createElement('h3', { className: 'uip-title' }, t.title),
        React_.createElement('p', { className: 'uip-intro' }, t.intro),
      ),
      React_.createElement(
        'button',
        {
          type: 'button',
          className: 'uip-button',
          onClick: () => run('__all__', store.resetAll()),
          disabled: pending.__all__ === true || !snapshot.anyActive,
        },
        t.resetAll,
      ),
    ),
    React_.createElement(
      'div',
      { className: 'uip-meta', key: 'meta' },
      React_.createElement('span', null, t.activeCount(snapshot.activeCount)),
      React_.createElement('span', null, t.storage[snapshot.storageKind] ?? t.storage.local),
    ),
    skinProjects.length > 1 ? React_.createElement('p', { className: 'uip-hint', key: 'skinhint' }, t.skinHint) : null,
    demoted.length > 0
      ? React_.createElement(
          'p',
          { className: 'uip-hint', key: 'perfhint' },
          t.perfDemoted(demoted.map((project) => project.name).join(', '), t.perf[snapshot.perfLevel]),
        )
      : null,
    conflictText === null ? null : React_.createElement('p', { className: 'uip-hint', key: 'regionhint' }, conflictText),
    /*
     * A failed write, at the top of the section rather than on a card.
     *
     * The record is one document — five fields, every project's options, the enabled set — so a
     * write failure belongs to no single project and must not be pinned on one. Until now it existed
     * only as a console line, which is invisible to the person whose choice just failed to stick:
     * they toggle a project, the switch comes back off after a reload, and the skin gets the blame.
     */
    persistError === undefined
      ? null
      : React_.createElement(
          'p',
          { className: 'uip-error', key: 'persist-error' },
          t.persistError(persistError.message),
        ),
    failure === undefined ? null : React_.createElement('p', { className: 'uip-error', key: 'failure' }, failure),
    snapshot.projects.length === 0
      ? React_.createElement(
          'div',
          { className: 'uip-hint', key: 'empty' },
          t.empty,
          ' ',
          t.emptyHint,
        )
      : React_.createElement(
          'ul',
          { className: 'uip-list', key: 'list' },
          snapshot.projects.map((project) =>
            createCard({
              React: React_,
              project,
              t,
              pending: pending[project.id] === true,
              activeNames,
              outOfOrder: snapshot.outOfOrderId === project.id,
              conflictsHere: regionConflicts.filter((pair) => pair.ids.includes(project.id)),
              onToggle: () => run(project.id, store.toggle(project.id)),
              onReset: () => run(project.id, store.resetOne(project.id)),
              onConfirmChecks: (itemIds) => run(project.id, store.confirmChecks(project.id, itemIds)),
              onClearChecks: () => run(project.id, store.clearChecks(project.id)),
              maintenance: maintenanceFor(project),
            }),
          ),
        ),
  ]

  return React_.createElement('section', { className: 'uip-root', 'aria-label': t.title }, children.filter(Boolean))
}

/**
 * The manual verification checklist for one project.
 *
 * A real component rather than another `createX` helper, because it owns state: the boxes ticked but
 * not yet confirmed. `createCard` is a plain function called inside the section's render, so hooks
 * there would be attributed to the parent and break the moment the project list changed length. A
 * component gets its own hook scope.
 *
 * The open/closed state is the platform's, not ours: a native `<details>` needs no hook, arrives
 * with keyboard support, and is announced as a disclosure. The same reasoning as using a real
 * `input[type=range]` for the project controls instead of rebuilding one.
 *
 * The checkboxes are the READING and the button is the ASSERTION. Confirming is deliberately not an
 * automatic consequence of ticking the last box: "I looked at all of these" is a claim a person
 * makes, and the record should say who made it and against which version.
 * @param {object} props
 * @returns {any}
 */
function Checklist(props) {
  const { R, t, project, pending, onConfirm, onClear } = props
  /*
   * Seeded from the record whenever there IS one, not only while the record is still current.
   *
   * The boxes are the READING and the record is the CLAIM, and the two go out of date for different
   * reasons: a new version, or an item added to the checklist, invalidates the claim — not the fact
   * that somebody read these items. Seeding only from a current record threw that reading away, and it
   * made re-confirming cost five clicks after the one item that changed. The record still reports
   * itself as stale or incomplete; a tick means "this was read", nothing more.
   */
  const stored = project.checks
  const hasRecord = project.checks !== undefined
  const [ticked, setTicked] = React.useState(() => ({ ...(stored?.items ?? {}) }))
  const all = project.testItems.length > 0 && project.testItems.every((item) => ticked[item.id] === true)

  /*
   * When the record goes away, the ticks go with it.
   *
   * The boxes are seeded from the stored confirmation at mount, so withdrawing that confirmation would
   * otherwise leave a fully ticked checklist standing beside no record at all — a reading nobody can
   * tell apart from the one that was just retracted, one click away from being recorded again.
   */
  React.useEffect(() => {
    if (!hasRecord) setTicked({})
  }, [hasRecord])

  const rows = project.testItems.map((item) =>
    R.createElement(
      'label',
      { className: 'uip-check', key: item.id },
      R.createElement('input', {
        type: 'checkbox',
        checked: ticked[item.id] === true,
        disabled: pending,
        onChange: (event) => setTicked((current) => ({ ...current, [item.id]: event.target.checked })),
      }),
      R.createElement('span', null, item.label),
    ),
  )
  rows.push(
    R.createElement(
      'div',
      { className: 'uip-actions', key: 'confirm' },
      R.createElement(
        'button',
        {
          type: 'button',
          className: 'uip-button',
          /*
           * A stable hook, because this button's identity is not its label.
           *
           * The label is localized, and the browser suite looked for the English one: on a Chinese
           * interface the button was never found, the assertion read `null`, and the failure looked
           * like the checklist refusing to work rather than a test that only spoke one language.
           * Assertions belong on state; copy belongs to whoever is reading the screen.
           */
          'data-uip-action': 'confirm-checks',
          disabled: !all || pending,
          onClick: () => {
            const itemIds = project.testItems.filter((item) => ticked[item.id] === true).map((item) => item.id)
            onConfirm(itemIds)
          },
        },
        t.tests.markPassed,
      ),
      /*
       * Withdrawing the confirmation, shown only when there is one to withdraw.
       *
       * Separate from the card's reset on purpose: retracting a claim should not also cost the
       * project's settings, and the card's reset is a bigger action than a person who confirmed by
       * mistake is asking for. It is not gated on the boxes — it is about the RECORD, not the reading
       * in progress — so it stays available while the boxes are empty.
       */
      hasRecord
        ? R.createElement(
            'button',
            {
              type: 'button',
              className: 'uip-button',
              'data-uip-action': 'clear-checks',
              disabled: pending,
              onClick: onClear,
            },
            t.tests.withdraw,
          )
        : null,
    ),
  )

  return R.createElement(
    'details',
    { className: 'uip-tests', key: 'tests', 'data-project': project.id },
    R.createElement('summary', { className: 'uip-testsSummary' }, t.tests.summary(project.testItems.length)),
    project.checks === undefined
      ? null
      : R.createElement(
          'p',
          {
            className: project.checksState === 'current' ? 'uip-description' : 'uip-hint',
            // The confirmation's STATE, for the same reason as the button's hook: the sentence
            // around it is translated, the state is not. Three values, because `stale` and
            // `incomplete` are different findings and the sentence has to say which one it is.
            'data-uip-checks': project.checksState,
            'data-uip-checks-version': project.checks.version,
          },
          project.checksState === 'current'
            ? t.tests.passed(project.checks.version)
            : project.checksState === 'stale'
              ? t.tests.stale(project.checks.version)
              : t.tests.incomplete(project.checks.version),
        ),
    R.createElement('div', { className: 'uip-checks' }, rows),
  )
}

/**
 * One project card. Everything shown here comes from the project definition.
 * @param {object} input
 * @returns {any}
 */
function createCard(input) {
  const { React: R, project, t, pending, activeNames, outOfOrder, conflictsHere, onToggle, onReset, onConfirmChecks, onClearChecks, maintenance } = input
  const name = project.name

  const badges = [
    R.createElement(
      'span',
      { className: 'uip-badge', 'data-kind': 'type', key: 'type' },
      t.badges[project.type] ?? project.type,
    ),
    R.createElement('span', { className: 'uip-badge', key: 'scope' }, t.scopes[project.scope] ?? project.scope),
  ]
  const perfLabel = t.perf?.[project.perfLevel]
  if (perfLabel !== undefined) {
    badges.push(R.createElement('span', { className: 'uip-badge', key: 'perf', 'data-kind': 'perf' }, perfLabel))
  }
  /*
   * The execution order, shown only where it means something.
   *
   * A skin is alone by policy and never sorted, so its priority is noise; among enhancements it is
   * the difference between two projects' effects landing in one order or the other, which is worth
   * being able to read off the card.
   */
  if (project.type === 'enhancement' && t.priority !== undefined) {
    badges.push(
      R.createElement('span', { className: 'uip-badge', key: 'priority', 'data-kind': 'priority' }, t.priority(project.priority)),
    )
  }
  for (const feature of project.supports) {
    const label = t.supports[feature]
    if (label !== undefined) badges.push(R.createElement('span', { className: 'uip-badge', key: feature }, label))
  }

  const replacements =
    project.type === 'skin'
      ? activeNames.filter((activeName) => activeName !== name)
      : []

  const body = [
    R.createElement(
      'div',
      { className: 'uip-rowTop', key: 'top' },
      R.createElement(
        'div',
        { className: 'uip-identity' },
        R.createElement('span', { className: 'uip-name' }, name),
        R.createElement('span', { className: 'uip-version' }, `v${project.version}`),
      ),
      createSwitch({ R, project, t, pending, onToggle }),
    ),
    R.createElement('div', { className: 'uip-badges', key: 'badges' }, badges),
  ]

  if (project.description.length > 0) {
    body.push(R.createElement('p', { className: 'uip-description', key: 'description' }, project.description))
  }
  if (replacements.length > 0) {
    body.push(R.createElement('p', { className: 'uip-description', key: 'replaces' }, t.replacedBy(replacements.join(', '))))
  }
  /*
   * This project's position is one the next load will change. A click applies what the user asked
   * for and does not re-order the projects already running — re-applying them to reorder would
   * make the interface flicker — so the consequence is stated here instead of being invisible.
   */
  if (outOfOrder === true) {
    body.push(R.createElement('p', { className: 'uip-hint', key: 'order' }, t.orderHint(name)))
  }
  /*
   * This project's own share of a region conflict, on its card: the section hint says what is
   * shared, this says which one is mine, which is the part a reader checking one project needs.
   */
  for (const pair of conflictsHere) {
    const other = pair.names.find((entry) => entry !== name) ?? pair.names[0]
    const regions = pair.regions.map((region) => t.regions?.[region] ?? region).join(', ')
    body.push(
      R.createElement(
        'p',
        { className: 'uip-hint', key: `region-${other}` },
        pair.nested ? t.regionNestedHere(other, regions) : t.regionSharedHere(other, regions),
      ),
    )
  }
  if (project.error !== undefined) {
    body.push(
      R.createElement(
        'p',
        { className: 'uip-error', key: 'error' },
        `${t.errorLabel}: ${project.error}`,
      ),
    )
  }
  for (const control of project.controls ?? []) {
    body.push(createControl({ R, control, t, pending }))
  }
  /*
   * THE MAINTENANCE COMMANDS, folded away but not hidden.
   *
   * The summary carries a badge exactly when a recorded version differs from the installed one, so the
   * one state worth acting on is visible without expanding anything — a collapsed block that hides the
   * only thing that changed is a block that hides its own reason for existing.
   *
   * The version sentence appears ONLY when the page actually knows something (see `maintenanceFor`): with
   * no store, a loading store, or a failed one, there is no `[data-uip-version-state]` element at all.
   */
  const versionKind = maintenance?.version?.kind ?? 'unavailable'
  const versionLine =
    versionKind === 'host-stale'
      ? t.snapshotHostStale
      : versionKind === 'none'
        ? t.snapshotNone
        : versionKind === 'same'
          ? t.snapshotNewer(maintenance.version.name, maintenance.version.version, maintenance.version.when)
          : versionKind === 'different'
            ? t.snapshotDifferent(
                maintenance.version.name,
                maintenance.version.version,
                maintenance.version.current,
              )
            : null
  body.push(
    R.createElement(
      'details',
      {
        className: 'uip-tests',
        key: 'maintenance',
        'data-uip-maintenance-panel': project.id,
      },
      R.createElement(
        'summary',
        { className: 'uip-testsSummary' },
        t.maintenanceTitle(maintenance?.packageName ?? 'dsh-ui-projects'),
        versionKind === 'different'
          ? R.createElement('span', { 'data-uip-maintenance-badge': 'different' }, ' · ' + t.maintenanceBadge)
          : null,
      ),
      R.createElement('p', { className: 'uip-hint' }, t.maintenanceHint),
      R.createElement('pre', null, t.maintenanceSnapshot),
      R.createElement('pre', null, t.maintenanceUpdate),
      R.createElement('pre', null, t.maintenanceRollback),
      versionLine === null
        ? null
        : R.createElement('p', { className: 'uip-hint', 'data-uip-version-state': versionKind }, versionLine),
    ),
  )
  if (project.testItems.length > 0) {
    body.push(
      R.createElement(Checklist, {
        key: 'checklist',
        R,
        t,
        project,
        pending,
        /*
         * `onConfirmChecks` ALREADY CLOSES OVER `project.id` (see the call site in `UiProjectsSection`), so
         * the id must not be passed again here. It was, once: the array of item ids then bound to the
         * callback's second parameter while `project.id` took its first, the store iterated the characters
         * of `'liquid-glass'`, matched none of them, and recorded `{ version, items: {} }` — a confirmation
         * with nothing in it, written silently. `onClear` on the next line never had the bug because it
         * passes no arguments at all.
         */
        onConfirm: (itemIds) => onConfirmChecks(itemIds),
        onClear: () => onClearChecks(project.id),
      }),
    )
  }
  body.push(
    R.createElement(
      'div',
      { className: 'uip-actions', key: 'actions' },
      R.createElement(
        'button',
        {
          type: 'button',
          className: 'uip-button',
          // Same reason as the checklist's buttons: the label is translated, the hook is not.
          'data-uip-action': 'reset-one',
          onClick: onReset,
          disabled: pending,
        },
        t.resetOne(name),
      ),
    ),
  )

  return R.createElement(
    'li',
    { className: 'uip-card', key: project.id, 'data-project': project.id, 'data-status': project.status },
    createPreview({ R, project, t }),
    R.createElement('div', { className: 'uip-body' }, body),
  )
}

/**
 * One control from a project's `controls` declaration.
 *
 * Everything specific to a control lives in the declaration (its range, its copy key) and
 * everything live comes from the store, so this function knows only that a slider exists —
 * not what it adjusts. The panel therefore gains a project's controls without gaining any
 * knowledge of that project.
 * @param {object} input
 * @returns {any}
 */
function createControl(input) {
  const { R, control, t, pending } = input
  const label = t.controls?.[control.labelKey] ?? control.id
  const unit = t.controls?.unit ?? '%'
  const visible = control.value === undefined ? control.min : control.value

  const onChange = (event) => {
    const next = Number(event.target.value)
    if (Number.isFinite(next)) control.onChange(next)
  }

  return R.createElement(
    'div',
    { className: 'uip-control', key: `control-${control.id}`, 'data-control': control.id },
    R.createElement(
      'div',
      { className: 'uip-controlHead' },
      R.createElement('span', { className: 'uip-controlLabel' }, label),
      R.createElement('span', { className: 'uip-controlValue' }, `${Math.round(visible)}${unit}`),
    ),
    R.createElement('input', {
      type: 'range',
      className: 'uip-slider',
      min: control.min,
      max: control.max,
      step: control.step,
      value: visible,
      disabled: pending,
      'aria-label': label,
      onChange,
    }),
  )
}

/**
 * The switch is a real button with `role="switch"`: Space and Enter activate it
 * through the browser's own button behaviour, `aria-checked` carries the state,
 * and the accessible name says what will happen.
 * @param {object} input
 * @returns {any}
 */
function createSwitch(input) {
  const { R, project, t, pending, onToggle } = input
  return R.createElement(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': project.enabled,
      'aria-label': project.enabled ? t.toggleOff(project.name) : t.toggleOn(project.name),
      className: 'uip-switch',
      onClick: onToggle,
      disabled: pending || project.status === 'unavailable',
    },
    R.createElement('span', { className: 'uip-knob', 'aria-hidden': 'true' }),
  )
}

/**
 * Preview thumbnail. A project may ship an image path; otherwise its `preview`
 * string is used as a CSS background and a labelled swatch is generated, so
 * every project gets a visual without shipping binary assets.
 * @param {object} input
 * @returns {any}
 */
function createPreview(input) {
  const { R, project, t } = input
  const alt = project.previewLabel ?? t.previewAlt(project.name)
  const isImage = typeof project.preview === 'string' && /^(https?:|\.|\/)/.test(project.preview)

  if (isImage) {
    return R.createElement(
      'div',
      { className: 'uip-preview', key: 'preview' },
      R.createElement('img', { className: 'uip-previewImage', src: project.preview, alt, loading: 'lazy' }),
    )
  }

  const style = typeof project.preview === 'string' ? { background: project.preview } : undefined
  return R.createElement(
    'div',
    { className: 'uip-preview', key: 'preview', style, role: 'img', 'aria-label': alt },
    R.createElement('span', { className: 'uip-previewGlass', 'aria-hidden': 'true' }),
  )
}

module.exports = { UiProjectsSection }
