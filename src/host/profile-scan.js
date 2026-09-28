/**
 * Read one dsh profile and say what is installed in it.
 *
 * READ-ONLY, AND STRUCTURALLY SO. This module imports `readFile`, `readdir`, `stat` and `realpath`
 * — no write API of any kind, and none may be added. The point of a scanner that cannot write is
 * that running it against a real profile is safe to do at any time, including by a person who is
 * trying to find out what is wrong; `scripts/check-installed.test.mjs` asserts the absence by
 * reading this file's source, so the property cannot be lost by accident.
 *
 * TWO FACTS ARE KEPT APART, because conflating them is the mistake this scanner exists to avoid:
 *
 *   installed   the name is in the profile's `dependencies` and resolves under `node_modules`
 *   composed    the name is in `dsh.profile.bundles` AND its package declares `dsh.bundle.patch`
 *
 * They are not the same set and neither contains the other. `dsh.profile.bundles` also lists the
 * profile template's IN-BOX bundles (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`), which
 * are not dependencies — the loader's own words are "in-box bundles from the profile template are
 * not dependencies and are never touched". A package can be installed and not composed, which is
 * exactly the state that leaves a first frame with nothing injected; the scanner reports it as
 * `orphanedBindings` so the panel can explain it instead of leaving a dead project behind.
 */

import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'

/** Where `install.ps1` keeps a package's version snapshots, inside the profile directory. */
const VERSIONS_DIR_NAME = '.dsh-ui-projects-versions'

/** How many snapshots are worth sending: the panel offers the newest and lists the rest on request. */
const VERSIONS_MAX = 5

/** How many package directories are worth opening: the store never holds many, and a scan is not free. */
const VERSIONS_MAX_PACKAGES = 20
import { join, resolve } from 'node:path'

import {
  PROBLEM_CODES,
  checkUiProjectDeclaration,
  declaresBundle,
  readDeclarations,
} from './conformance.js'
import { CONTRACT_RULE_COUNT, CONTRACT_RULES_JUDGED, scanClientBundle } from './contract-scan.js'

/**
 * How large a client bundle may be before the listing stops scanning it.
 *
 * The listing is fetched every time the settings column opens, and the scan is O(the bundle): measured on
 * this workspace's own build output, 296614 characters take 14.5 ms, so a profile with twenty client
 * halves costs a few hundred milliseconds. A cap keeps a hostile or merely careless package from turning
 * that into seconds, and the row says `scanned: false` with the size rather than pretending it looked.
 */
const CONTRACT_SCAN_MAX_BYTES = 4 * 1024 * 1024

/**
 * Judge one dependency's client bundle, and say so in a shape a row can render.
 *
 * WHO IS SCANNED, and this predicate was WRONG in the first version: it keyed off `kind`, and `kind`
 * reports `bundle` for any package that declares a bundle patch — which is every real plugin here. So the
 * two packages that most need judging were skipped: `dsh-cost-meter` (an enhancement with a client half)
 * and the framework itself, both of which declare `dsh.bundle.patch` AND `dsh.client`. The subject is the
 * declaration that makes a browser bundle reachable — `dsh.client` — and nothing else. `kind` answers a
 * different question (what a row IS in the listing) and must not be reused for this one.
 *
 * A FAILURE IS A PAYLOAD, never a throw — the same rule the endpoint follows one layer up. An unreadable
 * bundle makes the row say it could not be read, not the whole listing fail.
 * @param {{ dir?: string, resolved?: boolean }} installed
 * @param {any} dsh the package's `dsh` declarations
 * @returns {Promise<{ scanned: boolean, reason: string | null, bytes?: number, findings: any[], limits: string[] }>}
 */
