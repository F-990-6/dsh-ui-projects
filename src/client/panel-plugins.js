/**
 * Settings › UI plugins — what is installed in this profile, in a section of its own.
 *
 * A SEPARATE SECTION from Settings › UI, and that separation is the design: that page manages
 * PROJECTS (what the running client offers, applied and unapplied), this one manages PACKAGES (what
 * is installed, composed, and what would have to be typed to change it). They are different
 * questions with different sources of truth — the registry for the first, a directory scan for the
 * second — and one page answering both would be the page where they get confused.
 *
 * NOTHING HERE WRITES. Every control that would change the profile renders the exact command instead
 * and tells the user to run it, because `$DSH_HOME` is written by `install.ps1` and by nothing else
 * in this project. A button that spawned `dsh plugin` would be a write nobody reviewed, triggered by
 * a click — which is the thing that rule exists to prevent. And the second half of the same honesty:
 * the command alone does not take effect, so the section says so, next to it, in the same block.
 */

/**
 * @param {{ store: any, t: any, React: any }} props
 * @returns {any} a React element
 */
export function UiPluginsSection(props) {
  const { store, t, React } = props
  const state = store.state()
  const React_ = React

  const header = React_.createElement(
    'header',
    { className: 'uip-header', key: 'header' },
    React_.createElement('div', null, React_.createElement('h2', { className: 'uip-title' }, t.title)),
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
        t.refresh,
      ),
    ),
  )

  const intro = React_.createElement('p', { className: 'uip-intro', key: 'intro' }, t.intro)

  if (state.status === 'idle' || state.status === 'loading') {
    return React_.createElement(
      'section',
      { className: 'uip-section', 'data-uip-plugins': state.status },
      header,
      intro,
      React_.createElement('p', { className: 'uip-hint', key: 'loading' }, t.loading),
    )
  }

  if (state.status === 'failed') {
    return React_.createElement(
      'section',
      { className: 'uip-section', 'data-uip-plugins': 'failed' },
      header,
      intro,
      React_.createElement(
        'p',
        { className: 'uip-error', key: 'failed', 'data-uip-plugins-error': '' },
        t.failed(state.error ?? ''),
      ),
      React_.createElement('p', { className: 'uip-hint', key: 'failedhint' }, t.failedHint),
    )
  }

  const scan = state.scan
  /** The framework's own row is the thing rendering this list: it is not removable from itself. */
  const rows = scan.dependencies.map((dependency) =>
    React_.createElement(
      'li',
      { className: 'uip-plugin', key: dependency.name, 'data-uip-plugin': dependency.name },
      React_.createElement(
        'div',
        { className: 'uip-plugin-head' },
        React_.createElement('span', { className: 'uip-plugin-name' }, `${dependency.name}@${dependency.version ?? '?'}`),
        React_.createElement('span', { className: 'uip-badge' }, t.kinds[dependency.kind] ?? dependency.kind),
        dependency.bundled
          ? React_.createElement('span', { className: 'uip-badge' }, t.composed)
          : React_.createElement('span', { className: 'uip-badge uip-badge-warn' }, t.notComposed),
        dependency.name === 'dsh-ui-projects'
          ? React_.createElement('span', { className: 'uip-badge' }, t.framework)
          : null,
      ),
      dependency.projectId === undefined
        ? null
        : React_.createElement('p', { className: 'uip-hint' }, t.project(dependency.projectId)),
      ...dependency.problems.map((problem, index) =>
        React_.createElement(
          'p',
          { className: 'uip-error', key: `problem-${index}` },
          `${problem.code}: ${problem.message}`,
        ),
      ),
      dependency.name === 'dsh-ui-projects'
        ? null
        : CommandBlock({ t, React: React_, name: dependency.name, profileName: scan.profileName }),
    ),
  )

  return React_.createElement(
    'section',
    { className: 'uip-section', 'data-uip-plugins': 'ready' },
    header,
    intro,
    scan.orphanedBindings.length > 0
      ? React_.createElement('p', { className: 'uip-error', key: 'orphans' }, t.orphaned(scan.orphanedBindings.join(', ')))
      : null,
    rows.length === 0
      ? React_.createElement('p', { className: 'uip-hint', key: 'empty' }, t.empty)
      : React_.createElement('ul', { className: 'uip-list', key: 'list' }, rows),
  )
}

/**
 * The commands for one package, and the half that is easy to forget.
 *
 * The command is shown rather than run (see the header), and the restart is shown WITH it: after
 * `dsh plugin … add` the profile's bundle list has changed but the RUNNING process still holds the
 * old composition and has never fetched the new client bundle, so the package appears in this list
 * and does nothing until dsh is restarted. Telling the user only the first half produces "I installed
 * it and nothing happened", which reads as a bug in this system rather than as the second step.
 */
function CommandBlock({ t, React, name, profileName }) {
  return React.createElement(
    'div',
    { className: 'uip-command', 'data-uip-command': name },
    React.createElement('p', { className: 'uip-hint' }, t.commandsHint),
    React.createElement('pre', null, `dsh plugin --profile ${profileName} remove ${name}`),
    React.createElement('p', { className: 'uip-hint' }, t.restartHint),
    React.createElement('pre', null, t.restartBlock),
  )
}
