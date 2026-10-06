/**
 * Keep the framework's built-in copy of Glass identical to the package it came from — or say how it isn't.
 *
 * USAGE
 *   node scripts/sync-builtin.mjs                     # --check: report, change nothing, exit 1 on a diff
 *   node scripts/sync-builtin.mjs --write             # copy the sheets over, then re-check
 *   node scripts/sync-builtin.mjs --package <dir>     # or set DSH_SKIN_PACKAGE
 *
 * WHY A TOOL AND NOT A BUILD STEP. The copy is edited by hand, and a build that reached into another
 * repository would stop this package from building on its own. So the comparison runs on demand, the
 * mapping lives in `scripts/builtin-map.mjs` (shared with `scripts/check-builtin.test.mjs`, so the two
 * cannot drift), and the build stays repo-local.
 *
 * WHAT `--write` WILL AND WILL NOT DO. It rewrites the files whose mode says the two copies are the same
 * bytes (`raw`, `marker`) and re-substitutes the marker inside the overlay (`sheets`). It REFUSES the
 * `none` rows outright — `skin.js` calls the overlay from `apply`/`cleanup`, and the manifest's id, name,
 * package and version are meant to differ — because overwriting either would delete a deliberate
 * divergence and look like a successful sync.
 *
 * AND IT REFUSES TO WRITE A MANGLED FILE. Before anything is written, every file the run would touch is
 * counted for mojibake (`builtin-map.mjs`), and a non-zero count aborts the whole write with the numbers
 * printed. That is the accident recorded in `docs/known-issues.md` section 2, and a tool that repairs it
 * silently would be the second way to lose it.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUILT_IN_MAP,
  BUILT_IN_TREES,
  SKIN_PACKAGE_ENV,
  mojibakeCount,
  normalizeMarker,
  overlaySheets,
} from './builtin-map.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const ok = (/** @type {string} */ label) => process.stdout.write(`  ok   ${label}\n`)
const fail = (/** @type {string} */ label, /** @type {string} */ detail) => {
  failures += 1
  process.stdout.write(`  FAIL ${label}\n         ${detail}\n`)
}

/** Where the package is: `--package`, then the environment, then nothing. */
function findSkinPackage() {
  const index = process.argv.indexOf('--package')
  const fromArgv = index === -1 ? undefined : process.argv[index + 1]
  const named = fromArgv ?? process.env[SKIN_PACKAGE_ENV]
  if (named === undefined || named === '') return undefined
  return existsSync(named) ? resolve(named) : undefined
}

const write = process.argv.includes('--write')
const skinPackage = findSkinPackage()
if (skinPackage === undefined) {
  process.stdout.write(
    '  UNCHECKED  no skin package given, so nothing was compared.\n' +
      `             Pass --package <dir> or set ${SKIN_PACKAGE_ENV}; the two repositories are not siblings, so\n` +
      '             the path cannot be derived from this one.\n',
  )
  process.exit(0)
}
process.stdout.write(`== built-in sync ${write ? '(write)' : '(check)'} against ${skinPackage} ==\n`)

/* ── 1 · the trees, file for file, before a single file is compared ──────────────────────────────── */
const roots = { framework: packageRoot, package: skinPackage }
for (const [which, directory, expected] of BUILT_IN_TREES) {
  const full = join(roots[which], directory)
  if (!existsSync(full)) {
    fail(`${directory} exists in the ${which}`, 'missing directory')
    continue
  }
  const found = readdirSync(full).sort().join(',')
  if (found === expected) ok(`${directory} holds exactly its expected files in the ${which}`)
  else fail(`${directory} holds exactly its expected files in the ${which}`, `expected ${expected}, got ${found}`)
}

