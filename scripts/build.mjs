/**
 * Build the browser half of dsh-ui-projects, plus the host-side first-paint payload.
 *
 * The bundle rules themselves live in `./bundle-client.mjs` — one copy of the ESM→CJS rewrite
 * and the module-registry wrapper, shared with every UI project package's own build. What is
 * specific to this package is what is below: which files are in the graph, and the assertion
 * that makes the first-paint sheet honest.
 *
 *   src/client/**\/*.js   →  lib/client.js   (one lazy-CJS bundle)
 *   src/client/**\/*.css  →  `module.exports = "<css text>"` inside that graph
 *   src/host/**\/*.js     →  lib/**\/*.js    (plain ESM, copied verbatim)
 *   src/host/boot.css     →  lib/boot-css.js (the same bytes, as a module)
 *
 * No bundler, no transpiler, no network: the source is written in the same plain JavaScript the
 * browser will run. `verify.mjs` re-loads the emitted bundle through a faithful
 * `__ModuleLoader__` facade, so a broken bundle fails the test rather than the browser.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * The first-paint predicate is IMPORTED, not restated — and that is a fix, not tidiness.
 *
 * This file and `tools/derive-boot-css.mjs` each used to hold a copy, with a comment claiming a
 * disagreement would fail loudly. It would have, for every disagreement except the one that mattered:
 * both copies skipped a comma-separated selector on sight, so when three suppression blocks had to be
 * written as `body, body[data-ds-dark-theme]` to outrank the themed rule, both dropped them, both
 * agreed, and the sheet lost rules that decide the first frame. Two copies of a rule catch only the
 * mistakes one of them does not make.
 */
import { classifyPrelude, mixedSelectorError, MARKER, SKIN_DIR, SKIN_STYLESHEETS } from './boot-css-rules.mjs'
import { listFiles, renderBundle, transform } from './bundle-client.mjs'
import { scopeCss } from '../src/client/scope-css.js'

export { transform }

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientRoot = join(packageRoot, 'src', 'client')
const hostRoot = join(packageRoot, 'src', 'host')
const hostEntry = join(hostRoot, 'index.js')
const outFile = join(packageRoot, 'lib', 'client.js')
const outHost = join(packageRoot, 'lib', 'index.js')

/**
 * The host-side first-paint stylesheet, and the module generated from it.
 *
 * It exists as a built artefact rather than as a copy compiled into the host, because the host
 * half is shipped as plain ESM and cannot import CSS. Nothing here writes a second palette: the
 * generated module is a byte-for-byte copy of the source file, and the check below is what keeps
 * that source honest against the CSS the skin actually emits.
 */
const bootCssSource = join(hostRoot, 'boot.css')
const outBootCss = join(packageRoot, 'lib', 'boot-css.js')

/** The marker the client scoper stamps on every project rule. Must match `runtime.js`. */
const LIQUID_GLASS_MARKER = MARKER

/*
 * The skin directory and its stylesheet list come from `boot-css-rules.mjs`, not from here.
 *
 * They used to be a local `['tokens.css', 'glass.css']` plus a hard-coded path, which was one copy of a
 * rule that `tools/derive-boot-css.mjs` held as well — the exact arrangement that let three suppression
 * blocks vanish from the first-paint sheet while both copies agreed. A package now describes its own
 * first paint in one place, and `--package <dir>` is what lets the tool derive any package's sheet.
 */

/**
 * The module order this bundle is built from (order affects readability only).
 *
 * Every file under `src/client` must appear here. The entry point of a module graph
 * is hard to see by eye, so a file that is present but unreachable is a mistyped
 * import far more often than it is deliberate — which is why the build fails loudly
 * on one. A module listed here that nothing imports yet is simply never
 * materialised: registering a factory costs a line of code, not runtime work.
 */
const MODULE_ORDER = [
  'project-constants.js',
  'scope-css.js',
  'css-filter.js',
  'perf.js',
  'registry.js',
  'persist.js',
  'boot-presence.js',
  'service.js',
  'installed.js',
  'runtime.js',
  'store.js',
  'diagnostics.js',
  'locale.js',
  'panel.js',
  'panel-plugins.js',
  'styles/core.css',
  'projects/liquid-glass/tokens.css',
  'projects/liquid-glass/glass.css',
  'projects/liquid-glass/skin.js',
  'index.js',
]

/**
 * Every bare import in the host half must resolve from this package.
 *
 * A missing host dependency is uniquely nasty: the client bundle is fine, every
 * Node test that imports the bundle is fine, and the failure appears only when dsh
 * boots — as a refused loader entry that takes the whole GUI with it. That is
 * exactly what happened when the host half grew an import of a package that was not
 * declared, so the check is part of the build now rather than something a user
 * discovers by restarting.
 * @param {string} source
 */
function assertHostImportsResolvable(source) {
  const require = createRequire(join(packageRoot, 'package.json'))
  /** @type {string[]} */
  const unresolved = []
  for (const match of String(source).matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
    const specifier = match[1]
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    try {
      require.resolve(specifier)
    } catch {
      unresolved.push(specifier)
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `[build] the host half imports package(s) this package cannot resolve: ${unresolved.join(', ')}\n` +
        '[build] add them to "dependencies" and install, or the dsh loader entry will fail at boot.',
    )
  }
}

