/**
 * Self-diagnosis overlay — a temporary instrument, not a feature.
 *
 * The skin can fail in ways a screenshot cannot distinguish: the sheet is inserted but the
 * column marking never ran, the ambient layer landed in the wrong parent, `apply` threw and
 * was rolled back, or the browser is running a stale bundle entirely. Reasoning about which
 * one from the outside wasted several rounds, so this prints the facts instead.
 *
 * Enable it once and it stays on across reloads:
 *
 *   localStorage.setItem('dsh.ui-projects.debug', '1')   // in the page console
 *
 * It is off by default, adds nothing to the DOM when off, and is deleted from a normal
 * interface by removing this one module's import.
 */

/** The stored switch. Read on every render so the console can turn it on without a reload. */
const DEBUG_KEY = 'dsh.ui-projects.debug'

/**
 * @returns {boolean}
 */
function debugEnabled() {
  try {
    return typeof window !== 'undefined' && window.localStorage?.getItem(DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Everything needed to tell the failure modes apart.
 *
 * Each field answers one question that has actually cost a round: is the marker on the body
 * (`apply` finished), did the columns get marked (the DOM half ran), where did the ambient
 * layer land (its parent decides whether it distorts the shell's measurement), and is the
 * page taller than the window (the "second screen" the user could scroll to).
 * @param {import('./registry.js').UiProjectDefinition[]} projects
 * @returns {Record<string, unknown>}
 */
export function collectDiagnostics(projects, runtime) {
  if (typeof document === 'undefined') return { stage: 'no document' }
  const body = document.body
  const root = document.documentElement
  const ambient = document.querySelectorAll('.ds-ambient')
  const marked = document.querySelectorAll('[data-ui-skin-column]')
  /** @type {string[]} */
  const sheets = []
  for (const style of document.querySelectorAll('style')) {
    if (style.id.startsWith('dsh-ui-projects')) sheets.push(style.id)
  }

  return {
    /*
     * WHICH BUILD IS RUNNING. The first field on purpose.
     *
     * The browser caches a plugin revision, so after a fix there are always two possibilities —
     * the fix did not work, or the fix is not loaded — and they look identical from a screenshot.
     * That ambiguity has cost several rounds. `run` changes with every build; if the number here
     * does not match the newest one you built, the page is running stale code and nothing else in
     * this panel means anything.
     */
    run: 'r11-widths',
    /**
     * The widths that decide whether the sidebar is a column or a rail.
     *
     * The shipped layout measures the FRAME element with a `ResizeObserver` and collapses the
     * sidebar to the rail when that measurement is below `SIDEBAR_AUTO_COLLAPSE = 1024`. It
     * compares against 1024 rather than against `window.innerWidth`, so a frame that has been
     * squeezed — by a wide child, by a fixed-position overlay, by anything at all — collapses the
     * sidebar even in a 1440px window. Printing both numbers side by side is what separates "the
     * window is narrow" from "the frame is being squeezed", and those have different fixes.
     */
    widths: {
      window: window.innerWidth,
      frame: (() => {
        const frame = document.querySelector('[data-rightbar-col]')
        const outer = frame === null ? null : frame.parentElement
        return outer === null ? null : Math.round(outer.getBoundingClientRect().width)
      })(),
      sidebar: (() => {
        const column = document.querySelector('[data-ui-skin-column]')
        return column === null || column === undefined ? null : Math.round(column.getBoundingClientRect().width)
      })(),
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      autoCollapseBelow: 1024,
    },
    /**
     * The settings dialog, described from what it is rather than from a class name.
     *
     * Kept even though the dialog is no longer the focus: it costs a few milliseconds, and the two
     * things it answers — is the skin's fill winning, is the skin's lift applying — are exactly the
     * questions a future change to that element would raise again.
     */
    dialog: collectDialog(),
    /** Which stylesheets are actually loaded, and the fills the skin resolved. */
    sheets,
    sidebarFill: getComputedStyle(body).getPropertyValue('--dsw-specific-sidebar-fill').trim(),
    dialogFill: getComputedStyle(body).getPropertyValue('--dsw-alias-bg-layer-2').trim(),
    /* ── everything below is context; the fields above answer most questions ── */
    build: 'columns+clip+lift',
    /**
     * What the retry loop behind `markColumns` actually saw. This is the field that turns a
     * silent failure into a readable one: `frame: null` means the lookup never found the grid,
     * a non-empty `sizes` with `columns: 0` means it found the grid but rejected every child,
     * and `note: 'marked'` with `marked: 0` on the page would mean something REMOVED the
     * attributes afterwards.
     */
    marking: runtime?.markingState === undefined ? 'no runtime' : Object.fromEntries(runtime.markingState),
    /** The frame's own background token — transparent in this build, opaque in the old one. */
    frameBackground: (() => {
      try {
        return getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim()
      } catch {
        return '?'
      }
    })(),
    locale: root.lang,
    skinOn: root.getAttribute('data-ui-skin'),
    projectMarker: body.getAttribute('data-ui-project-liquid-glass'),
    systemMarker: root.getAttribute('data-ui-projects'),
    activeProjects: projects.filter((project) => project.status === 'active').map((project) => project.id),
    errored: projects.filter((project) => project.status === 'error').map((project) => [project.id, project.error]),
    columnsMarked: marked.length,
    columnClasses: Array.from(marked).map((el) => String(el.className).slice(0, 24)),
    ambientCount: ambient.length,
    ambientParent: ambient.length > 0 ? describeNode(ambient[0].parentElement) : null,
    ambientGrandparent: ambient.length > 0 ? describeNode(ambient[0].parentElement?.parentElement) : null,
    // The "second screen" check.
    pageHeight: body.scrollHeight,
    viewportHeight: window.innerHeight,
    overflows: body.scrollHeight > window.innerHeight + 1,
    sidebarWidth: (() => {
      // The sidebar is the first marked column. Falls back to the frame's first child so the
      // number is still reported before the marking has landed.
      const column =
        document.querySelector('[data-ui-skin-column]') ?? document.querySelector('[data-rightbar-col]')?.children?.[0]
      return column === undefined || column === null ? null : Math.round(column.getBoundingClientRect().width)
    })(),
  }
}

/**
 * The settings dialog's panel and mask, described from what they are.
 *
 * Returns a description with the properties that decide the two questions worth asking: is the
 * skin's fill winning (`background`), and is the skin's lift applying (`transform`, `position`)?
 * `bottomGap` turns the lift into a number that can be compared against the shipped 24px estimate.
 * @returns {Record<string, unknown> | string}
 */
function collectDialog() {
  const panels = Array.from(document.querySelectorAll('div')).filter((element) => {
    const style = getComputedStyle(element)
    const background = style.backgroundColor
    const rect = element.getBoundingClientRect()
    return (
      rect.width > 300 &&
      rect.height > 300 &&
      style.zIndex !== 'auto' &&
      background !== 'rgba(0, 0, 0, 0)' &&
      background !== 'transparent'
    )
  })
  if (panels.length === 0) return 'no floating panel found — open Settings to populate this'
  const panel = panels[0]
  const style = getComputedStyle(panel)
  const rect = panel.getBoundingClientRect()
  const mask = panel.parentElement
  return {
    classes: String(panel.className).slice(0, 40),
    background: style.backgroundColor,
    backdrop: style.backdropFilter,
    position: style.position,
    transform: style.transform,
    size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
    at: `x=${Math.round(rect.x)} y=${Math.round(rect.y)}`,
    bottomGap: Math.round(window.innerHeight - rect.bottom),
    maskBackground: mask === null ? null : getComputedStyle(mask).backgroundColor,
  }
}

/**
 * @param {Element | null | undefined} node
 * @returns {string | null}
 */
function describeNode(node) {
  if (node === null || node === undefined) return null
  const tag = node.tagName.toLowerCase()
  const cls = String(node.className || '').split(' ')[0].slice(0, 24)
  const attrs = Array.from(node.attributes)
    .map((attribute) => attribute.name)
    .filter((name) => name.startsWith('data-'))
    .join(',')
  return `${tag}${cls === '' ? '' : `.${cls}`}${attrs === '' ? '' : `[${attrs}]`}`
}

/**
 * The overlay element, created once and reused.
 * @param {Record<string, unknown>} data
 * @returns {HTMLElement}
 */
function renderOverlay(data) {
  const existing = document.getElementById('dsh-ui-projects-debug')
  const element = existing ?? document.createElement('pre')
  if (existing === null) {
    element.id = 'dsh-ui-projects-debug'
    element.setAttribute('aria-hidden', 'true')
    Object.assign(element.style, {
      position: 'fixed',
      /*
       * Top left, SMALL FONT — and since the last round, TWO COLUMNS.
       *
       * Both moves come from the same mistake. The panel started bottom-right, where a long report
       * ran off the right edge of the window; a screenshot then cut off exactly the fields being
       * asked about, and that was read as "nothing to see" rather than "the instrument is out of
       * frame". Moving it top-left fixed the horizontal problem and introduced a vertical one: the
       * report is taller than the window, `overflow: auto` cannot help because the panel is
       * `pointer-events: none`, and the last fields were simply unreachable.
       *
       * Two columns is the fix that does not trade one edge for the other — the report is mostly
       * short lines, so half the width costs little and halves the height. `column-width` (rather
       * than a fixed count) lets it fall back to one column on a narrow window.
       */
      left: '4px',
      top: '4px',
      zIndex: '2147483647',
      width: 'min(680px, 96vw)',
      maxHeight: '97vh',
      overflow: 'hidden',
      columns: '20ch 2',
      columnGap: '10px',
      columnRule: '1px solid rgba(255,255,255,.14)',
      margin: '0',
      padding: '6px 8px',
      borderRadius: '8px',
      font: '9px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      background: 'rgba(10,12,18,.95)',
      color: '#e6e8ee',
      pointerEvents: 'none',
    })
    document.body.appendChild(element)
  }
  const report = { ...data }
  element.textContent =
    `dsh-ui-projects  run=${String(report.run ?? '?')}\n` + JSON.stringify(report, null, 1)
  return element
}

/**
 * Keep the overlay in step with a store: drawn now when the switch is on, redrawn on every
 * registry change, and removed when the switch is off.
 *
 * While it is on it also repaints a few times a second, because the state it reports is not
 * all registry state: the column-marking retry and the shell's own layout settle *after* the
 * last registry change, so a panel that only redrew on store events showed a stale snapshot —
 * exactly the trap it exists to avoid.
 * @param {import('./store.js').UiProjectsStore} store
 * @param {import('./runtime.js').UiProjectRuntime} [runtime]
 * @returns {() => void} disposer
 */
export function mountDiagnostics(store, runtime) {
  if (typeof document === 'undefined') return () => {}
  const remove = () => document.getElementById('dsh-ui-projects-debug')?.remove()
  const update = () => {
    if (!debugEnabled()) {
      remove()
      return
    }
    renderOverlay(collectDiagnostics(store.snapshot().projects, runtime))
  }
  update()
  const unsubscribe = store.subscribe(update)
  // `unref`, so a diagnostic repaint timer can never keep a Node process alive: the overlay is a
  // convenience, and holding the event loop open for one is a bug rather than a feature.
  const timer = debugEnabled() ? setInterval(update, 400) : undefined
  timer?.unref?.()
  return () => {
    unsubscribe()
    if (timer !== undefined) clearInterval(timer)
    remove()
  }
}
