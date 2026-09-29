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

/**
 * @param {{ store: any, t: any, React: any }} props
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
  React_.useEffect(() => {
    if (props.state !== undefined) return undefined
    setLive(store.state())
    return store.subscribe(() => setLive(store.state()))
  }, [store, props.state])

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
    return React_.createElement(
      'li',
      { className: 'uip-plugin', key: dependency.name, 'data-uip-plugin': dependency.name },
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
       * THE FRAMEWORK'S ROW OPENS TOO (9b review). Its badge stays `na` — the contract is not a rule the
       * instrument is measured by — but declining to render the panel hid two findings that ARE in the
       * payload, and a reader who never runs the CLI could not see them. So the row explains itself:
       * the summary says the contract does not apply, the findings are listed, and a note says they are
       * recorded rather than fixed. `na` is a judgement about the BADGE; silence was a different claim.
       */
      ContractPanel({ copy, React: React_, name: dependency.name, state: contractState, contract: dependency.contract }),
      dependency.projectId === undefined
        ? null
        : React_.createElement('p', { className: 'uip-hint' }, copy.project(dependency.projectId)),
      ...(dependency.problems ?? []).map((problem, index) =>
        React_.createElement('p', { className: 'uip-error', key: 'problem-' + index }, problem.code + ': ' + problem.message),
      ),
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
function ContractPanel({ copy, React, name, state, contract }) {
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
    { className: 'uip-contract', 'data-uip-contract-panel': name },
    /*
     * TWO HOOKS, ADDED FOR THE SAME REASON THE BUTTONS HAVE THEM: an assertion belongs on state, not on
     * copy. The summary's sentence is localized and its number is part of the sentence ("2 accepted" /
     * "2 条已接受"), so a test that wants to check it against the findings the panel lists has to be
     * able to FIND it — and a test that parsed the row's text instead found the "0" in the package
     * version and reported a rendering bug that did not exist.
     */
    React.createElement('summary', { className: 'uip-hint', 'data-uip-contract-summary': name }, summary),
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
    'div',
    { className: 'uip-maintenance', 'data-uip-maintenance': name },
    React.createElement('p', { className: 'uip-hint', 'data-uip-maintenance-title': name }, copy.maintenanceTitle(name)),
    React.createElement('p', { className: 'uip-hint' }, copy.maintenanceHint),
    React.createElement('p', { className: 'uip-hint' }, copy.cmdSnapshotWhy),
    React.createElement('pre', { 'data-uip-command-maintenance': 'snapshot' }, 'install.ps1 -Snapshot'),
    React.createElement('p', { className: 'uip-hint' }, copy.cmdUpdateWhy),
    React.createElement('pre', { 'data-uip-command-maintenance': 'update' }, 'install.ps1 -Update'),
    React.createElement('p', { className: 'uip-hint' }, copy.cmdRollbackWhy),
    React.createElement('pre', { 'data-uip-command-maintenance': 'rollback' }, 'install.ps1 -Rollback -To <name>'),
    React.createElement('p', { className: 'uip-hint' }, copy.cmdRollbackList),
    React.createElement('p', { className: 'uip-hint' }, copy.restartReminder),
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
   * The third list is the load-bearing one. Everything else here can be discovered by trying it; "your
   * switch and this package's settings survive, and your source tree is not touched" cannot, and those
   * are precisely the facts somebody about to delete a package wants BEFORE pasting the command rather
   * than after. It is also the only place the two data decisions are visible from inside the interface:
   * an uninstall keeps what the user owns (`enabled`'s id, this package's settings entry) and removes
   * what the package owns.
   *
   * `copy.uninstall` is read without a fallback, deliberately: a missing dictionary key should fail
   * loudly here rather than render three empty lists — the shape of mistake that Round 35 was about.
   */
  const uninstall = copy.uninstall
  /*
   * ONE COMMAND, PRINTED TWICE — and one source for it.
   *
   * The line under the hint and the line inside the block a person copies are the same string, which is
   * the only arrangement in which they cannot disagree. They did: the block came from a dictionary
   * literal with `dsh-ui-projects` typed into it, so every row offered its own name in the first command
   * and the framework's name in the second. Invisible while a profile held one removable package; the
   * user read it off the page the first time three packages shared this template.
   */
  const command = 'dsh plugin --profile ' + profileName + ' remove ' + name
  const groups = [
    { key: 'automatic', heading: uninstall.automaticTitle, items: uninstall.automatic },
    { key: 'command', heading: uninstall.commandTitle, items: uninstall.command },
    { key: 'kept', heading: uninstall.keptTitle, items: uninstall.kept },
  ]
  return React.createElement(
    'div',
    { className: 'uip-command', 'data-uip-command': name },
    React.createElement('p', { className: 'uip-hint' }, copy.commandsHint),
    React.createElement('pre', null, command),
    React.createElement('p', { className: 'uip-hint', 'data-uip-restart': 'hint' }, copy.restartHint),
    React.createElement('pre', { 'data-uip-restart': 'block' }, copy.restartBlock(command)),
    React.createElement('p', { className: 'uip-hint' }, uninstall.title),
    React.createElement(
      'div',
      { className: 'uip-uninstall' },
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
