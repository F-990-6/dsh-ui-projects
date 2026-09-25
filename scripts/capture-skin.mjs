/**
 * Capture the skin from clean state and report the measured facts.
 * Usage: node scripts/capture-skin.mjs "<url>" [outdir]
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

const url = process.argv[2]
const outDir = process.argv[3] ?? 'E:/dsh'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const binary = [
  join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].find((c) => c.length > 0 && existsSync(c))
const profile = await mkdtemp(join(tmpdir(), 'capture-'))
const child = spawn(binary, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
const marker = join(profile, 'DevToolsActivePort')
let port
for (let i = 0; i < 150; i += 1) {
  if (existsSync(marker)) {
    port = Number((await readFile(marker, 'utf8')).split('\n')[0].trim())
    if (port > 0) break
  }
  await sleep(200)
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r))
let id = 1
const pending = new Map()
socket.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) =>
  new Promise((resolve) => { const myId = id++; pending.set(myId, resolve); socket.send(JSON.stringify({ id: myId, method, params })) })
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.exception?.description?.split('\n')[0]
  return r.result?.result?.value
}
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' })
  const path = `${outDir}/.skin-${name}.png`
  await writeFile(path, Buffer.from(s.result.data, 'base64'))
  console.log('saved', path)
}

function decodePng(png) {
  let offset = 8
  let width = 0
  let height = 0
  let channels = 4
  const idat = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      channels = data[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
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
  return { pixels, channels }
}
const lum = (r, g, b) => {
  const c = (v) => { const n = v / 255; return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
}
async function contrast(clip) {
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } })
  const { pixels, channels } = decodePng(Buffer.from(s.result.data, 'base64'))
  const values = []
  for (let i = 0; i + channels - 1 < pixels.length; i += channels) values.push(lum(pixels[i], pixels[i + 1], pixels[i + 2]))
  values.sort((a, b) => a - b)
  const bg = values[Math.floor(values.length * 0.15)]
  const fg = values[Math.floor(values.length * 0.99)]
  return Math.round(((fg + 0.05) / (bg + 0.05)) * 100) / 100
}

const HELPERS = `
  const isVisible = (el) => el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
  const clickable = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) { if (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button') return n } return el };
  const byOwnText = (t) => Array.from(document.querySelectorAll('*')).filter((el) => isVisible(el) && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() === t))[0];
  const openPanel = () => { if (document.querySelectorAll('.uip-root').length > 0) return; const t = byOwnText('设置') || byOwnText('Settings'); if (t) clickable(t).click(); };
  const pickSection = () => { const s = byOwnText('界面') || byOwnText('UI'); if (s) clickable(s).click(); };
  const setTheme = (light) => { const labels = light ? ['浅色','Light'] : ['深色','Dark'];
    const hit = Array.from(document.querySelectorAll('button,[role="radio"],[role="option"],label,li')).filter((el) => isVisible(el) && labels.includes((el.textContent || '').trim()))[0];
    if (hit) hit.click(); return !!hit; };
`
const REPORT = `(() => {${HELPERS}
  const bs = getComputedStyle(document.body);
  const blurred = [];
  for (const el of document.querySelectorAll('*')) {
    const v = getComputedStyle(el).backdropFilter;
    if (v && v !== 'none') {
      const r = el.getBoundingClientRect();
      blurred.push({ cls: String(el.className || '').slice(0, 24), attrs: Array.from(el.attributes).map((a) => a.name).filter((n) => n.startsWith('data-')).join(','), w: Math.round(r.width), h: Math.round(r.height), filter: v });
    }
  }
  const sample = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.min(r.width, 460), height: Math.min(Math.max(r.height, 18), 50) }; };
  const nav = byOwnText('界面') || byOwnText('UI') || byOwnText('通用设置') || byOwnText('General');
  const side = Array.from(document.querySelectorAll('[data-rightbar-col] *')).filter((el) => el.children.length === 0 && (el.textContent || '').trim().length > 2)[2];
  const marked = Array.from(document.querySelectorAll('[data-ui-skin-column]'));
  const grid = Array.from(document.querySelectorAll('div')).find((el) => {
    const cs = getComputedStyle(el);
    return cs.display === 'grid' && el.children.length >= 2 && cs.gridTemplateColumns.split(' ').length >= 2;
  });
  // Walk the runtime's own algorithm, step by step, to see where it diverges.
  const trace = (() => {
    const root = document.getElementById('root');
    if (root === null) return { step: 'no #root' };
    const divs = Array.from(root.querySelectorAll('div'));
    const candidates = [];
    for (const el of divs) {
      const style = getComputedStyle(el);
      candidates.push({
        cls: String(el.className).slice(0, 22),
        display: style.display,
        kids: el.children.length,
        tracks: String(style.gridTemplateColumns).split(' ').length,
        tracksRaw: String(style.gridTemplateColumns).slice(0, 40),
      });
      if (style.display === 'grid' && el.children.length >= 2 && String(style.gridTemplateColumns).split(' ').length >= 2) {
        return { step: 'MATCH', matched: candidates[candidates.length - 1], scanned: candidates.length };
      }
    }
    return { step: 'NO MATCH', scanned: candidates.length, gridish: candidates.filter((c) => c.display === 'grid').slice(0, 4) };
  })();
  return {
    theme: document.body.getAttribute('data-ds-dark-theme') === null ? 'light' : 'dark',
    sidebarFill: bs.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
    layer1: bs.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
    layer3: bs.getPropertyValue('--dsw-alias-bg-layer-3').trim(),
    rootExists: document.getElementById('root') !== null,
    gridFound: grid ? String(grid.className).slice(0, 24) : null,
    trace,
    markCount: marked.length,
    markedInfo: marked.map((el) => { const r = el.getBoundingClientRect(); return { cls: String(el.className).slice(0, 22), w: Math.round(r.width), blur: getComputedStyle(el).backdropFilter }; }),
    blurred,
    targets: [
      { label: 'settings nav item', ...sample(nav) },
      { label: 'sidebar row', ...sample(side) },
      { label: 'hero title', ...sample(document.querySelector('h1, h2')) },
      { label: 'composer input', ...sample(document.querySelector('[data-composer-input], textarea, [contenteditable="true"]')) },
    ].filter((t) => t && t.width > 10),
  };
})()`

await send('Page.enable')
await send('Runtime.enable')
/** Console output from the page, so a skin that reports a problem is heard. */
const consoleLines = []
socket.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data))
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  }
})
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await send('Page.navigate', { url })
await sleep(9000)

