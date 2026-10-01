/**
 * Settings › UI plugins — what is installed in this profile, in a section of its own.
 *
 * A SEPARATE SECTION from Settings › UI, and that separation is the design: that page manages
 * PROJECTS (what the running client offers, applied and unapplied), this one manages PACKAGES (what
 * is installed, composed, and what would have to be typed to change it). They are different questions
 * with different sources of truth — the registry for the first, a directory scan for the second — and
 * one page answering both would be the page where they get confused.
 *
 * NOTHING HERE WRITES. Every control that would change the profile renders the exact command instead
 * and tells the user to run it, because `$DSH_HOME` is written by `install.ps1` and by nothing else in
 * this project. A button that spawned `dsh plugin` would be a write nobody reviewed, triggered by a
 * click.
 *
 * ## The copy lives under `t.plugins`, and every read goes through `copy`
 *
 * THE BUG THIS FILE NOW CARRIES A COMMENT ABOUT. The first version read `t.title`, `t.refresh`,
 * `t.kinds[…]` and fourteen more keys one level too high: the dictionary nests this page's copy under
 * `plugins`, exactly as it nests `storage`, `perf` and `tests` — which `panel.js` reads with their
 * prefix, as `t.storage[…]` and `t.perf[…]`. One of the misplaced reads was dynamic,
 * `t.kinds[dependency.kind]`, and dynamic access on `undefined` THROWS. The browser reported
 * `Cannot read properties of undefined (reading 'bundle')`, where `bundle` is not a property name in
 * any file — it is the VALUE of `dependency.kind`, which is why grepping for it found nothing. The
 * other fifteen keys rendered as nothing at all, silently: the crash was the lucky part, and a green
 * suite beside a blank column would have been worse.
 *
 * So: one `copy` binding at the top, and `verify.mjs` guards the shape of this file — a direct
 * `t.<key>` read fails the suite, and both real dictionaries are rendered rather than a hand-built
 * fixture. A fixture is a dictionary that does not exist, and this file was tested against one.
 */

const { createPreview, previewKindOf } = require('./preview.js')
const { CHANNELS, mergeUpdates } = require('./channels.js')

/**
 * @param {{ store: any, projects?: any, t: any, React: any }} props
 * @param {any} [props.projects] the PROJECTS store, for the read-only switch mirror. Optional: an
 *   older wiring passes none, and the row then renders no mirror rather than a state it cannot know.
 * @returns {any} a React element
 */
