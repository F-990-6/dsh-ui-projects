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
import { join, resolve } from 'node:path'

import {
  PROBLEM_CODES,
  checkUiProjectDeclaration,
  declaresBundle,
  readDeclarations,
} from './conformance.js'

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

  // Every package's problems were appended as it was scanned. Re-appending the unresolved ones here
  // would double every one of those warnings in the listing, which is exactly the kind of noise that
  // teaches a reader to stop reading.
  return scan
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
 */
