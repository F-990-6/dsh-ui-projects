/**
 * Keep the framework's built-in copy of Glass identical to the package it came from — or say how it isn't.
 *
 * USAGE
 *   node scripts/sync-builtin.mjs                     # --check: report, change nothing
 *   node scripts/sync-builtin.mjs --write             # write the rows that may be written, then re-check
 *   node scripts/sync-builtin.mjs --package <dir>     # or set DSH_SKIN_PACKAGE
 *
 * EXIT CODES, three of them, because three different things can have happened:
 *   0  in sync — nothing to write, or a write that left nothing to report
 *   1  a divergence is still there, and this run did NOT write it (check mode, or a row the writer
 *      must not touch, or a `sheets` row whose divergence is in the module around the sheets)
 *   2  a write was REFUSED — the mojibake guard, which aborts the whole run before the first byte
 *
 * The distinction is the point of the third code: `--write && next-step` must not proceed after a run
 * that wrote nothing, and the previous version could not tell that apart from success. It exited 1 after a
 * SUCCESSFUL write, because the failure count came from the check phase and was never recomputed.
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

/** Where the package is: `--package`, then the environment, then nothing. */
function findSkinPackage() {
  const index = process.argv.indexOf('--package')
  const fromArgv = index === -1 ? undefined : process.argv[index + 1]
  const named = fromArgv ?? process.env[SKIN_PACKAGE_ENV]
  if (named === undefined || named === '') return undefined
  return existsSync(named) ? resolve(named) : undefined
}

/**
 * One whole pass: the two trees, then every mapped file.
 *
 * A FUNCTION RATHER THAN A STRAIGHT LINE, because a write has to be followed by another pass: the exit
 * code has to describe the state the run LEFT BEHIND, not the state it found. Everything it needs comes
 * from the arguments, so the second pass is the same pass.
 * @param {string} skinPackage
 * @returns {{ failures: number, inSync: number, writable: { label: string, mode: string, ours: string, theirs: string }[], total: number, mangled: { label: string, ours: string }[] }}
 */
