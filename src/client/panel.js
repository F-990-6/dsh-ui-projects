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
/*
 * The preview moved to its own module in step 56a: the installed-package column draws the same
 * picture from the same declared string, and two columns rendering one manifest field is exactly the
 * kind of duplicated decision this package keeps paying for.
 */
const { createPreview } = require('./preview.js')
/*
 * THE COPY BUTTON, from its own module (2026-09-30). `copyCommandText` used to live inside
 * `panel-plugins.js` — the "UI plugins" column, which is being removed — and the copy button is one of the
 * three things that survive that removal (uninstall, view CHANGELOG, copy diagnostics).
 *
 * `require`, not `import`: this file is CommonJS-dialect throughout, and one ESM line in the middle of it
 * would be the only exception in 699 lines.
 */
const { copyCommandText } = require('./clipboard.js')
const { buildDiagnostics } = require('./plugin-diagnostics.js')

/*
 * (C8 迁移) 这个常量原在 `panel-plugins.js:708`（`export const COPY_FEEDBACK_MS = 1500`），
 * 该文件于第 3 步删除，但 `CardMenu` 的 useEffect 仍引用它——浏览器里抛
 * ReferenceError 并让整个 settings.section 卸载。值 = 1500ms，与原定义一致。
 */
const COPY_FEEDBACK_MS = 1500
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
  /*
   * The listing the version sentence is derived from, read and SUBSCRIBED TO in the shape `live` above
   * already uses.
   *
   * READING IT ONCE WAS NOT ENOUGH, and this block is the whole of that correction. The card menu and the
   * diagnostics read this store synchronously at render, and a store read once and never subscribed to
   * cannot report that anything arrived: opening Settings › UI is what ASKS the host (`index.js` starts
   * the read from the section's own render, because the slot API offers no mount hook), so the answer
   * necessarily lands AFTER the first render — and with no subscription there is no second one. The menu
   * would offer to copy a command for a package it never saw, for the rest of the session, on the very
   * page the reader is looking at, which is the failure this round exists to remove. The browser suite
   * only ever reached this page through the column that has since been removed, where the listing was
   * already in hand before the first render — so the suite was green while this page was silent.
   *
   * A source that cannot notify still works: `useState` reads whatever it can, and the effect subscribes
   * only when there is something that can. Every unit test passes a bare `{ state }` stub, and a stub
   * with no `subscribe` renders from that single read exactly as it did before.
   */
  const [installedState, setInstalledState] = React_.useState(() =>
    typeof props.installed?.state === 'function' ? props.installed.state() : null,
  )
  React_.useEffect(() => {
    const source = props.installed
    if (source === undefined || source === null) return undefined
    if (typeof source.state !== 'function' || typeof source.subscribe !== 'function') return undefined
    setInstalledState(source.state())
    return source.subscribe(() => setInstalledState(source.state()))
  }, [props.installed])
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
   * (C5, 2026-09-30: `maintenanceFor(project)` stood here — the card's snapshot/version lookup, read
   * synchronously from `installedState`, with four states: (1) no store or not ready → SAY NOTHING,
   * because "no snapshots" would be a claim the page cannot support; (2) ready + no `versions` field → the
   * host has no such code yet (a restart that has not happened), and saying "none" would be a different
   * lie; (3) ready + the package's entry missing OR empty → `none`, which is the sentence that explains
   * what `-Snapshot` is for; (4) entries → compare the newest with what is installed, without guessing
   * which is newer.
   *
   * Two decisions in it are worth keeping beyond the block. NO FALLBACK: a project with no package
   * identity used to answer `'dsh-ui-projects'` — a second copy of the store's own fallback, free to
   * disagree with it, and a confident claim that the framework owned a project that never said so;
   * `null` was the honest value. And WITHOUT A NAME, NOTHING ABOUT VERSIONS IS ASKED: `scan.versions[null]`
   * is a miss and the `dependencies.find` is nothing, so the old code reported "this profile recorded no
   * snapshot of it" for a package it could not even name.
   *
   * Its only caller was the maintenance block (C2), so the function goes now that the block is gone.)
   */

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
              onRun: (task) => run(project.id, task),
              installed: installedState,
                            store: props.installed,
              /* (C4, 2026-09-30: `onConfirmChecks` and `onClearChecks` were passed here, for the checklist
               * block. That block is removed above, and its unit tests went with it in the same round, so
               * nothing calls these handlers any more. `store.confirmChecks`/`clearChecks` lose their last
               * caller and are recorded as a to-do rather than touched here: they are in the STORE, outside
               * the three files this round is allowed to change.) */
        /*
         * (C6, 2026-09-30: `maintenance: maintenanceFor(project),` was passed here, for the card's
         * maintenance disclosure. That block is gone (C2) and `maintenanceFor` goes with it (C5), so the
         * card receives nothing about versions and snapshots any more.)
         */
            }),
          ),
        ),
  ]

  return React_.createElement('section', { className: 'uip-root', 'aria-label': t.title }, children.filter(Boolean))
}