export function UiPluginsSection(props) {
  const { store, t, React } = props
  /*
   * The namespace, with a defensive empty object. A dictionary that predates this page is a real case
   * — copy added in one version, read in another — and rendering blanks is the outcome worth avoiding.
   * Throwing is worse, so the fallbacks below carry the meaning instead.
   */
  const copy = t.plugins ?? {}
  /** A dictionary older than a project kind shows the raw kind rather than a blank badge. */
  const kinds = copy.kinds ?? {}
  const React_ = React
  if (typeof React_?.useState !== 'function') {
    // The same diagnosis the projects page carries: this component is only ever reached through the
    // module table, so a missing react binding is a bundling fault rather than a render fault.
    throw new Error(
      '[dsh-ui-projects] Settings UI plugins needs the React runtime from the shell, but resolved ' +
        (React_ === null ? 'null' : typeof React_),
    )
  }
  /*
   * SUBSCRIBING IS THE POINT OF THIS BLOCK. The store publishes a new state object on every change,
   * and a render that reads it once and never subscribes never learns that anything changed: the
   * column sat on `loading` in a real browser for exactly that reason, while every offline test
   * passed, because those tests seed a state and never need an update.
   *
   * Mirrors `panel.js` on purpose: the same guard, the same seed from `props.state` for a caller that
   * already holds a snapshot, the same `useEffect` + `store.subscribe`.
   */
  const [live, setLive] = React_.useState(() => props.state ?? store.state())
  /*
   * §五's 启用开关, as a MIRROR: the projects page owns the switches, this column owns packages, and a
   * second switch here would be a second writer for one state. So it reads the projects store and says
   * where the switch actually lives. No store means no mirror (an older wiring), never a guessed state.
   */
  const projects = props.projects
  const [projectsLive, setProjectsLive] = React_.useState(() =>
    typeof projects?.state === 'function' ? projects.state() : undefined,
  )
  React_.useEffect(() => {
    if (props.state !== undefined) return undefined
    setLive(store.state())
    const offLive = store.subscribe(() => setLive(store.state()))
    const offProjects =
      typeof projects?.subscribe === 'function' ? projects.subscribe(() => setProjectsLive(projects.state())) : undefined
    return () => {
      offLive()
      offProjects?.()
    }
  }, [store, props.state, projects])

  const header = React_.createElement(
    'header',
    { className: 'uip-header', key: 'header' },
    React_.createElement('div', null, React_.createElement('h2', { className: 'uip-title' }, copy.title)),
    React_.createElement(
      'div',
      { className: 'uip-actions' },
      React_.createElement(
        'button',
        {
          type: 'button',
          className: 'uip-button',
          'data-uip-plugins-action': 'refresh',
          onClick: () => void store.refresh(),
        },
        copy.refresh,
      ),
    ),
  )

  const intro = React_.createElement('p', { className: 'uip-intro', key: 'intro' }, copy.intro)

  /*
   * THE UPDATE CHECK IS ASKED FOR HERE TOO (phase 3, step 1; extended by D2).
   *
   * A render-time side effect, like the listing's own trigger and for the same reason: this slot API has
   * no mount hook. `idle` is the guard, so a double render, a remount or a second visit asks nothing
   * more — and the guard now lives in the STORE as well (`installed.js`, `loadUpdates`), because a
   * second caller exists.
   *
   * THE TWO TRIGGERS ARE NOT THE SAME QUESTION, which is why they are separate calls in separate files:
   *
   *   · the LISTING (`/installed.json`) is on demand only — asked when the section renders
   *     (`src/client/index.js`), because fetching it at boot would be a request for a page most sessions
   *     never open;
   *   · the UPDATE CHECK (`/updates.json`) is additionally armed for AFTER THE FIRST FRAME
   *     (`src/client/index.js`, `installedStore.deferUpdateCheck()`), because the spec asks for a check
   *     after startup and never for a blocked first screen. Whoever asks first wins; the store makes the
   *     second ask a no-op.
   */
  if (live.status === 'ready' && typeof store.loadUpdates === 'function' && store.updates?.().status === 'idle') {
    void store.loadUpdates()
  }
  if (live.status === 'idle' || live.status === 'loading') {
    return React_.createElement(
      'section',
      { className: 'uip-section', 'data-uip-plugins': live.status },
      header,
      intro,
      React_.createElement('p', { className: 'uip-hint', key: 'loading' }, copy.loading),
    )
  }

  if (live.status === 'failed') {
    return React_.createElement(
      'section',
      { className: 'uip-section', 'data-uip-plugins': 'failed' },
      header,
      intro,
      React_.createElement(
        'p',
        { className: 'uip-error', key: 'failed', 'data-uip-plugins-error': '' },
        copy.failed(live.error ?? ''),
      ),
      React_.createElement('p', { className: 'uip-hint', key: 'failedhint' }, copy.failedHint),
    )
  }

  /*
   * THE MERGE HAPPENS HERE, ONCE, and it is why a row can carry a channel and an update without a fixture
   * having pre-merged them: the scan says what is installed, the settings record says which channel each
   * package is on, and the store says what the registry answered.
   */
  const channels = props.channels
  const scan = mergeUpdates(live.scan, channels?.record?.(), store.updates?.().payload ?? { results: [] })
  /** The framework's own row is the thing rendering this list: it is not removable from itself. */
  const rows = scan.dependencies.map((dependency) => {
    /*
     * THE CONTRACT STATE IS COMPUTED ONCE PER ROW, here, and the badge and the panel both read it — two
     * derivations of one question is how a row ends up claiming two different things.
     */
    const contractState = contractStateOf(dependency)
    /*
     * THE SECOND QUESTION, ON ITS OWN ATTRIBUTE (E1b). `compat` is produced by the scan
     * (`profile-scan.js`), passed through unchanged by the endpoint (`installed-endpoint.js:74`), and
     * `'unknown'` is the answer for a package that declares no project — not the same sentence as broken.
     */
    const apiState = apiVersionStateOf(dependency)
    const contractBadge = React_.createElement(
      'span',
      {
        className: 'uip-badge' + (contractState === 'ok' ? ' uip-badge-ok' : contractState === 'warn' ? ' uip-badge-warn' : ''),
        key: 'contract',
        'data-uip-contract': contractState,
      },
      contractBadgeText(copy, contractState, dependency.contract),
    )
    /*
     * §五's row facts, and the three states each of them can be in. `hasProject` is "the package
     * declares a project", which decides whether the four project metadata chips exist at all; a
     * package that declares none gets no meta row rather than four "not declared" chips, because
     * "this package has no project" and "its project declares nothing" are different sentences.
     */
    const hasProject = dependency.uiProject !== null && dependency.uiProject !== undefined
    const project = projectStateOf(projectsLive, dependency.projectId)
    const previewKind = previewKindOf(dependency.uiProject?.preview)
    return React_.createElement(
      'li',
      {
        className: 'uip-plugin',
        key: dependency.name,
        'data-uip-plugin': dependency.name,
        // Three states, not two: "a URL to fetch", "a CSS material to paint", "declares none". The
        // stylesheet keys the preview column off this, so a row without one has no empty gutter.
        'data-uip-preview': previewKind,
        // A SEPARATE attribute from `data-uip-contract`: two questions, two answers, neither folded
        // into the other's enum.
        'data-uip-api-version': apiState,
        /*
         * AND THE SENTENCE, FROM THE LOCALE TABLE (E1b). Without this the attribute was the only trace of
         * the verdict, and a reader hovering the row got nothing: the mark existed for the stylesheet, not
         * for a person. Read from `copy`, never a literal, so both languages come from `locale.js`.
         */
        title: apiState === 'unsupported' ? copy.apiUnsupported : undefined,
      },
      previewKind === 'none'
        ? null
        : createPreview({
            R: React_,
            project: {
              preview: dependency.uiProject?.preview,
              previewLabel: dependency.uiProject?.previewLabel,
              name: dependency.name,
            },
            t: copy,
          }),
      React_.createElement(
        'div',
        { className: 'uip-plugin-body' },
        React_.createElement(
          'div',
          { className: 'uip-plugin-head' },
          React_.createElement('span', { className: 'uip-plugin-name' }, dependency.name + '@' + (dependency.version ?? '?')),
          React_.createElement('span', { className: 'uip-badge' }, kinds[dependency.kind] ?? dependency.kind),
          dependency.bundled
            ? React_.createElement('span', { className: 'uip-badge' }, copy.composed)
            : React_.createElement('span', { className: 'uip-badge uip-badge-warn' }, copy.notComposed),
          dependency.name === 'dsh-ui-projects'
            ? React_.createElement('span', { className: 'uip-badge' }, copy.framework)
            : null,
          contractBadge,
          /*
           * THE UPDATE DOT (phase 3, step 1). A package whose channel's dist-tag holds something newer
           * than what is installed gets a dot and a channel read-out — and that is ALL it gets here: the
           * command that would install it is printed inside the fold below, like every other command in
           * this column, because this page never runs anything.
           *
           * The dot is absent when there is nothing new, and absent when a check FAILED — a registry this
           * machine cannot reach must not read as "up to date", which is why the data layer carries the
           * reason and the row renders nothing rather than a reassuring blank.
           */
          dependency.update?.available === true
            ? React_.createElement(
                'span',
                { className: 'uip-badge uip-badge-warn', key: 'update', 'data-uip-update': dependency.name },
                copy.updateAvailable(dependency.update.tag),
              )
            : null,
          /*
           * THE CHANNEL IS A CONTROL, not a read-out (phase 3, step 1): stable/beta/canary, the chosen one
           * selected, and a change written straight into `settings['<pkg>'].channel` through the adapter —
           * which is the same record the host half reads when it decides which dist-tag to compare
           * against. The write is followed by a re-render token, because a controlled select that reverted
           * on the next render would be a control that looks broken.
           */
          React_.createElement(
            'select',
            {
              className: 'uip-badge uip-select',
              key: 'channel',
              'data-uip-channel': dependency.name,
              'data-uip-value': dependency.channel ?? 'stable',
              /*
               * UNCONTROLLED, and deliberately: `defaultValue` shows the chosen channel and keeps showing
               * what the user picked, while a controlled `value` would need a re-render on every change —
               * which would mean a hook in this component, and a hook here shifts the `useState` index the
               * fake-React tests force by position. The record is written either way; the dot catches up
               * on the next render.
               */
              defaultValue: dependency.channel ?? 'stable',
              'aria-label': copy.channelLabel(dependency.channel ?? 'stable'),
              onChange: (event) => {
                void Promise.resolve(channels?.write?.(dependency.name, event?.target?.value)).catch(() => {})
              },
            },
            CHANNELS.map((channel) => React_.createElement('option', { key: channel, value: channel }, copy.channelLabel(channel))),
          ),
        ),
        /*
         * THE DEFAULT ROW: preview, name, badges, one line of description, and one fold. Nothing else.
         *
         * A field with no value renders NOTHING — no "not declared", no empty line. A package that
         * declares nothing says nothing about it, and eight rows of "not declared" is a page nobody
         * reads.
         */
        ...RowHeadFacts({ copy, React: React_, dependency }),
        React_.createElement(
          'details',
          { className: 'uip-plugin-details', 'data-uip-row-details': dependency.name, open: false },
          React_.createElement('summary', { className: 'uip-hint', 'data-uip-fold-summary': 'row-details' }, copy.rowDetails),
          /*
           * THE UPDATE, AS A COMMAND. `add <pkg>@<tag>` is how a channel is acted on: `dsh plugin` is a
           * pnpm forwarder, and pnpm takes the dist-tag in the package SPEC rather than behind a flag —
           * so the channel a user picked is visible in the command they are about to run.
           */
          dependency.update?.available === true
            ? React_.createElement(
                'div',
                { className: 'uip-update', key: 'update-command' },
                React_.createElement(
                  'p',
                  { className: 'uip-hint' },
                  copy.updateHint(dependency.version ?? '?', dependency.update.latest ?? '?'),
                ),
                React_.createElement(CommandRow, {
                  copy,
                  React: React_,
                  kind: 'update-channel',
                  source: 'dsh plugin --profile ' + scan.profileName + ' add ' + dependency.name + '@' + dependency.update.tag,
                }),
              )
            : null,
          ...UpgradeCheck({ copy, React: React_, dependencies: scan.dependencies, profileName: scan.profileName }),
          ...ChecklistBlock({
            copy,
            React: React_,
            dependency,
            onToggle: (name, itemId, checked) => {
              void Promise.resolve(props.channels?.writeChecklist?.(name, itemId, checked)).catch(() => {})
            },
          }),
          ...RowFoldFacts({ copy, React: React_, dependency, hasProject, project, mirrorAvailable: projectsLive !== undefined }),
          ...(dependency.problems ?? []).map((problem, index) =>
            React_.createElement('p', { className: 'uip-error', key: 'problem-' + index }, problem.code + ': ' + problem.message),
          ),
          /*
           * THE ORDER IS THE READER'S, not the payload's: who made it, what the contract found, how to
           * maintain it, how to remove it, what changed. Every one of them is folded, and every one of
           * them starts folded — opening the row must not open four panels with it.
           *
           * THE FRAMEWORK'S ROW OPENS TOO (9b review). Its badge stays `na` — the contract is not a rule
           * the instrument is measured by — but declining to render the panel hid two findings that ARE
           * in the payload, and a reader who never runs the CLI could not see them. So the row explains
           * itself: the summary says the contract does not apply, the findings are listed, and a note
           * says they are recorded rather than fixed. `na` is a judgement about the BADGE; silence was a
           * different claim.
           */
          ContractPanel({
            copy,
            React: React_,
            name: dependency.name,
            state: contractState,
            contract: dependency.contract,
          }),
          /*
           * THE MAINTENANCE BLOCK IS FOR EVERY ROW, the framework's included.
           *
           * 7d-1 put it inside `CommandBlock`, which this row skips for the framework — so the package that
           * most needs `-Snapshot`/`-Update`/`-Rollback` (updating and rolling back the framework is the
           * ordinary case) was the one row without them. What the framework must not carry is a REMOVAL
           * command, because it is the thing rendering this list; maintenance is not removal.
           */
          MaintenanceBlock({ copy, React: React_, name: dependency.name }),
          dependency.name === 'dsh-ui-projects'
            ? null
            : CommandBlock({ copy, React: React_, name: dependency.name, profileName: scan.profileName }),
          /*
           * LAST, because it is the longest thing a row can hold and the least often read: §五's
           * CHANGELOG, folded, and fetched only when a reader opens it.
           */
          ChangelogBlock({
            copy,
            React: React_,
            dependency,
            state: typeof store.changelog === 'function' ? store.changelog(dependency.name) : undefined,
            onToggle: createChangelogToggle(store, dependency.name),
          }),
        ),
      ),
    )
  })

  return React_.createElement(
    'section',
    { className: 'uip-section', 'data-uip-plugins': 'ready' },
    header,
    intro,
    (scan.orphanedBindings ?? []).length > 0
      ? React_.createElement('p', { className: 'uip-error', key: 'orphans' }, copy.orphaned(scan.orphanedBindings.join(', ')))
      : null,
    rows.length === 0
      ? React_.createElement('p', { className: 'uip-hint', key: 'empty' }, copy.empty)
      : React_.createElement('ul', { className: 'uip-list', key: 'list' }, rows),
  )
}

