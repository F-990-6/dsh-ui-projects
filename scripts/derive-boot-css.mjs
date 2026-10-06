/**
 * Derive `src/host/boot.css` from the scoped skin CSS.
 *
 * WHY THIS IS A KEPT TOOL rather than a one-off. The first-paint sheet is a verbatim copy of every
 * body-level rule the skin emits, and it has to be re-derived whenever those rules change — which
 * is exactly what happens every time a token is added or a conditional branch is added to
 * `tokens.css` / `glass.css`. Doing that by hand is how two copies of one palette start to differ.
 *
 * The build enforces the result from one side (`scripts/build.mjs`: every rule in boot.css must
 * exist in the skin's emitted CSS). This tool produces the file that satisfies it; run it after
 * any body-level edit, then `npm run build`.
 *
 *   node scripts/derive-boot-css.mjs                            # rewrite THIS package's src/host/boot.css
 *   node scripts/derive-boot-css.mjs --check                    # report drift, change nothing
 *   node scripts/derive-boot-css.mjs --package <dir> [--check]  # another package's first-paint sheet
 *
 * WHY IT LIVES HERE. It used to sit in the workspace's `tools/`, where `--package` was the only way to
 * point it at anything and the flag-less default was the framework — a package with no stylesheets of its
 * own and no `scripts/boot-css-rules.mjs`, so that default could only ever exit 1. The tool belongs to the
 * package whose CSS it derives, so it now lives in that package's `scripts/`, beside the build that calls
 * it and the rules module that decides what it keeps.
 *
 * WHAT COUNTS AS BODY-LEVEL is decided by the TARGET PACKAGE's `scripts/boot-css-rules.mjs`, shared
 * with that package's `scripts/build.mjs`: a rule whose selector is about the marked body element itself
 * — `body[data-ui-project-…="on"]` and the same with further attribute conditions — together with the
 * conditional at-rules (`@supports`, `@media`) that wrap such rules. A descendant rule such as
 * `body[marker] .lg-glass` is NOT included: it needs DOM a first frame does not have yet.
 *
 * `--package` still lets one copy serve another package: the marker, the stylesheet list, the output path
 * and the header all come from the package it is pointed at. WITHOUT the flag it derives the package it
 * lives in — this one, the only package it can answer for without being told. Both directions matter: the
 * framework has no first-paint rules at all, and `--package <framework>` is how it says so (the read below
 * fails with the path it expected) rather than agreeing with a file that describes nothing.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { scopeCss } from '../src/client/scope-css.js'

const toolPath = fileURLToPath(import.meta.url)
const here = dirname(toolPath)
const root = resolve(here, '..')

/**
 * WHICH PACKAGE. Resolved before anything is read, because every path below hangs off it.
 *
 * The default is the package this tool lives in — the skin that owns the stylesheets it reads. `--package
 * <dir>` names another one, which is how a second skin would use it, and how the framework is asked a
 * question whose answer is "I have no first-paint rules".
 */
const packageFlagAt = process.argv.indexOf('--package')
if (packageFlagAt >= 0 && (process.argv[packageFlagAt + 1] === undefined || process.argv[packageFlagAt + 1].startsWith('--'))) {
  process.stderr.write('usage: node scripts/derive-boot-css.mjs [--package <dir>] [--check]\n')
  process.exit(2)
}
const packageDir = resolve(packageFlagAt >= 0 ? process.argv[packageFlagAt + 1] : root)
const rulesPath = join(packageDir, 'scripts', 'boot-css-rules.mjs')
/** @type {any} */
let rules
try {
  rules = await import(pathToFileURL(rulesPath).href)
} catch (error) {
  process.stderr.write(
    `cannot read the first-paint rules of ${packageDir}\n  expected ${rulesPath}\n  ${String(error?.message ?? error)}\n`,
  )
  process.exit(1)
}
const { MARKER, classifyPrelude, mixedSelectorError, SKIN_DIR, SKIN_STYLESHEETS, BOOT_CSS_OUT, BOOT_CSS_HEADER } = rules
if (MARKER === undefined || !Array.isArray(SKIN_STYLESHEETS) || BOOT_CSS_OUT === undefined || BOOT_CSS_HEADER === undefined) {
  process.stderr.write(`${rulesPath} does not export MARKER, SKIN_STYLESHEETS, BOOT_CSS_OUT and BOOT_CSS_HEADER\n`)
  process.exit(1)
}
const skinDir = join(packageDir, SKIN_DIR)
const outFile = join(packageDir, BOOT_CSS_OUT)
const checkOnly = process.argv.includes('--check')
/**
 * The exact command that would rewrite this sheet, printed when it is stale.
 *
 * Relative to the READER's working directory, not to this file: the tool is run from a package root, and an
 * absolute path in a message is a fact about one machine rather than about the command. `--package` is
 * echoed back only when it was given, so the printed command is the one that was run.
 */