async function judgeContract(installed, dsh) {
  if (installed.resolved !== true) {
    return { scanned: false, reason: 'not installed, so there is nothing on disk to scan', findings: [], limits: [] }
  }
  if (dsh?.client === undefined) {
    return { scanned: false, reason: 'declares no client half (dsh.client), so nothing of it runs in the page', findings: [], limits: [] }
  }
  const bundlePath = join(String(installed.dir), 'lib', 'client.js')
  let size
  try {
    const stats = await stat(bundlePath)
    if (!stats.isFile()) throw new Error('not a file')
    size = stats.size
  } catch {
    return { scanned: false, reason: 'lib/client.js is missing, so there is nothing to scan', findings: [], limits: [] }
  }
  if (size > CONTRACT_SCAN_MAX_BYTES) {
    return {
      scanned: false,
      reason: `lib/client.js is ${size} bytes, over the ${CONTRACT_SCAN_MAX_BYTES}-byte scan cap`,
      bytes: size,
      findings: [],
      limits: [],
    }
  }
  try {
    const { findings, limits } = scanClientBundle(await readFile(bundlePath, 'utf8'))
    return { scanned: true, reason: null, bytes: size, findings, limits }
  } catch (error) {
    return {
      scanned: false,
      reason: `lib/client.js could not be read: ${String(error?.message ?? error)}`,
      bytes: size,
      findings: [],
      limits: [],
    }
  }
}

/**
 * The scan above, plus the two numbers the settings column needs to describe its own coverage.
 *
 * ONE PLACE, not six. `judgeContract` returns from six points (not installed, no client half, no bundle,
 * over the cap, unreadable, judged) and the counts describe the INSTRUMENT rather than the bundle, so they
 * are the same for every row — attaching them here is what keeps the six returns from drifting apart.
 *
 * They travel even on a row that was not scanned, and the column ignores them there: a coverage sentence
 * ("3 of 4 rules were judged") over a bundle nobody read would be the most confident possible lie.
 * @param {{ dir?: string, resolved?: boolean }} installed
 * @param {any} dsh the package's `dsh` declarations
 * @returns {Promise<{ scanned: boolean, reason: string | null, bytes?: number, findings: any[], limits: string[], rules: { judged: number, total: number } }>}
 */
async function contractFor(installed, dsh) {
  return {
    ...(await judgeContract(installed, dsh)),
    rules: { judged: CONTRACT_RULES_JUDGED, total: CONTRACT_RULE_COUNT },
  }
}

/*
 * WHY THERE IS NO LIST OF ENTRIES TO SKIP. Resolution is BY NAME, out of the profile's
 * `dependencies`, so `node_modules` is never walked — and its furniture can therefore never be
 * mistaken for an installed package: pnpm's `.pnpm` store, the `.ignored_<name>` tombstone it
 * leaves behind when a package is moved aside, dsh's `.dsh-module-fallback`. A scanner that walked
 * the directory would need that skip list and would still be guessing; this one cannot need it.
 */

/** Specifiers that point at a directory on this machine rather than at a published version. */
const LOCAL_SPEC = /^(link|file|portal|workspace):/

/**
 * Profile names under one dsh home.
 *
 * Names only: it does not read a single package.json, so listing profiles cannot fail because one
 * of them is broken. A missing `profiles/` directory is an empty list, not an error — a machine
 * that has never run dsh is a legitimate machine.
 * @param {{ dshHome: string }} options
 * @returns {Promise<string[]>}
 */
export async function discoverProfiles({ dshHome }) {
  const root = join(dshHome, 'profiles')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  /*
   * A directory is a profile when it has a package.json — the same definition everything else here
   * uses. The obvious alternative, "any directory that is not hidden", is wrong in practice and was
   * wrong here first: `profiles/node_modules` is a directory, is not hidden, and was duly listed as
   * a profile. The predicate is a fact about the directory, not a name added to a skip list.
   */
  const names = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    try {
      if ((await stat(join(root, entry.name, 'package.json'))).isFile()) names.push(entry.name)
    } catch {
      // Not a profile: nothing to say about it, and nothing to fail on.
    }
  }
  return names.sort()
}

/**
 * Read one installed package's identity and declarations.
 *
 * Resolution goes through `node_modules/<name>`, following symlinks — the two shapes a profile has
 * are a `link:` dependency pointing at a working directory and a store entry that pnpm links into
 * place, and `readFile` treats both the same. A tombstone (`.ignored_<name>`) is never consulted,
 * because resolution is BY NAME from `dependencies` rather than by walking `node_modules`: a
 * package that pnpm moved aside is not installed.
 *
 * @param {{ profileDir: string, name: string }} options
 * @returns {Promise<{ resolved: boolean, dir?: string, realDir?: string, via?: 'link'|'store', manifest?: any, version?: string, problems: Problem[] }>}
 */