/**
 * One row's CHANGELOG, folded away.
 *
 * TWO SOURCES, and they are different facts rather than one read twice: the SUMMARY's heading arrives
 * with the listing (the host reads the first 64 KB of each package's file during the scan), while the
 * BODY arrives from the store when a reader opens the row. A block that took both from one place could
 * not tell a broken summary from a broken body, and the suite stubs them separately for that reason.
 *
 * The body is package-supplied TEXT — a changelog is not written by this project — so it is rendered as
 * text and never as markup. React escapes it, and the suite asserts that with a `<script>` line.
 */
function ChangelogBlock({ copy, React, dependency, state, onToggle }) {
  const status = state?.status ?? 'idle'
  const payload = status === 'ready' ? state.payload : undefined
  const sections = Array.isArray(payload?.sections) ? payload.sections : []
  let body
  if (status === 'failed') {
    body = React.createElement('p', { className: 'uip-error' }, copy.changelogFailed(state.error ?? ''))
  } else if (payload !== undefined && payload.reason !== null && payload.reason !== undefined) {
    body = React.createElement('p', { className: 'uip-hint' }, changelogReasonText(copy, payload, dependency.name))
  } else if (sections.length > 0) {
    body = sections.map((section, index) =>
      React.createElement(
        'div',
        { className: 'uip-plugin-changelogSection', key: 'section-' + index },
        // The heading is NOT repeated here: the summary above already names the section, and printing it
        // twice is the first thing a reader notices inside a fold.
        React.createElement('pre', { 'data-uip-changelog-body': dependency.name }, section.lines.join('\n')),
        section.truncated
          ? React.createElement('p', { className: 'uip-hint' }, copy.changelogTruncated(section.moreLines))
          : null,
      ),
    )
  } else {
    /*
     * Nothing has been asked for yet, or the ask is still in flight. The body is hidden until the row is
     * opened, so this is what a reader sees when they open it faster than the host can answer.
     */
    body = React.createElement('p', { className: 'uip-hint' }, copy.changelogLoading)
  }
  /*
   * THE SUMMARY IS THE ONLY PLACE THE HEADING APPEARS, and it reads `CHANGELOG · 1.0.0 — Step 8c`: the
   * version because a changelog belongs to a version, and the heading with its `##` markdown taken off
   * and cut at sixty characters because a heading is a line rather than a paragraph.
   */
  const heading =
    typeof dependency.changelogHeading === 'string' && dependency.changelogHeading.length > 0 ? dependency.changelogHeading : null
  const parts = [copy.changelogTitle]
  if (typeof dependency.version === 'string' && dependency.version.length > 0) parts.push(dependency.version)
  const label =
    heading === null
      ? parts.join(' · ')
      : parts.join(' · ') + ' — ' + truncate(heading.replace(/^#+\s*/, ''), CHANGELOG_SUMMARY_CHARS)
  return React.createElement(
    'details',
    { className: 'uip-plugin-changelog', 'data-uip-changelog': dependency.name, open: false },
    React.createElement(
      'summary',
      { className: 'uip-hint', 'data-uip-changelog-summary': dependency.name, 'data-uip-fold-summary': 'changelog', onClick: onToggle },
      label,
    ),
    body,
  )
}

/**
 * The sentence for a reason code that is not a section list.
 *
 * The CODE is the host's, the words are this page's: `install.ps1` prints English, the settings page is
 * bilingual, and a sentence assembled on the host could not be translated here.
 */
function changelogReasonText(copy, payload, name) {
  switch (payload.reason) {
    case 'no-file':
      return copy.changelogNoFile
    case 'no-sections':
      return copy.changelogNoSections
    case 'not-installed':
      return copy.changelogNotInstalled(name)
    default:
      return copy.changelogUnreadable(payload.detail ?? '')
  }
}

/**
 * The click handler for a row's changelog summary.
 *
 * WHY `onClick` ON THE SUMMARY, and not a `toggle` listener: the `toggle` event neither bubbles nor
 * exists as a React synthetic event, so `<details onToggle>` would be a control that looks wired and
 * reads nothing. The summary is what a reader clicks or presses Enter on, and it is where a plain
 * handler works.
 *
 * `open` is read BEFORE the browser flips it — a summary click toggles after the handler runs — so
 * `open === false` means this click is the one that opens the row. A click that CLOSES it is ignored
 * rather than re-asked: the store would answer from its cache anyway, but a handler that fired on every
 * click would leave the cache as the only thing between a reader and a request per click.
 * @param {{ loadChangelog?: (name: string) => Promise<void> }} store
 * @param {string} name
 */
export function createChangelogToggle(store, name) {
  return (event) => {
    const details = event?.currentTarget?.parentElement
    if (details !== undefined && details !== null && details.open === true) return
    void store?.loadChangelog?.(name)
  }
}

/**
 * THE DEFAULT VIEW: the description line, and the project the package contributes.
 *
 * A field with no value renders NOTHING — no "not declared", no empty row. The previous version
 * reported every absence in words, which turned a column of five packages into a column of thirty
 * sentences and buried the one thing a reader needs (which fields matter for THIS package). Absence is
 * legible as absence; eight lines of "not declared" is a page nobody reads.
 *
 * `hostFieldMissing` survives for exactly one case: the KEY is missing from the payload, which means
 * the running dsh is older than this page. That is a fact about the host rather than about the
 * package, and silence there would leave a reader to guess.
 */
function RowHeadFacts({ copy, React, dependency }) {
  const fields = []
  if (typeof dependency.description === 'string' && dependency.description.length > 0) {
    fields.push(
      React.createElement(
        'p',
        { className: 'uip-description', key: 'description', 'data-uip-field': 'description' },
        // One line, cut at 80 characters: a package with a 400-character description must not be able to
        // make every other row unreadable. The full sentence stays in `package.json`, where it belongs.
        truncate(dependency.description, DESCRIPTION_CHARS),
      ),
    )
  } else if (dependency.description === undefined) {
    fields.push(
      React.createElement('p', { className: 'uip-hint', key: 'description', 'data-uip-field': 'description' }, copy.hostFieldMissing('description')),
    )
  }
  return fields
}

/**
 * THE FOLDED HALF: the author, the project's declared metadata, and the switch mirror.
 *
 * The four chips render ONLY when they have a value, and `priority` needs one rule beyond that: it is
 * a number for an enhancement and means nothing for a skin, which is alone by policy and never sorted
 * (`panel.js` states the same rule and hides the badge there). A skin's priority is therefore simply
 * not shown — the sentence that used to stand in its place ("enhancements only") was a sentence about
 * the vocabulary rather than about the package, and this column no longer prints those.
 */
function RowFoldFacts({ copy, React, dependency, hasProject, project, mirrorAvailable }) {
  const fields = []
  if (typeof dependency.author === 'string' && dependency.author.length > 0) {
    fields.push(React.createElement('p', { className: 'uip-hint', key: 'author', 'data-uip-field': 'author' }, copy.author(dependency.author)))
  } else if (dependency.author === undefined) {
    fields.push(React.createElement('p', { className: 'uip-hint', key: 'author', 'data-uip-field': 'author' }, copy.hostFieldMissing('author')))
  }
  /*
   * The project id moved in here with the layout redo: the default row answers "what is this package",
   * and which project it contributes is the first thing a reader wants when they open it.
   */
  if (dependency.projectId !== undefined) {
    fields.push(
      React.createElement(
        'p',
        { className: 'uip-hint', key: 'project', 'data-uip-project-id': dependency.projectId },
        copy.project(dependency.projectId),
      ),
    )
  }

  if (hasProject) {
    const declared = dependency.uiProject
    const chips = []
    if (declared.perfLevel !== null && declared.perfLevel !== undefined) {
      chips.push(metaChip(React, 'perfLevel', declared.perfLevel, copy.perf?.[declared.perfLevel] ?? declared.perfLevel))
    }
    if (declared.type === 'enhancement' && declared.priority !== null && declared.priority !== undefined) {
      chips.push(metaChip(React, 'priority', declared.priority, copy.priority(declared.priority)))
    }
    if (declared.modifies !== null && declared.modifies !== undefined) {
      chips.push(
        metaChip(React, 'modifies', declared.modifies, copy.modifies(declared.modifies.map((region) => copy.regions?.[region] ?? region))),
      )
    }
    if (declared.requires !== null && declared.requires !== undefined) {
      chips.push(metaChip(React, 'requires', declared.requires, copy.requires(declared.requires)))
    }
    if (chips.length > 0) {
      fields.push(React.createElement('div', { className: 'uip-plugin-meta', key: 'meta', 'data-uip-meta-row': '' }, chips))
    }
  }

  /*
   * THE MIRROR, and the one thing it must never do is invent a state. `absent` is a real answer —
   * installed, but this session never registered its client half — and it is not "off".
   */
  if (dependency.projectId !== undefined && mirrorAvailable) {
    const name = project?.name ?? dependency.projectId
    const state = project?.state ?? 'absent'
    fields.push(
      React.createElement(
        'p',
        {
          className: 'uip-hint',
          key: 'mirror',
          'data-uip-project-mirror': dependency.projectId,
          'data-uip-project-state': state,
        },
        state === 'absent'
          ? copy.projectNotRegistered(dependency.projectId)
          : (state === 'on' ? copy.projectOn(name) : copy.projectOff(name)) + ' · ' + copy.changeInUiPage,
      ),
    )
  }
  return fields
}

/**
 * One project-metadata chip: the state in a `data-uip-value` hook, the sentence from the dictionary.
 *
 * The hook carries the RAW value — the declared tier, the number, the region ids — rather than what
 * the row painted, so a test can assert the state without asserting the current spelling of a
 * sentence.
 */
function metaChip(React, kind, value, text) {
  const declared =
    value === null || value === undefined ? {} : { 'data-uip-value': Array.isArray(value) ? value.join(',') : String(value) }
  return React.createElement('span', { className: 'uip-badge', key: kind, 'data-uip-meta': kind, ...declared }, text)
}

/**
 * Copy one command to the clipboard, and report which of three things happened.
 *
 * THREE STEPS, in order of preference, because a copy button that silently does nothing is worse than
 * no button at all:
 *
 *   1. `navigator.clipboard.writeText` — the supported API, and available on the origins this page is
 *      served from (`127.0.0.1` and `localhost` are secure contexts)
 *   2. a hidden `<textarea>` and `document.execCommand('copy')` — the deprecated path, for a page that
 *      is not in a secure context (Electron over `file://` is the case this project has to keep working)
 *   3. `'failed'` — the caller renders "select it and copy by hand", so the reader is never left
 *      wondering whether the click landed
 *
 * NOTHING IS EVER EXECUTED: the command is text that goes to the clipboard, and no code path here
 * reaches a shell. The suite asserts that this module contains no `spawn`/`exec` at all.
 * @param {string} source
 * @returns {Promise<'copied'|'failed'>}
 */
export async function copyCommandText(source) {
  try {
    if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(source)
      return 'copied'
    }
  } catch {
    /* the API exists and refused (permissions, focus): try the legacy path before giving up */
  }
  try {
    const area = document.createElement('textarea')
    area.value = source
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied === true ? 'copied' : 'failed'
  } catch {
    return 'failed'
  }
}

/** How long a button says "copied" (or "copy failed") before it goes back to "Copy". */
export const COPY_FEEDBACK_MS = 1500

/** How many characters of a package's DESCRIPTION the default row keeps. */
export const DESCRIPTION_CHARS = 80

/** How many characters of a CHANGELOG heading the folded summary keeps. */
export const CHANGELOG_SUMMARY_CHARS = 60

/**
 * Cut a string to `limit` characters, with an ellipsis when it was longer.
 *
 * Used wherever a package's own text can be arbitrarily long — its description line and a changelog
 * heading — because the row is a list, and one package with a 400-character description must not be
 * able to make every other row unreadable. `limit` counts the characters KEPT, so the marker never
 * pushes the result past what a caller asked for.
 * @param {unknown} text @param {number} limit
 */
export function truncate(text, limit) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= limit ? value : value.slice(0, limit) + '…'
}