/*
 * (C4, 2026-09-30: `Checklist(props)` stood here — the per-project manual verification checklist, removed
 * with the author's tools. FOUR THINGS IT TAUGHT ARE WORTH KEEPING, because each one is a decision a
 * future rewrite would otherwise have to rediscover:
 *
 *   · IT HAD TO BE A REAL COMPONENT, not another `createX` helper, "because it owns state: the boxes
 *     ticked but not yet confirmed". `createCard` is a plain function called inside the section's render,
 *     so hooks there would be attributed to the PARENT and break the moment the project list changed
 *     length. A component gets its own hook scope.
 *   · THE OPEN/CLOSED STATE WAS THE PLATFORM'S, not ours: a native `<details>` needs no hook, arrives with
 *     keyboard support, and is announced as a disclosure — the same reasoning as using a real
 *     `input[type=range]` for the project controls instead of rebuilding one.
 *   · "THE CHECKBOXES ARE THE READING AND THE BUTTON IS THE ASSERTION."
 *   · "CONFIRMING IS DELIBERATELY NOT AN AUTOMATIC CONSEQUENCE OF TICKING THE LAST BOX": "I looked at all
 *     of these" is a claim a person makes, and the record should say who made it and against which version.
 *
 * The two decisions the BODY carried — the stable state hook, and why withdrawal was kept separate from
 * the card's reset — are recorded where that body stood, below.)
 */
/*
 * (C4, 2026-09-30, continued: `Checklist`'s BODY stood here. Two decisions inside it are worth keeping,
 * for the same reason as the four above — a rewrite would otherwise have to rediscover them:
 *
 *   · "A STABLE HOOK, BECAUSE THIS BUTTON'S IDENTITY IS NOT ITS LABEL." The label is localized, and the
 *     browser suite looked for the ENGLISH one: on a Chinese interface the button was never found, the
 *     assertion read `null`, and the failure looked like the checklist refusing to work rather than a test
 *     that only spoke one language. ASSERTIONS BELONG ON STATE; COPY BELONGS TO WHOEVER IS READING THE
 *     SCREEN.
 *   · "WITHDRAWING THE CONFIRMATION … SEPARATE FROM THE CARD'S RESET ON PURPOSE": retracting a claim
 *     should not also cost the project's settings, and the card's reset is a bigger action than a person
 *     who confirmed by mistake is asking for. It was not gated on the boxes — it was about the RECORD, not
 *     the reading in progress — so it stayed available while the boxes were empty.
 *
 * The block that rendered this component is gone (C3), its call-site handlers are gone with it, and the
 * store methods they called are recorded as a to-do: they are in the STORE, outside this round's files.)
 */


/**
 * THE CARD MENU (C8, 2026-09-30) — "more actions" for one card.
 *
 * A COMPONENT, not a bag of props handed to `createElement` inline: it owns state (which item is mid-copy,
 * and whether the CHANGELOG is showing), and `createCard` is a plain function called inside the section's
 * render — hooks there would be attributed to the PARENT and break the moment the project list changed
 * length. The checklist had to be a component for exactly this reason, and that lesson is now recorded
 * twice.
 *
 * THE COPY FEEDBACK IS TEMPORARY AND THE TIMER IS OWNED: "Copied" that stays for ever is a button a reader
 * cannot use twice, and a timer that outlives the component is a setState on something that no longer
 * exists — one effect, one ref, one cleanup. The button is never disabled: a copy button that stops
 * accepting clicks reads as broken.
 *
 * NOTHING HERE RUNS A COMMAND. The uninstall line is printed and copied; the CHANGELOG is read through the
 * store; the diagnostics are assembled from facts the page already holds. The facts it does not have — the
 * package's spec, where it was resolved from, its kind — render as "unknown", which is what
 * `buildDiagnostics` does by design rather than something this call site fakes.
 * @param {object} props
 * @returns {any}
 */