async function readInstalledPackage({ profileDir, name }) {
  const dir = join(profileDir, 'node_modules', name)
  /** @type {Problem[]} */
  const problems = []
  let info
  try {
    info = await stat(dir)
  } catch {
    return { resolved: false, problems }
  }
  if (!info.isDirectory()) return { resolved: false, problems }

  let via = 'store'
  let realDir = dir
  try {
    realDir = await realpath(dir)
    via = (await lstat(dir)).isSymbolicLink() ? 'link' : 'store'
  } catch {
    // A path that cannot be resolved is still perfectly readable in every case we care about: this
    // distinction only brightens the diagnostics, so it must never be able to fail the scan.
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch (error) {
    problems.push({
      package: name,
      version: 'unknown',
      file: 'package.json',
      field: 'package.json',
      code: PROBLEM_CODES.PACKAGE_MANIFEST_UNPARSEABLE,
      severity: 'error',
      message: `the installed package's package.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
      action: 'reinstall the package — nothing can be said about a manifest that does not parse',
    })
    return { resolved: true, dir, realDir, via, problems }
  }

  return { resolved: true, dir, realDir, via, manifest, version: String(manifest.version ?? 'unknown'), problems }
}

/**
 * Scan one profile.
 *
 * Throws when the profile's own `package.json` does not exist: that is not a package problem but a
 * wrong-path problem, and the caller passed the path. A profile whose manifest exists but does not
 * PARSE is reported as a problem instead, because "your profile file is broken" is exactly the kind
 * of thing the person running this needs to be told rather than to crash on.
 *
 * @param {{ profileDir: string }} options
 * @returns {Promise<ProfileScan>}
 */
export async function scanProfile({ profileDir }) {
  const dir = resolve(profileDir)
  const manifestPath = join(dir, 'package.json')
  const raw = await readFile(manifestPath, 'utf8') // ENOENT throws: the caller named this path.

  /** @type {ProfileScan} */
  const scan = {
    profileDir: dir,
    profileName: dir.split(/[\\/]/).filter(Boolean).pop() ?? '',
    readAt: new Date().toISOString(),
    dependencies: [],
    bundles: { all: [], inBox: [], fromDependencies: [] },
    uiProjectPackages: [],
    orphanedBindings: [],
    unresolved: [],
    problems: [],
  }

  let profile
  try {
    profile = JSON.parse(raw)
  } catch (error) {
    scan.problems.push({
      scope: 'profile',
      file: 'package.json',
      field: 'package.json',
      code: PROBLEM_CODES.PROFILE_MANIFEST_UNPARSEABLE,
      severity: 'error',
      message: `the profile's package.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      action: 'fix or delete the file — dsh cannot compose a profile it cannot parse either',
    })
    return scan
  }

  const dependencyEntries = Object.entries(profile?.dependencies ?? {})
  const bundlesRaw = profile?.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundlesRaw)) {
    scan.problems.push({
      scope: 'profile',
      file: 'package.json',
      field: 'dsh.profile.bundles',
      code: PROBLEM_CODES.PROFILE_BUNDLES_INVALID,
      severity: 'error',
      message: `dsh.profile.bundles is ${JSON.stringify(bundlesRaw)}, not an array`,
      action: 'set it to the list of bundles the profile composes, or remove it',
    })
  }
  const bundles = Array.isArray(bundlesRaw) ? bundlesRaw.filter((name) => typeof name === 'string') : []
  scan.bundles.all = [...bundles]
  scan.bundles.inBox = bundles.filter((name) => !dependencyEntries.some(([dependency]) => dependency === name))
  scan.bundles.fromDependencies = bundles.filter((name) => dependencyEntries.some(([dependency]) => dependency === name))

  for (const [name, spec] of dependencyEntries) {
    const installed = await readInstalledPackage({ profileDir: dir, name })
    const dsh = readDeclarations(installed.manifest?.dsh)
    const bundled = installed.resolved && declaresBundle(installed.manifest) && bundles.includes(name)

    /*
     * The patch path is relative to the PACKAGE ROOT, which is how the loader resolves it too
     * (`resolveBundleDir` anchors there). Probed here, because `conformance.js` is pure and must
     * not touch a filesystem; `undefined` means "not probed" and suppresses the check rather than
     * guessing at it.
     */
    let patchFileExists
    const patchSpec = dsh.bundle?.patch
    if (installed.resolved && typeof patchSpec === 'string') {
      try {
        patchFileExists = (await stat(join(installed.dir, patchSpec))).isFile()
      } catch {
        patchFileExists = false
      }
    }

    const problems = [
      ...installed.problems,
      ...(installed.resolved
        ? checkUiProjectDeclaration({
            name,
            version: installed.version ?? 'unknown',
            dsh,
            patchFileExists,
          })
        : [
            {
              package: name,
              version: String(spec),
              file: 'package.json',
              field: 'dependencies',
              code: PROBLEM_CODES.DEPENDENCY_UNRESOLVED,
              severity: 'warning',
              message: `${name} is listed in dependencies as ${JSON.stringify(spec)} but is not installed under node_modules`,
              action: 'run the loader for this profile to materialize it, or remove the dependency',
            },
          ]),
    ]

    const kind = !installed.resolved
      ? 'unresolved'
      : dsh.uiProject !== undefined
        ? 'ui-project'
        : declaresBundle(installed.manifest)
          ? 'bundle'
          : dsh.client !== undefined
            ? 'plugin-with-client'
            : 'library'

    const contract = await contractFor(installed, dsh)

    scan.dependencies.push({
      name,
      spec: String(spec),
      resolved: installed.resolved,
      version: installed.version,
      dir: installed.dir,
      realDir: installed.realDir,
      via: installed.via,
      kind,
      bundled,
      projectId: typeof dsh.uiProject?.id === 'string' ? dsh.uiProject.id : undefined,
      problems,
      contract,
    })
    if (!installed.resolved) scan.unresolved.push(name)
    if (kind === 'ui-project') {
      scan.uiProjectPackages.push({
        name,
        version: installed.version ?? 'unknown',
        projectId: dsh.uiProject.id,
      })
    }
    /*
     * Orphaned bindings are dependencies that DECLARE a bundle but are missing from the layer
     * stack — installed, claiming to be composed, and not composed. A dependency that declares no
     * bundle at all is a plain library, and the loader's own note is that this is fine; calling it
     * an orphan would make the report cry wolf about `zod`.
     */
    if (installed.resolved && declaresBundle(installed.manifest) && !bundles.includes(name)) {
      scan.orphanedBindings.push(name)
    }
    scan.problems.push(...problems)
  }

  // Version snapshots, for the packages a row can be rendered for. Read here rather than in the
  // endpoint so that the wire projection stays a projection: what crosses the channel is decided in
  // one place (`projectScan`), and what is read is decided in this one.
  scan.versions = await readVersions(profileDir)

  // Every package's problems were appended as it was scanned. Re-appending the unresolved ones here
  // would double every one of those warnings in the listing, which is exactly the kind of noise that
  // teaches a reader to stop reading.
  return scan
}