/** What a copy button says for each state. Pure, so the three labels are pinned without a renderer. */
export function copyLabelFor(state, copy) {
  if (state === 'copied') return copy.copyDone
  if (state === 'failed') return copy.copyFailed
  return copy.copyCommand
}

/**
 * One command and its copy button.
 *
 * THE BUTTON COMES FIRST, then the command: a reader scanning the column sees the control in the same
 * place on every line, and the command — which is long and wraps — hangs off it.
 *
 * `data-uip-copy-source` carries the command ITSELF, so the suite can assert the button copies exactly
 * the line printed beside it rather than a second string that happens to look the same — the defect
 * this project has already paid for once, when one command was written out twice in one row.
 *
 * THE FEEDBACK IS TEMPORARY, AND THE TIMER IS OWNED. "Copied" that stays for ever is a button a reader
 * cannot use twice without wondering whether the second click landed; and a timer that outlives the
 * component is a `setState` on something that no longer exists. So: one effect, one ref, one cleanup.
 * The button is never disabled — a copy button that stops accepting clicks reads as broken.
 */
/**
 * THE UPGRADE CHECK (`UI第三阶段.txt:37-40`): the packages this dsh cannot run, and the TWO things a
 * reader can really do about it.
 *
 * A PLAIN FUNCTION, deliberately: the file's hook-bearing functions are named and asserted
 * (`verify.mjs:4530` lists exactly `UiPluginsSection` and `CommandRow`), so a list that needs no state
 * must not take any.
 *
 * WHAT IS HONEST HERE. Updating is a COMMAND, printed and never run — `dsh plugin` is a pnpm forwarder
 * and the tag belongs in the package spec, the same rule the update row already follows. Turning a
 * package OFF is the loader's job, so the row offers the project switch this plugin can really flip
 * (`data-uip-disable-project`) and the `remove` command as text. Postponing the dsh upgrade is a
 * sentence, not a button: nothing in this plugin can roll back a host, and a control that pretended to
 * would be the one lie this block could tell.
 *
 * `kind` is a free string on `CommandRow` (it becomes `data-uip-copy`, `panel-plugins.js:725-726`), which
 * is why the two new commands carry names of their own.
 * @param {{ copy: any, React: any, dependencies: any[], profileName?: string }} input
 * @returns {any[] | null}
 */
