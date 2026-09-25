/**
 * Real-browser verification for the Liquid Glass skin.
 *
 * Everything else in this package is verified in Node: the bundle executes, the
 * registry behaves, the CSS is scoped, the tokens are real. What no Node test can
 * answer is the only question a skin ultimately has to answer — *does the running
 * application actually become glass, and does it actually come back?*
 *
 * So this script drives a real Chrome over the DevTools Protocol (WebSocket from
 * Node, no dependency) against a real `dsh web` process, and asserts against the
 * live DOM and computed styles:
 *
 *   1. the Settings › UI section opens and renders the project card
 *   2. clicking the switch turns the skin on, and the DOM says so
 *   3. shipped surfaces really gain `backdrop-filter` — measured, not assumed
 *   4. the shipped design tokens really change value
 *   5. the state survives a reload
 *   6. clicking it off again restores the original computed styles exactly
 *   7. a mobile-sized viewport gets the reduced blur and no overflow
 *   8. no console or page errors are raised along the way
 *
 * Usage (the server URL must include its `?token=`):
 *   node scripts/browser-verify.mjs "http://127.0.0.1:3081/?token=…" [--shot out.png]
 */

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

const pageUrl = process.argv[2]
if (pageUrl === undefined) {
  process.stderr.write('usage: node scripts/browser-verify.mjs "<dsh web url with token>" [--shot out.png]\n')
  process.exit(2)
}
const shotIndex = process.argv.indexOf('--shot')
const shotPath = shotIndex === -1 ? undefined : process.argv[shotIndex + 1]

/**
 * The blur radius the skin uses on a phone-sized viewport. Read from the source
 * rather than restated here, so changing the material cannot leave this test
 * asserting a value the skin no longer uses.
 */
const MOBILE_BLUR_PX = Number(
  /--lg-blur-mobile:\s*(\d+)px/.exec(
    await (await import('node:fs/promises')).readFile(
      new URL('../src/client/projects/liquid-glass/glass.css', import.meta.url),
      'utf8',
    ),
  )?.[1] ?? 0,
)

const CHROME_CANDIDATES = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
]

let failures = 0
let checks = 0

/** @param {string} name @param {() => void | Promise<void>} body */
async function test(name, body) {
  try {
    await body()
    process.stdout.write(`  ok   ${name}\n`)
  } catch (err) {
    failures += 1
    process.stdout.write(`  FAIL ${name}\n         ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/** @param {unknown} actual @param {unknown} expected @param {string} [what] */
function equal(actual, expected, what = 'value') {
  checks += 1
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

/** @param {unknown} value @param {string} [what] */
function truthy(value, what = 'value') {
  checks += 1
  if (!value) throw new Error(`${what}: expected truthy, got ${JSON.stringify(value)}`)
}

/** @param {string} haystack @param {string} needle */
function contains(haystack, needle, detail) {
  checks += 1
  if (!String(haystack).includes(needle)) {
    throw new Error(`expected to find ${JSON.stringify(needle)}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── chrome + CDP ─────────────────────────────────────────────────────────── */

/**
 * Launch a headless browser and learn which debug port it chose.
 *
 * The port is read from `DevToolsActivePort` — the file Chrome/Edge writes into
 * the user-data directory when started with `--remote-debugging-port=0` — rather
 * than from a piped stderr. Reading the file is strictly better here: it needs no
 * pipe, so the launcher works under a sandbox that forbids piped stdio, and it is
 * the browser's own authoritative statement of the port it bound.
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number, profile: string }>}
 */
async function launchChrome() {
  const { existsSync } = await import('node:fs')
  const { readFile } = await import('node:fs/promises')
  const binary = CHROME_CANDIDATES.find((candidate) => candidate.length > 0 && existsSync(candidate))
  if (binary === undefined) throw new Error('no Chrome or Edge binary found')
  const profile = await mkdtemp(join(tmpdir(), 'dsh-ui-projects-chrome-'))
  const child = spawn(
    binary,
    [
      '--headless=new',
      // Port 0 lets the browser choose: this can never collide with a port in use.
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=1440,900',
      'about:blank',
    ],
    // No piped stdio: a sandbox may forbid capturing another program's output.
    { stdio: 'ignore' },
  )
  const marker = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + 30000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the browser exited early with code ${child.exitCode}`)
    if (existsSync(marker)) {
      const firstLine = (await readFile(marker, 'utf8')).split('\n')[0].trim()
      const port = Number(firstLine)
      if (Number.isInteger(port) && port > 0) return { child, port, profile }
    }
    if (Date.now() > deadline) throw new Error('the browser did not report a debug port within 30s')
    await sleep(200)
  }
}

/** Minimal CDP client: one socket, id-keyed replies, event fan-out. */
class Cdp {
  /** @param {string} url */
  constructor(url) {
    this.next = 1
    this.pending = new Map()
    /** @type {Map<string, Array<(params: any) => void>>} */
    this.listeners = new Map()
    this.socket = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(undefined))
      this.socket.addEventListener('error', () => reject(new Error('cdp socket error')))
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        this.pending.delete(message.id)
        if (message.error !== undefined) entry.reject(new Error(`${message.error.message} (${entry.method})`))
        else entry.resolve(message.result)
        return
      }
      const handlers = this.listeners.get(message.method)
      if (handlers !== undefined) for (const handler of [...handlers]) handler(message.params)
    })
  }

  /** @param {string} method @param {any} [params] @returns {Promise<any>} */
  send(method, params = {}) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** @param {string} method @param {(params: any) => void} handler @returns {() => void} */
  on(method, handler) {
    const handlers = this.listeners.get(method) ?? []
    handlers.push(handler)
    this.listeners.set(method, handlers)
    return () => {
      const index = handlers.indexOf(handler)
      if (index >= 0) handlers.splice(index, 1)
    }
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
  }
}

/* ── page helpers ─────────────────────────────────────────────────────────── */

/** @param {{ send: Function }} session @param {string} expression */
async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page exception: ${result.exceptionDetails.exception?.description ?? 'unknown'}`)
  }
  return result.result.value
}

/** Poll a page predicate until it is true or the budget runs out. */
async function waitFor(session, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await evaluate(session, expression)) === true) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(200)
  }
}

