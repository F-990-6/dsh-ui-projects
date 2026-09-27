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
  const rows = scan.dependencies.map((dependency) =>
    React_.createElement(
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
      ),
      dependency.projectId === undefined
        ? null
        : React_.createElement('p', { className: 'uip-hint' }, copy.project(dependency.projectId)),
      ...(dependency.problems ?? []).map((problem, index) =>
        React_.createElement('p', { className: 'uip-error', key: 'problem-' + index }, problem.code + ': ' + problem.message),
      ),
      dependency.name === 'dsh-ui-projects'
        ? null
        : CommandBlock({ copy, React: React_, name: dependency.name, profileName: scan.profileName }),
    ),
  )

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
  const groups = [
    { key: 'automatic', heading: uninstall.automaticTitle, items: uninstall.automatic },
    { key: 'command', heading: uninstall.commandTitle, items: uninstall.command },
    { key: 'kept', heading: uninstall.keptTitle, items: uninstall.kept },
  ]
  return React.createElement(
    'div',
    { className: 'uip-command', 'data-uip-command': name },
    React.createElement('p', { className: 'uip-hint' }, copy.commandsHint),
    React.createElement('pre', null, 'dsh plugin --profile ' + profileName + ' remove ' + name),
    React.createElement('p', { className: 'uip-hint', 'data-uip-restart': 'hint' }, copy.restartHint),
    React.createElement('pre', { 'data-uip-restart': 'block' }, copy.restartBlock),
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
  )
}