function inspect(skinPackage) {
  let failures = 0
  const ok = (/** @type {string} */ label) => process.stdout.write(`  ok   ${label}\n`)
  const fail = (/** @type {string} */ label, /** @type {string} */ detail) => {
    failures += 1
    process.stdout.write(`  FAIL ${label}\n         ${detail}\n`)
  }
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

  /** @type {{ label: string, mode: string, ours: string, theirs: string, outcome: string }[]} */
  const rows = []
  /** Files the mojibake guard has to look at before any write: every row the writer may touch. */
  const mangled = []
  for (const [label, inFramework, inPackage, mode] of BUILT_IN_MAP) {
    const ours = join(packageRoot, inFramework)
    const theirs = join(skinPackage, inPackage)
    if (!existsSync(ours) || !existsSync(theirs)) {
      fail(
        `${label} is where the map says it is`,
        `framework ${existsSync(ours) ? 'ok' : 'missing'}, package ${existsSync(theirs) ? 'ok' : 'missing'}`,
      )
      continue
    }
    const ourText = readFileSync(ours, 'utf8')
    const theirText = readFileSync(theirs, 'utf8')

    const wreckage = mojibakeCount(ourText)
    if (wreckage === 0) ok(`${label} carries no mojibake`)
    else {
      fail(`${label} carries no mojibake`, `${wreckage} character(s) of wreckage in the framework's copy`)
      if (mode !== 'none') mangled.push({ label, ours })
    }

    if (mode === 'raw' || mode === 'marker') {
      const same = ourText === (mode === 'raw' ? theirText : normalizeMarker(theirText))
      rows.push({ label, mode, ours, theirs, outcome: same ? 'in sync' : 'differs' })
      if (same) ok(`${label} is byte-identical to the package's${mode === 'marker' ? ', once the marker is normalized' : ''}`)
      else fail(`${label} is byte-identical to the package's`, 'the two files differ')
      continue
    }
    if (mode === 'sheets') {
      const oursSheets = overlaySheets(ourText)
      const theirSheets = overlaySheets(theirText)
      const names = Object.keys(theirSheets)
      if (Object.keys(oursSheets).sort().join(',') !== names.slice().sort().join(',')) {
        fail(`${label} carries the same sheets as the package's`, `${Object.keys(oursSheets).join(',')} vs ${names.join(',')}`)
        rows.push({ label, mode, ours, theirs, outcome: 'sheet set differs' })
        continue
      }
      const differing = names.filter((name) => oursSheets[name] !== normalizeMarker(theirSheets[name]))
      rows.push({
        label,
        mode,
        ours,
        theirs,
        outcome: differing.length === 0 ? 'in sync' : `${differing.length} sheet(s) differ`,
      })
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

  return {
    failures,
    inSync: rows.filter((row) => row.outcome === 'in sync').length,
    writable: rows.filter((row) => row.outcome !== 'in sync' && row.mode !== 'none'),
    total: rows.length,
    mangled,
  }
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

const first = inspect(skinPackage)

if (!write) {
  process.stdout.write(`\n  ${first.inSync} of ${first.total} mapped file(s) in sync`)
  process.stdout.write(first.writable.length === 0 ? '; nothing to write\n' : `; ${first.writable.length} would be written by --write\n`)
  process.stdout.write(`\n  ${first.failures} failure(s)\n`)
  process.exit(first.failures === 0 ? 0 : 1)
}

if (first.writable.length === 0) {
  process.stdout.write(`\n  already in sync; nothing written\n  ${first.failures} failure(s)\n`)
  process.exit(first.failures === 0 ? 0 : 1)
}

/*
 * THE GUARD COMES FIRST, over every file this run would touch, before the first byte is written: a partial
 * write is worse than no write, and the whole point of counting is to refuse rather than repair.
 */
if (first.mangled.length > 0) {
  process.stdout.write(
    `\n  REFUSED  ${first.mangled.length} file(s) in the framework's copy carry mojibake; nothing was written:\n` +
      first.mangled.map((row) => `           ${row.label}: ${mojibakeCount(readFileSync(row.ours, 'utf8'))} character(s)\n`).join(''),
  )
  process.stdout.write('\n  exit 2: a refused write is not the same as a divergence left alone.\n')
  process.exit(2)
}

for (const row of first.writable) {
  if (row.mode === 'raw') {
    copyFileSync(row.theirs, row.ours)
    process.stdout.write(`  wrote ${row.label} verbatim\n`)
  } else if (row.mode === 'marker') {
    writeFileSync(row.ours, normalizeMarker(readFileSync(row.theirs, 'utf8')), 'utf8')
    process.stdout.write(`  wrote ${row.label}, marker substituted\n`)
  } else {
    /*
     * `sheets` WRITES THE SHEETS, NOT THE FILE — the one place where copying is impossible and a sync is
     * still the right answer. The framework's `overlay.js` is the package's `src/client/index.js` with its
     * head, its requires and its tail rewritten for a built-in, so copying the package's file over it would
     * delete all three. What the two DO share is the four CSS sheets inside them, and those are what this
     * mode compares — and, since this round, what it writes: each sheet body is replaced in place,
     * marker-normalized, and the module around it is left exactly as this repository wrote it.
     *
     * Before this, the mode could only re-substitute a marker, so a change to a dialog rule lived in the
     * package and reached nowhere: the one part of the copy that still had to be carried by hand.
     */
    let next = readFileSync(row.ours, 'utf8')
    const theirSheets = overlaySheets(readFileSync(row.theirs, 'utf8'))
    const missing = []
    let updated = 0
    for (const [name, body] of Object.entries(theirSheets)) {
      const pattern = new RegExp(`(const ${name} = \`)[\\s\\S]*?(\`)`)
      if (!pattern.test(next)) {
        missing.push(name)
        continue
      }
      const before = next
      next = next.replace(pattern, (_match, head, tail) => head + normalizeMarker(body) + tail)
      if (next !== before) updated += 1
    }
    if (missing.length > 0) {
      fail(`${row.label}: every sheet the package has was found`, `missing in the framework's copy: ${missing.join(', ')}`)
      continue
    }
    if (updated === 0) {
      process.stdout.write(`  ${row.label}: sheets already identical — left alone\n`)
      continue
    }
    writeFileSync(row.ours, next, 'utf8')
    process.stdout.write(`  wrote ${updated} of ${Object.keys(theirSheets).length} sheet(s) into ${row.label}\n`)
  }
}

/*
 * AND THE EXIT CODE DESCRIBES WHAT IS LEFT, so the state is measured again rather than remembered. This is
 * the fix for the version that exited 1 after a successful write: it read a counter from the check phase.
 */
process.stdout.write('\n  --- after the write ---\n')
const second = inspect(skinPackage)
process.stdout.write(`\n  ${second.inSync} of ${second.total} mapped file(s) in sync; ${second.failures} failure(s) left\n`)
process.stdout.write('  run `node scripts/build.mjs` to rebuild.\n')
process.exit(second.failures === 0 ? 0 : 1)