function UpgradeCheck({ copy, React: React_, dependencies, profileName }) {
  const broken = (dependencies ?? []).filter((dependency) => dependency?.uiProject?.compat === 'unsupported')
  /*
   * ALWAYS AN ARRAY, never `null`: the caller spreads the result (`...UpgradeCheck({…})`), and `...null`
   * throws `TypeError: null is not iterable` — measured 2026-09-30, where it took 25 unrelated tests down
   * with it. An empty list is the honest empty answer.
   */
  if (broken.length === 0) return []
  return [
    React_.createElement(
      'div',
      { className: 'uip-upgrade-check', key: 'upgrade-check', 'data-uip-upgrade-check': 'rows' },
      React_.createElement('p', { className: 'uip-hint' }, copy.upgradeCheckTitle),
      React_.createElement('p', { className: 'uip-hint' }, copy.upgradeCheckHint),
      React_.createElement(
        'ul',
        { className: 'uip-upgrade-list' },
        broken.map((dependency) =>
          React_.createElement(
            'li',
            { key: dependency.name, 'data-uip-upgrade-row': dependency.name },
            dependency.name + '@' + (dependency.version ?? '?') + ' — ' + copy.upgradeCheckIncompatible,
            dependency.update?.available === true
              ? React_.createElement(CommandRow, {
                  copy,
                  React: React_,
                  kind: 'update-package',
                  source: 'dsh plugin --profile ' + profileName + ' add ' + dependency.name + '@' + dependency.update.tag,
                })
              : React_.createElement('span', { className: 'uip-hint' }, copy.upgradeCheckCurrent),
            React_.createElement(
              'span',
              { className: 'uip-hint', 'data-uip-disable-project': dependency.projectId ?? dependency.name },
              copy.disableProjectHint,
            ),
            React_.createElement('p', { className: 'uip-hint' }, copy.removePackageHint),
            React_.createElement(CommandRow, {
              copy,
              React: React_,
              kind: 'remove-package',
              source: 'dsh plugin --profile ' + profileName + ' remove ' + dependency.name,
            }),
            React_.createElement('p', { className: 'uip-hint' }, copy.upgradeDeferredNote),
          ),
        ),
      ),
    ),
  ]
}