/* ── 2 · every mapped file: what it should be, and what the writer would do with it ──────────────── */
/** @type {{ label: string, mode: string, ours: string, theirs: string, outcome: string }[]} */
const rows = []
for (const [label, inFramework, inPackage, mode] of BUILT_IN_MAP) {
  const ours = join(packageRoot, inFramework)
  const theirs = join(skinPackage, inPackage)
  if (!existsSync(ours) || !existsSync(theirs)) {
    fail(`${label} is where the map says it is`, `framework ${existsSync(ours) ? 'ok' : 'missing'}, package ${existsSync(theirs) ? 'ok' : 'missing'}`)
    continue
  }
  const ourText = readFileSync(ours, 'utf8')
  const theirText = readFileSync(theirs, 'utf8')

  const mangled = mojibakeCount(ourText)
  if (mangled === 0) ok(`${label} carries no mojibake`)
  else fail(`${label} carries no mojibake`, `${mangled} character(s) of wreckage in the framework's copy`)

  if (mode === 'raw') {
    const same = ourText === theirText
    rows.push({ label, mode, ours, theirs, outcome: same ? 'in sync' : 'differs' })
    if (same) ok(`${label} is byte-identical to the package's`)
    else fail(`${label} is byte-identical to the package's`, 'the two files differ')
    continue
  }
  if (mode === 'marker') {
    const same = ourText === normalizeMarker(theirText)
    rows.push({ label, mode, ours, theirs, outcome: same ? 'in sync' : 'differs' })
    if (same) ok(`${label} is byte-identical once the marker is normalized`)
    else fail(`${label} is byte-identical once the marker is normalized`, 'the two files differ')
    continue
  }
  if (mode === 'sheets') {
    const oursSheets = overlaySheets(ourText)
    const theirSheets = overlaySheets(theirText)
    const names = Object.keys(theirSheets)
    const sameSet = Object.keys(oursSheets).sort().join(',') === names.sort().join(',')
    if (!sameSet) {
      fail(`${label} carries the same sheets as the package's`, `${Object.keys(oursSheets).join(',')} vs ${names.join(',')}`)
      rows.push({ label, mode, ours, theirs, outcome: 'sheet set differs' })
      continue
    }
    const differing = names.filter((name) => oursSheets[name] !== normalizeMarker(theirSheets[name]))
    rows.push({ label, mode, ours, theirs, outcome: differing.length === 0 ? 'in sync' : `${differing.length} sheet(s) differ` })
    if (differing.length === 0) ok(`${label} carries the package's ${names.length} sheets, marker-normalized`)
    else fail(`${label} carries the package's sheets`, `differing: ${differing.join(', ')}`)
    continue
  }
  /* `none`: deliberately different. Existence, mojibake and the marker counts are all that can be said. */
  const stale = (ourText.match(/data-ui-project-liquid-glass/g) ?? []).length
  rows.push({ label, mode, ours, theirs, outcome: 'deliberately different' })
  if (stale === 0) ok(`${label} is deliberately different, and carries no stale marker`)
  else fail(`${label} is deliberately different, and carries no stale marker`, `${stale} package marker(s) in the framework's copy`)
}

/* ── 3 · the writer ──────────────────────────────────────────────────────────────────────────────── */
const writable = rows.filter((row) => row.outcome !== 'in sync' && row.mode !== 'none')
if (!write) {
  process.stdout.write(`\n  ${rows.filter((row) => row.outcome === 'in sync').length} of ${rows.length} mapped file(s) in sync`)
  process.stdout.write(writable.length === 0 ? '; nothing to write\n' : `; ${writable.length} would be written by --write\n`)
} else if (writable.length === 0) {
  process.stdout.write('\n  already in sync; nothing written\n')
} else {
  /*
   * THE GUARD COMES FIRST, over every file this run would touch, before the first byte is written: a
   * partial write is worse than no write, and the whole point of counting is to refuse rather than repair.
   */
  const dirty = rows.filter((row) => row.mode !== 'none' && mojibakeCount(readFileSync(row.ours, 'utf8')) !== 0)
  if (dirty.length > 0) {
    process.stdout.write(
      `\n  REFUSED  ${dirty.length} file(s) in the framework's copy carry mojibake; nothing was written:\n` +
        dirty.map((row) => `             ${row.label}: ${mojibakeCount(readFileSync(row.ours, 'utf8'))} character(s)\n`).join(''),
    )
    process.exit(1)
  }
  for (const row of writable) {
    if (row.mode === 'raw') {
      copyFileSync(row.theirs, row.ours)
      process.stdout.write(`  wrote ${row.label} verbatim\n`)
    } else if (row.mode === 'marker') {
      writeFileSync(row.ours, normalizeMarker(readFileSync(row.theirs, 'utf8')), 'utf8')
      process.stdout.write(`  wrote ${row.label}, marker substituted\n`)
    } else {
      /*
       * `sheets` may only re-substitute in place: the surrounding module is this repository's, not the
       * package's, and copying the package's file here would delete the rewritten head and tail.
       */
      const text = readFileSync(row.ours, 'utf8')
      const fixed = text.split('data-ui-project-liquid-glass').join('data-ui-project-glass')
      if (fixed === text) {
        process.stdout.write(`  ${row.label}: nothing to substitute, and ${row.outcome} — left alone\n`)
        continue
      }
      writeFileSync(row.ours, fixed, 'utf8')
      process.stdout.write(`  re-substituted the marker in ${row.label}\n`)
    }
  }
  process.stdout.write('\n  written. Run `node scripts/sync-builtin.mjs` again to confirm, and `node scripts/build.mjs` to rebuild.\n')
}

process.stdout.write(`\n  ${failures} failure(s)\n`)
process.exit(failures === 0 ? 0 : 1)