/* ── reading the rendered pixels ──────────────────────────────────────────── */

/**
 * Decode a PNG far enough to read its pixels.
 *
 * Chrome emits 8-bit non-interlaced PNGs, either RGB (a clipped screenshot drops
 * the alpha channel) or RGBA, so the full format is not needed: concatenate the
 * `IDAT` chunks, inflate, and undo the per-scanline filter. This is what lets the
 * suite measure *rendered* contrast instead of trusting a token value, which is the
 * only honest way to check a translucent surface.
 * @param {Buffer} png
 * @returns {{ width: number, height: number, channels: number, pixels: Buffer }}
 */
function decodePng(png) {
  let offset = 8
  let width = 0
  let height = 0
  let channels = 4
  /** @type {Buffer[]} */
  const idat = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      const colourType = data[9]
      if (depth !== 8 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${colourType})`)
      }
      channels = colourType === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]
    const line = raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride)
    const out = pixels.subarray(row * stride, (row + 1) * stride)
    const prior = row === 0 ? Buffer.alloc(stride) : pixels.subarray((row - 1) * stride, row * stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0
      const up = prior[x]
      const upLeft = x >= channels ? prior[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      out[x] = value & 0xff
    }
  }
  return { width, height, channels, pixels }
}

/** Relative luminance, the WCAG definition. */
function luminance(/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) {
  const channel = (/** @type {number} */ value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * The rendered contrast inside one element's box: the luminance distance between
 * its darkest and lightest pixel. Text on a surface always produces both, so this
 * measures what a reader actually sees over a translucent background — including
 * whatever the glass is refracting — without needing to locate glyphs.
 * @param {{ send: Function }} session
 * @param {{ x: number, y: number, width: number, height: number }} clip
 * @returns {Promise<number>} luminance delta, 0..1
 */
async function measuredContrast(session, clip) {
  const shot = await session.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
  })
  const { pixels, channels } = decodePng(Buffer.from(shot.data, 'base64'))
  let min = 1
  let max = 0
  for (let i = 0; i + channels - 1 < pixels.length; i += channels) {
    const value = luminance(pixels[i], pixels[i + 1], pixels[i + 2])
    if (value < min) min = value
    if (value > max) max = value
  }
  return Math.round((max - min) * 1000) / 1000
}

/** Shared page-side helpers, injected into every expression that needs them. */
const HELPERS = `
  const isVisible = (el) => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
  const clickable = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button' || node.tagName === 'A') return node;
    }
    return el;
  };
  const byOwnText = (needle) => Array.from(document.querySelectorAll('*'))
    .filter((el) => isVisible(el) && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() === needle))[0];
  // The project marker lives on the BODY: project stylesheets are scoped there,
  // because that is the element the shipped design tokens are declared on.
  const skinMarker = () => document.body.getAttribute('data-ui-project-liquid-glass');
  // A stable identity for "which elements are blurred", so a test can compare the
  // SET before and after rather than a count. The shipped client blurs one surface
  // of its own, so a bare count proves nothing either way.
  const blurredKeys = () => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const value = cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : cs.webkitBackdropFilter;
      if (value && value !== 'none') {
        out.push([el.tagName.toLowerCase(), String(el.className || '').slice(0, 40), Array.from(el.attributes).map((a) => a.name).filter((n) => n.startsWith('data-')).join(',')].join('|'));
      }
    }
    return out.sort();
  };
  const sweepBlur = () => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const value = cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : cs.webkitBackdropFilter;
      if (value && value !== 'none') {
        const rect = el.getBoundingClientRect();
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 50),
          attrs: Array.from(el.attributes).map((a) => a.name).filter((n) => n.startsWith('data-')).join(','),
          w: Math.round(rect.width), h: Math.round(rect.height), filter: value,
        });
      }
    }
    return out;
  };
