/**
 * Self-diagnosis overlay — a temporary instrument, not a feature.
 *
 * The skin can fail in ways a screenshot cannot distinguish: the sheet is inserted but the
 * column marking never ran, `apply` threw and was rolled back, the settings dialog is being
 * laid out against the wrong box, or the browser is running a stale bundle entirely. Reasoning
 * about which one from the outside wasted several rounds, so this prints the facts instead.
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
 * (`apply` finished), did the columns get marked (the DOM half ran), is the settings dialog
 * being laid out against the box it thinks it has, and is the page taller than the window
 * (the "second screen" the user could scroll to).
 * @param {import('./registry.js').UiProjectDefinition[]} projects
 * @returns {Record<string, unknown>}
 */
export function collectDiagnostics(projects, runtime) {
  if (typeof document === 'undefined') return { stage: 'no document' }
  const body = document.body
  const root = document.documentElement
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
    run: 'r12-poll-cleanup',
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
    /*
     * Where state actually lives, and whether that went cleanly.
     *
     * These three are the only outlet for a question this plugin has already lost a round to.
     * `persistKind` names the backend that won (`'settings'` = the dsh settings document,
     * `'local'` = this browser only), `persistReady` says whether the wait for the settings
     * transport settled or hit its deadline, and `persistDiverged` says a leftover localStorage
     * record disagreed with the settings document during the handover. A skin that "did not come
     * back" after a reload is one of these three — and until now the only way to see any of them
     * was one line of small print on the settings card.
     */
    persistKind: runtime?.persist?.kind ?? 'no runtime',
    persistReady: runtime?.persist?.readiness ?? 'no runtime',
    persistDiverged: runtime?.persist?.diverged === true,
    /**
     * Which projects this page was told about by the FIRST FRAME rather than by the document.
     *
     * Non-empty only on a degraded load: the settings transport had not answered when the boot
     * finished, so the host's own markers — written from the same document at emit time — were what
     * the runtime went on, and the record corrects it when it lands. `persistReady: 'timeout'` next
     * to a non-empty list is the whole story of "my skin came back on a slow load"; an EMPTY list
     * with a timeout means the host plane said nothing and the shipped defaults were used instead.
     * Without this field the two are the same picture, and they need different fixes.
     */
    persistAdopted: runtime?.diagnostics?.().adoptedFromFrame ?? 'no runtime',
    persistError: runtime?.diagnostics?.().persistError,
    /**
     * Which surfaces two active projects both claim, and whether either claim is a blur.
     *
     * The settings page shows the same thing as a hint; it is repeated here because the overlay is
     * where a CONFIRMED nesting shows up, and the two need reading together: this says what was
     * declared, `layers` says what is actually on screen.
     */
    regionConflicts:
      runtime === undefined
        ? 'no runtime'
        : runtime.registry
            .regionConflicts()
            .map((pair) => `${pair.ids.join('+')}:${pair.regions.join(',')}${runtime.declaresFilter(pair.ids[0]) && runtime.declaresFilter(pair.ids[1]) ? ' (both blur)' : ''}`),
    /** The measured answer: which elements really carry a filter, and which sit inside another. */
    layers: collectLayers(runtime),
    sidebarFill: getComputedStyle(body).getPropertyValue('--dsw-specific-sidebar-fill').trim(),
    dialogFill: getComputedStyle(body).getPropertyValue('--dsw-alias-bg-layer-2').trim(),
    /* ── everything below is context; the fields above answer most questions ── */
    /**
     * Which capabilities this build carries, by name. The second staleness marker, after `run`:
     * `clip` used to be in this list, and the `overflow: clip` rules it stood for were deleted
     * because forcing geometry on a layout column is how this skin broke the first two times.
     * A label that outlives its feature is the same defect as a class name that outlives a
     * rebuild, so it is corrected rather than left to mislead the next reader.
     */
    build: 'columns+lift+visibility',
    /**
     * What the bounded retry behind `markColumns` actually saw. This is the field that turns a
     * silent failure into a readable one: `frame: null` means the lookup never found the grid,
     * a non-empty `sizes` with `columns: 0` means it found the grid but rejected every child,
     * and `note: 'marked'` with `marked: 0` on the page would mean something REMOVED the
     * attributes afterwards.
     *
     * `timedOut` is the newer one. The retry now stops polling after five seconds instead of
     * running for the life of the session, so a give-up has to be distinguishable from a page
     * where marking simply worked. It is NOT a verdict on the skin: a timed-out project stays
     * enabled, its observer stays connected, and a frame that appears later is still marked.
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
    /*
     * ONE ENTRY PER REGISTERED PROJECT, keyed by id, and the id comes from the registry rather than
     * from a literal typed here.
     *
     * This field used to be `projectMarker: body.getAttribute('data-ui-project-liquid-glass')` — the
     * one skin this package shipped, named in the diagnostic that exists to explain why a skin is not
     * working. The name survived the framework's ownership of the project and would have outlived the
     * project itself: a field that asks about an id nobody registered reads `null` on a perfectly
     * healthy page, and a diagnostic that reports `null` when everything is fine is one the next
     * reader learns to skip. Reading the registry instead means the field answers about whatever is
     * actually installed, and a marker that is missing is missing for a project that exists.
     */
    projectMarkers: Object.fromEntries(
      projects.map((project) => [project.id, body.getAttribute(`data-ui-project-${project.id}`)]),
    ),
    systemMarker: root.getAttribute('data-ui-projects'),
    activeProjects: projects.filter((project) => project.status === 'active').map((project) => project.id),
    errored: projects.filter((project) => project.status === 'error').map((project) => [project.id, project.error]),
    columnsMarked: marked.length,
    columnClasses: Array.from(marked).map((el) => String(el.className).slice(0, 24)),
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
 * The scan's cached result, keyed by the registry's revision.
 *
 * The overlay repaints four times a second, and a DOM scan is the most expensive thing in this
 * file, so it must not run per repaint. Keying on the revision is what makes the cache correct
 * rather than merely fast: the answer can only change when a project is registered, applied or
 * removed, and all three bump that number.
 * @type {{ revision: number, value: Record<string, unknown> } | undefined}
 */
let layerCache

/**
 * Which elements actually carry a `backdrop-filter`, and which of those sit inside another one.
 *
 * BOUNDED ON PURPOSE, and never called from the toggle path. A full-document scan means a
 * `getComputedStyle` per node plus a forced layout, which on a real application is tens of
 * milliseconds; the candidate set here is a dozen elements by construction.
 *
 * The pseudo-element is the reason this cannot be a `querySelectorAll`: the skin's frost lives on
 * the frame's `::before`, and a pseudo-element is not an element — no selector returns it and no
 * ancestor walk passes through it. Reading `getComputedStyle(el, '::before')` for each candidate is
 * what makes the skin's own layer visible to the scan at all.
 * @param {import('./runtime.js').UiProjectRuntime | undefined} runtime
 * @returns {Record<string, unknown>}
 */
function collectLayers(runtime) {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return { supported: false }
  const revision = runtime?.registry?.getVersion?.() ?? -1
  if (layerCache !== undefined && layerCache.revision === revision) return layerCache.value

  /** @type {Array<{ node: Element, label: string }>} */
  const candidates = []
  /** @param {Element | null | undefined} node @param {string} label */
  const consider = (node, label) => {
    if (node === null || node === undefined) return
    if (candidates.some((entry) => entry.node === node)) return
    candidates.push({ node, label })
  }
  consider(document.body, 'body')
  const columns = Array.from(document.querySelectorAll('[data-ui-skin-column]'))
  for (const column of columns) consider(column, 'column')
  consider(columns[0]?.parentElement, 'frame')
  consider(document.querySelector('[data-rightbar-col]'), 'rightbar')
  consider(document.querySelector('[data-shell-overlay]'), 'overlay')
  consider(document.querySelector('[data-composer-card]'), 'composer')
  for (const surface of document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]')) {
    consider(surface, `role:${surface.getAttribute('role')}`)
  }

  /** @param {Element} node @returns {{ element: string, pseudo: string }} */
  const blurOf = (node) => {
    const read = (pseudo) => {
      try {
        const value = getComputedStyle(node, pseudo).backdropFilter
        return typeof value === 'string' ? value : ''
      } catch {
        return ''
      }
    }
    return { element: read(undefined), pseudo: read('::before') }
  }
  const filters = (value) => value !== '' && value !== 'none'

  /** @type {Array<{ node: Element, label: string, where: string, value: string }>} */
  const filtered = []
  for (const entry of candidates) {
    const blur = blurOf(entry.node)
    if (filters(blur.element)) filtered.push({ ...entry, where: 'element', value: blur.element })
    else if (filters(blur.pseudo)) filtered.push({ ...entry, where: '::before', value: blur.pseudo })
  }

  /*
   * A nesting is a filtered node with another filtered node above it. The walk is capped at 12
   * levels: deeper than any real wrapper chain, and a cap is what keeps a malformed document from
   * turning a diagnostic into a hang.
   */
  const chains = []
  for (const inner of filtered) {
    let node = inner.node.parentElement
    for (let depth = 0; depth < 12 && node !== null; depth += 1) {
      const outer = filtered.find((entry) => entry.node === node)
      if (outer !== undefined) {
        chains.push({
          inner: `${inner.label}${inner.where === '::before' ? '::before' : ''}`,
          outer: `${outer.label}${outer.where === '::before' ? '::before' : ''}`,
        })
        break
      }
      node = node.parentElement
    }
  }

  const value = {
    supported: true,
    scanned: candidates.length,
    filtered: filtered.map((entry) => `${entry.label}${entry.where === '::before' ? '::before' : ''}`),
    chains,
  }
  layerCache = { revision, value }
  return value
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