/**
 * The directory name one package's snapshots live under, inside the version store.
 *
 * THE LAYOUT RULE, in the half that reads the store, and it exists because a scoped package name is not a
 * directory name: `@xjl-resources/dsh-plugin-liquid-glass` contains a `/`, which would make it a NESTED
 * directory — and this module reads the store exactly one level deep. So the name and the directory are
 * two different things with one agreed translation, and `install.ps1` holds the same rule on the writing
 * side (`Get-VersionsDirName`, asserted equal to this function by a parity check in the suites, because a
 * source guard can prove the shape of a PowerShell function but not its behaviour).
 *
 * `+` is the separator because npm forbids it in a package name — so a directory containing `+` can only
 * have come from a scoped name — and because pnpm's lockfile uses the same convention. An unscoped name
 * maps to ITSELF, which is what leaves every snapshot taken before the split exactly where it is.
 *
 * EVERY separator is replaced, not the first one, and that is not pedantry: PowerShell's `String.Replace`
 * replaces all occurrences, so a JS `String.replace` with a string pattern would disagree with it on any
 * input holding two slashes. The two halves are compared by running both (`scripts/verify.mjs`), and the
 * first version of this function failed that comparison — which is the only reason the difference was
 * found rather than shipped.
 *
 * THERE IS NO REVERSE FUNCTION, on purpose. `readVersions` keys its map by the `package` field each
 * snapshot's manifest records, which is the authoritative answer and needs no decoding; a directory whose
 * snapshots record no package is REPORTED rather than guessed at, because a name reconstructed from a
 * directory name would be a claim this module cannot support.
 * @param {string} packageName
 * @returns {string}
 */