/*
 * The ten checklist items come from the CLIENT MIRROR, never from the host module: the two halves are
 * separate bundles (`checklist-items.js` says so at length), and the suite holds the mirror equal to
 * `src/host/test-checklist.js` item by item. Declared here rather than at the top only because this is
 * where the change landed; ESM hoists imports.
 */
import { CHECKLIST_ITEMS } from './checklist-items.js'

/**
 * THE TEN-ITEM TEST CHECKLIST, rendered in a row's fold (`UI第三阶段.txt:51-57`).
 *
 * A PLAIN FUNCTION, and it MUST return an ARRAY: the caller spreads the result
 * (`...ChecklistBlock({ … })`), and a `null` return would throw
 * `TypeError: null is not iterable` — measured 2026-09-30, where exactly that mistake took 25 unrelated
 * tests down with it. The file's hook-bearing functions are named and asserted
 * (`verify.mjs:4530`: `['UiPluginsSection', 'CommandRow']`), so a list that needs no state must not take
 * any — the state lives in the user's settings record, and a click writes it back through the adapter.
 *
 * `null` AND `{}` RENDER THE SAME, BY DECISION (2026-09-30): both mean "nothing is confirmed yet", and a
 * row that distinguished "never started" from "started, zero items" would be making a distinction the
 * person looking at it cannot act on. The count is always `confirmed/10`.
 *
 * EVERYTHING VISIBLE COMES FROM THE TABLE: the item ids and `labelKey`s from the mirror, the sentences
 * from `copy` (i.e. `locale.js`, in both languages) — this function prints no literal of its own.
 * @param {{ copy: any, React: any, dependency: any, onToggle?: (name: string, itemId: string, checked: boolean) => void }} input
 * @returns {any[]}
 */
function ChecklistBlock({ copy, React: React_, dependency, onToggle }) {
  const record = dependency?.checklist
  const confirmed = CHECKLIST_ITEMS.filter((item) => record?.[item.id] === true).length
  return [
    React_.createElement(
      'div',
      { className: 'uip-checklist', key: 'checklist', 'data-uip-checklist': dependency?.name },
      React_.createElement(
        'p',
        { className: 'uip-hint' },
        copy.checklistTitle + ' — ' + confirmed + '/' + CHECKLIST_ITEMS.length,
      ),
      React_.createElement('p', { className: 'uip-hint' }, copy.checklistHint),
      React_.createElement(
        'ul',
        { className: 'uip-checklist-list' },
        CHECKLIST_ITEMS.map((item) =>
          React_.createElement(
            'li',
            { key: item.id, 'data-uip-checklist-item': item.id },
            React_.createElement('input', {
              type: 'checkbox',
              checked: record?.[item.id] === true,
              onChange: (event) => onToggle?.(dependency?.name, item.id, event?.target?.checked === true),
            }),
            React_.createElement('span', { className: 'uip-hint' }, copy[item.labelKey]),
          ),
        ),
      ),
    ),
  ]
}

function CommandRow({ copy, React, kind, source, hook }) {
  const [state, setState] = React.useState('idle')
  const timer = React.useRef(undefined)
  React.useEffect(() => {
    if (state === 'idle') return undefined
    timer.current = setTimeout(() => setState('idle'), COPY_FEEDBACK_MS)
    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = undefined
    }
  }, [state])
  return React.createElement(
    'div',
    { className: 'uip-commandRow' },
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'uip-button uip-copyButton',
        'data-uip-copy': kind,
        'data-uip-copy-source': source,
        'aria-label': copy.copyCommand + ': ' + source,
        onClick: () => {
          void copyCommandText(source).then((outcome) => setState(outcome))
        },
      },
      copyLabelFor(state, copy),
    ),
    React.createElement('pre', hook ?? null, source),
  )
}

/**
 * The project's live state, for the read-only mirror: on, off, or absent from this session.
 *
 * Read from the projects store's snapshot, which is the registry — so "on" here means the same thing
 * the projects page's switch shows, because it is the same fact rather than a copy of it.
 */
function projectStateOf(snapshot, projectId) {
  if (projectId === undefined) return undefined
  const found = (snapshot?.projects ?? []).find((entry) => entry.id === projectId)
  if (found === undefined) return { id: projectId, state: 'absent' }
  return { id: projectId, state: found.enabled === true ? 'on' : 'off', name: found.name }
}

