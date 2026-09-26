/**
 * Conformance: is this installed package one we could actually run?
 *
 * Pure functions, deliberately. Everything about the filesystem — does the patch file exist, is
 * the dependency resolvable, which directory is it — is a FACT the caller probes and passes in.
 * That split is what lets the same judgement run in three places without three behaviours:
 *
 *   `scripts/check-installed.mjs`  against a real profile, read-only, by a person
 *   `uiProjectsHost.installedPackages()` (step 5) inside the host process, for the panel
 *   `check-installed.test.mjs`     against fixtures, with no profile involved at all
 *
 * WHAT A PROBLEM IS, AND WHAT IT IS NOT. Every problem names a field, the offending value, and
 * the change that fixes it, because the reader is a package author or a user looking at a listing
 * — neither of whom can act on "invalid package". This is CONTRACT VALIDATION, NOT A SANDBOX: a
 * bundle's patch file and its `lib/` are executed by dsh at composition time, and nothing here
 * changes that. What it changes is that a package we cannot run says so before it is installed,
 * instead of taking the GUI down at boot.
 */

import {
  KNOWN_PROJECT_TYPES,
  SUPPORTED_MANIFEST_SCHEMA,
  SUPPORTED_PLUGIN_API,
  validateManifest,
} from './manifest-schema.js'

export {
  ID_PATTERN,
  KNOWN_FEATURES,
  KNOWN_PERF_LEVELS,
  KNOWN_PROJECT_TYPES,
  KNOWN_SCOPES,
  MANIFEST_FIELDS,
  SUPPORTED_MANIFEST_SCHEMA,
  SUPPORTED_PLUGIN_API,
  validateManifest,
} from './manifest-schema.js'

/** Stable codes. The listing prints `message`; tests and the panel branch on these. */
export const PROBLEM_CODES = {
  MANIFEST_INVALID: 'manifest-invalid',
  UNSUPPORTED_MANIFEST_SCHEMA: 'unsupported-manifest-schema',
  UNSUPPORTED_PLUGIN_API: 'unsupported-plugin-api',
  MISSING_BUNDLE_PATCH: 'missing-bundle-patch',
  PATCH_FILE_MISSING: 'patch-file-missing',
  MISSING_CLIENT: 'missing-client',
  UNKNOWN_PROJECT_TYPE: 'unknown-project-type',
  /** Profile-level, not package-level: the profile's own package.json could not be parsed. */
  PROFILE_MANIFEST_UNPARSEABLE: 'profile-manifest-unparseable',
  /** Profile-level: `dsh.profile.bundles` is not an array, so the layer stack cannot be read. */
  PROFILE_BUNDLES_INVALID: 'profile-bundles-invalid',
  /** A package that is installed but whose own package.json does not parse. */
  PACKAGE_MANIFEST_UNPARSEABLE: 'package-manifest-unparseable',
  /** A dependency that is listed but not materialized under node_modules. A warning, not an error. */
  DEPENDENCY_UNRESOLVED: 'dependency-unresolved',
}

/**
 * Does this package's `dsh` block declare a bundle?
 *
 * The loader's own admission predicate, restated: a dependency joins the layer stack when its
 * resolved manifest declares `dsh.bundle.patch`. Two callers need it — the scanner, to decide
 * whether a dependency is composed, and `orphanedBindings`, to decide whether a dependency that is
 * NOT in the stack is a problem or just a library.
 * @param {{ dsh?: { bundle?: { patch?: unknown } } } | undefined} manifest
 */
export function declaresBundle(manifest) {
  return manifest?.dsh?.bundle?.patch !== undefined
}

/**
 * Every reason this package cannot be run as a UI project.
 *
 * Returns `[]` for a package that declares no `dsh.uiProject`: it is not a UI project package, and
 * a plain library or an ordinary client plugin is a legitimate thing to install. The loader says
 * the same thing in its own words — "a plain library is fine; the warning is orientation".
 *
 * @param {object} facts probed by the caller
 * @param {string} facts.name the package name, as installed
 * @param {string} facts.version
 * @param {any} facts.dsh the package.json `dsh` block, as parsed
 * @param {boolean} [facts.patchFileExists] whether `dsh.bundle.patch` resolves to a readable file
 *   under the package root; `undefined` means the caller did not probe, and the check is skipped
 *   rather than guessed
 * @returns {Problem[]}
 */