function CardMenu(props) {
  const { R, t, project, name, pending, onRun, installed } = props
  /*
   * `copied` 是 OBJECT，不是字符串——每个按钮一个独立的反馈状态。
   * 之前它是单值，两个复制按钮（uninstall / diagnostics）共享，
   * 点其中一个两个都变"已复制"。按 key 分开后它们各自计时、各自复位。
   */
  const [copied, setCopied] = React.useState({})
  const timers = React.useRef({})

  React.useEffect(() => {
    for (const key of Object.keys(copied)) {
      const state = copied[key]
      if (state !== 'copied' && state !== 'failed') continue
      if (timers.current[key] !== undefined) continue
      timers.current[key] = setTimeout(() => {
        setCopied((cur) => {
          const next = { ...cur }
          delete next[key]
          return next
        })
        delete timers.current[key]
      }, COPY_FEEDBACK_MS)
    }
  }, [copied])

  React.useEffect(() => {
    return () => {
      for (const key of Object.keys(timers.current)) clearTimeout(timers.current[key])
      timers.current = {}
    }
  }, [])

  /*
   * 每个按钮有自己的初始 label：
   *   · uninstall   → t.plugins.copyCommand（"复制"）
   *   · diagnostics → t.plugins.diagnosticsCopy（"复制诊断信息"）
   * 复制成功后都变 copyDone（"已复制"），失败都变 copyFailed。
   */
  const labelFor = (key, fallback) => {
    const state = copied[key]
    if (state === 'copied') return t.plugins?.copyDone
    if (state === 'failed') return t.plugins?.copyFailed
    return fallback
  }
  const copy = (key, source) => {
    void copyCommandText(source).then((outcome) => {
      setCopied((cur) => ({ ...cur, [key]: outcome }))
    })
  }

  const scan = installed !== null && installed?.status === 'ready' ? installed.scan : undefined
  const profileName = typeof scan?.profileName === 'string' && scan.profileName.length > 0 ? scan.profileName : null
  const installedVersion = (scan?.dependencies ?? []).find((entry) => entry.name === project.package)?.version ?? null
  const diagnosis = buildDiagnostics(
    { name: project.package, version: installedVersion, problems: [], update: null },
    scan?.versions?.[project.package],
  )

  const items = []
  if (profileName !== null) {
    const command = 'dsh plugin --profile ' + profileName + ' remove ' + name
    items.push(
      R.createElement(
        'button',
        {
          type: 'button',
          className: 'uip-button uip-copyButton',
          key: 'uninstall',
          'data-uip-action': 'uninstall',
          'data-uip-copy-source': command,
                   'aria-label': t.plugins?.copyUninstallCommand + ': ' + command,
          onClick: () => copy('uninstall', command),
        },
        labelFor('uninstall', t.plugins?.copyUninstallCommand),
      ),
    )
  }

  items.push(
    R.createElement(
      'button',
      {
        type: 'button',
        className: 'uip-button uip-copyButton',
        key: 'diagnostics',
        'data-uip-action': 'copy-diagnostics',
        'data-uip-copy-source': diagnosis.text,
        'aria-label': t.plugins?.diagnosticsCopy + ': ' + project.package,
        onClick: () => copy('diagnostics', diagnosis.text),
      },
      labelFor('diagnostics', t.plugins?.diagnosticsCopy),
    ),
  )

  const body = [R.createElement('div', { className: 'uip-actions', key: 'menu-items' }, items)]

  return R.createElement(
    'details',
    { className: 'uip-menu', 'data-uip-menu': project.id, open: false },
    R.createElement('summary', { 'data-uip-fold-summary': 'card-menu' }, t.plugins?.cardMenuTitle),
    body,
  )
}

/**
 * THE CHANGELOG DISCLOSURE (2026-10-02) — a card-level `<details>` beside
 * the "more actions" menu, not a button inside it.
 *
 * `store`, not `installed`: the snapshot has `scan`, but `changelog()` and
 * `loadChangelog()` live on the STORE itself (`installed.js:360`).
 * Passing the snapshot made both `undefined`.
 *
 * Loads lazily: nothing is asked of the host until the reader opens it.
 */