/**
 * Which of the four contract states a row is in.
 *
 *   ok    the scanner read the bundle and found nothing
 *   warn  it read the bundle and found something (the panel says what)
 *   none  nothing was read — four different host answers: not installed, no client half, no bundle on
 *         disk, or a bundle over the scan cap. They share a state because they share a consequence (no
 *         judgement), and they are told apart by the REASON printed under it, which is the host's own.
 *   na    not judged on purpose: the framework's own row is the instrument, not a package anybody
 *
 * A host older than step 9a sends no `contract` at all; that is `none` with no reason, and the panel's
 * copy says so about the HOST rather than about the bundle. `scanned !== true` rather than `!scanned`
 * because a payload from an older 9a host could omit it, and "absent" must not read as "clean".
 */
function contractStateOf(dependency) {
  if (dependency.name === 'dsh-ui-projects') return 'na'
  const contract = dependency.contract
  if (contract === null || typeof contract !== 'object') return 'none'
  if (contract.scanned !== true) return 'none'
  return (contract.findings ?? []).length > 0 ? 'warn' : 'ok'
}

/**
 * `ok` | `unsupported` | `unknown`, read straight off the subset the scan produced.
 *
 * A DIFFERENT QUESTION from the contract state above, and deliberately a different attribute on the row
 * (`data-uip-api-version` beside `data-uip-contract`): "can this dsh run the plugin API the package
 * declares" is not "did the static contract scan pass", and folding the two into one enum would make one
 * of them unreadable. `unknown` covers a package that declares no project at all — the same answer the
 * scan gives (`profile-scan.js`), so the two halves cannot disagree.
 * @param {any} dependency
 */
function apiVersionStateOf(dependency) {
  const compat = dependency?.uiProject?.compat
  return compat === 'ok' || compat === 'unsupported' ? compat : 'unknown'
}

/** The badge's text: one sentence per state, from the dictionary — this file spells none of it. */
function contractBadgeText(copy, state, contract) {
  if (state === 'na') return copy.contractNotApplicable
  if (state === 'warn') return copy.contractWarn((contract?.findings ?? []).length)
  if (state === 'ok') return copy.contractOk
  return copy.contractNotScanned
}

/**
 * The row's contract panel: how much of the contract was covered, what was found, and what the instrument
 * cannot see.
 *
 * RENDERED FOR A GREEN ROW TOO, and that is the design rather than thoroughness: an unexpanded panel beside
 * a green badge reads as "this plugin is fine", and the limits are the sentence that stops it — rule 3 is
 * not scanned at all, and a violation written inside an event handler is invisible to a scan that only
 * reads text.
 *
 * THE FINDINGS ARE THE HOST'S OWN ENGLISH, rendered verbatim. They are the output of a measurement, and a
 * localized paraphrase of a measurement is a second instrument with no calibration.
 *
 * `null` when there is nothing true to print. A judged row whose host sent no rule counts (a host between
 * 9a and 9b, before the counts existed) still gets its panel, with the badge's own sentence standing in for
 * the coverage line — repeating that sentence is the one summary that cannot disagree with the badge above
 * it — because dropping the panel there would drop the LIMITS, which are the part that matters most.
 */
function ContractPanel({ copy, React, name, state, contract }) {
  const findings = contract?.findings ?? []
  const limits = contract?.limits ?? []
  const rules = contract?.rules
  /** The framework's own row: not judged by the contract, and still shown what the scan found. */
  const framework = state === 'na'
  const covered =
    typeof rules?.judged === 'number' && typeof rules?.total === 'number' ? copy.contractCoverage(rules.judged, rules.total) : null
  let detail = covered
  if (state === 'none') detail = copy.contractNotScannedWhy(contract?.reason)
  else if (framework) detail = copy.contractFramework(findings.length)
  else if (detail === null) detail = contractBadgeText(copy, state, contract)
  if (detail === null || detail === undefined || detail === '') return null
  /*
   * ALWAYS FOLDED, AND THE TITLE IS A LABEL RATHER THAN A SENTENCE.
   *
   * The panel used to open itself when the scan found something, which pushed the rest of the row off
   * the screen: a row that answers a question nobody asked yet stops being a row. The verdict is
   * already on the badge above; what is folded here is the evidence, and evidence waits to be asked
   * for. The long sentence — the coverage counts, or why nothing was scanned — moves into the body,
   * where it sits with the findings it describes.
   */
  const title =
    state === 'warn' ? copy.foldContractFindings(findings.length) : state === 'ok' ? copy.foldContractPassed : detail
  return React.createElement(
    'details',
    { className: 'uip-contract', 'data-uip-contract-panel': name, open: false },
    /*
     * TWO HOOKS, ADDED FOR THE SAME REASON THE BUTTONS HAVE THEM: an assertion belongs on state, not on
     * copy. The summary's sentence is localized and its number is part of the sentence ("2 accepted" /
     * "2 条已接受"), so a test that wants to check it against the findings the panel lists has to be
     * able to FIND it — and a test that parsed the row's text instead found the "0" in the package
     * version and reported a rendering bug that did not exist.
     */
    React.createElement('summary', { className: 'uip-hint', 'data-uip-contract-summary': name, 'data-uip-fold-summary': 'contract' }, title),
    React.createElement('p', { className: 'uip-hint', 'data-uip-contract-detail': state }, detail),
    findings.length === 0
      ? null
      : React.createElement('p', { className: 'uip-hint' }, copy.contractFindingsTitle),
    findings.length === 0
      ? null
      : React.createElement(
          'ul',
          { className: 'uip-contract-findings' },
          findings.map((finding, index) =>
            React.createElement(
              'li',
              {
                className: 'uip-contract-finding',
                key: (finding.code ?? 'finding') + '-' + index,
                'data-uip-contract-finding': finding.code,
              },
              React.createElement('code', null, finding.code),
              React.createElement('p', null, finding.message),
              React.createElement('p', { className: 'uip-hint' }, '→ ' + finding.action),
              React.createElement(
                'p',
                { className: 'uip-hint' },
                'line ' + finding.evidence.line + ': ' + finding.evidence.excerpt,
              ),
            ),
          ),
        ),
    /*
     * THE FRAMEWORK'S ROW SAYS WHY, right under the findings it is explaining: a badge that says "not
     * applicable" beside two findings that are plainly there is a contradiction until this sentence is
     * read, and it belongs before the instrument's own limits rather than after them.
     */
    framework
      ? React.createElement(
          'p',
          { className: 'uip-hint', 'data-uip-contract-note': 'framework' },
          copy.contractFrameworkNote(findings.length),
        )
      : null,
    limits.length === 0 ? null : React.createElement('p', { className: 'uip-hint' }, copy.contractLimitsTitle),
    limits.length === 0
      ? null
      : React.createElement(
          'ul',
          { className: 'uip-contract-limits', 'data-uip-contract-limits': name },
          limits.map((limit) => React.createElement('li', { className: 'uip-hint', key: limit }, limit)),
        ),
  )
}