export const versionsDirNameOf = (packageName) =>
  packageName.startsWith('@') ? packageName.split('/').join('+') : packageName

/**
 * The version snapshots a package has recorded, newest first — identity and counts only.
 *
 * READ-ONLY like the rest of this module, and deliberately blind to paths: a snapshot NAME is what a
 * person pastes into `-Rollback -To`, and the directory it lives in is none of the page's business.
 *
 * THE KEYS ARE PACKAGE NAMES, taken from each snapshot's own `manifest.package` rather than from the
 * directory it sits in. That is the difference between reading the layout and guessing at it, and it is
 * what lets the client stay ignorant of the layout entirely: the page looks up
 * `versions[project.source.package]` and never has to know that a scoped package's directory is spelled
 * with a `+`.
 *
 * THE DISTINCTION THAT MATTERS TO A CALLER: a package this function was not asked about is absent from
 * the map, which is NOT the same as a package with an empty list. A host whose code predates this field
 * sends no `versions` object at all, and the client renders a different sentence for that than for "no
 * snapshots yet" — one is a restart that has not happened, the other is a fact about the profile.
 */
async function readVersions(profileDir) {
  /*
   * THE DIRECTORY ITSELF IS THE LIST.
   *
   * It used to be handed a list of package names, and that list came from `uiProjectPackages` — which holds
   * only packages declaring `dsh.uiProject`. The framework declares none (it IS the framework), so it was
   * never asked about and `versions` came back `{}` while its snapshots sat on disk the whole time. Which
   * packages have snapshots is a fact about this directory, not something a caller should have to know.
   */
  /** @type {Record<string, any[]>} */
  const out = {}
  const root = join(profileDir, VERSIONS_DIR_NAME)
  /** @type {any[]} */
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    /* no versions directory at all: every package has none, which a caller reads as an empty object */
    return out
  }
  let scanned = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (scanned >= VERSIONS_MAX_PACKAGES) break
    scanned += 1
    const dirName = entry.name
    /** @type {any[]} */
    const list = []
    /*
     * The package this directory belongs to, taken from a snapshot's OWN manifest. Every snapshot
     * `install.ps1 -Snapshot` has ever written carries `package` (7b onward), so this is the field the
     * writer already publishes for exactly this purpose -- and reading it means the reader never has to
     * decode the directory name, which is a derived spelling (`@scope+name`) that would be a guess the
     * moment a directory was made by hand.
     */
    /** @type {string | undefined} */
    let packageName
    const packageDir = join(profileDir, VERSIONS_DIR_NAME, dirName)
    try {
      /* Named apart from the outer list on purpose: shadowing it would read as a bug to the next person. */
      const snapshotDirs = await readdir(packageDir, { withFileTypes: true })
      for (const snapshot of snapshotDirs) {
        if (!snapshot.isDirectory()) continue
        try {
          const manifest = JSON.parse(await readFile(join(packageDir, snapshot.name, 'manifest.json'), 'utf8'))
          const payload = manifest?.payload ?? {}
          const declared = typeof manifest?.package === 'string' ? manifest.package : ''
          if (packageName === undefined && declared.length > 0) packageName = declared
          list.push({
            name: snapshot.name,
            version: String(manifest.version ?? 'unknown'),
            createdAt: String(manifest.createdAt ?? ''),
            files: Number(payload.files ?? 0),
            bytes: Number(payload.bytes ?? 0),
            ours: String(manifest.tool ?? '') === 'install.ps1 -Snapshot',
          })
        } catch {
          /*
           * A directory without a readable manifest is not a snapshot this page can describe. It is
           * left out rather than rendered as a broken row: the column's subject is the package, and a
           * half-read snapshot would invite a rollback to something that cannot be verified.
           */
        }
      }
    } catch {
      /* no versions directory for this package — an empty list, which is a fact about the profile */
    }
    if (packageName === undefined) {
      /*
       * REPORTED, NOT DECODED. Nothing in this directory said which package it belongs to, and the
       * directory name is not allowed to answer for it: `@scope+name` is a spelling this project chose,
       * so turning it back into a name would invent an authority the file on disk never claimed. The
       * listing says the directory is there and that it cannot be attributed -- which is how a damaged or
       * hand-made snapshot gets noticed instead of quietly disappearing from the page.
       */
      out.unattributed = Array.isArray(out.unattributed) ? out.unattributed : []
      out.unattributed.push({ directory: dirName, snapshots: list.length })
      continue
    }
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    out[packageName] = list.slice(0, VERSIONS_MAX)
  }
  return out
}