const rerun =
  packageFlagAt >= 0
    ? `node ${relative(process.cwd(), toolPath)} --package ${packageDir}`
    : `node ${relative(process.cwd(), toolPath)}`

/**
 * Split a stylesheet into top-level segments. Braces inside strings do not occur in this package's
 * CSS, so a brace counter is exact; a brace-less at-rule would be folded into the next prelude,
 * which this package does not use.
 * @param {string} css
 * @returns {Array<{ prelude: string, body: string }>}
 */
function segments(css) {
  const out = []
  let start = 0
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] !== '{') continue
    const prelude = css.slice(start, index)
    const block = blockBody(css, index + 1)
    out.push({ prelude, body: block.text })
    index = block.end
    start = index + 1
  }
  return out
}

/** The text of the block opened at `from`, and the index of its closing brace. */
function blockBody(css, from) {
  let depth = 1
  for (let index = from; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return { text: css.slice(from, index), end: index }
    }
  }
  throw new Error('unbalanced braces')
}

/** @param {string} prelude */
const isConditional = (prelude) => prelude.trim().startsWith('@')

/**
 * Reduce one stylesheet to its body-level rules, preserving order and any conditional wrapper that
 * still has body-level content inside it.
 *
 * The predicate itself lives in the TARGET package's `scripts/boot-css-rules.mjs`, shared with that
 * package's `scripts/build.mjs`, which asserts the completeness of what this writes. One copy, so the two
 * can not disagree about which rules the sheet is supposed to contain.
 * @param {string} scoped
 * @returns {string[]}
 */
function bodyLevel(scoped) {
  const kept = []
  for (const segment of segments(scoped.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    const kind = classifyPrelude(segment.prelude)
    if (kind === 'mixed') throw mixedSelectorError(segment.prelude, 'top level')
    if (kind === 'body') {
      kept.push(`${segment.prelude.trim()}{${segment.body.trim()}}`)
      continue
    }
    if (!isConditional(segment.prelude)) continue
    const inner = []
    for (const child of segments(segment.body)) {
      const childKind = classifyPrelude(child.prelude)
      if (childKind === 'mixed') throw mixedSelectorError(child.prelude, `inside ${segment.prelude.trim()}`)
      if (childKind === 'body') inner.push(`  ${child.prelude.trim()}{${child.body.trim()}}`)
    }
    if (inner.length === 0) continue
    kept.push(`${segment.prelude.trim()}{\n${inner.join('\n')}\n}`)
  }
  return kept
}

/**
 * Re-indent by brace depth. Cosmetic, and safe because the build compares rules with whitespace
 * normalised — this cannot change what the sheet means, only how tiring it is to read.
 * @param {string} css
 */
function pretty(css) {
  const lines = css.replace(/\{\s*/g, '{\n').replace(/\s*\}/g, '\n}').split('\n')
  const out = []
  let depth = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') {
      if (out.length > 0 && out[out.length - 1] !== '' && depth > 0) out.push('')
      continue
    }
    if (line.startsWith('}')) depth = Math.max(0, depth - 1)
    out.push('  '.repeat(depth) + line)
    if (line.endsWith('{')) depth += 1
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

const pieces = []
for (const file of SKIN_STYLESHEETS) {
  const raw = await readFile(join(skinDir, file), 'utf8')
  for (const block of bodyLevel(scopeCss(MARKER, raw))) pieces.push({ file, block: pretty(block) })
}

const next = `${BOOT_CSS_HEADER}\n\n${pieces.map((piece) => piece.block).join('\n\n')}\n`
const current = await readFile(outFile, 'utf8').catch(() => '')

if (next === current) {
  process.stdout.write(`boot.css is up to date — ${pieces.length} blocks, ${Buffer.byteLength(next, 'utf8')} bytes\n`)
} else if (checkOnly) {
  process.stdout.write(
    `boot.css is STALE — would be ${pieces.length} blocks, ${Buffer.byteLength(next, 'utf8')} bytes ` +
      `(on disk: ${Buffer.byteLength(current, 'utf8')}). Run: ${rerun}\n`,
  )
  process.exitCode = 1
} else {
  await writeFile(outFile, next, 'utf8')
  process.stdout.write(
    `boot.css rewritten — ${pieces.length} blocks, ${Buffer.byteLength(next, 'utf8')} bytes\n` +
      pieces
        .map((piece, index) => `  ${String(index + 1).padStart(2)}. ${piece.file} ${piece.block.slice(0, 62).replace(/\n/g, ' ')}…\n`)
        .join(''),
  )
}