/**
 * The maintenance commands for one package, printed for EVERY row.
 *
 * Its own function, not a tail on `CommandBlock`, for a reason worth keeping: `CommandBlock` shows the
 * REMOVAL command, and the framework's row skips it because it is the thing rendering the list. Folded in
 * there, the framework row lost its maintenance commands too — and updating or rolling back the framework
 * is the ordinary case, not an exotic one.
 *
 * Printed, never run: `$DSH_HOME` is written by install.ps1 and by nothing else in this project.
 */
function MaintenanceBlock({ copy, React, name }) {
  return React.createElement(
    'details',
    { className: 'uip-maintenance', 'data-uip-maintenance': name, open: false },
    React.createElement(
      'summary',
      { className: 'uip-hint', 'data-uip-fold-summary': 'maintenance', 'data-uip-maintenance-title': name },
      copy.foldMaintenance,
    ),
    /*
     * CREATED, NOT CALLED. A plain `CommandRow({…})` would run its `useState` on whichever component is
     * currently rendering — this file's helpers are element factories, and a factory is not a component
     * boundary. Step 56c shipped exactly that mistake: four hooks per row, registered on
     * `UiPluginsSection` inside a loop over the dependencies, which React refuses with #310 as soon as
     * the row count changes between renders. The suite's hook guard now fails on a bare call.
     */
    React.createElement(CommandRow, { copy, React, kind: 'snapshot', source: 'install.ps1 -Snapshot', hook: { 'data-uip-command-maintenance': 'snapshot' } }),
    React.createElement(CommandRow, { copy, React, kind: 'update', source: 'install.ps1 -Update', hook: { 'data-uip-command-maintenance': 'update' } }),
    React.createElement(CommandRow, {
      copy,
      React,
      kind: 'rollback',
      source: 'install.ps1 -Rollback -To <name>',
      hook: { 'data-uip-command-maintenance': 'rollback' },
    }),
    /*
     * THE PROSE IS ONE FOLD DEEPER than the commands it explains. A reader who opens "maintenance" wants
     * three lines they can copy; the sentence about WHERE to run them and the reminder about restarting
     * are what they need a moment later, and both stay one click away instead of printed under every row.
     */
    React.createElement(
      'details',
      { className: 'uip-hint-fold', 'data-uip-hint': 'maintenance', open: false },
      React.createElement('summary', { className: 'uip-hint', 'data-uip-fold-summary': 'hint' }, copy.foldHint),
      React.createElement('p', { className: 'uip-hint' }, copy.maintenanceBrief),
      React.createElement('p', { className: 'uip-hint' }, copy.cmdRollbackList),
      React.createElement('p', { className: 'uip-hint' }, copy.restartReminder),
    ),
  )
}

/**
 * The commands for one package, and the half that is easy to forget.
 *
 * The command is shown rather than run (see the header), and the restart is shown WITH it: after
 * `dsh plugin … add` the profile's bundle list has changed but the RUNNING process still holds the old
 * composition and has never fetched the new client bundle, so the package appears in this list and
 * does nothing until dsh is restarted. Telling the user only the first half produces "I installed it
 * and nothing happened", which reads as a bug in this system rather than as the second step.
 *
 * The browser round proved that note necessary by failing on itself: the endpoint did not exist for
 * exactly this reason until the host was restarted.
 */
function CommandBlock({ copy, React, name, profileName }) {
  /*
   * The three answers, in the order a person asks them before running the command above: what goes on
   * its own, what the command does, and what is deliberately left alone.
   *
   * They now live one fold deeper, under a one-line summary. The third list is the load-bearing one —
   * everything else can be discovered by trying it, while "your switch and this package's settings
   * survive, and your source tree is not touched" cannot, and it is where the two data decisions are
   * visible from inside the interface. Brevity must not delete it, so it is folded rather than dropped.
   *
   * `copy.uninstall` is read without a fallback, deliberately: a missing dictionary key should fail
   * loudly here rather than render three empty lists — the shape of mistake that Round 35 was about.
   */
  const uninstall = copy.uninstall
  /*
   * ONE COMMAND, ONE SOURCE.
   *
   * The hint line, the block a person copies and the string the copy button carries are the same
   * string. They were not, once: the block came from a dictionary literal with `dsh-ui-projects` typed
   * into it, so every row offered its own name on one line and the framework's name four lines later.
   * Invisible while a profile held one removable package; the user read it off the page the first time
   * three packages shared this template.
   */
  const command = 'dsh plugin --profile ' + profileName + ' remove ' + name
  const groups = [
    { key: 'automatic', heading: uninstall.automaticTitle, items: uninstall.automatic },
    { key: 'command', heading: uninstall.commandTitle, items: uninstall.command },
    { key: 'kept', heading: uninstall.keptTitle, items: uninstall.kept },
  ]
  return React.createElement(
    'details',
    { className: 'uip-command', 'data-uip-command': name, open: false },
    React.createElement('summary', { className: 'uip-hint', 'data-uip-fold-summary': 'uninstall' }, copy.uninstallTitle(name)),
    /* One command, one copy button, and the explanation one fold deeper — same shape as maintenance. */
    React.createElement(CommandRow, { copy, React, kind: 'uninstall', source: command }),
    React.createElement(
      'details',
      { className: 'uip-hint-fold', 'data-uip-hint': 'uninstall', open: false },
      React.createElement('summary', { className: 'uip-hint', 'data-uip-fold-summary': 'hint' }, uninstall.title),
      React.createElement('p', { className: 'uip-hint' }, copy.uninstallBrief),
      React.createElement('p', { className: 'uip-hint' }, copy.commandsHint),
      React.createElement('p', { className: 'uip-hint', 'data-uip-restart': 'hint' }, copy.restartHint),
      React.createElement('pre', { 'data-uip-restart': 'block' }, copy.restartBlock(command)),
      React.createElement('p', { className: 'uip-hint' }, copy.restartReminder),
      groups.map((group) =>
        React.createElement(
          'div',
          { className: 'uip-uninstallGroup', 'data-uip-uninstall': group.key, key: group.key },
          React.createElement('p', { className: 'uip-hint' }, group.heading),
          React.createElement(
            'ul',
            null,
            group.items.map((item) => React.createElement('li', { key: item }, item)),
          ),
        ),
      ),
    ),
    /*
     * The maintenance block used to live here, and moved out when the framework's row turned out to have
     * lost it: this function is only rendered for rows that may be REMOVED, and maintenance is not removal.
     */
  )
}
