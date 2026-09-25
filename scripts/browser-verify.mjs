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

/*
 * The URL is identified by its SHAPE, not by its position.
 *
 * It used to be `process.argv[2]`, which made one argument order-sensitive while the flags around
 * it were not — so `--no-write` alone became the "page URL", Chrome launched, every navigation
 * failed, and the suite reported fifteen skin failures that were really one bad argument. A harness
 * that answers a usage error with a verdict about the skin is worse than one that refuses to start.
 */
const cliArgs = process.argv.slice(2)
const pageUrl = cliArgs.find((argument) => /^https?:\/\//i.test(argument))
if (pageUrl === undefined) {
  const shown = cliArgs.length === 0 ? '(none)' : cliArgs.join(' ')
  process.stderr.write(
    `usage: node scripts/browser-verify.mjs "<dsh web url with token>" [--shot out.png] [--no-write]\n` +
      `  arguments given: ${shown}\n` +
      `  the page URL must start with http:// or https:// (a bare host or a flag is not accepted)\n` +
      "  --no-write  refuse the checklist's settings write, so a run leaves no confirmation behind\n",
  )
  process.exit(2)
}
const shotIndex = cliArgs.indexOf('--shot')
const shotPath = shotIndex === -1 ? undefined : cliArgs[shotIndex + 1]
/*
 * `--no-write` keeps the checklist confirmation out of the durable settings document.
 *
 * The concern is real and not hypothetical: the default run records a confirmation against the
 * current version, which overwrites whatever a person had confirmed by hand and accumulates on
 * every re-run. But a blanket "do not persist" would break this suite's own reload assertions — a
 * skin toggle that does not survive a reload fails the test that checks it — so the refusal is
 * narrowed to the one write that matters: a settings mutation whose payload carries `checks`.
 *
 * The write path is HTTP, which is what makes this possible at all: every api call is a
 * `POST /api/<service>/<operation>` (see the connection layer's rpc), so the operation is in the URL
 * and the payload is in the body. Nothing here reaches into the page or mocks its code; the request
 * is simply refused in flight, which is also why the plugin's in-memory state still changes and the
 * test can assert the difference between the two.
 */
const noWrite = cliArgs.includes('--no-write')

/**
 * The mobile radius: its token name, and the value read from it.
 *
 * Named once, because the name was wrong in two places at once — this reader and the assertion that
 * reports the resolved token both looked for `--lg-blur-mobile`, which appears in no file; the real
 * name is `--lg-glass-blur-mobile`. A reader that missed then fell through `?? 0`, so the first run
 * of this suite compared the skin's mobile radius against `0px` and failed a check whose measured
 * value was exactly right.
 *
 * A miss is now a thrown error rather than a default, which is the part that matters: a value this
 * script asserts against must never be something it invented. (Round 20 removed the same class of
 * silence from the Node suite by reading a storage key from the module that owns it.)
 */
const MOBILE_BLUR_TOKEN = '--lg-glass-blur-mobile'
const mobileBlurSource = await (await import('node:fs/promises')).readFile(
  new URL('../src/client/projects/liquid-glass/glass.css', import.meta.url),
  'utf8',
)
const mobileBlurMatch = new RegExp(`${MOBILE_BLUR_TOKEN}:\\s*(\\d+)px`).exec(mobileBlurSource)
if (mobileBlurMatch === null) {
  throw new Error(`glass.css declares no ${MOBILE_BLUR_TOKEN}, so the mobile assertion has nothing to compare against`)
}
const MOBILE_BLUR_PX = Number(mobileBlurMatch[1])

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
  /*
   * The composer, read the same way the frame is: the fill from the card and the blur from the
   * pseudo-element that carries it. Nothing here assumes the rules exist — a missing hook or a
   * missing pseudo answers null and the assertions below say so.
   */
  const card = document.querySelector('[data-composer-card]');
  const seat = document.querySelector('[data-composer-seat]');
  const cardStyle = card === null ? null : getComputedStyle(card);
  const frostStyle = card === null ? null : getComputedStyle(card, '::before');
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
    composer: {
      cardFound: card !== null,
      seatFound: seat !== null,
      fill: cardStyle === null ? null : cardStyle.backgroundColor,
      isolation: cardStyle === null ? null : cardStyle.isolation,
      shadow: cardStyle === null ? null : cardStyle.boxShadow,
      radius: cardStyle === null ? null : cardStyle.borderRadius,
      frostBlur: frostStyle === null ? null : String(frostStyle.backdropFilter || frostStyle.webkitBackdropFilter || ''),
      frostRadius: frostStyle === null ? null : frostStyle.borderRadius,
      seatFade: seat === null ? null : String(getComputedStyle(seat).backgroundImage),
    },
    tokens: {
      // Read from the BODY: that is where the shipped client declares its tokens,
      // and where a project stylesheet therefore has to override them.
      layer1: body.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
      sidebar: body.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
      accent: body.getPropertyValue('--lg-accent').trim(),
      brand: body.getPropertyValue('--dsw-alias-brand-primary').trim(),
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

/*
 * Click the switch, waiting first for it to accept input, and report what happened AT THAT INSTANT.
 *
 * The switch is disabled while an action is pending, and a click on a disabled button is dropped
 * without a trace. That is not a defect in the panel — it is the panel refusing input while it is
 * still persisting the previous change — but it made this suite flaky in a way that read as a skin
 * failure: the marker wait timed out, the switch looked perfectly healthy afterwards, and nothing was
 * logged, because by then the pending flag had cleared. A person seeing a greyed-out control waits;
 * so does this now, and it reports how long it waited.
 *
 * The state is read at click time because a probe taken when the wait gives up cannot tell "the click
 * was refused" from "the click was accepted and the skin did not follow" — the first version of this
 * diagnostic was taken thirty seconds too late and reported a healthy switch through a whole run.
 */
const CLICK_SWITCH = `(async () => {
  const find = () => document.querySelector('[data-project="liquid-glass"] [role="switch"]');
  if (find() === null) return { error: 'switch not found' };
  const startedAt = Date.now();
  let target = find();
  while (target !== null && target.disabled === true && Date.now() - startedAt < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    target = find();
  }
  if (target === null) return { error: 'switch disappeared while waiting for it to accept input' };
  const waitedMs = Date.now() - startedAt;
  if (target.disabled === true) return { error: 'switch stayed disabled for 10s', waitedMs };
  const was = target.getAttribute('aria-checked');
  target.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const now = find();
  return {
    ok: true,
    was,
    waitedMs,
    replaced: now !== target,
    checkedAfter: now === null ? null : now.getAttribute('aria-checked'),
    disabledAfter: now === null ? null : now.disabled === true,
    markerAfter: document.body.getAttribute('data-ui-project-liquid-glass'),
  };
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

/**
 * Whether the skin is applied right now.
 *
 * Read from the marker rather than from the switch's own attribute: the two agree, and when they do
 * not, the marker is the one the stylesheet keys off — it decides what the page looks like.
 * @param {{ send: Function }} session
 * @returns {Promise<boolean>}
 */
async function skinIsOn(session) {
  return (await evaluate(session, "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'")) === true
}

/**
 * Drive the skin to a known state through the UI, the way a person would.
 *
 * Each phase states the state it needs rather than inheriting one from the phase before it. Two
 * things made that necessary rather than tidy: the suite used to assume the settings document
 * happened to say `enabled: []` when it started — a machine where somebody had switched the skin on
 * produced a dozen failures, every one of them an echo of that single mismatch — and one phase "set"
 * the state by writing a `localStorage` key this plugin has never read, which worked only because
 * the document beside it happened to say the right thing.
 * @param {{ send: Function }} session
 * @param {boolean} wantOn
 */
async function setSkin(session, wantOn) {
  await ensurePanel(session)
  if ((await skinIsOn(session)) === wantOn) return
  const clicked = await evaluate(session, CLICK_SWITCH)
  truthy(clicked.ok, `switch click (${JSON.stringify(clicked)})`)
  await waitFor(
    session,
    wantOn
      ? "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'"
      : "document.body.getAttribute('data-ui-project-liquid-glass') === null",
    wantOn ? 'the marker' : 'the marker to clear',
  )
}

/* ── run ──────────────────────────────────────────────────────────────────── */

const chrome = await launchChrome()
process.stdout.write(
  `\nLiquid Glass browser verification\nchrome:   port ${chrome.port}\npage:     ${pageUrl}\nsettings: ${
    noWrite ? 'writes REFUSED for the checklist (--no-write)' : 'writes allowed (the checklist records a real confirmation)'
  }\n\n`,
)

/** @type {Cdp | undefined} */
let cdp
/** @type {Cdp | undefined} */
let page
/**
 * What the skin's state was before this run touched anything.
 *
 * Declared out here because the restore lives in the `finally` below, and a `const` inside the `try`
 * block is not in scope there.
 */
let startedWithSkinOn = false
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
  /*
   * Page-level `console.error` calls, which arrive on THIS event and nowhere else.
   *
   * The suite asserted "the skin raises no console or page errors" while listening only to the two
   * events above, so the claim was broader than the instrument: a page's own `console.error` — how
   * React reports duplicate list keys, among much else — was invisible to it. The gap was found while
   * adding the registry's uniqueness rule, which removes one source of exactly such a warning.
   *
   * Errors only: the shell logs informational lines through the same event by design.
   */
  page.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error') return
    pageErrors.push((params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' '))
  })
  /**
   * Whether every assertion that READS `pageErrors` has already run.
   *
   * The console calibration at the end of this file deliberately produces one, so from that point on
   * the collector is no longer a clean channel. That contract is asserted rather than described —
   * see the calibration test — because a comment cannot fail when someone adds an assertion after it.
   */
  let consoleAssertionsDone = false

  /** How many checklist writes `--no-write` refused, so the test can prove it refused something. */
  let refusedWrites = 0
  /**
   * The checklist record the instance had before this run, and how many writes were refused for
   * trying to DELETE it. Declared out here because the Fetch handler below needs both, and it runs
   * from the first navigation onwards.
   */
  let checksAtStart = null
  let protectedRemovals = 0
  /**
   * Why a settings write should be refused under `--no-write`, or null to let it through.
   *
   * Extracted as a pure function so it can be checked against real payload shapes without a browser,
   * which matters because the first version of the removal rule was WRONG in a way no run revealed:
   * it looked for a `settings` property at the top level of the request body, and the real
   * operation is `settings/mutate`, whose arguments are `[namespace, ops]` with each op shaped
   * `{op: 'set', path: [...], value: ...}`. It therefore refused nothing, and the run that was
   * supposed to leave no trace deleted the confirmation it found.
   * @param {{ payload: string, isWrite: boolean, checksAtStart: string | null }} input
   * @returns {'checks' | 'removal' | null}
   */
  const refusalReason = ({ payload, isWrite, checksAtStart: had }) => {
    if (!isWrite) return null
    // The checklist write itself: the second of the two ways a record can be lost.
    if (payload.includes('checks')) return 'checks'
    if (had === null) return null
    /*
     * The removal: the plugin persists its record key by key, so the `settings` key is written on its
     * own and, once the record is gone from memory, its value carries nothing this can match on. The
     * path is what identifies it.
     */
    try {
      const body = JSON.parse(payload)
      const args = body?.payload ?? body
      const [namespace, ops] = Array.isArray(args) ? args : []
      if (namespace !== 'ui-projects' || !Array.isArray(ops)) return null
      for (const op of ops) {
        if (op?.op !== 'set' || !Array.isArray(op.path) || op.path[0] !== 'settings') continue
        const value = op.value
        if (value === null || typeof value !== 'object' || value['liquid-glass']?.checks === undefined) return 'removal'
      }
    } catch {
      /* a body this cannot parse falls back to the rule above */
    }
    return null
  }
  if (noWrite) {
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/settings/*', requestStage: 'Request' }] })
    page.on('Fetch.requestPaused', (params) => {
      /*
       * Answer a paused request, tolerating the one answer that can legitimately fail.
       *
       * A paused request is discarded when the page navigates away from it, and answering it
       * afterwards fails with `Invalid InterceptionId`. This suite navigates constantly, so the race
       * is not avoidable — and it is not a failure of anything. It must still be CAUGHT: these sends
       * are fire-and-forget, and an unhandled rejection does not fail an assertion, it aborts the
       * entire run mid-suite. That is how this was found: a full green run up to the mobile check,
       * then a crash with no verdict at all.
       *
       * Anything else is recorded rather than thrown, so a real interception problem shows up in the
       * console assertions instead of silently disappearing.
       */
      const answer = (method, request) =>
        session.send(method, request).catch((err) => {
          const message = String(err?.message ?? err)
          if (/Invalid InterceptionId/i.test(message)) return
          pageErrors.push(`[no-write] ${method}: ${message}`)
        })
      /*
       * Every paused request MUST be answered or the page hangs, so the decision is wrapped: a
       * handler that threw would present as a frozen application rather than as a failed assertion.
       */
      try {
        const isWrite = /settings\/(mutate|replace|update)(\?|$)/.test(String(params.request.url))
        const reason = refusalReason({
          payload: String(params.request.postData ?? ''),
          isWrite,
          checksAtStart,
        })
        if (reason !== null) {
          if (reason === 'removal') protectedRemovals += 1
          else refusedWrites += 1
          void answer('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' })
          return
        }
      } catch {
        /* fall through to continuing the request */
      }
      void answer('Fetch.continueRequest', { requestId: params.requestId })
    })
  }

  const navigate = async (url) => {
    await session.send('Page.navigate', { url })
    await waitFor(session, "document.querySelectorAll('#root *').length > 40", 'the app to mount', 45000)
    await waitFor(session, "document.querySelector('[data-rightbar-col]') !== null", 'the app frame')
  }

  await test('the application boots and mounts', async () => {
    await navigate(pageUrl)
  })

  if (noWrite) {
    /*
     * The refusal rule, checked against payloads in the shape the client really sends.
     *
     * This exists because the first version of the removal rule was silently wrong: it looked for a
     * `settings` property on the request body, while the operation is `settings/mutate` with
     * `[namespace, ops]` arguments. No run could reveal that — a rule that refuses nothing looks
     * exactly like a rule whose case never came up — and it cost the instance a confirmation it had
     * recorded. A pure function can be checked without a browser, so now it is.
     */
    const settingsWrite = (value) =>
      JSON.stringify({
        type: 'client-request',
        rpcId: 1,
        method: 'mutate',
        payload: ['ui-projects', [{ op: 'set', path: ['settings'], value }]],
      })
    const withRecord = settingsWrite({ 'liquid-glass': { checks: { version: '3.0.0', items: {} } } })
    const withoutRecord = settingsWrite({})
    const enabledWrite = JSON.stringify({
      type: 'client-request',
      rpcId: 2,
      method: 'mutate',
      payload: ['ui-projects', [{ op: 'set', path: ['enabled'], value: ['liquid-glass'] }]],
    })
    const otherNamespace = JSON.stringify({
      type: 'client-request',
      rpcId: 3,
      method: 'mutate',
      payload: ['ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' }]],
    })
    const reason = (payload, had = 'current') => refusalReason({ payload, isWrite: true, checksAtStart: had })
    equal(reason(withRecord), 'checks', 'a write that carries the record is refused')
    equal(reason(withoutRecord), 'removal', 'a write that would drop a record this run found is refused')
    equal(reason(withoutRecord, null), null, 'and an instance with no record keeps its freedom to write settings')
    equal(reason(enabledWrite), null, 'the enabled list is not blocked, or the reload assertions would break')
    equal(reason(otherNamespace), null, 'another namespace is not this flag’s business')
    equal(refusalReason({ payload: withoutRecord, isWrite: false, checksAtStart: 'current' }), null, 'reads are never refused')
    equal(reason('not json at all'), null, 'an unparseable body falls back rather than throwing')
  }

  await test('the Settings › UI section opens from the sidebar', async () => {
    const opened = await evaluate(session, OPEN_PANEL)
    truthy(opened.ok, `settings trigger (${JSON.stringify(opened)})`)
    const section = await evaluate(session, CLICK_SECTION)
    truthy(section.ok, `UI section (${JSON.stringify(section)})`)
    await waitFor(session, "document.querySelectorAll('.uip-root').length > 0", 'the UI panel')
  })

  /*
   * Start from the state the phases below assume, and remember what it was.
   *
   * The alternative — requiring a machine whose settings document happens to say `enabled: []` — is
   * not a precondition, it is a fragility: the suite passed only where nobody had switched the skin
   * on, and a person who had would see a dozen failures that all echoed that one mismatch. The
   * `finally` below puts the document back, so a run that starts with the skin ON still ends with it
   * ON.
   */
  await test('the run starts from the skin off, whatever the document said', async () => {
    startedWithSkinOn = await skinIsOn(session)
    if (!startedWithSkinOn) return
    await setSkin(session, false)
    equal(await skinIsOn(session), false, 'the skin is off, so the phases below measure the default interface first')
  })

  await test('the panel lists the registered project with a keyboard-accessible switch', async () => {
    const state = await evaluate(session, PANEL_STATE)
    truthy(state.panel > 0, 'the panel is rendered')
    contains(JSON.stringify(state.cards), 'liquid-glass')
    equal(state.checked, 'false', 'the skin ships off')
    contains(state.label, 'Liquid Glass')
    equal(state.name, 'Liquid Glass', 'card title')
    equal(state.status, 'inactive', 'card status')

    /*
     * What the document said about the checklist BEFORE this run touched anything.
     *
     * A machine that has a confirmation recorded is a normal machine, not a broken one, and two things
     * have to know about it. `--no-write` refuses the checklist write, so with a record already there
     * the reload assertion below would otherwise read the INHERITED record and call it evidence that
     * this run wrote one. And the withdrawal check presses the card's reset, whose write carries no
     * `checks` at all — refusing writes that merely mention `checks` is not enough to protect a record
     * from being deleted by a run that is supposed to leave no trace.
     */
    checksAtStart = await evaluate(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        const record = details === null ? null : details.querySelector('[data-uip-checks]')
        return record === null ? null : record.getAttribute('data-uip-checks')
      })()`,
    )
    if (checksAtStart !== null) {
      process.stdout.write(
        `         note  this instance starts with a checklist record (${checksAtStart}); ` +
          `--no-write will hand it back unchanged\n`,
      )
    }
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
    try {
      await waitFor(session, "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'", 'the marker')
    } catch (err) {
      /*
       * Report WHY the click had no effect, rather than only that it did not, and keep watching:
       * the switch is disabled while an action is pending, so a click on it is silently dropped. A
       * suite whose first action succeeds while the second does nothing two seconds later is
       * describing exactly that — so measure how long the pending state actually lasts instead of
       * leaving it to be guessed at.
       */
      const probe = `(() => {
        const sw = document.querySelector('[data-project="liquid-glass"] [role="switch"]')
        return {
          switchFound: sw !== null,
          disabled: sw === null ? null : sw.disabled,
          ariaChecked: sw === null ? null : sw.getAttribute('aria-checked'),
          panelOpen: document.querySelectorAll('.uip-root').length,
        }
      })()`
      const state = await evaluate(session, probe)
      const startedAt = Date.now()
      let recoveredAfter = null
      while (Date.now() - startedAt < 30000) {
        const now = await evaluate(session, probe)
        if (now.disabled === false) {
          recoveredAfter = Date.now() - startedAt
          break
        }
        await sleep(250)
      }
      const final = await evaluate(session, probe)
      throw new Error(
        `${err.message}; click ${JSON.stringify(clicked)}; switch at failure ${JSON.stringify(state)}; ` +
          `enabled again after ${recoveredAfter === null ? '>30000' : recoveredAfter} ms, now ${JSON.stringify(final)}; ` +
          `errors so far ${JSON.stringify(pageErrors.filter((m) => !/favicon|net::ERR_/i.test(m)).slice(-3))}`,
      )
    }

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
    /*
     * The accent pair — and the halves are here because the assertion that used to stand here
     * compared the wrong token with the wrong value.
     *
     * `--lg-accent` is the skin's OWN token: the specification names its palette, `#007aff`, in the
     * system-blue family that `--lg-accent-dark` and the indigo pair beside it belong to. It has to
     * reach the page, because the skin's own material reads it. Assert `#4d6bfe` here and the check
     * is describing the shell's brand colour while measuring the skin's.
     *
     * The shipped accent is the other half, and it is the more interesting claim: a skin is a
     * material, not a re-brand. `--dsw-alias-brand-primary` is the shell's colour — the one its own
     * components fall back to — and the skin must leave it exactly as it found it.
     */
    equal(before.tokens.accent, '', 'no Liquid Glass accent exists in the default interface')
    equal(after.tokens.accent, '#007aff', "the skin's own accent reaches the page")
    truthy(before.tokens.brand !== '', 'the shipped brand accent is present to compare against')
    equal(after.tokens.brand, before.tokens.brand, 'and the skin did not re-brand it')

    /*
     * The composer, which is the surface the specification never named.
     *
     * Measured, not asserted from the stylesheet: the fill has to actually change, the blur has to
     * be on the pseudo-element, and the pseudo-element has to be the thing that carries it — the card
     * itself must stay free of `backdrop-filter`, because that property is what would create a
     * containing block for a fixed descendant.
     */
    truthy(after.composer.cardFound, 'the composer card is in the document')
    truthy(after.composer.seatFound, 'and the seat it sits in')
    /*
     * The alpha, read from the computed colour rather than pattern-matched for a `/`: Chrome
     * serialises a computed `backgroundColor` in the legacy comma form (`rgba(255, 255, 255, 0.58)`),
     * so a translucency test written the way the token values are written would fail on a correct
     * page. `undefined` means the colour has no alpha channel, i.e. it is opaque.
     */
    const alphaOf = (value) => /rgba\([^)]*,\s*([\d.]+)\)\s*$/.exec(String(value))?.[1]
    equal(alphaOf(before.composer.fill), undefined, `the shipped card is opaque (${before.composer.fill})`)
    truthy(
      after.composer.fill !== before.composer.fill,
      `the card's fill changed: ${before.composer.fill} → ${after.composer.fill}`,
    )
    truthy(
      Number(alphaOf(after.composer.fill)) < 1,
      `and it is now translucent (${after.composer.fill})`,
    )
    contains(after.composer.frostBlur, 'blur', `the frost is on the pseudo-element (${after.composer.frostBlur})`)
    contains(after.composer.frostBlur, '20px', `at the full radius (${after.composer.frostBlur})`)
    equal(after.composer.isolation, 'isolate', 'with the stacking context the frost needs to land in')
    /*
     * The seat is deliberately NOT asserted here. The skin declares no rule about it — that absence
     * is asserted in `suite` — and a browser-side value comparison would be vacuous: with the skin
     * off no skin rule applies, so the two readings are equal whatever the skin says.
     */
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
    /*
     * The composer too, and the comparison is against the RECORDED value rather than a colour written
     * here: hard-coding `#fff` would fail on a dark-themed instance for a reason that has nothing to
     * do with the skin, which is a mistake this suite has already made once.
     */
    equal(restored.composer.fill, before.composer.fill, 'the composer fill is back to the shipped opaque value')
    equal(restored.composer.frostBlur, before.composer.frostBlur, 'and its frost layer is gone')
    equal(restored.composer.isolation, before.composer.isolation, 'with the stacking context it declared')
  })

  await test('a mobile-sized viewport gets the reduced blur with no overflow', async () => {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    })
    /*
     * Cleared in a `finally`, and that is load-bearing rather than tidy. On this suite's first run
     * the assertions below failed, the clear at the end of the body never executed, and the 390px
     * viewport stayed in force for every test after it — which is why the tier check three tests
     * later measured the mobile radius and reported it as a wrong full-tier blur. A failed test
     * must not change what the next test is measuring.
     */
    try {
      // The skin is turned ON for this phase explicitly, rather than relying on what
      // the previous test left behind: each phase states the state it needs.
      await setSkin(session, true)
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
          resolvedRadius: getComputedStyle(document.body).getPropertyValue(${JSON.stringify(MOBILE_BLUR_TOKEN)}).trim(),
          /*
           * The composer's own frost, read from its pseudo-element. It is in this probe because a
           * phone is where it matters most — the card is nearly the full width of the viewport — and
           * because a degradation block that forgot it would otherwise pass this test while leaving
           * the one large surface at the desktop radius.
           */
          composerBlur: (() => {
            const card = document.querySelector('[data-composer-card]');
            return card === null ? null : String(getComputedStyle(card, '::before').backdropFilter || '');
          })(),
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
      contains(
        String(mobile.composerBlur),
        `${MOBILE_BLUR_PX}px`,
        `the composer steps down with everything else on a phone (${mobile.composerBlur})`,
      )
    } finally {
      await session.send('Emulation.clearDeviceMetricsOverride')
    }
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
    /*
     * Every channel a page can complain on: uncaught exceptions, browser log entries, and — since this
     * round — the page's own `console.error`. The name of this test used to promise more than the
     * instrument covered.
     */
    const relevant = pageErrors.filter((message) => !/favicon|net::ERR_|Failed to load resource/i.test(message))
    equal(relevant, [], 'no errors raised while the skin was applied')
    // The collector is a clean channel up to here; the calibration at the end of the run is what
    // makes it dirty, and it asserts this flag before it does.
    consoleAssertionsDone = true
  })

  /*
   * The verification checklist, driven the way a person drives it.
   *
   * The suite cannot judge whether text is comfortable to read; a person can. What it CAN check is
   * that the instrument around that judgement works: the disclosure opens, the boxes tick, the
   * button refuses until every box is ticked, and the confirmation survives a reload — which is the
   * whole point of recording it.
   *
   * NOTE: this writes to the durable settings document. The run leaves a confirmation recorded
   * against the current version, which is honest — a test did look at it — but it is a real change
   * to the profile this suite is pointed at.
   */
  await test('the verification checklist records a confirmation that survives a reload', async () => {
    await ensurePanel(session)
    await waitFor(
      session,
      `document.querySelector('details.uip-tests[data-project="liquid-glass"]') !== null`,
      'the checklist disclosure',
    )

    const opened = await evaluate(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        if (details === null) return { ok: false, why: 'no disclosure' }
        details.open = true
        const boxes = Array.from(details.querySelectorAll('input[type=checkbox]'))
        if (boxes.length === 0) return { ok: false, why: 'no boxes' }
        return { ok: true, boxes: boxes.length }
      })()`,
    )
    truthy(opened.ok, `the disclosure opens with items (${JSON.stringify(opened)})`)

    // The button must refuse while the boxes are unticked: the confirmation is an assertion, not an
    // automatic consequence of opening the panel.
    /*
     * Found by its `data-uip-action` hook, never by its label. The label is localized — this
     * interface is Chinese — so looking for the English words found nothing, and the `null` that came
     * back read as the checklist refusing to render rather than as a test that spoke one language.
     */
    const beforeTicking = await evaluate(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        const button = details.querySelector('button[data-uip-action="confirm-checks"]')
        return { disabled: button === null ? null : button.disabled, label: button === null ? null : button.textContent }
      })()`,
    )
    equal(beforeTicking.disabled, true, `the button refuses until every item is ticked (${beforeTicking.label})`)

    // Tick them all, the way a click does, then wait for React to re-render the button.
    await evaluate(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        for (const box of details.querySelectorAll('input[type=checkbox]')) if (!box.checked) box.click()
        return true
      })()`,
    )
    await waitFor(
      session,
      `(() => {
        const button = document.querySelector('details.uip-tests[data-project="liquid-glass"] button[data-uip-action="confirm-checks"]')
        return button !== null && !button.disabled
      })()`,
      'the button to become available',
    )

    await evaluate(
      session,
      `document.querySelector('details.uip-tests[data-project="liquid-glass"] button[data-uip-action="confirm-checks"]').click()`,
    )
    /*
     * Both modes assert the confirmation APPEARS: the plugin updates its in-memory settings before
     * it persists, and the store is notified, so the card redraws whether or not the write lands.
     * That is the half `--no-write` can still hold to account.
     *
     * Read from `data-uip-checks`, not from the sentence: the sentence is translated, the state is
     * not, and an assertion that can only pass in English is an assertion about the test's language.
     */
    await waitFor(
      session,
      `document.querySelector('[data-uip-checks][data-uip-checks-version]') !== null`,
      'the recorded confirmation',
    )

    await navigate(pageUrl)
    await ensurePanel(session)
    const afterReload = await evaluate(
      session,
      `(() => {
        const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
        if (details === null) return null
        const record = details.querySelector('[data-uip-checks]')
        return record === null ? false : record.getAttribute('data-uip-checks')
      })()`,
    )

    if (noWrite) {
      // The refusal is the point of the flag, so it must be observed rather than assumed: a pattern
      // that matched nothing would leave this test passing while quietly writing to the document.
      truthy(refusedWrites > 0, `the settings write was refused in flight (${refusedWrites} request(s))`)
      /*
       * And the state after a reload is the state the run INHERITED, not "nothing".
       *
       * The old form asserted `false` here, which is only the right answer on a machine that had no
       * record to begin with: an instance with a confirmation already stored came back from the
       * reload showing it, and the assertion called that evidence that this run had written one. The
       * flag's promise is "this run records nothing", and the honest test of that is that the
       * document says exactly what it said at the start.
       */
      equal(afterReload === false ? null : afterReload, checksAtStart, 'and the document says what it said before the run')
    } else {
      // `current`, not merely present: a confirmation carried over from another version is reported
      // as stale, and that is a different outcome from the one this test is about.
      equal(afterReload, 'current', 'the confirmation survives a reload, recorded against this version')
    }
  })

  /*
   * WITHDRAWING IT AGAIN, through the card's own reset button, in a running browser.
   *
   * The order is deliberate: this re-records a confirmation first, so the check is about the removal
   * rather than inheriting a state from the test above — and in `--no-write` mode that matters twice
   * over, because the refused write leaves the confirmation in memory only, so there is still
   * something on the card to withdraw.
   *
   * What it asserts is the pair a reset has to satisfy: the record goes, and the reading goes with it.
   * A card that kept its boxes ticked would leave a full checklist standing beside no confirmation,
   * one click away from recording the same claim again.
   */
  await test('the card reset withdraws the confirmation and the ticks with it', async () => {
    const openAndTick = `(() => {
      const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
      if (details === null) return { error: 'no disclosure' }
      details.open = true
      const boxes = Array.from(details.querySelectorAll('input[type=checkbox]'))
      for (const box of boxes) if (!box.checked) box.click()
      return { boxes: boxes.length }
    })()`
    const recordState = `(() => {
      const details = document.querySelector('details.uip-tests[data-project="liquid-glass"]')
      if (details === null) return { error: 'no disclosure' }
      const record = details.querySelector('[data-uip-checks]')
      const boxes = Array.from(details.querySelectorAll('input[type=checkbox]'))
      return {
        record: record === null ? null : record.getAttribute('data-uip-checks'),
        withdrawOffered: details.querySelector('button[data-uip-action="clear-checks"]') !== null,
        ticked: boxes.filter((box) => box.checked).length,
        boxes: boxes.length,
      }
    })()`

    await ensurePanel(session)
    // State stated rather than inherited: this check needs the skin running, and it ends by switching
    // it off, so it must not depend on which phase left it in which state.
    await setSkin(session, true)
    const ticked = await evaluate(session, openAndTick)
    truthy(ticked.boxes >= 1, `the checklist has items (${JSON.stringify(ticked)})`)
    await waitFor(
      session,
      `(() => {
        const button = document.querySelector('details.uip-tests[data-project="liquid-glass"] button[data-uip-action="confirm-checks"]')
        return button !== null && !button.disabled
      })()`,
      'the confirm button to become available',
    )
    await evaluate(
      session,
      `document.querySelector('details.uip-tests[data-project="liquid-glass"] button[data-uip-action="confirm-checks"]').click()`,
    )
    await waitFor(
      session,
      `document.querySelector('details.uip-tests[data-project="liquid-glass"] [data-uip-checks]') !== null`,
      'a confirmation to exist',
    )
    const recorded = await evaluate(session, recordState)
    equal(recorded.withdrawOffered, true, 'the card offers to withdraw it')
    equal(recorded.ticked, recorded.boxes, 'every item is ticked')

    /*
     * Wait for the reset control to ACCEPT input before clicking it.
     *
     * The panel disables its buttons while an action is pending, and this test's confirm click is
     * still in flight when the record is already on the card — which is the case on an instance that
     * had a confirmation before the run started, where the `waitFor` above is satisfied instantly.
     * A click on a disabled button is dropped without a trace, and the failure it produces is a
     * timeout three steps later. Same lesson as the switch: wait, then click.
     */
    await waitFor(
      session,
      `(() => {
        const button = document.querySelector('li.uip-card[data-project="liquid-glass"] button[data-uip-action="reset-one"]')
        return button !== null && !button.disabled
      })()`,
      'the card reset to accept input',
    )

    // The reset button, found by its hook rather than by its translated label.
    const reset = await evaluate(
      session,
      `(() => {
        const button = document.querySelector('li.uip-card[data-project="liquid-glass"] button[data-uip-action="reset-one"]')
        if (button === null) return { error: 'no reset button' }
        if (button.disabled) return { error: 'the reset button is disabled' }
        button.click()
        return { ok: true }
      })()`,
    )
    truthy(reset.ok, `the card reset was clicked (${JSON.stringify(reset)})`)

    await waitFor(
      session,
      `document.querySelector('details.uip-tests[data-project="liquid-glass"] [data-uip-checks]') === null`,
      'the confirmation to be withdrawn',
    )
    const cleared = await evaluate(session, recordState)
    equal(cleared.record, null, 'the card no longer claims a verification')
    equal(cleared.withdrawOffered, false, 'and offers no withdrawal for a record that is gone')
    equal(cleared.ticked, 0, 'the ticks went with the record, so nothing is left half-claimed')
    /*
     * The reset is "back to the shipped default", and this skin's default is OFF — so the assertion
     * is that it went off, not that it stayed on. The state is then put back, because every phase
     * below measures the skin and this one has just switched it off.
     */
    equal(await skinIsOn(session), false, 'and the reset returned the skin to its shipped default, which is off')
    await setSkin(session, true)

    // If the instance had a record to protect, the protection must have engaged — and the count is
    // the proof, because a rule that matched nothing would look exactly like a rule that worked.
    if (noWrite && checksAtStart !== null) {
      truthy(
        protectedRemovals > 0,
        `the run refused to delete the record it found (${protectedRemovals} write(s) refused)`,
      )
    }
  })

  /*
   * A request for more contrast, answered where it can actually be measured: in pixels.
   *
   * `Emulation.setEmulatedMedia` is how a real `prefers-contrast: more` is presented to the page
   * without changing the machine's settings. The measurement is the same coarse instrument the
   * rest of this suite uses — the darkest-to-lightest spread inside a text box — which is exactly
   * the right tool here: a contrast request should WIDEN that spread, and a branch that only
   * rewrote token values without changing what is painted would leave it flat.
   *
   * The emulation is restored in a `finally`, and that is not tidiness: under this query the skin
   * drops its frost entirely, so leaving it on would make the tier check below measure a blur that
   * is deliberately not there.
   */
  await test('prefers-contrast: more raises the contrast, in tokens and in painted pixels', async () => {
    const readState = `(() => {
      const body = getComputedStyle(document.body)
      return {
        layer1: body.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
        border1: body.getPropertyValue('--dsw-alias-border-l1').trim(),
        gradient: String(body.backgroundImage),
        layers: (document.body.getAttribute('data-ui-perf') || '') + '|' + (document.body.getAttribute('data-ui-project-liquid-glass') || ''),
        dark: document.body.hasAttribute('data-ds-dark-theme'),
      }
    })()`
    /** @returns {Promise<number>} the narrowest spread across the sampled text boxes */
    const worstSpread = async () => {
      const targets = await evaluate(session, TEXT_TARGETS)
      truthy(Array.isArray(targets) && targets.length >= 1, `text targets located (${JSON.stringify(targets)})`)
      const measured = []
      for (const target of targets) measured.push(await measuredContrast(session, target))
      return measured.reduce((a, b) => (a <= b ? a : b))
    }

    /*
     * Both themes are measured, and that is what this check exists for now.
     *
     * The gradient is painted by a plain `body` rule in light mode and by `body[data-ds-dark-theme]`
     * in dark mode. A media query adds no specificity, so a suppression written as `body { … }` beat
     * the light rule on source order and lost to the dark one — which means a light-mode-only check
     * passed while a dark-mode reader kept the moving wash of colour they had asked to be rid of.
     * Covering one theme per run is how that survives; covering both is how it cannot.
     */
    const setTheme = (/** @type {boolean} */ dark) =>
      evaluate(
        session,
        dark
          ? "(() => { document.body.setAttribute('data-ds-dark-theme', ''); return document.body.hasAttribute('data-ds-dark-theme') })()"
          : "(() => { document.body.removeAttribute('data-ds-dark-theme'); return document.body.hasAttribute('data-ds-dark-theme') })()",
      )
    const originalDark = (await evaluate(session, "document.body.hasAttribute('data-ds-dark-theme')")) === true

    /** @param {boolean} dark @returns {Promise<{before: any, after: any, beforeSpread: number, afterSpread: number}>} */
    const measure = async (dark) => {
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'no-preference' }] })
      await navigate(pageUrl)
      await setTheme(dark)
      const before = await evaluate(session, readState)
      const beforeSpread = await worstSpread()
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] })
      await navigate(pageUrl)
      await setTheme(dark)
      const after = await evaluate(session, readState)
      const afterSpread = await worstSpread()
      return { before, after, beforeSpread, afterSpread }
    }

    try {
      for (const dark of [false, true]) {
        const theme = dark ? 'dark' : 'light'
        const { before, after, beforeSpread, afterSpread } = await measure(dark)

        // The instrument first: if the theme did not hold, every number below is about the other one.
        equal(before.dark, dark, `the ${theme} theme is in force before the query`)
        equal(after.dark, dark, `and still in force under it`)

        // Deterministic half: the branch reached the page, and it changed what will be painted.
        // The fills go transparent -> opaque, and the decorative wash goes with them.
        /*
         * The branch is written per theme, so the expected fill has to be read from the theme the
         * page is actually in rather than assumed. Assuming light made this assertion fail against a
         * correct dark fill — the check was describing the harness, not the skin.
         */
        const opaqueFill = dark ? '#1e212a' : '#fff'
        equal(after.layer1, opaqueFill, `the page fill is opaque under more contrast (${theme})`)
        truthy(
          before.layer1 !== after.layer1,
          `and it was not already (${theme}: before ${before.layer1}, after ${after.layer1})`,
        )
        // Non-vacuous: there has to have been a wash for its removal to mean anything.
        truthy(before.gradient !== 'none', `a decorative gradient is painted before the query (${theme})`)
        equal(after.gradient, 'none', `and the decorative gradient is gone under it (${theme})`)
        truthy(
          after.border1 !== before.border1,
          `the hairline got heavier (${theme}: before ${before.border1}, after ${after.border1})`,
        )
        // The skin is still applied: this branch changes the material, not whether it exists.
        contains(after.layers, 'on')

        // Measured half, with the whole suite's caveat attached: this instrument reports the spread
        // inside a text box, which cannot prove a ratio but does catch a surface that never
        // repainted. A branch that rewrote tokens without changing paint would leave it flat.
        /*
         * The tolerance is the instrument's own resolution, not a cushion for a failing check.
         *
         * The spread is the distance between the SINGLE darkest and SINGLE lightest pixel in the box,
         * decoded from an 8-bit PNG, and the extremes are glyph edges — antialiased pixels whose value
         * shifts by a step or two between screenshots. Two steps at each end of the scale is about
         * 0.006 in luminance, so anything smaller than 0.01 is the measurement talking. A legibility
         * regression is not that: a text/background pair losing its separation moves this number by
         * five or ten times the tolerance.
         *
         * What this half canNOT catch is a branch that changed nothing at all — before and after would
         * be equal and equal passes. That case is the deterministic half above, which requires the
         * fills, the hairline and the gradient to have changed.
         */
        const SPREAD_TOLERANCE = 0.01
        truthy(
          afterSpread >= beforeSpread - SPREAD_TOLERANCE,
          `the painted text spread did not narrow (${theme}: before ${beforeSpread}, after ${afterSpread}, tolerance ${SPREAD_TOLERANCE})`,
        )
      }
    } finally {
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'no-preference' }] })
      // The theme is put back, including the case where this test is what changed it.
      await setTheme(originalDark)
    }
  })

  /*
   * The two modes that ask for less transparency, measured instead of reasoned about.
   *
   * `prefers-reduced-transparency` is a real Chrome feature since Chrome 118 — not a Safari-only
   * nicety — so the branch the skin has always carried can finally be exercised rather than trusted.
   * The stylesheet guard in `verify.mjs` proves the tokens are declared; this proves they arrive.
   *
   * `forced-colors` is different in kind, and the distinction decides what can be asserted: the
   * platform replaces author BACKGROUND COLOURS with system ones, so every translucent fill is
   * opaque by the time it paints and the skin needs no token work for it. It does not force CUSTOM
   * PROPERTY values, so reading `--dsw-alias-bg-layer-3` off the body under this query would report
   * the skin's own declaration and prove nothing. What can be measured is the outcome on elements:
   * the fills are opaque, and they are not the values they had a moment earlier.
   */
  await test('the modes that ask for less transparency get it', async () => {
    const readState = `(() => {
      const body = getComputedStyle(document.body)
      /*
       * The settings PANEL, found through the section this suite already knows how to open, rather
       * than the first [role="dialog"] in the document. The first form measured whichever dialog
       * happened to come first — rgba(0, 0, 0, 0.52) came back, which is neither the skin's fill nor
       * a system colour, and read like a scrim rather than a panel. Naming the element by the panel
       * it contains is the difference between measuring a surface and measuring whatever is first in
       * the tree.
       */
      const section = document.querySelector('.uip-root')
      const panel = section === null ? null : section.closest('[role="dialog"]')
      const card = document.querySelector('[data-composer-card]')
      const frost = card === null ? null : getComputedStyle(card, '::before')
      return {
        tokens: {
          layer3: body.getPropertyValue('--dsw-alias-bg-layer-3').trim(),
          overlay: body.getPropertyValue('--dsw-alias-bg-overlay').trim(),
          module: body.getPropertyValue('--dsw-alias-bg-module-platform').trim(),
          tooltip: body.getPropertyValue('--dsw-alias-tooltip-bg').trim(),
          glass: body.getPropertyValue('--lg-glass-bg').trim(),
        },
        panelFound: panel !== null,
        panel: panel === null ? null : getComputedStyle(panel).backgroundColor,
        panelAdjust: panel === null ? null : getComputedStyle(panel).forcedColorAdjust,
        card: card === null ? null : getComputedStyle(card).backgroundColor,
        cardAdjust: card === null ? null : getComputedStyle(card).forcedColorAdjust,
        frost: frost === null ? null : String(frost.backdropFilter || ''),
        reducedTransparencyMatches: matchMedia('(prefers-reduced-transparency: reduce)').matches,
        forcedColorsMatches: matchMedia('(forced-colors: active)').matches,
      }
    })()`
    /** The alpha a computed colour carries, or undefined when it has none — i.e. it is opaque. */
    const alphaOf = (value) => /rgba\([^)]*,\s*([\d.]+)\)\s*$/.exec(String(value))?.[1]

    await setSkin(session, true)
    await navigate(pageUrl)
    await waitFor(session, "document.body.getAttribute('data-ui-project-liquid-glass') === 'on'", 'the marker')
    await ensurePanel(session)
    const before = await evaluate(session, readState)
    truthy(
      before.panelFound && before.card !== null,
      `the surfaces to measure exist (${JSON.stringify(before)})`,
    )
    truthy(
      Number(alphaOf(before.panel)) < 1,
      `the premise: the panel fill is translucent before any query (${before.panel})`,
    )

    try {
      // ── prefers-reduced-transparency ────────────────────────────────────────
      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
      })
      const reduced = await evaluate(session, readState)
      /*
       * The capability probe, printed rather than swallowed. If a browser or a CDP version does not
       * know this feature the query never matches, and silently asserting nothing would turn "not
       * tested" into "passed". The stylesheet guard still covers the branch in that case, and this
       * says so out loud.
       */
      const supported = reduced.reducedTransparencyMatches === true
      if (!supported) {
        process.stdout.write(
          '         note  this browser does not apply prefers-reduced-transparency; the branch is ' +
            'covered by the stylesheet guard in verify.mjs, not by a measurement here\n',
        )
      } else {
        const stillTranslucent = Object.entries(reduced.tokens)
          .filter(([, value]) => Number(alphaOf(value)) < 1 || /rgba\(/.test(String(value)))
          .map(([name, value]) => `${name}=${value}`)
        equal(
          stillTranslucent,
          [],
          `every surface token resolves opaque under prefers-reduced-transparency (${stillTranslucent.join(', ') || 'all opaque'})`,
        )
        equal(alphaOf(reduced.card), undefined, `the composer's fill is opaque (${reduced.card})`)
        equal(alphaOf(reduced.panel), undefined, `and so is the panel's (${reduced.panel})`)
        equal(reduced.frost, 'none', `the composer's frost is dropped (${reduced.frost})`)
      }
    } finally {
      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }],
      })
    }

    try {
      // ── forced-colors ───────────────────────────────────────────────────────
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
      const forced = await evaluate(session, readState)
      /*
       * The outcome, not the cause: the skin's branch asks for the blur to go and the platform may
       * also be forcing it, and this cannot tell the two apart. It can tell that the fills are no
       * longer translucent and no longer what they were, which is the claim worth having.
       *
       * The raw readings are in every message, because the first attempt at this measured the wrong
       * element and the failure said only "expected undefined, got 0.52" — a number that names no
       * element. A diagnostic that cannot say WHAT it measured costs a run to interpret.
       */
      const raw = JSON.stringify({ forced: forced.forcedColorsMatches, panel: forced.panel, card: forced.card })
      /*
       * The CALIBRATION, added because the first two attempts at this measured expensive nonsense:
       * both elements reported the same `rgba(0, 0, 0, 0.52)`, which is neither of their own fills,
       * and a single number that describes no element cannot tell a forced palette from a wrong
       * selector. A throwaway element with a colour nothing else uses answers the question the whole
       * assertion rests on: does this mode replace AUTHOR background colours at all?
       */
      const calibration = await evaluate(
        session,
        `(() => {
          const probe = document.createElement('div')
          probe.style.backgroundColor = 'rgb(1, 2, 3)'
          probe.style.color = 'rgb(4, 5, 6)'
          const translucent = document.createElement('div')
          translucent.style.backgroundColor = 'rgba(1, 2, 3, 0.52)'
          document.body.append(probe, translucent)
          const style = getComputedStyle(probe)
          const half = getComputedStyle(translucent)
          const result = {
            background: style.backgroundColor,
            color: style.color,
            adjust: style.forcedColorAdjust,
            translucentBackground: half.backgroundColor,
          }
          probe.remove()
          translucent.remove()
          return result
        })()`,
      )
      const full = JSON.stringify({
        forced: forced.forcedColorsMatches,
        panel: forced.panel,
        panelAdjust: forced.panelAdjust,
        card: forced.card,
        cardAdjust: forced.cardAdjust,
        probe: calibration,
      })
      /*
       * What the calibration establishes, and why it changed the design of this branch.
       *
       * The platform DOES replace author colours here — `rgb(1, 2, 3)` came back as `rgb(0, 0, 0)`
       * and the text colour as white — which was the assumption this branch was built on. But it
       * keeps the author's ALPHA: the same probe at `rgba(1, 2, 3, 0.52)` comes back as
       * `rgba(0, 0, 0, 0.52)`. So a translucent fill stays translucent in this mode, and the skin
       * cannot leave the fills to the platform after all. That was measured twice — the panel and the
       * card both reported `rgba(0, 0, 0, 0.52)`, the card's own alpha, and the first version of this
       * assertion had called the platform's takeover sufficient and skipped the tokens.
       */
      truthy(
        calibration.background !== 'rgb(1, 2, 3)',
        `calibration: the platform replaces author colours (${full})`,
      )
      contains(
        String(calibration.translucentBackground),
        '0.52',
        `calibration: and keeps the author's alpha, which is why the tokens are needed here too (${full})`,
      )
      truthy(forced.forcedColorsMatches, `the query is in force in this browser (${full})`)
      equal(alphaOf(forced.panel), undefined, `forced colors leaves the panel fill opaque (${full})`)
      equal(alphaOf(forced.card), undefined, `and the composer's (${full})`)
      equal(forced.frost, 'none', `the composer's frost is gone (${forced.frost}; ${full})`)
      truthy(
        forced.panel !== before.panel && forced.card !== before.card,
        `and both fills were replaced rather than merely already opaque (panel ${before.panel} → ${forced.panel}, card ${before.card} → ${forced.card})`,
      )    } finally {
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] })
    }

    // Put the page back the way the tests around this one expect to find it.
    await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'no-preference' }] })
    await navigate(pageUrl)
    await ensurePanel(session)
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
      const card = document.querySelector('[data-composer-card]')
      return {
        tier: document.body.getAttribute('data-ui-perf'),
        blur: frame === null ? null : getComputedStyle(frame, '::before').backdropFilter,
        composerBlur: card === null ? null : String(getComputedStyle(card, '::before').backdropFilter || ''),
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
      /*
       * And the composer drops with it. Without this the tier block would leave the one card the
       * reader types into at the desktop radius on a device that can afford least — the same
       * omission as the suppression branches, in the other direction.
       */
      contains(
        String(weak.composerBlur),
        '12px',
        `the composer's frost drops too on a capped device (${weak.composerBlur})`,
      )
    } finally {
      await session.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: original })
    }

    await navigate(pageUrl)
    const capable = await evaluate(session, readTier)
    /*
     * The expected tier is derived from the machine, not written down. A capable device can only be
     * as good as the hardware it claims to be: on a two-core host the skin's own demand is capped
     * at `low`, and asserting `high` there would fail against a correct page — the check would be
     * describing the workstation rather than the skin.
     */
    const capableCap = original >= 4 ? 'high' : original >= 2 ? 'medium' : 'low'
    const RADIUS = { high: '20px', medium: '16px', low: '12px' }
    truthy(
      RADIUS[capable.tier] !== undefined && RADIUS[capable.tier] === RADIUS[capableCap],
      `the tier follows the machine — ${original} cores cap it at ${capableCap}, got ${capable.tier}`,
    )
    // The stronger half: whatever tier was chosen, the frost matches THAT tier's radius, so the
    // attribute and the stylesheet cannot drift apart.
    contains(String(capable.blur), RADIUS[capable.tier], `and the frost is at ${capable.tier} radius (${capable.blur})`)
    contains(
      String(capable.composerBlur),
      RADIUS[capable.tier],
      `and so is the composer's (${capable.composerBlur})`,
    )
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
            clientStyles: document.querySelectorAll('style[id^="dsh-ui-projects"]').length,
            clientColumns: document.querySelectorAll('[data-ui-skin-column]').length,
          }
        })()`,
      )

      /*
       * The bundle never ran, and the proof is that nothing the client owns is in the document.
       *
       * This used to assert the shell's BOOT PAGE was still in place, on the reasoning that its
       * survival IS the bundle's absence. That reasoning is wrong twice over, and both halves were
       * measured rather than assumed: the served HTML is `<div id="root"></div>` with nothing in
       * it, so there is no boot page before scripts run at all; and the element is created by the
       * RENDERER bundle (its own request, untouched by the block), not by this plugin, so its
       * presence tracks the renderer mounting the application and says nothing about whether this
       * bundle arrived. The assertion was therefore false on every run — including the runs where
       * the skin assertions below it never got to execute. A check that cannot pass is worse than
       * a missing one, because it hides the ones behind it.
       *
       * `style[id^="dsh-ui-projects"]` is the honest replacement: those elements are created by
       * this client bundle and by nothing else, so their absence states exactly what this test
       * needs — the document was painted by the served HTML alone.
       */
      equal(first.clientStyles, 0, 'the client bundle never ran, so it injected no stylesheet')
      equal(first.clientColumns, 0, 'and it stamped no skin column')
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

  /*
   * The console collector, calibrated — and LAST, because calibrating it dirties it.
   *
   * `the skin raises no console or page errors` reads `pageErrors`, and this pushes an error into that
   * same array on purpose. The two facts have to be asserted rather than described: a listener that
   * silently stopped working would leave every run green while proving nothing, which is the failure
   * this round exists to fix — and a later assertion added below this one would read a channel that is
   * no longer clean, so the ordering contract is checked here instead of trusted.
   */
  await test('the console collector observes page console errors at all', async () => {
    truthy(consoleAssertionsDone, 'every assertion that reads the collector has already run')
    await evaluate(session, `(() => { console.error('dsh-ui-projects calibration'); return true })()`)
    await sleep(300)
    truthy(
      pageErrors.some((message) => message.includes('dsh-ui-projects calibration')),
      `a page console.error reaches the collector (${pageErrors.length} message(s) collected)`,
    )
  })
} finally {
  /*
   * Put the skin back the way this run found it.
   *
   * `test()` never throws — it records a failure and the next test runs — so this exists for the
   * unexpected abort, which is exactly when a harness is most likely to leave a machine changed. It
   * restores only when the run STARTED with the skin off: the phases turn it on and leave it on, so
   * a run that started with it on already ends in the state it began with, and a redundant toggle
   * would be a write for nothing.
   */
  if (startedWithSkinOn === false && page !== undefined) {
    try {
      await page.send('Page.navigate', { url: pageUrl })
      await waitFor(page, "document.querySelectorAll('#root *').length > 40", 'the app to mount', 45000)
      await setSkin(page, false)
    } catch (err) {
      // The run has already reported its own failures; a failed restore must not mask them.
      process.stdout.write(`         note  could not restore the skin state: ${String(err)}\n`)
    }
  }
  page?.close()
  cdp?.close()
  chrome.child.kill()
}

process.stdout.write(`\n${checks} assertions, ${failures} failing\n`)
if (failures > 0) process.exitCode = 1
