/**
 * What is installed in a dsh profile, and whether we could run it.
 *
 *   node scripts/check-installed.mjs                       # the profile named web, or the only one
 *   node scripts/check-installed.mjs --all-profiles         # every profile, fully scanned
 *   node scripts/check-installed.mjs --list-profiles         # profile names only, nothing read
 *   node scripts/check-installed.mjs --profile <dir>         # an explicit profile directory
 *   node scripts/check-installed.mjs --candidate <spec>      # preview installing something not installed
 *   node scripts/check-installed.mjs --json                  # machine-readable
 *
 * It NEVER WRITES. There is no install path here, no `pnpm`, no network: the whole point is to be
 * runnable against a real profile — by a person, at any time — without any chance of changing it.
 * The commands that WOULD be run are printed for inspection, which is the rule this phase runs on:
 * nothing may write to `$DSH_HOME` that a person has not first seen written out.
 *
 * Exit codes: 0 no errors, 1 at least one error-severity problem, 2 usage error.
 */

import { join, resolve } from 'node:path'

import { discoverProfiles, previewCommand, scanProfile } from '../src/host/profile-scan.js'
import { nameColumnWidth, pad } from './installed-columns.mjs'

const USAGE = `usage: node scripts/check-installed.mjs [--profile <dir> | --all-profiles | --list-profiles]
       [--dsh-home <dir>] [--candidate <spec>]... [--json] [--no-preview]

  --profile <dir>     scan this profile directory (must exist)
  --all-profiles      scan every profile under <dsh-home>/profiles
  --list-profiles     print the profile names under <dsh-home>/profiles and stop
  --dsh-home <dir>    the dsh home to read (default $DSH_HOME, else ~/.dsh)
  --candidate <spec>  a package that is NOT installed; preview the command that would install it
  --json              print the scan as JSON
  --no-preview        skip the command preview

Read-only: no writes, no installs, no network.`

const argv = process.argv.slice(2)
const flags = { candidates: [] }
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  switch (arg) {
    case '--profile':
      flags.profile = argv[++index]
      break
    case '--all-profiles':
      flags.allProfiles = true
      break
    case '--list-profiles':
      flags.listProfiles = true
      break
    case '--dsh-home':
      flags.dshHome = argv[++index]
      break
    case '--candidate':
      flags.candidates.push(argv[++index])
      break
    case '--json':
      flags.json = true
      break
    case '--no-preview':
      flags.noPreview = true
      break
    case '--help':
    case '-h':
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
      break
    default:
      process.stderr.write(`unknown argument ${JSON.stringify(arg)}\n\n${USAGE}\n`)
      process.exit(2)
  }
}