/**
 * Split a stylesheet into top-level segments: `{ prelude, body }`.
 *
 * Thin on purpose. This package authors plain CSS, so a brace counter is exact and a real parser
 * would be more machinery than the question needs; the only string in the skin's CSS that could
 * hide a brace is `content: ''`, and it holds none.
 * @param {string} css
 * @returns {Array<{ prelude: string, body: string | undefined }>}
 */
function cssSegments(css) {
  const out = []
  let start = 0
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] !== '{') continue
    let depth = 1
    let end = -1
    for (let scan = index + 1; scan < css.length; scan += 1) {
      if (css[scan] === '{') depth += 1
      else if (css[scan] === '}') {
        depth -= 1
        if (depth === 0) {
          end = scan
          break
        }
      }
    }
    if (end < 0) throw new Error(`[build] unbalanced braces:\n${css.slice(start, start + 200)}`)
    out.push({ prelude: css.slice(start, index), body: css.slice(index + 1, end) })
    index = end
    start = end + 1
  }
  return out
}

/** Whitespace-insensitive identity, so re-indenting a sheet can never trip the subset check. */
const normalizeCss = (text) => text.replace(/\s+/g, ' ').trim()

/**
 * Every leaf rule of a stylesheet, each tagged with the at-rule context it sits in.
 *
 * Leaf rules rather than whole blocks, and the context matters: `glass.css` has conditional blocks
 * that hold a body rule AND a frost rule together, so the first-paint sheet keeps part of such a
 * block. Comparing blocks would call that a drift; comparing each rule together with its own
 * at-rule prelude says exactly what is true — every rule in boot.css is a rule the skin also
 * declares, under the same condition.
 * @param {string} css
 * @param {string} [context]
 * @returns {Array<{ context: string, selector: string, text: string }>}
 */
function leafRules(css, context = '') {
  const out = []
  for (const segment of cssSegments(css)) {
    const prelude = segment.prelude.trim()
    if (prelude === '' || segment.body === undefined) continue
    if (prelude.startsWith('@')) {
      out.push(...leafRules(segment.body, `${context}${normalizeCss(prelude)} | `))
      continue
    }
    out.push({ context, selector: prelude, text: normalizeCss(`${prelude}{${segment.body}}`) })
  }
  return out
}

/** @param {{ context: string, text: string }} rule */
const ruleKey = (rule) => `${rule.context}${rule.text}`

/**
 * Generate `lib/boot-css.js` from `src/host/boot.css`, after proving it is a subset of the CSS the
 * skin itself emits.
 *
 * WHY THE CHECK IS FATAL RATHER THAN A WARNING. The first paint and everything after it use two
 * copies of the same declarations, and the only thing that makes that safe is that they are the
 * same declarations. If they drift, the symptom is a colour that changes a few milliseconds after
 * load — which reads as a rendering glitch rather than as a stale file, and would be chased in the
 * wrong place. Failing here names the file to fix instead.
 * @returns {Promise<{ bytes: number, blocks: number, rules: number }>}
 */