// Put the durable theme preference back to light, through the app.
await ev(`(() => {${HELPERS} openPanel(); return true })()`)
await sleep(1200)
await ev(`(() => {${HELPERS} const g = byOwnText('通用设置') || byOwnText('General'); if (g) clickable(g).click(); return !!g })()`)
await sleep(1500)
console.log('light option clicked:', await ev(`(() => {${HELPERS} return setTheme(true) })()`))
await sleep(1500)

// Skin ON.
await ev(`localStorage.setItem('dsh.ui-projects.v1', JSON.stringify({ v:1, initialized:true, enabled:['liquid-glass'], settings:{}, touched:true }))`)
await send('Page.navigate', { url })
await sleep(9000)
await ev(`(() => {${HELPERS} openPanel(); return true })()`)
await sleep(1200)
await ev(`(() => {${HELPERS} pickSection(); return true })()`)
await sleep(1200)

const light = await ev(REPORT)
console.log(
  'OPEN DIALOG:',
  JSON.stringify(
    {
      theme: light.theme,
      sidebarFill: light.sidebarFill,
      layer1: light.layer1,
      layer3: light.layer3,
      rootExists: light.rootExists,
      gridFound: light.gridFound,
      trace: light.trace,
      markCount: light.markCount,
      markedInfo: light.markedInfo,
      blurred: light.blurred.slice(0, 6),
    },
    null,
    2,
  ),
)
for (const t of light.targets) console.log(`  contrast ${t.label}: ${await contrast(t)}`)
await shot('light-settings')
console.log('page console:', JSON.stringify(consoleLines.slice(0, 6), null, 2))

for (const type of ['keyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
await sleep(900)
const closed = await ev(REPORT)
console.log('CLOSED:', JSON.stringify({ sidebarFill: closed.sidebarFill, layer1: closed.layer1, blurred: closed.blurred.slice(0, 4) }, null, 2))
for (const t of closed.targets) console.log(`  contrast ${t.label}: ${await contrast(t)}`)
await shot('light-interface')

socket.close()
child.kill()