`

const PROBE = `(() => {${HELPERS}
  const blurred = sweepBlur();
  const body = getComputedStyle(document.body);
  return {
    blurredCount: blurred.length,
    blurred: blurred.slice(0, 10),
    blurKeys: blurredKeys(),
    ambient: document.querySelectorAll('.ds-ambient').length,
    skinAttr: document.documentElement.getAttribute('data-ui-skin'),
    projectAttr: skinMarker(),
    systemAttr: document.documentElement.getAttribute('data-ui-projects'),
    frames: document.querySelectorAll('[data-rightbar-col]').length,
    overlay: document.querySelectorAll('[data-shell-overlay]').length,
    tokens: {
      // Read from the BODY: that is where the shipped client declares its tokens,
      // and where a project stylesheet therefore has to override them.
      layer1: body.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
      sidebar: body.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
      accent: body.getPropertyValue('--lg-accent').trim(),
      highlight: body.getPropertyValue('--lg-highlight').trim(),
    },
  };
})()`

const OPEN_PANEL = `(() => {${HELPERS}
  // The foot trigger's label is visually hidden in the sidebar's rail state (a
  // phone-sized viewport auto-collapses it), so fall back to the accessible name and
  // then to the trigger's own control.
  const byLabel = Array.from(document.querySelectorAll('button,[role="button"]'))
    .filter((el) => isVisible(el))
    .find((el) => /设置|Settings/i.test(el.getAttribute('aria-label') || '') || /设置|Settings/i.test(el.getAttribute('title') || ''));
  const trigger = byOwnText('设置') || byOwnText('Settings') || byLabel;
  if (!trigger) {
    return {
      error: 'settings trigger not found',
      buttons: Array.from(document.querySelectorAll('button')).filter(isVisible)
        .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 12))
        .filter(Boolean).slice(0, 20),
    };
  }
  clickable(trigger).click();
  return { ok: true };
})()`

const CLICK_SECTION = `(() => {${HELPERS}
  const section = byOwnText('界面') || byOwnText('UI');
  if (!section) {
    return {
      error: 'UI section not found',
      seen: Array.from(document.querySelectorAll('*'))
        .filter(isVisible)
        .map((el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(''))
        .filter((t) => t.length > 0 && t.length < 12).slice(0, 30),
    };
  }
  clickable(section).click();
  return { ok: true };
})()`

const PANEL_STATE = `(() => {
  const card = document.querySelector('[data-project="liquid-glass"]');
  const sw = card ? card.querySelector('[role="switch"]') : null;
  return {
    panel: document.querySelectorAll('.uip-root').length,
    cards: Array.from(document.querySelectorAll('[data-project]')).map((c) => c.getAttribute('data-project')),
    checked: sw ? sw.getAttribute('aria-checked') : null,
    label: sw ? sw.getAttribute('aria-label') : null,
    status: card ? card.getAttribute('data-status') : null,
    name: card ? (card.querySelector('.uip-name') || {}).textContent : null,
  };
})()`

const CLICK_SWITCH = `(() => {
  const sw = document.querySelector('[data-project="liquid-glass"] [role="switch"]');
  if (!sw) return { error: 'switch not found' };
  const was = sw.getAttribute('aria-checked');
  sw.click();
  return { ok: true, was };
})()`

/**
 * Boxes of the text a reader depends on, with the label to report them under. Each
 * is a place the glass sits behind real words, so each is a place the skin could
 * have destroyed legibility.
 *
 * The list falls back to always-present application text, because the settings
 * panel is not open in every phase that measures contrast.
 */
/**
 * Boxes of text a reader depends on, with the label to report them under.
 *
 * Only UNOBSTRUCTED text qualifies. When the settings dialog is open, the
 * application behind it sits under the dialog's scrim: the sidebar label is
 * covered, so measuring its pixels finds a flat wash and would report a contrast
 * failure for a label nobody is reading at that moment. What is measured instead
 * is the settings surface — which really does sit on the glass — plus, only when
 * no dialog covers it, the sidebar's own label.
 */
const TEXT_TARGETS = `(() => {${HELPERS}
  const runBox = (el, label) => {
    if (!el) return null;
    const textNode = Array.from(el.childNodes).find((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!textNode) return null;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const firstLine = range.getClientRects()[0];
    if (!firstLine) return null;
    const width = Math.min(firstLine.width, 420);
    const height = Math.min(firstLine.height, 40);
    return width >= 16 && height >= 10
      ? { label, x: firstLine.x, y: firstLine.y, width, height }
      : null;
  };
  const elementBox = (el, label) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 10
      ? { label, x: r.x, y: r.y, width: Math.min(r.width, 420), height: Math.min(r.height, 40) }
      : null;
  };
  const dialogOpen = document.querySelector('.uip-root') !== null;
  const own = (needle) => Array.from(document.querySelectorAll('*'))
    .filter((el) => isVisible(el) && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() === needle))[0];
  const settingsLabel = own('设置') || own('Settings') || own('界面') || own('UI');
  return [
    dialogOpen ? null : runBox(settingsLabel, 'sidebar label'),
    elementBox(document.querySelector('.uip-intro'), 'settings panel copy'),
    elementBox(document.querySelector('.uip-description'), 'project card description'),
    elementBox(document.querySelector('.uip-title'), 'settings panel title'),
  ].filter(Boolean);
})()`

/**
 * Open Settings on the UI section, whatever state the shell is in.
 *
 * The sidebar trigger TOGGLES, so a naive "click trigger, then click section" closes
 * the dialog again whenever it happened to be open — which made several phases
 * intermittently fail for reasons that had nothing to do with the skin. This checks
 * first, retries once from a known-closed state, and is safe to call any number of
 * times.
 * @param {{ send: Function }} session
 */
async function ensurePanel(session) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await evaluate(session, "document.querySelectorAll('.uip-root').length > 0")) === true) return
    const opened = await evaluate(session, OPEN_PANEL)
    if (opened.ok !== true) {
      // A narrow viewport auto-collapses the sidebar into a rail, where the foot
      // trigger may not be rendered at all until the rail is expanded. Expanding it
      // is the one extra step, and it is a real user action rather than a hack.
      const expanded = await evaluate(session, `(() => {${HELPERS}
        const toggle = Array.from(document.querySelectorAll('button')).filter(isVisible)
          .find((el) => /展开|收起|expand|collapse|sidebar/i.test((el.getAttribute('aria-label') || '') + (el.getAttribute('title') || '')));
        if (!toggle) return { error: 'no sidebar toggle', width: window.innerWidth };
        toggle.click();
        return { ok: true };
      })()`)
      if (expanded.ok !== true) {
        throw new Error(
          `the settings trigger could not be found at ${expanded.width}px: ${JSON.stringify({ opened, expanded })}`,
        )
      }
      await sleep(500)
      continue
    }
    await evaluate(session, CLICK_SECTION)
    try {
      await waitFor(session, "document.querySelectorAll('.uip-root').length > 0", 'the UI panel', 6000)
      return
    } catch (err) {
      if (attempt === 2) throw err
      // Start the next attempt from a state we know: dialog closed.
      await closePanel(session)
    }
  }
}

/**
 * Close Settings if it is open, using Escape — the shell owns that chrome, and the
 * close control is not something a skin test should have to guess at.
 * @param {{ send: Function }} session
 */
async function closePanel(session) {
  if ((await evaluate(session, "document.querySelectorAll('.uip-root').length")) === 0) return
  for (const type of ['keyDown', 'keyUp']) {
    await session.send('Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
  }
  await waitFor(session, "document.querySelectorAll('.uip-root').length === 0", 'the dialog to close', 10000)
}

/* ── run ──────────────────────────────────────────────────────────────────── */

const chrome = await launchChrome()
process.stdout.write(
  `\nLiquid Glass browser verification\nchrome:   port ${chrome.port}\npage:     ${pageUrl}\n\n`,
)

/** @type {Cdp | undefined} */
let cdp
/** @type {Cdp | undefined} */
let page
try {
  const version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()
  cdp = new Cdp(version.webSocketDebuggerUrl)
  await cdp.ready

  // Attach straight to a page target's own socket: `Page`/`Runtime` are page
  // domains, so a browser-level socket has neither. A fresh tab keeps the run
  // independent of any other window the profile might restore.
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json()
  const target = targets.find((entry) => entry.id === targetId)
  if (target?.webSocketDebuggerUrl === undefined) throw new Error('the page target exposes no debugger socket')

  page = new Cdp(target.webSocketDebuggerUrl)
  await page.ready
  /** @type {{ send: (method: string, params?: any) => Promise<any> }} */
  const session = page

  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Log.enable')

  /** @type {string[]} */
  const pageErrors = []
  page.on('Runtime.exceptionThrown', (params) => {
    pageErrors.push(String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '?'))
  })
  page.on('Log.entryAdded', (params) => {
    if (params.entry.level === 'error') pageErrors.push(String(params.entry.text))
  })

  const navigate = async (url) => {
    await session.send('Page.navigate', { url })
    await waitFor(session, "document.querySelectorAll('#root *').length > 40", 'the app to mount', 45000)
    await waitFor(session, "document.querySelector('[data-rightbar-col]') !== null", 'the app frame')
  }

  await test('the application boots and mounts', async () => {
    await navigate(pageUrl)
  })

  await test('the Settings › UI section opens from the sidebar', async () => {
    const opened = await evaluate(session, OPEN_PANEL)
    truthy(opened.ok, `settings trigger (${JSON.stringify(opened)})`)
    const section = await evaluate(session, CLICK_SECTION)
    truthy(section.ok, `UI section (${JSON.stringify(section)})`)
    await waitFor(session, "document.querySelectorAll('.uip-root').length > 0", 'the UI panel')
  })

  await test('the panel lists the registered project with a keyboard-accessible switch', async () => {
    const state = await evaluate(session, PANEL_STATE)
    truthy(state.panel > 0, 'the panel is rendered')
    contains(JSON.stringify(state.cards), 'liquid-glass')
    equal(state.checked, 'false', 'the skin ships off')
    contains(state.label, 'Liquid Glass')
    equal(state.name, 'Liquid Glass', 'card title')
    equal(state.status, 'inactive', 'card status')
  })

  /** @type {any} */
  let before
  await test('the default interface is untouched before the skin is on', async () => {
    before = await evaluate(session, PROBE)
    equal(before.projectAttr, null, 'no project marker')
    equal(before.ambient, 0, 'no ambient layer')
    equal(before.tokens.accent, '', 'the skin vocabulary is absent')
    truthy(before.frames > 0, 'the app frame is present to measure against')
    truthy(before.tokens.layer1 !== '', 'the shipped token resolves')
    // The shipped client blurs one surface of its own, so the skin is held to the
    // stronger claim: it must ADD blur, and later remove exactly what it added.
    truthy(Array.isArray(before.blurKeys), 'the blurred-element set is observable')
  })

  /** @type {any} */
  let after
  await test('turning the skin on really makes shipped surfaces glass', async () => {
    const clicked = await evaluate(session, CLICK_SWITCH)
    truthy(clicked.ok, `switch click (${JSON.stringify(clicked)})`)
    await waitFor(session, "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'", 'the marker')

    after = await evaluate(session, PROBE)
    equal(after.projectAttr, 'on', 'project marker')
    equal(after.skinAttr, 'liquid-glass', 'skin marker')
    equal(after.systemAttr, 'on', 'system marker')
    equal(after.ambient, 0, 'no ambient layer: the material is stylesheet-only')

    // The point of the whole exercise: the skin adds refraction to shipped regions.
    // Compared as a set, so the one surface the client already blurs is not
    // mistaken for the skin's own work.
    const added = after.blurKeys.filter((key) => !before.blurKeys.includes(key))
    truthy(
      added.length > 0,
      `the skin added blurred surfaces (added ${added.length}: ${JSON.stringify(added.slice(0, 4))})`,
    )
    const large = after.blurred.filter((entry) => entry.w > 200 && entry.h > 100)
    truthy(large.length > 0, `a real application region is blurred: ${JSON.stringify(after.blurred.slice(0, 4))}`)

    // The shipped design tokens changed value — that is what turns components glass.
    truthy(
      after.tokens.layer1 !== before.tokens.layer1,
      `the layer-1 token changed: ${before.tokens.layer1} → ${after.tokens.layer1}`,
    )
    contains(after.tokens.layer1, '/', 'the new fill is translucent rather than opaque')
    truthy(
      after.tokens.sidebar !== before.tokens.sidebar,
      `the sidebar fill changed: ${before.tokens.sidebar} → ${after.tokens.sidebar}`,
    )
    equal(after.tokens.accent, '#4d6bfe', 'the skin accent is available to its own material')
  })

  await test('the switch reports its state accessibly after the change', async () => {
    const state = await evaluate(session, PANEL_STATE)
    equal(state.checked, 'true', 'aria-checked follows the state')
    // The accessible name is localized, so assert it names the project and reflects
    // the new state rather than pinning one language's wording.
    contains(state.label, 'Liquid Glass')
    truthy(
      /Turn off|关闭/.test(String(state.label)),
      `the label says the switch will turn it OFF: ${state.label}`,
    )
    equal(state.status, 'active', 'card status')
  })

  if (shotPath !== undefined) {
    await test('a screenshot of the skinned interface is captured', async () => {
      const shot = await session.send('Page.captureScreenshot', { format: 'png' })
      await writeFile(shotPath, Buffer.from(shot.data, 'base64'))
      process.stdout.write(`         saved ${shotPath} (dialog open)\n`)
    })

    await test('the interface itself is captured with the dialog closed', async () => {
      // The dialog covers the conversation, so the skin's effect on the *content* —
      // the thing that must stay readable — is only visible with it dismissed. An
      // earlier version of this skin failed exactly here, and a passing panel
      // screenshot hid it.
      //
      // Dismissed with Escape rather than by hunting for the close button: the shell
      // owns that chrome, and guessing at it clicked the wrong control.
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await waitFor(session, "document.querySelectorAll('.uip-root').length === 0", 'the dialog to close', 10000)
      // Let the dialog's exit transition and the shell's own animations settle: a
      // capture taken mid-transition is a photograph of the animation, not of the
      // interface, and would misreport a readable page as a blurred one.
      await sleep(700)
      const shot = await session.send('Page.captureScreenshot', { format: 'png' })
      const closedPath = shotPath.replace(/\.png$/, '-closed.png')
      await writeFile(closedPath, Buffer.from(shot.data, 'base64'))
      process.stdout.write(`         saved ${closedPath} (dialog closed)\n`)

      // Record what the capture should show, so a blurred result can be attributed
      // instead of guessed at.
      const state = await evaluate(session, `(() => {${HELPERS}
        const blurred = sweepBlur();
        const copy = Array.from(document.querySelectorAll('[data-rightbar-col] *'))
          .filter((el) => el.children.length === 0 && (el.textContent || '').trim().length > 1)
          .slice(0, 3)
          .map((el) => ({ text: (el.textContent || '').trim().slice(0, 20), opacity: getComputedStyle(el).opacity, filter: getComputedStyle(el).filter, blur: getComputedStyle(el).backdropFilter }));
        return { blurredCount: blurred.length, blurred: blurred.slice(0, 5), sample: copy, animations: document.getAnimations().length };
      })()`)
      process.stdout.write(`         closed state: ${JSON.stringify(state)}\n`)

      // Re-open for the phases that follow.
      await ensurePanel(session)
    })
  }

  await test('text over the glass is still readable, measured from the rendered pixels', async () => {
    // Runs while the skin is ON and the panel is open, so both the application's
    // own text and the settings copy are measurable. A translucent skin can look
    // convincing and still fail here — which is the whole reason for measuring.
    const targets = await evaluate(session, TEXT_TARGETS)
    truthy(targets.length >= 2, `text targets located (${JSON.stringify(targets.map((t) => t.label))})`)

    /** @type {Array<{ label: string, delta: number }>} */
    const measured = []
    for (const target of targets) {
      measured.push({ label: target.label, delta: await measuredContrast(session, target) })
    }
    const worst = measured.reduce((a, b) => (a.delta <= b.delta ? a : b))
    // 14px body text needs 4.5:1 against its background, roughly a luminance delta
    // of 0.25 for the greys this design uses. Under 0.2 means the glass has washed
    // the text out, whatever the token values claim.
    truthy(
      worst.delta >= 0.2,
      `every measured text box keeps contrast (worst: ${worst.label} at ${worst.delta}; all: ${JSON.stringify(measured)})`,
    )
  })

  await test('the skin survives a reload', async () => {
    await navigate(pageUrl)
    await waitFor(session, "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'", 'the marker')
    const restored = await evaluate(session, PROBE)
    equal(restored.projectAttr, 'on', 'the marker is restored from persisted state')
    equal(restored.ambient, 0, 'still no ambient layer after a reload')
    equal(restored.tokens.layer1, after.tokens.layer1, 'the skin palette is restored')
    // And the refraction comes back where it belongs: on a floating surface.
    await ensurePanel(session)
    const withDialog = await evaluate(session, PROBE)
    truthy(withDialog.blurredCount > 0, 'the dialog carries the refraction after a reload')
  })

  await test('turning the skin off restores the original computed styles exactly', async () => {
    await ensurePanel(session)
    const clicked = await evaluate(session, CLICK_SWITCH)
    truthy(clicked.ok, `switch click (${JSON.stringify(clicked)})`)
    await waitFor(
      session,
      "document.body.getAttribute('data-ui-project-liquid-glass') === null",
      'the marker to clear',
    )

    const restored = await evaluate(session, PROBE)
    equal(restored.projectAttr, null, 'project marker removed')
    equal(restored.skinAttr, null, 'skin marker removed')
    equal(restored.ambient, 0, 'ambient layer removed')
    equal(restored.blurKeys, before.blurKeys, 'exactly the original blurred surfaces remain')
    equal(restored.tokens.layer1, before.tokens.layer1, 'the layer-1 token is back to its original value')
    equal(restored.tokens.sidebar, before.tokens.sidebar, 'the sidebar fill is back to its original value')
    equal(restored.tokens.accent, '', 'the skin vocabulary is gone')
  })

  await test('a mobile-sized viewport gets the reduced blur with no overflow', async () => {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    })
    // The skin is turned ON for this phase explicitly, rather than relying on what
    // the previous test left behind: each phase states the state it needs.
    await evaluate(
      session,
      `localStorage.setItem('dsh.ui-projects.v1', JSON.stringify({ v: 1, initialized: true, enabled: ['liquid-glass'], settings: {}, touched: true }))`,
    )
    await navigate(pageUrl)
    await waitFor(session, "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'", 'the marker')
    // Open the panel: the refraction lives on floating surfaces, so a dialog is what
    // makes it measurable — and the dialog is also the surface a phone user opens.
    await ensurePanel(session)
    const mobile = await evaluate(session, `(() => {${HELPERS}
      const blurred = sweepBlur();
      // The element to measure is the one carrying the SKIN's material, not merely the
      // first blurred node in the tree: the dialog's own mask is a shipped element that
      // blurs 2px, and it comes first. Selecting by the saturate() the skin always adds
      // keeps this a measurement of the skin.
      const skinBlur = blurred.find((entry) => entry.filter.includes('saturate')) || blurred[0];
      return {
        count: blurred.length,
        blurValue: skinBlur ? skinBlur.filter : '',
        blurred,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        width: window.innerWidth,
        mobileQuery: matchMedia('(max-width: 768px)').matches,
        resolvedRadius: getComputedStyle(document.body).getPropertyValue('--lg-blur-mobile').trim(),
      };
    })()`)
    equal(mobile.width, 390, 'the emulated viewport applied')
    truthy(mobile.count > 0, `a floating surface is still blurred on mobile (${JSON.stringify(mobile)})`)
    // The mobile step-down is the whole point of that media query, so assert it.
    contains(
      mobile.blurValue,
      `${MOBILE_BLUR_PX}px`,
      `measured ${JSON.stringify(mobile.blurValue)}; radius token ${JSON.stringify(mobile.resolvedRadius)}; ` +
        `mobile query ${mobile.mobileQuery}; blurred ${JSON.stringify(mobile.blurred)}`,
    )
    equal(mobile.overflow, false, 'the skin introduces no horizontal overflow')
    await session.send('Emulation.clearDeviceMetricsOverride')
  })

  await test('dark mode gets blue-black glass, not the light palette', async () => {
    /*
     * Dark mode is selected through the SAME signal the shipped client uses to
     * switch its own palette: the `data-ds-dark-theme` attribute on `body`. That is
     * the whole interface between the theme feature and a skin, and setting it
     * directly is what makes this phase independent of which Settings section
     * happens to be open — an earlier version drove the Appearance control and
     * broke whenever the dialog remembered a different section.
     *
     * The skin's own behaviour is what is under test here, and the token values
     * below are read from computed styles, so nothing about this is assumed.
     */
    await navigate(pageUrl)
    await waitFor(
      session,
      "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'",
      'the restored skin',
    )
    await evaluate(session, "document.body.setAttribute('data-ds-dark-theme', '')")
    await waitFor(session, "document.body.getAttribute('data-ds-dark-theme') !== null", 'dark mode to apply', 10000)

    const dark = await evaluate(session, PROBE)
    const darkState = await evaluate(session, `(() => {${HELPERS}
      const bs = getComputedStyle(document.body);
      const supports = (q) => window.CSS && CSS.supports ? CSS.supports(q) : 'no CSS.supports';
      // Which rule actually won for the layer-1 token, and why.
      let winner = null;
      for (const sheet of document.styleSheets) {
        let rules = [];
        try { rules = Array.from(sheet.cssRules); } catch (e) { continue; }
        for (const rule of rules) {
          const text = rule.cssText || '';
          if (!text.includes('--dsw-alias-bg-layer-1')) continue;
          winner = winner || [];
          if (winner.length < 4) winner.push(text.slice(0, 150));
        }
      }
      return {
        darkAttr: document.body.getAttribute('data-ds-dark-theme'),
        layer1: bs.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
        sidebar: bs.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
        blurSupported: supports('backdrop-filter: blur(1px)'),
        webkitBlurSupported: supports('-webkit-backdrop-filter: blur(1px)'),
        winner,
      };
    })()`)
    // The skin must still be applied, and its fill must be the DARK one.
    equal(dark.projectAttr, 'on', 'the skin is still applied in dark mode')
    equal(dark.ambient, 0, 'and none in dark mode either')
    // The refraction is on floating surfaces, so it is checked with the dialog open
    // (the dark-mode block below re-opens it) rather than on the page at rest.
    truthy(
      String(darkState.layer1).includes('/') && !String(darkState.layer1).includes('255 255 255'),
      `the dark fill resolves to translucent blue-black (state: ${JSON.stringify(darkState)})`,
    )

    const darkText = String(darkState.layer1).match(/rgb\((\d+) (\d+) (\d+)/)
    truthy(darkText !== null && Number(darkText[1]) < 90, `the dark fill is dark: ${darkState.layer1}`)

    // Re-open the panel so there is unobstructed glass-backed text to measure, and so
    // the dark palette's refraction is present on a floating surface.
    await ensurePanel(session)
    const darkFloating = await evaluate(session, PROBE)
    truthy(darkFloating.blurredCount > 0, 'the floating surface is glass in dark mode too')

    // And it must stay readable over that fill, measured from pixels, not tokens.
    const darkTargets = await evaluate(session, TEXT_TARGETS)
    const darkUi = await evaluate(session, `(() => {${HELPERS}
      return {
        panelOpen: document.querySelectorAll('.uip-root').length,
        visibleTexts: Array.from(document.querySelectorAll('*'))
          .filter(isVisible)
          .map((el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(''))
          .filter((t) => t.length > 0 && t.length < 14)
          .slice(0, 16),
      };
    })()`)
    truthy(
      Array.isArray(darkTargets) && darkTargets.length >= 1,
      `dark-mode text targets located (got ${JSON.stringify(darkTargets)}; ui ${JSON.stringify(darkUi)})`,
    )
    const measured = []
    for (const target of darkTargets) {
      measured.push({ label: target.label, delta: await measuredContrast(session, target) })
    }
    const worst = measured.reduce((a, b) => (a.delta <= b.delta ? a : b))
    truthy(
      worst.delta >= 0.2,
      `dark-mode text keeps contrast (worst: ${worst.label} at ${worst.delta}; all: ${JSON.stringify(measured)})`,
    )

    if (shotPath !== undefined) {
      const darkShot = shotPath.replace(/\.png$/, '-dark.png')
      const shot = await session.send('Page.captureScreenshot', { format: 'png' })
      await writeFile(darkShot, Buffer.from(shot.data, 'base64'))
      process.stdout.write(`         saved ${darkShot}\n`)
    }

    // Leave the page in light mode so the run is repeatable: the same signal that
    // switched it on switches it back.
    await evaluate(session, "document.body.removeAttribute('data-ds-dark-theme')")
  })

  await test('the skin raises no console or page errors', () => {
    const relevant = pageErrors.filter((message) => !/favicon|net::ERR_|Failed to load resource/i.test(message))
    equal(relevant, [], 'no errors raised while the skin was applied')
  })

  /*
   * The effect tier, against a device forced to be weak.
   *
   * `Emulation.setHardwareConcurrencyOverride` applies to the TARGET, so it has to be set BEFORE the
   * page loads: the tier is decided once at `apply` time from the signals available then, not
   * polled. Both directions are checked, because a mechanism that only ever lowered the tier would
   * pass a one-sided test while leaving every capable machine on the cheap treatment.
   *
   * The blur is read from the frame's `::before` — the one frost layer — so this measures what the
   * stylesheet resolved, not what the attribute claims.
   */
  await test('a low-capacity device gets the reduced tier, and a capable one keeps the full tier', async () => {
    const readTier = `(() => {
      const column = document.querySelector('[data-ui-skin-column]')
      const frame = column === null ? null : column.parentElement
      return {
        tier: document.body.getAttribute('data-ui-perf'),
        blur: frame === null ? null : getComputedStyle(frame, '::before').backdropFilter,
      }
    })()`
    const original = await evaluate(session, 'navigator.hardwareConcurrency')
    truthy(typeof original === 'number' && original > 0, `the browser reports a core count (${original})`)

    try {
      await session.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 2 })
      await navigate(pageUrl)
      const weak = await evaluate(session, readTier)
      equal(weak.tier, 'low', 'two cores cap the tier at low')
      contains(String(weak.blur), '12px', `and the frost drops to the low radius (${weak.blur})`)
    } finally {
      await session.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: original })
    }

    await navigate(pageUrl)
    const capable = await evaluate(session, readTier)
    equal(capable.tier, 'high', 'a capable device returns to the tier the skin declares')
    contains(String(capable.blur), '20px', `and the frost is back at full radius (${capable.blur})`)
  })

  /*
   * Step 5, verified the hard way — and deliberately LAST, because it blocks the bundle.
   *
   * Everything above drives the RUNNING application, and a skin that is correct once the bundle
   * has loaded says nothing about the first frame, which happens before that bundle is even
   * fetched. With `dsh-ui-projects/client.js` blocked the application never mounts, so whatever
   * the document shows came from the served HTML alone: the host's inlined stylesheet and its
   * marker script. If the first frame is skinned here, it is skinned on every real load too —
   * including the ones where the bundle is still in flight.
   *
   * The boundary this asserts around: the FROST is not expected, because it hangs off
   * `data-ui-skin-column`, stamped by the client runtime. The colours, the transparent frame and
   * the ambient gradient are.
   */
  await test('the first frame is already the skin, with the client bundle blocked', async () => {
    await session.send('Network.enable')
    await session.send('Network.setBlockedURLs', { urls: ['*dsh-ui-projects/client.js*'] })
    try {
      await session.send('Page.navigate', { url: pageUrl })
      await waitFor(
        session,
        "document.body !== null && document.body.hasAttribute('data-ui-project-liquid-glass')",
        'the host-emitted marker',
        20000,
      )
      const first = await evaluate(
        session,
        `(() => {
          const body = document.body
          const style = getComputedStyle(body)
          return {
            marker: body.getAttribute('data-ui-project-liquid-glass'),
            rootSkin: document.documentElement.getAttribute('data-ui-skin'),
            fill: style.getPropertyValue('--dsw-alias-bg-base').trim(),
            gradient: String(style.backgroundImage).includes('radial-gradient'),
            attachment: String(style.backgroundAttachment),
            mounted: document.querySelectorAll('#root *').length,
          }
        })()`,
      )

      // The bundle never ran, so the rest of this is the host's work and nothing else's.
      equal(first.mounted, 0, 'the application did not mount, so the bundle really was blocked')
      equal(first.marker, 'on', 'the host marked the body before the first paint')
      equal(first.rootSkin, 'liquid-glass', 'and the root carries the skin id')
      truthy(
        String(first.fill).includes('/ 0%)'),
        `the frame is already see-through on the first frame (${first.fill})`,
      )
      truthy(first.gradient, 'the ambient gradient is already painted on the body')
      contains(first.attachment, 'fixed', `the gradient is viewport-anchored (${first.attachment})`)
    } finally {
      await session.send('Network.setBlockedURLs', { urls: [] })
    }
  })
} finally {
  page?.close()
  cdp?.close()
  chrome.child.kill()
}

process.stdout.write(`\n${checks} assertions, ${failures} failing\n`)
if (failures > 0) process.exitCode = 1