async function writeBootCss() {
  /*
   * Comments are stripped before anything else happens, for two reasons.
   *
   * They are not rules, so leaving them in made the header comment itself look like a drifted
   * declaration — the first thing this check did was accuse its own documentation.
   *
   * And they are not shipped: the payload below is inlined into every rendered index, and the
   * header is prose for whoever opens the source file. The page gets the declarations only.
   */
  const payload = (await readFile(bootCssSource, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').trim()
  const skinDir = join(packageRoot, SKIN_DIR)
  /** @type {Set<string>} */
  const emitted = new Set()
  for (const file of SKIN_STYLESHEETS) {
    const scoped = scopeCss(LIQUID_GLASS_MARKER, await readFile(join(skinDir, file), 'utf8'))
    for (const rule of leafRules(scoped)) emitted.add(ruleKey(rule))
  }
  const rules = leafRules(payload)
  if (rules.length === 0) throw new Error(`[build] ${bootCssSource} declares no rules`)
  /** @type {Set<string>} */
  const declared = new Set(rules.map(ruleKey))
  const drifted = rules.filter((rule) => !emitted.has(ruleKey(rule)))
  if (drifted.length > 0) {
    throw new Error(
      `[build] src/host/boot.css is no longer a subset of the skin's own CSS — ${drifted.length} rule(s) drifted:\n` +
        drifted.map((rule) => `[build]   ${rule.context}${rule.text.slice(0, 110)}…`).join('\n') +
        '\n[build] The first-paint sheet must say exactly what the skin says. Change the value in' +
        ' projects/liquid-glass/tokens.css or glass.css, then re-derive src/host/boot.css from' +
        ' `node tools/derive-boot-css.mjs`.',
    )
  }
  /*
   * AND THE OTHER DIRECTION, which is the half that was missing.
   *
   * The subset check alone cannot see the failure that matters most in practice: add a body-level
   * rule to the skin — a new token, a new conditional branch — and forget to re-derive, and the
   * build passes while the first frame silently lacks it. Subset says "boot.css claims nothing the
   * skin does not"; completeness says "boot.css claims everything the skin has". Together they make
   * boot.css exactly the skin's body-level rules, which is what its header promises.
   */
  /** @type {Array<{ context: string, text: string }>} */
  const missing = []
  for (const file of SKIN_STYLESHEETS) {
    const scoped = scopeCss(LIQUID_GLASS_MARKER, await readFile(join(skinDir, file), 'utf8'))
    for (const rule of leafRules(scoped)) {
      const kind = classifyPrelude(rule.selector)
      /*
       * A rule that mixes body-level and other selectors is refused rather than skipped, and this is
       * the third place the same silence could have hidden: `classifyPrelude` reports `mixed`
       * instead of guessing, and a caller that treated "not body" as "nothing to check" would drop
       * the body half from the sheet while the completeness check reported success. The point of
       * this file is that a rule is either in the sheet or loudly not allowed to be.
       */
      if (kind === 'mixed') throw mixedSelectorError(rule.selector, `skin rule in ${file}`)
      if (kind !== 'body') continue
      if (!declared.has(ruleKey(rule))) missing.push(rule)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[build] src/host/boot.css is missing ${missing.length} body-level rule(s) the skin declares — the` +
        ' first frame would paint without them:\n' +
        missing.map((rule) => `[build]   ${rule.context}${rule.text.slice(0, 110)}…`).join('\n') +
        '\n[build] Re-derive it: `node tools/derive-boot-css.mjs`.',
    )
  }
  const module = `/**
 * GENERATED by scripts/build.mjs — do not edit.
 *
 * The first-paint subset of the Liquid Glass stylesheet, sourced from src/host/boot.css. The build
 * proves it rule by rule against the CSS the skin itself emits; edit that file (and then the
 * skin's own tokens.css / glass.css), never this one.
 */
export const BOOT_CSS = ${JSON.stringify(payload)}
`
  await writeFile(outBootCss, module, 'utf8')
  return { bytes: Buffer.byteLength(payload, 'utf8'), blocks: cssSegments(payload).length, rules: rules.length }
}

async function build() {
  const { code: bundle, ordered, externals, undeclared } = await renderBundle({
    packageRoot,
    clientRoot,
    moduleOrder: MODULE_ORDER,
    loaderId: 'dsh-ui-projects',
    loaderName: 'ui-projects',
    generator: 'scripts/build.mjs',
  })
  if (undeclared.length > 0) {
    // Warnings only: see `bundle-client.mjs` for why a present-but-undeclared file must not fail
    // the build for whoever is working on the stable part of the graph.
  }

  await mkdir(dirname(outFile), { recursive: true })
  await writeFile(outFile, bundle, 'utf8')

  // The host half needs no transformation (it is plain ESM), but it does need to
  // exist at the path `package.json` `main` names — and it is no longer a single
  // file: `service.js` owns the first-paint contract and the loader row imports it.
  // So the whole `src/host` tree is copied verbatim, preserving structure, with
  // every bare import in every file checked as it goes.
  const hostSource = await readFile(hostEntry, 'utf8')
  const hostFiles = (await listFiles(hostRoot)).filter((file) => file.endsWith('.js'))
  for (const file of hostFiles) {
    const rel = relative(hostRoot, file).split(sep).join('/')
    if (rel === 'boot-css.js') {
      throw new Error(
        '[build] src/host/boot-css.js would be overwritten by the generated lib/boot-css.js; ' +
          'the first-paint payload belongs in src/host/boot.css, not in a module of its own',
      )
    }
    const source = rel === 'index.js' ? hostSource : await readFile(file, 'utf8')
    assertHostImportsResolvable(source)
    const destination = rel === 'index.js' ? outHost : join(packageRoot, 'lib', rel)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, source, 'utf8')
  }
  const boot = await writeBootCss()

  const digest = createHash('sha256').update(bundle).digest('hex').slice(0, 12)
  const size = Buffer.byteLength(bundle, 'utf8')
  process.stdout.write(
    `[build] lib/client.js ← ${ordered.length} modules, ${size} bytes, sha256:${digest}\n` +
      `[build] lib/index.js  ← host half (${Buffer.byteLength(hostSource, 'utf8')} bytes) + ${hostFiles.length - 1} host module(s)\n` +
      `[build] lib/boot-css.js — ${boot.bytes} bytes, ${boot.blocks} blocks (host-side first-paint subset)\n` +
      `[build] externals: ${[...externals].sort().join(', ') || '(none)'}\n`,
  )
}

if (!existsSync(clientRoot)) {
  throw new Error(`[build] missing ${clientRoot}`)
}
if (!existsSync(hostEntry)) {
  throw new Error(`[build] missing ${hostEntry}`)
}

/*
 * Run only when this file is the entry point.
 *
 * A sibling UI project package's build imports from `./bundle-client.mjs`, and this file is not a
 * library — but `verify.mjs` and the older tooling reach for `transform` here, so importing it
 * must stay free of the side effect of rebuilding a package.
 */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build()
}