function ChangelogDetails(props) {
  const { R, t, project, store } = props
  const [open, setOpen] = React.useState(false)
  const changelog = typeof store?.changelog === 'function' ? store.changelog(project.package) : null
  React.useEffect(() => {
    if (!open) return undefined
    if (changelog !== null && changelog?.status !== 'idle') return undefined
    if (typeof store?.loadChangelog === 'function') void store.loadChangelog(project.package)
    return undefined
  }, [open, project.package, changelog?.status, store])
  const sections = changelog?.payload?.sections
  return R.createElement(
    'details',
    {
      className: 'uip-menu',
      key: 'changelog',
      'data-uip-card-changelog': project.id,
      open,
      onToggle: (event) => setOpen(event.target.open),
    },
    R.createElement('summary', { 'data-uip-fold-summary': 'card-changelog' }, t.plugins?.changelogTitle),
    Array.isArray(sections) && sections.length > 0
      ? sections.map((section, index) =>
          R.createElement(
            'p',
            { key: 'section-' + index },
            String(section?.title ?? section?.heading ?? ''),
          ),
        )
      : R.createElement('p', { className: 'uip-hint' }, t.plugins?.changelogUnavailable),
  )
}
/**
 * One project card. Everything shown here comes from the project definition.
 * @param {object} input
 * @returns {any}
 */
function createCard(input) {
  /* (C7, 2026-09-30: `maintenance` was destructured here, for the card's maintenance disclosure. That
   * block is gone (C2) and the prop with it (C6), so the field is no longer read.) */
  /* (C4, 2026-09-30: `onConfirmChecks` and `onClearChecks` were destructured here, for the checklist block
   * (removed above). `onReset` stays until the card menu replaces the reset control.) */
  const { React: R, project, t, pending, activeNames, outOfOrder, conflictsHere, onToggle, onRun, installed, store } = input
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
   * (C2, 2026-09-30: the card's MAINTENANCE DISCLOSURE stood here — a folded `<details>` carrying
   * `data-uip-maintenance-panel`, three printed commands (`install.ps1 -Snapshot`, `-Update`,
   * `-Rollback`), a hint, and a version sentence with its own badge when a recorded snapshot differed
   * from what is installed.
   *
   * Two things about it are worth keeping in writing. Its summary carried the badge precisely WHEN a
   * recorded version differed, "so the one state worth acting on is visible without expanding anything — a
   * collapsed block that hides the only thing that changed is a block that hides its own reason for
   * existing". And its version sentence appeared ONLY when the page actually knew something: with no
   * store, a loading store, or a failed one there was no `[data-uip-version-state]` at all, which is the
   * difference between "nothing recorded" and "nothing read".
   *
   * A reader now gets the three things they act on through the card menu below, and the printed
   * maintenance commands go with the "UI plugins" column. Those four states existed only here, which is
   * why the suite's assertions about them were withdrawn with this block rather than left pointing at a
   * marker that no longer renders.)
   */
  /*
   * (C3, 2026-09-30: the card's CHECKLIST block stood here — `if (project.testItems.length > 0)`, pushing
   * `<Checklist>` with `onConfirm`/`onClear`. The confirmation it drove is gone with the author's tools,
   * and the store-level half of it records a lesson worth keeping: `onConfirmChecks` ALREADY CLOSES OVER
   * `project.id`, so the id must not be passed again. It was, once — the array of item ids bound to the
   * callback's second parameter while `project.id` took its first, the store iterated the CHARACTERS of
   * `'liquid-glass'`, matched none, and recorded `{ version, items: {} }`: a confirmation with nothing in
   * it, written silently. `onClear` never had the bug because it passes no arguments at all.)
   */
  /*
   * THE CARD'S "MORE ACTIONS" MENU (C8, 2026-09-30). Three things a reader acts on, and nothing that only
   * looks like an action: copy the uninstall command, open the CHANGELOG this package already ships, copy
   * the diagnostics this build can actually see. The reset control it replaces is gone, together with the
   * printed maintenance commands (C2) and the checklist (C3).
   */
  body.push(
    CardMenu({
      key: 'menu',
      R,
      t,
      project,
      name,
      pending,
      onRun,
      installed,
    }),
  )
  body.push(
    ChangelogDetails({
      key: 'changelog',
      R,
      t,
      project,
      store,
    }),
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

module.exports = { UiProjectsSection }