export function checkUiProjectDeclaration(facts) {
  const manifest = facts?.dsh?.uiProject
  if (manifest === undefined || manifest === null) return []

  const base = { package: facts.name, version: facts.version, file: 'package.json' }
  /** @type {Problem[]} */
  const problems = []
  const problem = (field, code, message, action) =>
    problems.push({ ...base, field, code, severity: 'error', message, action })

  /*
   * The manifest's own schema version first: if we cannot read the document, every judgement below
   * is being made about fields we may be misreading.
   *
   * This is an ERROR, and the reason is that `schemaVersion` is OUR contract version, not a third
   * party's. Step 1 of this phase put it in the same sentence as `dshVersionHint` and called both
   * "advisory"; that was wrong for this one. A hint about which dsh a package expects can be
   * advisory, because the package still says what it needs. A schema version we do not implement
   * means the package was written against a table we do not have — including fields we would drop
   * without noticing.
   */
  if (manifest.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA) {
    problem(
      'dsh.uiProject.schemaVersion',
      PROBLEM_CODES.UNSUPPORTED_MANIFEST_SCHEMA,
      `schemaVersion is ${JSON.stringify(manifest.schemaVersion)}; this build reads ${SUPPORTED_MANIFEST_SCHEMA}`,
      'upgrade the framework, or rebuild the package against this schema — an unread document is not a package we can run',
    )
  }

  if (manifest.pluginApiVersion !== undefined && !SUPPORTED_PLUGIN_API.includes(manifest.pluginApiVersion)) {
    problem(
      'dsh.uiProject.pluginApiVersion',
      PROBLEM_CODES.UNSUPPORTED_PLUGIN_API,
      `pluginApiVersion is ${JSON.stringify(manifest.pluginApiVersion)}; this build understands ${SUPPORTED_PLUGIN_API.join(', ')}`,
      'rebuild the package against a supported plugin API, or upgrade the framework first',
    )
  }

  /*
   * The type gets a code of its own, and the generic validator's complaint about the same field is
   * dropped: one broken value, one line in the listing. It earns a code because the fix differs in
   * kind from "a field has the wrong shape" — a project type this build does not implement means the
   * package was written against a NEWER vocabulary, and the reader needs to see which vocabulary
   * this build actually has before deciding whether to upgrade the framework or the package.
   */
  const typeIsKnown = KNOWN_PROJECT_TYPES.includes(manifest.type)
  if (manifest.type !== undefined && !typeIsKnown) {
    problem(
      'dsh.uiProject.type',
      PROBLEM_CODES.UNKNOWN_PROJECT_TYPE,
      `dsh.uiProject.type is ${JSON.stringify(manifest.type)}; this build understands ${KNOWN_PROJECT_TYPES.join(', ')}`,
      'rebuild the package against this framework, or upgrade the framework — an unknown type is a project nothing here can apply',
    )
  }

  for (const issue of validateManifest(manifest)) {
    if (!typeIsKnown && issue.field === 'dsh.uiProject.type') continue
    problem(issue.field, PROBLEM_CODES.MANIFEST_INVALID, issue.message, issue.action)
  }

  /*
   * The four package-level checks: a UI project package needs all three declarations, and they are
   * three different failures with three different fixes, so they are reported separately.
   *
   *   dsh.bundle.patch   without it the loader never admits the package: `exportsPatch()` in dsh
   *                      returns false, the name never joins `dsh.profile.bundles`, and the host
   *                      row — the thing that serves the client bundle and injects the first
   *                      frame — is never composed. Installed and dead.
   *   the file itself    the loader's predicate checks only that the property EXISTS
   *                      (`dsh?.bundle?.patch !== void 0`). A package naming a patch file it does
   *                      not ship therefore joins the layer stack and fails when the stack is
   *                      built, which is a boot failure rather than a package problem. We check
   *                      the file; the loader does not.
   *   dsh.client         without it there is no browser half. The host row would compose, serve
   *                      nothing, and inject rows for a project that can never register.
   */
  const patchSpec = facts?.dsh?.bundle?.patch
  if (patchSpec === undefined) {
    problem(
      'dsh.bundle.patch',
      PROBLEM_CODES.MISSING_BUNDLE_PATCH,
      'the package declares dsh.uiProject but no dsh.bundle.patch, so the loader never admits it',
      'declare "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } and ship that file',
    )
  } else if (facts.patchFileExists === false) {
    problem(
      'dsh.bundle.patch',
      PROBLEM_CODES.PATCH_FILE_MISSING,
      `dsh.bundle.patch is ${JSON.stringify(patchSpec)} but no such file exists under the package root`,
      'ship the patch file, or fix the path — the loader admits the package on the declaration alone and fails later, at boot',
    )
  }

  const platform = facts?.dsh?.client?.platform
  if (platform !== 'web') {
    problem(
      'dsh.client.platform',
      PROBLEM_CODES.MISSING_CLIENT,
      platform === undefined
        ? 'the package declares dsh.uiProject but no dsh.client, so its browser half is never served'
        : `dsh.client.platform is ${JSON.stringify(platform)}; the UI project system is a web client feature`,
      'declare "dsh": { "client": { "platform": "web" } } — a project registers itself from its client half',
    )
  }

  return problems
}

/**
 * Normalize the `dsh` block of a parsed package.json.
 *
 * Tolerates anything: the input comes from a file we did not write and, in the failure cases we
 * care about, is wrong in some way. The checks above report the wrongness; this only guarantees
 * they are looking at an object rather than at `undefined`.
 * @param {any} dsh
 */
export function readDeclarations(dsh) {
  if (dsh === null || typeof dsh !== 'object') return {}
  return dsh
}