/**
 * The command a real install/uninstall/update/rollback would run.
 *
 * Pure and never executed: this exists so a person can see what would happen before anything
 * happens, which is the rule the whole phase runs on. The loader is a pnpm forwarder
 * (`dsh plugin --profile <name> <args…>`), so the commands below are the loader's own argument
 * shapes and nothing invented.
 *
 * A `link:`/`file:` dependency has no published version, so a rollback is reported as impossible
 * rather than as a command that would fail.
 * @param {{ action: 'install'|'remove'|'update'|'rollback', profileName: string, packageName?: string, spec?: string, version?: string }} request
 * @returns {{ action: string, command: string[] | null, note: string }}
 */
export function previewCommand({ action, profileName, packageName, spec, version }) {
  const base = ['dsh', 'plugin', '--profile', profileName]
  switch (action) {
    case 'install':
      return {
        action,
        command: [...base, 'add', String(spec)],
        note: 'the loader forwards this to pnpm in the profile directory, then reconciles dsh.profile.bundles against what is installed',
      }
    case 'remove':
      return {
        action,
        command: [...base, 'remove', String(packageName)],
        note: "the package's entry leaves dsh.profile.bundles; the user's own records for its projects stay in settings.yaml",
      }
    case 'update':
      return {
        action,
        command: [...base, 'update', String(packageName)],
        note: 'a package that gained or lost its dsh.bundle declaration reconciles by installed state, not by version',
      }
    case 'rollback':
      if (spec !== undefined && LOCAL_SPEC.test(String(spec))) {
        return {
          action,
          command: null,
          note: `a ${String(spec).split(':')[0]}: dependency has no published version to return to`,
        }
      }
      return {
        action,
        command: [...base, 'add', `${String(packageName)}@${String(version)}`],
        note: 'pnpm resolves the requested version from the store or the registry, then the layer stack is reconciled',
      }
    default:
      return { action, command: null, note: `unknown action ${JSON.stringify(action)}` }
  }
}

/**
 * @typedef {object} Problem
 * @property {string} [package] absent on profile-level problems
 * @property {string} [version]
 * @property {string} file
 * @property {string} field
 * @property {string} code
 * @property {'error'|'warning'} severity
 * @property {string} message
 * @property {string} action
 */

/**
 * @typedef {object} ProfileScan
 * @property {string} profileDir
 * @property {string} profileName
 * @property {string} readAt
 * @property {Array<{ name: string, spec: string, resolved: boolean, version?: string, dir?: string, realDir?: string, via?: string, kind: string, bundled: boolean, projectId?: string, problems: Problem[] }>} dependencies
 * @property {{ all: string[], inBox: string[], fromDependencies: string[] }} bundles
 * @property {Array<{ name: string, version: string, projectId?: string }>} uiProjectPackages
 * @property {string[]} orphanedBindings
 * @property {string[]} unresolved
 * @property {Problem[]} problems
 * @property {Record<string, Array<{ name: string, version: string, createdAt: string, files: number, bytes: number, ours: boolean }>> & { unattributed?: Array<{ directory: string, snapshots: number }> }} [versions]
 *   Keyed by PACKAGE NAME, taken from each snapshot's own manifest. `unattributed` lists version-store
 *   directories whose snapshots record no package, so a damaged store is visible instead of silent.
 */
