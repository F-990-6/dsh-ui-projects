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

  const scan = live.scan
  /** The framework's own row is the thing rendering this list: it is not removable from itself. */
  const rows = scan.dependencies.map((dependency) => {
    /*
     * THE CONTRACT STATE IS COMPUTED ONCE PER ROW, here, and the badge and the panel both read it — two
     * derivations of one question is how a row ends up claiming two different things.
     */
    const contractState = contractStateOf(dependency)
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
        ),
        /*
         * THE DEFAULT VIEW ANSWERS THREE QUESTIONS — what is it, what does it look like, which project
         * is it — and nothing else. Everything the row knows beyond that is folded into the block below,
         * because the column had grown to where a reader met a wall of commands and hints before
         * learning what the package was.
         *
         * A field with no value renders NOTHING: no "not declared", no empty row. A package that
         * declares nothing says nothing about it, and a reader can tell the difference between "this
         * package has no author" and "the page is broken" from the absence of the line just as well as
         * from a sentence about it — better, in fact, since eight rows of "not declared" is a page
         * nobody reads.
         */
        ...RowHeadFacts({ copy, React: React_, dependency }),
        React_.createElement(
          'details',
          { className: 'uip-plugin-details', 'data-uip-row-details': dependency.name },
          React_.createElement('summary', { className: 'uip-hint', 'data-uip-fold-summary': 'row-details' }, copy.rowDetails),
          ...RowFoldFacts({ copy, React: React_, dependency, hasProject, project, mirrorAvailable: projectsLive !== undefined }),
          /*
           * THE FRAMEWORK'S ROW OPENS TOO (9b review). Its badge stays `na` — the contract is not a rule
           * the instrument is measured by — but declining to render the panel hid two findings that ARE
           * in the payload, and a reader who never runs the CLI could not see them. So the row explains
           * itself: the summary says the contract does not apply, the findings are listed, and a note
           * says they are recorded rather than fixed. `na` is a judgement about the BADGE; silence was a
           * different claim.
           *
           * A CLEAN ROW KEEPS ITS PANEL AND KEEPS IT SHUT (`open` is the state's answer, not a
           * constant): the limits inside it — rule 3 is not scanned at all — are the sentence that
           * stops a green badge from reading as "this plugin is fine", and that matters most on the
           * rows where nothing was found. A finding opens it, because then it is the answer.
           */
          ContractPanel({
            copy,
            React: React_,
            name: dependency.name,
            state: contractState,
            contract: dependency.contract,
            open: contractState !== 'ok',
          }),
          ...(dependency.problems ?? []).map((problem, index) =>
            React_.createElement('p', { className: 'uip-error', key: 'problem-' + index }, problem.code + ': ' + problem.message),
          ),
          /*
           * §五's CHANGELOG, folded away, and read only when a reader opens it. §五's CHANGELOG, in its
           * own fold inside this one, because it is content rather than a state of the package.
           */
          ChangelogBlock({
            copy,
            React: React_,
            dependency,
            state: typeof store.changelog === 'function' ? store.changelog(dependency.name) : undefined,
            onToggle: createChangelogToggle(store, dependency.name),
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
        React.createElement('h4', { className: 'uip-plugin-changelogHeading' }, section.heading),
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
  const heading =
    typeof dependency.changelogHeading === 'string' && dependency.changelogHeading.length > 0 ? dependency.changelogHeading : null
  return React.createElement(
    'details',
    { className: 'uip-plugin-changelog', 'data-uip-changelog': dependency.name },
    React.createElement(
      'summary',
      { className: 'uip-hint', 'data-uip-changelog-summary': dependency.name, 'data-uip-fold-summary': 'changelog', onClick: onToggle },
      heading === null ? copy.changelogTitle : copy.changelogTitle + ' · ' + heading,
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
      React.createElement('p', { className: 'uip-description', key: 'description', 'data-uip-field': 'description' }, dependency.description),
    )
  } else if (dependency.description === undefined) {
    fields.push(
      React.createElement('p', { className: 'uip-hint', key: 'description', 'data-uip-field': 'description' }, copy.hostFieldMissing('description')),
    )
  }
  if (dependency.projectId !== undefined) {
    fields.push(
      React.createElement(
        'p',
        { className: 'uip-hint', key: 'project', 'data-uip-project-id': dependency.projectId },
        copy.project(dependency.projectId),
      ),
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

/**
 * One command line and its copy button.
 *
 * `data-uip-copy-source` carries the command ITSELF, so the suite can assert the button copies exactly
 * the line printed beside it rather than a second string that happens to look the same — the defect
 * this project has already paid for once, when one command was written out twice in one row.
 */
function CommandRow({ copy, React, kind, source, hook }) {
  const [state, setState] = React.useState('idle')
  const label = state === 'copied' ? copy.copyDone : state === 'failed' ? copy.copyFailed : copy.copyCommand
  return React.createElement(
    'div',
    { className: 'uip-commandRow' },
    React.createElement('pre', hook ?? null, source),
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
      label,
    ),
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
function ContractPanel({ copy, React, name, state, contract, open }) {
  const findings = contract?.findings ?? []
  const limits = contract?.limits ?? []
  const rules = contract?.rules
  /** The framework's own row: not judged by the contract, and still shown what the scan found. */
  const framework = state === 'na'
  const covered =
    typeof rules?.judged === 'number' && typeof rules?.total === 'number' ? copy.contractCoverage(rules.judged, rules.total) : null
  let summary = covered
  if (state === 'none') summary = copy.contractNotScannedWhy(contract?.reason)
  else if (framework) summary = copy.contractFramework(findings.length)
  else if (summary === null) summary = contractBadgeText(copy, state, contract)
  if (summary === null || summary === undefined || summary === '') return null
  return React.createElement(
    'details',
    // `open` is the caller's answer to "is there something to read here": a clean row keeps its panel
    // shut (the badge already said it), a finding opens it (the panel IS the answer).
    { className: 'uip-contract', 'data-uip-contract-panel': name, open: open === true },
    /*
     * TWO HOOKS, ADDED FOR THE SAME REASON THE BUTTONS HAVE THEM: an assertion belongs on state, not on
     * copy. The summary's sentence is localized and its number is part of the sentence ("2 accepted" /
     * "2 条已接受"), so a test that wants to check it against the findings the panel lists has to be
     * able to FIND it — and a test that parsed the row's text instead found the "0" in the package
     * version and reported a rendering bug that did not exist.
     */
    React.createElement('summary', { className: 'uip-hint', 'data-uip-contract-summary': name, 'data-uip-fold-summary': 'contract' }, summary),
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
    { className: 'uip-maintenance', 'data-uip-maintenance': name },
    React.createElement(
      'summary',
      { className: 'uip-hint', 'data-uip-fold-summary': 'maintenance', 'data-uip-maintenance-title': name },
      copy.maintenanceTitle(name),
    ),
    /*
     * ONE SENTENCE, then the three commands. The block used to carry four hints and a restart reminder
     * per row — correct, and unreadable at five rows. The sentence that survives is the load-bearing
     * one: WHERE the command has to be run, which is the difference between `install.ps1` working and
     * "not recognized" (the dictionaries keep the long version, and the suite still asserts it says
     * `-Package`).
     */
    React.createElement('p', { className: 'uip-hint' }, copy.maintenanceBrief),
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
    React.createElement('p', { className: 'uip-hint' }, copy.cmdRollbackList),
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
    { className: 'uip-command', 'data-uip-command': name },
    React.createElement('summary', { className: 'uip-hint', 'data-uip-fold-summary': 'uninstall' }, copy.uninstallTitle(name)),
    React.createElement('p', { className: 'uip-hint' }, copy.commandsHint),
    React.createElement(CommandRow, { copy, React, kind: 'uninstall', source: command }),
    React.createElement('p', { className: 'uip-hint' }, copy.uninstallBrief),
    React.createElement(
      'details',
      { className: 'uip-uninstall', 'data-uip-uninstall-details': name },
      React.createElement('summary', { className: 'uip-hint', 'data-uip-fold-summary': 'uninstall-details' }, uninstall.title),
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