/** @param {string} message */
function usageError(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`)
  process.exit(2)
}

const dshHome = resolve(
  flags.dshHome ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'),
)

if (flags.profile !== undefined && flags.allProfiles) usageError('--profile and --all-profiles are mutually exclusive')

if (flags.listProfiles) {
  const names = await discoverProfiles({ dshHome })
  if (names.length === 0) {
    process.stdout.write(`no profiles under ${join(dshHome, 'profiles')}\n`)
    process.exit(0)
  }
  for (const name of names) process.stdout.write(`${name}\t${join(dshHome, 'profiles', name)}\n`)
  process.exit(0)
}

/*
 * Which profiles to scan. The scans are read ONCE each: an explicit `--profile` is scanned here and
 * its result reused below, so a broken-but-readable profile cannot produce two different reports of
 * itself (the read timestamp alone would differ).
 * @type {Array<{ profileDir: string, scan?: any }>}
 */
let targets
if (flags.profile !== undefined) {
  const profileDir = resolve(flags.profile)
  let scan
  try {
    scan = await scanProfile({ profileDir })
  } catch (error) {
    // An explicitly named profile that does not exist is a wrong PATH, not an empty profile.
    // Answering "0 dependencies" about a directory the user mistyped is the worst answer available.
    if (error?.code === 'ENOENT') usageError(`no package.json under ${profileDir} — not a dsh profile directory`)
    throw error
  }
  targets = [{ profileDir, scan }]
} else if (flags.allProfiles) {
  // An empty (or absent) profiles directory is an empty result, not a failure: a machine that has
  // never run dsh is a legitimate machine to ask.
  targets = (await discoverProfiles({ dshHome })).map((name) => ({ profileDir: join(dshHome, 'profiles', name) }))
} else {
  const names = await discoverProfiles({ dshHome })
  if (names.includes('web')) targets = [{ profileDir: join(dshHome, 'profiles', 'web') }]
  else if (names.length === 1) targets = [{ profileDir: join(dshHome, 'profiles', names[0]) }]
  else if (names.length === 0) usageError(`no profiles under ${join(dshHome, 'profiles')}; pass --profile <dir>`)
  else usageError(`several profiles exist (${names.join(', ')}); pass --profile <dir> or --all-profiles`)
}

const scans = []
for (const target of targets) {
  scans.push(target.scan ?? (await scanProfile({ profileDir: target.profileDir })))
}

/**
 * The command previews, flat and tagged with their profile.
 *
 * Per installed dependency: what removing, updating and rolling it back would run. Per `--candidate`:
 * what installing it would run — a candidate is never guessed at, it is handed in, because inventing
 * a registry name for a package we know nothing about would be worse than saying nothing.
 */
const previews = flags.noPreview
  ? []
  : scans.flatMap((scan) => {
      const rows = scan.dependencies
        .filter((dependency) => dependency.resolved)
        .flatMap((dependency) => [
          previewCommand({ action: 'remove', profileName: scan.profileName, packageName: dependency.name }),
          previewCommand({ action: 'update', profileName: scan.profileName, packageName: dependency.name }),
          previewCommand({
            action: 'rollback',
            profileName: scan.profileName,
            packageName: dependency.name,
            spec: dependency.spec,
            version: dependency.version,
          }),
        ])
        .map((preview, index) => ({
          profile: scan.profileName,
          subject: scan.dependencies.filter((dependency) => dependency.resolved)[Math.floor(index / 3)].name,
          version: scan.dependencies.filter((dependency) => dependency.resolved)[Math.floor(index / 3)].version,
          spec: scan.dependencies.filter((dependency) => dependency.resolved)[Math.floor(index / 3)].spec,
          ...preview,
        }))
      const candidates = flags.candidates
        .filter((spec) => typeof spec === 'string')
        .map((spec) => ({ profile: scan.profileName, subject: spec, version: undefined, spec, ...previewCommand({ action: 'install', profileName: scan.profileName, spec }) }))
      return [...rows, ...candidates]
    })

const problems = scans.flatMap((scan) => scan.problems)
const errors = problems.filter((problem) => problem.severity === 'error')

if (flags.json) {
  process.stdout.write(
    `${JSON.stringify({ tool: 'check-installed', at: new Date().toISOString(), dshHome, scans, previews }, null, 2)}\n`,
  )
  process.exit(errors.length > 0 ? 1 : 0)
}

/*
 * The name columns are the only columns here whose width is not a constant: they are padded through
 * `installed-columns.mjs`, which decides each section's width from the names that land in it. That module
 * carries the reason a written-down 34 was wrong and the property the replacement has to keep.
 */
for (const scan of scans) {
  process.stdout.write(`\ndsh profile: ${scan.profileName}   ${scan.profileDir}\n`)
  process.stdout.write('read-only scan — no writes, no installs, no network\n\n')

  process.stdout.write(`DEPENDENCIES (${scan.dependencies.length})\n`)
  if (scan.dependencies.length === 0) process.stdout.write('  (none)\n')
  const dependencyNameWidth = nameColumnWidth(scan.dependencies.map((dependency) => dependency.name))
  for (const dependency of scan.dependencies) {
    const state = !dependency.resolved ? 'UNRESOLVED' : dependency.bundled ? 'composed' : 'not composed'
    const where = dependency.via === 'link' ? `link → ${dependency.realDir}` : 'store'
    process.stdout.write(
      `  ${pad(dependency.name, dependencyNameWidth)}${pad(dependency.version ?? '-', 10)}${pad(dependency.kind, 18)}${pad(state, 14)}${where}\n`,
    )
  }

  process.stdout.write(`\nBUNDLES (${scan.bundles.all.length})\n`)
  const bundleNameWidth = nameColumnWidth(scan.bundles.all)
  for (const name of scan.bundles.all) {
    const tags = [scan.bundles.inBox.includes(name) ? '[in-box]' : '', scan.dependencies.some((d) => d.name === name) ? '[dependency]' : '']
    process.stdout.write(`  ${pad(name, bundleNameWidth)}${tags.filter(Boolean).join(' ')}\n`)
  }

  process.stdout.write(`\nUI PROJECT PACKAGES (${scan.uiProjectPackages.length})\n`)
  if (scan.uiProjectPackages.length === 0) process.stdout.write('  (none)\n')
  const projectNameWidth = nameColumnWidth(scan.uiProjectPackages.map((entry) => entry.name))
  for (const entry of scan.uiProjectPackages) {
    process.stdout.write(`  ${pad(entry.name, projectNameWidth)}${pad(entry.version, 10)}project id: ${entry.projectId ?? '(invalid)'}\n`)
  }

  /*
   * UI CONTRACT FINDINGS (step 9a).
   *
   * What a static scan of each package's `lib/client.js` could see, printed from the same scan the column
   * reads — so the CLI and the page can never disagree about what was found. Two statements that look
   * alike and are not: `scanned: false` means nothing was judged (a library, a missing bundle, a bundle
   * over the cap) and is printed as its reason; a clean scan prints as `0 findings`. Collapsing them would
   * make "we did not look" indistinguishable from "we looked and it is clean", which is the one thing this
   * section exists to keep apart.
   *
   * Printed only when a package HAS a client half or something to report: a section that says "nothing to
   * scan" for every row on every profile is a section nobody reads.
   */
  const scanned = scan.dependencies.filter((dependency) => dependency.contract?.scanned === true)
  const withFindings = scanned.filter((dependency) => (dependency.contract.findings ?? []).length > 0)
  if (scanned.length > 0) {
    process.stdout.write(`\nUI CONTRACT (${scanned.length} client bundle(s) scanned, ${withFindings.length} with findings)\n`)
    const contractNameWidth = nameColumnWidth(scanned.map((dependency) => dependency.name))
    for (const dependency of scanned) {
      const findings = dependency.contract.findings ?? []
      process.stdout.write(
        `  ${pad(dependency.name, contractNameWidth)}${findings.length === 0 ? 'no findings' : `${findings.length} finding(s)`}\n`,
      )
      for (const finding of findings) {
        process.stdout.write(`      ${finding.code}  (line ${finding.evidence?.line ?? '?'})\n`)
        process.stdout.write(`        ${finding.evidence?.excerpt ?? ''}\n`)
      }
    }
    /*
     * The limits belong in the same breath as the findings: a clean scan is not a clean plugin, and a
     * reader who takes this section as a verdict has been misled by the section rather than by the tools.
     * They are UNIONED across the scanned rows, because a per-scan note (how many role values were
     * computed rather than written) is a fact about one bundle and the standing limits are about all of
     * them.
     */
    for (const limit of new Set(scanned.flatMap((dependency) => dependency.contract.limits ?? []))) {
      process.stdout.write(`  note: ${limit}\n`)
    }
  }
  const unscanned = scan.dependencies.filter((dependency) => dependency.contract !== undefined && dependency.contract.scanned !== true)
  if (unscanned.length > 0) {
    process.stdout.write(`\nNOT SCANNED (${unscanned.length})\n`)
    const unscannedNameWidth = nameColumnWidth(unscanned.map((dependency) => dependency.name))
    for (const dependency of unscanned) {
      process.stdout.write(`  ${pad(dependency.name, unscannedNameWidth)}${dependency.contract.reason ?? 'no reason given'}\n`)
    }
  }

  /*
   * VERSION DIRECTORIES NOBODY CAN ATTRIBUTE.
   *
   * The version store keys its directories by a package name spelled for a filesystem (`@scope+name`), and
   * the page reads a snapshot's own `manifest.package` rather than decoding that spelling back. When a
   * directory holds snapshots that record no package, the page cannot show them against any card — so the
   * fact is REPORTED here instead of being silently dropped, because a store that is damaged or was made by
   * hand is exactly what a person needs to hear about. `-ListVersions` names the same directories from the
   * other side; this is the scan's view, and it is the one that says how many snapshots are inside.
   *
   * Printed only when there is something to say: a section that is empty on every healthy profile is a
   * section nobody reads.
   */
  const unattributed = Array.isArray(scan.versions?.unattributed) ? scan.versions.unattributed : []
  if (unattributed.length > 0) {
    process.stdout.write(
      `\nUNATTRIBUTED VERSION DIRECTORIES (${unattributed.length}) — snapshots exist, but none records which package it belongs to\n`,
    )
    const directoryNameWidth = nameColumnWidth(unattributed.map((entry) => entry.directory))
    for (const entry of unattributed) {
      process.stdout.write(`  ${pad(entry.directory, directoryNameWidth)}${entry.snapshots} snapshot(s)\n`)
    }
    process.stdout.write(
      '  The directory name is a spelling this project chose for a scoped package, so it is not decoded\n' +
        '  back into a package name — that would be a claim the file on disk never made. `-ListVersions`\n' +
        '  names them too; `-Rollback -To <name>` can still restore one by name.\n',
    )
  }

  if (scan.orphanedBindings.length > 0) {
    process.stdout.write(
      `\nORPHANED BINDINGS (${scan.orphanedBindings.length}) — declare a bundle, missing from dsh.profile.bundles\n` +
        `  ${scan.orphanedBindings.join(', ')}\n` +
        '  Installed but not composed: their host rows never run, so nothing is injected for their\n' +
        '  projects and their cards can never appear. Re-run the loader for this profile.\n',
    )
  }

  process.stdout.write(`\nPROBLEMS (${scan.problems.length})\n`)
  if (scan.problems.length === 0) process.stdout.write('  (none)\n')
  for (const problem of scan.problems) {
    const where =
      problem.package === undefined
        ? 'profile'
        : `${problem.package}${problem.version === undefined ? '' : `@${problem.version}`}`
    process.stdout.write(`  [${problem.severity}] ${problem.code}  ${where}  ${problem.field}\n`)
    process.stdout.write(`      ${problem.message}\n`)
    process.stdout.write(`      fix: ${problem.action}\n`)
  }
}

if (previews.length > 0) {
  process.stdout.write('\nPREVIEW — the commands this profile would run (nothing was executed)\n')
  let subject
  for (const preview of previews) {
    if (preview.subject !== subject) {
      subject = preview.subject
      const version = preview.version === undefined ? '(not installed)' : preview.version
      process.stdout.write(`  ${preview.subject}  ${version}  ${preview.spec ?? ''}\n`)
    }
    process.stdout.write(`    would ${preview.action}: ${preview.command === null ? 'n/a' : preview.command.join(' ')}\n`)
    if (preview.command === null) process.stdout.write(`      ${preview.note}\n`)
  }
}
process.stdout.write('\n')

if (errors.length > 0) {
  process.stdout.write(`${errors.length} error-severity problem(s); see the PROBLEMS section above.\n`)
  process.exit(1)
}
process.stdout.write('no error-severity problems\n')
process.exit(0)
