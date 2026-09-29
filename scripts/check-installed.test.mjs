/**
 * The conformance checker's own suite.
 *
 * Two halves, and both are needed:
 *
 *   the PURE half exercises `conformance.js` with facts handed straight in — no filesystem at all,
 *   because that is the module's whole design: filesystem facts are injected, so every judgement
 *   can be tested without building a profile.
 *
 *   the SCANNER half builds real directory trees under the system temp directory and runs
 *   `scanProfile` against them: the two facts it must never conflate (installed vs composed), the
 *   tombstone it must never mistake for an install, the profile that does not parse and must be
 *   reported rather than thrown on.
 *
 * Plus two structural guards, because the properties they check cannot be seen in behaviour:
 * `profile-scan.js` and the CLI must contain no write API at all, and the project-type vocabulary
 * must match the client's own constants.
 *
 * Nothing here touches `$DSH_HOME`: every fixture lives under `os.tmpdir()`.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROBLEM_CODES, checkUiProjectDeclaration, KNOWN_PROJECT_TYPES } from '../src/host/conformance.js'
import { discoverProfiles, previewCommand, scanProfile, versionsDirNameOf } from '../src/host/profile-scan.js'
import { CONTRACT_CODES, CONTRACT_LIMITS, CONTRACT_RULES, CONTRACT_RULE_COUNT, CONTRACT_RULES_JUDGED, WAI_ARIA_ROLES, scanClientBundle } from '../src/host/contract-scan.js'
import { NAME_COLUMN_FLOOR, nameColumnWidth, pad } from './installed-columns.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

let passed = 0
let failed = 0
const ok = (label) => {
  passed += 1
  process.stdout.write(`  ok   ${label}\n`)
}
const fail = (label) => {
  failed += 1
  process.stdout.write(`  FAIL ${label}\n`)
}
const equal = (actual, expected, label) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) ok(label)
  else fail(`${label}\n         got      ${JSON.stringify(actual)}\n         expected ${JSON.stringify(expected)}`)
}
const check = (condition, label) => (condition ? ok(label) : fail(label))

/** One well-formed `dsh.uiProject`, overridable per test. */
const project = (over = {}) => ({
  schemaVersion: 1,
  pluginApiVersion: 1,
  id: 'sample-skin',
  name: 'Sample',
  description: 'A sample project',
  type: 'skin',
  scope: 'global',
  ...over,
})

/**
 * A package.json `dsh` block for a UI project package.
 *
 * `over.uiProject` is MERGED into the well-formed project rather than replacing it, so a test that
 * overrides one field is testing that field and not the eight it accidentally removed. `over.bundle`
 * and `over.client` may be replaced outright, because the tests that break those do so on purpose.
 */
const uiProjectDsh = (over = {}) => ({
  ...over,
  bundle: over.bundle ?? { patch: './cordis.patch.yml' },
  client: over.client ?? { platform: 'web' },
  uiProject: project(over.uiProject ?? {}),
})

const codes = (problems) => problems.map((problem) => problem.code)
const fields = (problems) => problems.map((problem) => problem.field)

const root = await mkdtemp(join(tmpdir(), 'dsh-check-installed-'))
/** @type {string[]} */
const created = [root]

/**
 * Build one profile directory under the temp root.
 * @param {object} spec
 * @param {Record<string, string>} spec.dependencies
 * @param {string[]} [spec.bundles]
 * @param {Record<string, { dsh?: any, version?: string, files?: Record<string, string> }>} [spec.packages]
 * @param {string} [spec.rawProfileJson] when present, written verbatim instead of a composed profile
 * @param {boolean} [spec.writeProfileJson]
 */
async function makeProfile(spec) {
  const profileDir = await mkdtemp(join(root, 'profile-'))
  created.push(profileDir)
  if (spec.writeProfileJson !== false) {
    const profile = spec.rawProfileJson ?? JSON.stringify({
      name: 'dsh-profile-fixture',
      private: true,
      dependencies: spec.dependencies,
      dsh: { profile: { bundles: spec.bundles ?? [] } },
    })
    await writeFile(join(profileDir, 'package.json'), profile, 'utf8')
  }
  for (const [name, entry] of Object.entries(spec.packages ?? {})) {
    const packageDir = join(profileDir, 'node_modules', name)
    await mkdir(packageDir, { recursive: true })
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({ name, version: entry.version ?? '1.0.0', ...(entry.dsh === undefined ? {} : { dsh: entry.dsh }) }, null, 2),
      'utf8',
    )
    for (const [relative, content] of Object.entries(entry.files ?? {})) {
      const target = join(packageDir, relative)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
  }
  return profileDir
}

process.stdout.write('== pure conformance ==\n')

equal(checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: {} }), [], 'a package with no dsh.uiProject is not a UI project package and has no problems')
equal(
  checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: { client: { platform: 'web' } } }),
  [],
  'nor is an ordinary client plugin',
)

const good = checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: uiProjectDsh(), patchFileExists: true })
equal(good, [], 'a complete declaration passes with every fact supplied')

const badId = checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: uiProjectDsh({ uiProject: { id: 'Bad_Id!' } }), patchFileExists: true })
equal(codes(badId), [PROBLEM_CODES.MANIFEST_INVALID], 'an invalid id is a manifest problem')
equal(fields(badId), ['dsh.uiProject.id'], 'and the field it names is the id')

const noPatch = checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: { client: { platform: 'web' }, uiProject: project() } })
equal(codes(noPatch), [PROBLEM_CODES.MISSING_BUNDLE_PATCH], 'a UI project package without dsh.bundle.patch is refused: the loader would never admit it')

const missingPatchFile = checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: uiProjectDsh(), patchFileExists: false })
equal(codes(missingPatchFile), [PROBLEM_CODES.PATCH_FILE_MISSING], 'a patch path with no file behind it is refused (the loader checks only the declaration)')

const unprobed = checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: uiProjectDsh() })
equal(codes(unprobed), [], 'when the caller did not probe for the patch file, the check is skipped rather than guessed')

const noClient = checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' }, uiProject: project() }, patchFileExists: true })
equal(codes(noClient), [PROBLEM_CODES.MISSING_CLIENT], 'a UI project package without dsh.client is refused: no browser half means no registrant')

const unknownType = checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: uiProjectDsh({ uiProject: { type: 'theme' } }), patchFileExists: true })
equal(codes(unknownType), [PROBLEM_CODES.UNKNOWN_PROJECT_TYPE], 'an unknown project type gets its own code, not a generic manifest complaint')
check(unknownType[0].message.includes(KNOWN_PROJECT_TYPES.join(', ')), 'and the message lists the vocabulary this build actually has')

const schemaTooNew = checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: uiProjectDsh({ uiProject: { schemaVersion: 2 } }), patchFileExists: true })
equal(
  codes(schemaTooNew).includes(PROBLEM_CODES.UNSUPPORTED_MANIFEST_SCHEMA),
  true,
  'an unreadable schema version is an ERROR, not a warning: we cannot say what fields we are dropping',
)

const apiTooNew = checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: uiProjectDsh({ uiProject: { pluginApiVersion: 2 } }), patchFileExists: true })
equal(codes(apiTooNew).includes(PROBLEM_CODES.UNSUPPORTED_PLUGIN_API), true, 'an unsupported plugin API is refused')

const unknownField = checkUiProjectDeclaration({ name: 'a', version: '1.0.0', dsh: uiProjectDsh({ uiProject: { colour: 'blue' } }), patchFileExists: true })
equal(codes(unknownField), [PROBLEM_CODES.MANIFEST_INVALID], 'an unknown manifest field is fatal rather than silently dropped')
check(unknownField[0].message.includes('colour'), 'and the message names the field')

const duplicateItems = checkUiProjectDeclaration({
  name: 'a',
  version: '1.0.0',
  dsh: uiProjectDsh({
    uiProject: {
      testItems: [
        { id: 'text-readable', label: 'Text is readable' },
        { id: 'text-readable', label: 'Text is readable, again' },
      ],
    },
  }),
  patchFileExists: true,
})
equal(codes(duplicateItems), [PROBLEM_CODES.MANIFEST_INVALID], 'two checklist items sharing an id are refused')
check(duplicateItems[0].message.includes('duplicate'), 'and the message says so, because the ticks are stored per id')

process.stdout.write('\n== the scanner, against real directories ==\n')

const goodProfile = await makeProfile({
  dependencies: { 'dsh-ui-project-skeleton': '^0.1.0', zod: '^3.23.8', 'dsh-orphan-bundle': '^1.0.0' },
  bundles: ['@deepseek-ai/dsh-base', 'dsh-ui-project-skeleton'],
  packages: {
    'dsh-ui-project-skeleton': {
      dsh: uiProjectDsh({ uiProject: { id: 'skeleton', name: 'Skeleton' } }),
      files: { 'cordis.patch.yml': '- insert:\n    - id: ui-project-skeleton\n      name: dsh-ui-project-skeleton\n' },
    },
    zod: { dsh: undefined },
    'dsh-orphan-bundle': { dsh: { bundle: { patch: './cordis.patch.yml' } }, files: { 'cordis.patch.yml': '- insert: []\n' } },
  },
})

const scan = await scanProfile({ profileDir: goodProfile })
equal(scan.dependencies.length, 3, 'every dependency is reported')
equal(scan.dependencies.find((d) => d.name === 'dsh-ui-project-skeleton').kind, 'ui-project', 'a package with dsh.uiProject is a UI project package')
equal(scan.dependencies.find((d) => d.name === 'dsh-ui-project-skeleton').bundled, true, 'and it is composed, because it declares a bundle and is in the layer stack')
equal(scan.dependencies.find((d) => d.name === 'zod').kind, 'library', 'a dependency with no dsh block is a library')
equal(scan.dependencies.find((d) => d.name === 'zod').bundled, false, 'and is not composed')
equal(scan.uiProjectPackages.length, 1, 'exactly one UI project package was found')
equal(scan.uiProjectPackages[0].projectId, 'skeleton', 'with the project id from its manifest')
equal(scan.bundles.inBox, ['@deepseek-ai/dsh-base'], 'a bundle that is not a dependency is in-box (the loader never touches it)')
equal(scan.bundles.fromDependencies, ['dsh-ui-project-skeleton'], 'a bundle that is a dependency came from the profile')
equal(scan.problems, [], 'a complete profile has no problems')
equal(scan.orphanedBindings, ['dsh-orphan-bundle'], 'a dependency that declares a bundle but is missing from the layer stack is an orphaned binding')
check(!scan.orphanedBindings.includes('zod'), 'while a plain library is NOT called an orphan: it never claimed to be a bundle')

const tombstoneProfile = await makeProfile({
  dependencies: { 'dsh-gone': '^1.0.0' },
  bundles: [],
  packages: { '.ignored_dsh-gone': { dsh: uiProjectDsh({ uiProject: { id: 'gone' } }) } },
})
const tombstoneScan = await scanProfile({ profileDir: tombstoneProfile })
equal(tombstoneScan.dependencies[0].resolved, false, 'a package that pnpm moved aside is not installed')
equal(tombstoneScan.uiProjectPackages, [], 'and its tombstone is never mistaken for a UI project package')
equal(codes(tombstoneScan.problems), [PROBLEM_CODES.DEPENDENCY_UNRESOLVED], 'an unresolved dependency is a warning, and only one line')

const unparseableProfile = await makeProfile({ dependencies: {}, writeProfileJson: false })
await writeFile(join(unparseableProfile, 'package.json'), '{ "dependencies": { ', 'utf8')
const unparseableScan = await scanProfile({ profileDir: unparseableProfile })
equal(codes(unparseableScan.problems), [PROBLEM_CODES.PROFILE_MANIFEST_UNPARSEABLE], 'a profile that does not parse is reported, not thrown on')
equal(unparseableScan.problems[0].severity, 'error', 'and it is an error, because nothing can be composed from it')

const badBundlesProfile = await makeProfile({ dependencies: {}, rawProfileJson: JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: 'web' } } }) })
const badBundlesScan = await scanProfile({ profileDir: badBundlesProfile })
equal(codes(badBundlesScan.problems), [PROBLEM_CODES.PROFILE_BUNDLES_INVALID], 'a dsh.profile.bundles that is not an array is reported')

let threw = undefined
try {
  await scanProfile({ profileDir: join(root, 'does-not-exist') })
} catch (error) {
  threw = error
}
equal(threw?.code, 'ENOENT', 'a profile directory with no package.json throws: a wrong PATH is not an empty profile')

process.stdout.write('\n== the command preview ==\n')

equal(
  previewCommand({ action: 'install', profileName: 'web', spec: '@xjl-resources/dsh-plugin-liquid-glass' }).command,
  ['dsh', 'plugin', '--profile', 'web', 'add', '@xjl-resources/dsh-plugin-liquid-glass'],
  'the install preview is the loader invocation, verbatim',
)
equal(
  previewCommand({ action: 'remove', profileName: 'web', packageName: 'dsh-ui-projects' }).command,
  ['dsh', 'plugin', '--profile', 'web', 'remove', 'dsh-ui-projects'],
  'and so is the removal',
)
equal(
  previewCommand({ action: 'update', profileName: 'web', packageName: 'dsh-ui-projects' }).command,
  ['dsh', 'plugin', '--profile', 'web', 'update', 'dsh-ui-projects'],
  'and the update',
)
const linkRollback = previewCommand({ action: 'rollback', profileName: 'web', packageName: 'dsh-ui-projects', spec: 'link:E:/dsh/plugins/dsh-ui-projects', version: '0.1.0' })
equal(linkRollback.command, null, 'a link: dependency has no rollback command')
check(linkRollback.note.includes('link:'), 'and the preview says why, rather than printing a command that would fail')
equal(
  previewCommand({ action: 'rollback', profileName: 'web', packageName: 'dsh-skin', spec: '^1.2.0', version: '1.2.3' }).command,
  ['dsh', 'plugin', '--profile', 'web', 'add', 'dsh-skin@1.2.3'],
  'a published dependency rolls back by asking for the exact version',
)

process.stdout.write('\n== the version store: the layout rule, and the keys ==\n')

/*
 * THE LAYOUT RULE, asserted here because this is the JS half of a pair whose other half is PowerShell.
 *
 * `install.ps1` owns the writing side (`Get-VersionsDirName`) and cannot import this function; a source
 * guard can prove that function's SHAPE but never its behaviour. So the rule is stated once here, in the
 * language that can be executed, and `scripts/verify.mjs` extracts the PowerShell function's text and runs
 * it against this same table — a real parity check rather than a hopeful one.
 */
const LAYOUT_CASES = [
  ['dsh-ui-projects', 'dsh-ui-projects'],
  ['@xjl-resources/dsh-plugin-liquid-glass', '@xjl-resources+dsh-plugin-liquid-glass'],
  ['dsh-cost-meter', 'dsh-cost-meter'],
  ['@scope/name', '@scope+name'],
]
for (const [packageName, dirName] of LAYOUT_CASES) {
  equal(versionsDirNameOf(packageName), dirName, `versionsDirNameOf(${packageName}) is ${dirName}`)
}
const mapped = LAYOUT_CASES.map(([packageName]) => versionsDirNameOf(packageName))
equal(new Set(mapped).size, mapped.length, 'the mapping is injective over these names, so two packages never share one directory')
equal(
  mapped.filter((dir) => /[\\/:*?"<>|]/.test(dir)).length,
  0,
  'and every mapped name is a single legal directory segment — a scoped name would otherwise nest',
)
equal(
  versionsDirNameOf('dsh-ui-projects'),
  'dsh-ui-projects',
  'an unscoped name maps to ITSELF, which is what leaves every snapshot taken before the split in place',
)

/** Write one snapshot into a profile's version store. `package` omitted means "the manifest does not say". */
async function writeSnapshot(profileDir, dirName, snapshot, manifest) {
  const dir = join(profileDir, '.dsh-ui-projects-versions', dirName, snapshot)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        tool: 'install.ps1 -Snapshot',
        name: snapshot,
        version: manifest.version ?? '1.0.0',
        createdAt: manifest.createdAt ?? '2026-09-27T04:47:12.2663764Z',
        payload: { files: 2, bytes: 10 },
        ...(manifest.package === undefined ? {} : { package: manifest.package }),
      },
      null,
      2,
    ),
    'utf8',
  )
}

const scopedName = '@xjl-resources/dsh-plugin-liquid-glass'
const scopedDir = versionsDirNameOf(scopedName)
const storeProfile = await makeProfile({ dependencies: {} })
await writeSnapshot(storeProfile, scopedDir, '1.0.0-20260927T044712Z', { package: scopedName, version: '1.0.0' })
await writeSnapshot(storeProfile, 'wrong-directory-name', '0.1.0-20260927T044712Z', { package: 'dsh-ui-projects', version: '0.1.0' })
await writeSnapshot(storeProfile, 'nobody-claims-this', '9.9.9-20260927T044712Z', {})
const store = await scanProfile({ profileDir: storeProfile })

equal(
  store.versions[scopedName]?.[0]?.name,
  '1.0.0-20260927T044712Z',
  'a scoped package is keyed by its REAL name, taken from the snapshot manifest',
)
equal(
  store.versions[scopedDir],
  undefined,
  'and NOT by the directory it lives in, whose `+` spelling is this project\'s choice rather than the package\'s name',
)
equal(
  store.versions['dsh-ui-projects']?.[0]?.name,
  '0.1.0-20260927T044712Z',
  'the key follows the manifest even when the directory is named something else entirely',
)
equal(
  store.versions['wrong-directory-name'],
  undefined,
  'so a directory name is never echoed back as if it were a package',
)
equal(
  store.versions.unattributed,
  [{ directory: 'nobody-claims-this', snapshots: 1 }],
  'a store directory whose snapshots record no package is REPORTED, not decoded from its directory name',
)
equal(
  store.versions['nobody-claims-this'],
  undefined,
  'and it contributes no key to the map, so nothing can look it up by a name it never claimed',
)
equal(store.versions['never-installed'], undefined, 'a package with no directory is absent — which is not the same as having none recorded')

/*
 * THE OUTLET FOR A DIRECTORY NOBODY CAN ATTRIBUTE.
 *
 * The scan reports such a directory (asserted just above); this is the CLI's half of the promise that a
 * person can SEE it. Asserted by reading the script, because the alternative is running it — a child
 * process whose output would have to be captured — and because what could silently go wrong here is the
 * WIRING (a section that is never printed), not the formatting.
 */
const cliSource = await readFile(join(packageRoot, 'scripts', 'check-installed.mjs'), 'utf8')
check(cliSource.includes('scan.versions?.unattributed'), 'the listing reads the unattributed directories the scan reports')
check(cliSource.includes('UNATTRIBUTED VERSION DIRECTORIES'), 'and prints a section of its own for them')
check(/unattributed\.length > 0/.test(cliSource), 'only when there are any, so a healthy profile gains no section nobody reads')
check(
  cliSource.includes('not decoded') && cliSource.includes('never made'),
  'and says why the directory name is not turned back into a package name',
)

/*
 * AND THE CONTRACT SECTION, for the same reason: what can silently rot is the wiring. Two sections, because
 * the CLI must keep "we looked and found nothing" apart from "we did not look" — a distinction that exists
 * in the payload (`scanned: false` + `reason`) and has to survive into the printed form.
 */
check(cliSource.includes('UI CONTRACT ('), 'the listing prints what the contract scan found')
check(
  cliSource.includes('dependency.contract.findings'),
  'and it reads the findings from the scan rather than re-deriving them',
)
check(cliSource.includes('NOT SCANNED ('), 'and prints the rows nothing was judged for, separately')
check(
  cliSource.includes('dependency.contract.reason'),
  'naming the reason a row was not scanned, so "nothing to scan" cannot read as "clean"',
)
check(
  cliSource.includes('note: ') && cliSource.includes('contract.limits'),
  'and carries the scan’s own limits, so a clean report cannot be read as a clean plugin',
)

/*
 * THE NAME COLUMN OF THE REPORT (56h-1).
 *
 * `padEnd` pads and never truncates, so a column width decided ONCE runs a long name into the field after
 * it: `@xjl-resources/dsh-plugin-example-dialog` is 40 characters and was printed as `…-dialog1.0.0`, and
 * `@xjl-resources/dsh-plugin-liquid-glass` is 38 and was printed as `…liquid-glassno findings`. Both were
 * seen on a real profile and are recorded in `docs/phase2-scope.md` (group B, first item).
 *
 * THE PROPERTY, in one sentence: the second column of a section begins at the same offset in every row of
 * that section, whatever the longest name in it is. The width is therefore asserted against the names and
 * not as a number — with one exception, the floor, which is the promise that a section of short names keeps
 * the layout it has always had instead of buying alignment with blank space no row needs.
 *
 * The wiring is read out of the CLI for the reason the guards above give: what can silently rot is WHICH
 * width a section asks for, and running the report to find out is not available where this tooling runs.
 */
const LONG_NAME = '@xjl-resources/dsh-plugin-example-dialog'
const SHORT_NAME = 'dsh-cost-meter'
equal(LONG_NAME.length > NAME_COLUMN_FLOOR, true, 'the long fixture is a real scoped name, longer than the floor')
equal(
  nameColumnWidth([LONG_NAME]) > LONG_NAME.length,
  true,
  'a section holding a 40-character name is wider than that name, so the next field cannot touch it',
)
equal(
  nameColumnWidth([SHORT_NAME, 'dsh-ui-projects']),
  NAME_COLUMN_FLOOR,
  'a section of short names keeps the column it has always had',
)
const dependencyRows = [LONG_NAME, SHORT_NAME].map(
  (name) => `${pad(name, nameColumnWidth([LONG_NAME, SHORT_NAME]))}${pad('1.0.0', 10)}`,
)
equal(
  dependencyRows[0].indexOf('1.0.0'),
  dependencyRows[1].indexOf('1.0.0'),
  'and the version column starts at the same offset whether the name is 40 characters or 14',
)
check(
  cliSource.includes("from './installed-columns.mjs'"),
  'the report takes its name column from the module this suite can test',
)
check(
  !/pad\([^)]*,\s*34\s*\)/.test(cliSource),
  'and no name column is padded to the written-down 34 that ran long names into the next field',
)
equal(
  (cliSource.match(/nameColumnWidth\(/g) ?? []).length,
  6,
  'each of the report’s six name columns asks for its own width (dependencies, bundles, ui-project packages, the contract rows, the not-scanned rows, the unattributed directories)',
)

process.stdout.write('\n== profile discovery ==\n')

const fakeHome = await mkdtemp(join(root, 'dsh-home-'))
created.push(fakeHome)
await mkdir(join(fakeHome, 'profiles', 'zeta'), { recursive: true })
await mkdir(join(fakeHome, 'profiles', 'alpha'), { recursive: true })
// A directory with no package.json is not a profile — `profiles/node_modules` is the real one that
// taught this suite the difference.
await mkdir(join(fakeHome, 'profiles', 'half-built'), { recursive: true })
await writeFile(join(fakeHome, 'profiles', 'zeta', 'package.json'), '{}', 'utf8')
await writeFile(join(fakeHome, 'profiles', 'alpha', 'package.json'), '{}', 'utf8')
await writeFile(join(fakeHome, 'profiles', 'not-a-profile.txt'), 'x', 'utf8')
equal(
  await discoverProfiles({ dshHome: fakeHome }),
  ['alpha', 'zeta'],
  'profiles are listed by name and sorted; files and directories without a package.json are skipped',
)
equal(await discoverProfiles({ dshHome: join(fakeHome, 'elsewhere') }), [], 'a dsh home that has never run dsh is an empty list, not an error')

process.stdout.write('\n== structural guards ==\n')

/*
 * The property that makes this checker safe to point at a real profile is not visible in its
 * behaviour — it is the ABSENCE of a write path. Reading the sources is the only way to assert it,
 * and the alternative (trusting a comment) is how a "read-only" tool grows a repair mode.
 */
const WRITE_API = /\bwriteFile\b|\bappendFile\b|\bmkdir\b|\brm\(|\brmdir\b|\bunlink\b|\brename\b|\bcopyFile\b|\bcp\(|\btruncate\b|\bcreateWriteStream\b|\bopen\(/
for (const relative of ['src/host/profile-scan.js', 'src/host/conformance.js', 'src/host/manifest-schema.js', 'scripts/check-installed.mjs', 'scripts/installed-columns.mjs']) {
  const source = await readFile(join(packageRoot, relative), 'utf8')
  check(!WRITE_API.test(source), `${relative} contains no write API`)
}

const constants = await readFile(join(packageRoot, 'src', 'client', 'project-constants.js'), 'utf8')
const clientTypes = [...constants.matchAll(/export const TYPE_\w+\s*=\s*'([^']+)'/g)].map((match) => match[1])
equal(
  [...KNOWN_PROJECT_TYPES].sort(),
  [...clientTypes].sort(),
  'the types a package may declare match the vocabulary the client implements (TYPE_* in project-constants.js)',
)

/* ── the UI Contract scanner (step 9a) ──────────────────────────────────────
 *
 * A LAYER: synthetic bundle texts, one claim each. Every case below exists because a real bundle in this
 * workspace does that thing — the case list was written from the syntactic-form inventory the 9a probes
 * measured, not from imagination:
 *
 *   框架 bundle:  `role=` ×11 raw → 0 in code, 4 in strings, 7 in comments; `role: 'switch'` (object
 *                 property, a standard role that is not an overlay role) ×2; `--dsw-alias-*` ×54, all
 *                 inside CSS strings; one `body.appendChild` in code.
 *   皮肤 bundle:  `role=` ×33, all inside CSS selectors; 156 colour literals, every one of them the value
 *                 of a `--*:` declaration — the case that must NOT fire, or the skin becomes the biggest
 *                 "violator" in the workspace.
 *   骨架 bundle:  none of the above.
 */

/** One finding per case, or none — the shape every A-layer case is written against. */
const findingsFor = (text) => scanClientBundle(text).findings
const codesFor = (text) => findingsFor(text).map((finding) => finding.code)

equal(
  codesFor('<div role="dialog">hi</div>'),
  [],
  'a standard overlay role in an HTML string is not a finding',
)
equal(
  codesFor('<div role="custom-dialog">hi</div>'),
  [CONTRACT_CODES.NON_STANDARD_ROLE],
  'a non-standard role in an HTML string is a finding',
)
equal(
  codesFor("const panel = React.createElement('div', { role: 'popover' })"),
  [CONTRACT_CODES.NON_STANDARD_ROLE],
  'and so is one written as an object property, which is how this workspace writes roles',
)
equal(
  codesFor("const css = `[role='custom-dialog'] { color: red }`"),
  [],
  'a role named inside a CSS SELECTOR is not a role assignment — the case the 9a probe got wrong',
)
equal(
  codesFor("React.createElement('button', { role: 'switch' })"),
  [],
  'a standard ARIA role that is not an overlay role is still standard',
)
/*
 * A LABEL IS NOT AN ASSIGNMENT. Found by the first package to consume this scanner: the two-sided
 * example labels its surfaces with the very strings that assign their roles
 * (`title: 'role="custom-dialog"'`), and the first version reported that as a second violation. A role
 * assignment is an object key or a markup attribute; a role quoted inside a display string is neither.
 */
equal(
  codesFor("const title = 'role=\"custom-dialog\"'"),
  [],
  'a display string that merely quotes a role is not an assignment',
)
equal(
  codesFor("element.setAttribute('data-role', 'custom')"),
  [],
  'and a plugin’s own data-role is not an ARIA role at all',
)
/*
 * A LABEL IN THE MIDDLE OF A SENTENCE, which the “not at the string’s start” test above does NOT catch:
 * `'foo role="x" bar'` starts with text, so the prefix before `role` does not end in a quote and the first
 * version of the markup test called it an attribute. The refinement asks the question the label case only
 * approximated — did a TAG start inside this string literal before the `role=`? — and these two cases are
 * the pair that pins it: `'foo …'` has no tag, `'<span>see …'` has a tag that CLOSED again, and neither is
 * an attribute. The case below them is the control that keeps the pair from passing for the wrong reason.
 */
equal(
  codesFor("const label = 'foo role=\"custom-dialog\" bar'"),
  [],
  'a role named inside a label that reads like a sentence is not an assignment either',
)
equal(
  codesFor("const label = '<span>see role=\"custom-dialog\"</span>'"),
  [],
  'and neither is one after a tag that already closed: a string containing markup is not automatically markup',
)
equal(
  codesFor("const node = { title: 'x', role: 'dialog' }"),
  [],
  'a role written as the SECOND property of an object — after a comma rather than a brace — is still an assignment',
)
equal(
  codesFor("const node = { title: 'x', role: 'custom' }"),
  [CONTRACT_CODES.NON_STANDARD_ROLE],
  'and that is what makes the case above mean something: the same shape with a non-standard role IS reported',
)
equal(
  scanClientBundle('const node = { role: name }').limits.some((limit) => limit.includes('computed value')),
  true,
  'while a role whose value is a variable is COUNTED rather than judged, and the count travels in the limits',
)
equal(
  codesFor('const x = 1; /* role="custom-dialog" and attachShadow({ mode: "closed" }) */'),
  [],
  'a violation written in a comment is not a violation: comments were 7 of the framework’s 11 raw hits',
)
equal(
  codesFor('.card { background: #ffffff; }'),
  [CONTRACT_CODES.HARD_CODED_COLOUR],
  'a colour literal in a rule declaration is a finding',
)
equal(
  codesFor(':root { --lg-glass-bg-light: #ffffff; }'),
  [],
  'the same literal as a custom-property DECLARATION is not — the case that keeps a skin innocent',
)
/*
 * THE FALLBACK CASE, found by running this scanner against a real third-party plugin rather than by
 * imagining one: `dsh-cost-meter` writes `var(--dsw-alias-bg-hover, rgba(127,127,127,.08))`, and the first
 * version of the tokens rule reported five of those. A plugin that reads a token and names a fallback is
 * DOING the contract, so the fallback half of a `var()` is exempt — while a literal anywhere else in the
 * same value is still a violation, which the case below pins.
 */
equal(
  codesFor('.pill { border-top: 3px solid var(--dsw-alias-state-info-primary, #3b82f6); }'),
  [],
  'a literal as the FALLBACK of a token is not a violation: the plugin is reading the token',
)
equal(
  codesFor('.pill { background: #ff9800; border-color: var(--dsw-alias-bg-layer-1, #34a853); }'),
  [CONTRACT_CODES.HARD_CODED_COLOUR],
  'while a bare literal beside it still is — but only the bare one is reported',
)
equal(
  codesFor('el.attachShadow({ mode: "closed" })'),
  [CONTRACT_CODES.CLOSED_SHADOW_ROOT],
  'a closed shadow root is a finding',
)
equal(
  codesFor('el.attachShadow({ mode: "open" })'),
  [],
  'an open one is not: a skin’s selectors reach through it',
)
equal(
  findingsFor('const a = 1\n<div role="custom-dialog">\n.card { background: #fff; }\n').map((f) => `${f.rule}:${f.evidence.line}`),
  [`${CONTRACT_RULES.ROLE}:2`, `${CONTRACT_RULES.TOKENS}:3`],
  'and findings are reported in source order, with the line they came from',
)

/*
 * THE THREE-VIOLATION CASE is where the SORT is pinned: `(line, rule, code)`, so two findings on one line
 * come out in a stable order that a dictionary or a Set would not guarantee.
 */
const threeViolations = scanClientBundle(
  ['const a = 1', '<div role="custom-dialog">', 'el.attachShadow({mode:"closed"})', '.x { color: #123456 }'].join('\n'),
)
equal(
  threeViolations.findings.map((finding) => finding.code),
  [CONTRACT_CODES.NON_STANDARD_ROLE, CONTRACT_CODES.CLOSED_SHADOW_ROOT, CONTRACT_CODES.HARD_CODED_COLOUR],
  'a bundle with three violations reports exactly three, in (line, rule, code) order',
)
equal(
  [...new Set(threeViolations.findings.map((finding) => finding.severity))],
  ['warning'],
  'every finding is advice rather than a refusal: the contract is not a gate',
)

/*
 * The standard-role list is hardcoded, so its SIZE is pinned: an edit to it is visible in the count.
 * 94 = the 82 non-abstract roles of WAI-ARIA 1.2 §5.3.2–5.3.4 plus the 12 abstract roles of §5.3.1, which
 * are accepted on purpose: this scanner reports a role it cannot RECOGNISE, and `role="widget"` is a real
 * WAI-ARIA role. Source and version are in `contract-scan.js`'s header.
 */
equal(
  WAI_ARIA_ROLES.size,
  94,
  'the hardcoded WAI-ARIA list is the 1.2 set: 82 non-abstract roles plus 12 abstract (and this count guards an edit)',
)
check(
  ['dialog', 'menu', 'listbox', 'tooltip', 'switch', 'alertdialog', 'gridcell'].every((role) => WAI_ARIA_ROLES.has(role)),
  'and it contains the roles the contract names, plus standard roles that are not overlays',
)
check(
  ['custom-dialog', 'popover', 'my-thing', ''].every((role) => WAI_ARIA_ROLES.has(role) === false),
  'while the non-standard names in this project’s own vocabulary are absent from it',
)
equal(
  CONTRACT_LIMITS.length >= 3 && CONTRACT_LIMITS[0].includes('rule 3'),
  true,
  'and the standing limits travel with every result, starting with the rule this scanner cannot see',
)

/* ── B LAYER: the three bundles in this workspace, as a SNAPSHOT ─────────────
 *
 * THESE ARE SNAPSHOTS OF A STATE, NOT PERMANENT GUARANTEES, and the labels say so.
 *
 * A static scanner can only be shown to be right about the text in front of it, and this text is this
 * workspace's own build output. When one of these numbers moves, the question is not "who broke the
 * test" but "did a real violation appear, or did the scanner get worse" — and the answer is whichever
 * `git log` explains. The day the framework's own bundle gains `role="custom-dialog"`, this layer SHOULD
 * go red: that is a true finding about a real file.
 *
 * The skin's entry is the load-bearing one. It ships 156 colour literals in its bundle and every one of
 * them is the value of a `--*:` declaration; if a future refinement of the tokens rule loses that
 * exemption, this is the assertion that says so.
 *
 * THE FRAMEWORK'S TWO ARE ACCEPTED FINDINGS, NOT FALSE POSITIVES, and the count is 2 for that reason:
 * `styles/core.css`'s `.uip-previewGlass` — the placeholder swatch the settings card draws when a project
 * declares no preview — writes `border: 1px solid rgb(255 255 255 / 45%)` and
 * `background: rgb(255 255 255 / 32%)`. By the contract as written (rule 2: colour belongs in a
 * `--dsw-alias-*` token, the example being `background: #ffffff`) those ARE hard-coded colours. Changing
 * them would move the preview's visual, which is out of scope for this round, so they are recorded here
 * instead of being quietly narrowed out of the rule.
 *
 * THREE OR MORE IS A NEW VIOLATION AND MUST BE DEALT WITH — the equality below goes red there, and the
 * assertion after the loop goes red if the pair ever becomes a DIFFERENT pair with the same count.
 * If a later round edits `core.css` and these excerpts change (a literal added, or the values moved into
 * tokens), that red is GOOD NEWS: it means the framework's contract surface moved and the decision should
 * be taken again rather than inherited.
 *
 * The rule's boundary is visible in that same CSS rule: `box-shadow: 0 6px 18px rgb(15 23 42 / 18%)` on the
 * next line is NOT reported, because decoration a plugin may legitimately author is out of scope by design.
 */
/** @type {Map<string, Array<{ code: string, evidence: { line: number, excerpt: string } }>>} */
const findingsByBundle = new Map()
for (const [name, relative, expected] of [
  ['the framework', 'dsh-ui-projects', 2],
  ['the skin', 'dsh-plugin-liquid-glass', 0],
  ['the skeleton', 'dsh-ui-project-skeleton', 0],
]) {
  const bundlePath = resolve(packageRoot, '..', relative, 'lib', 'client.js')
  let text = null
  try {
    text = await readFile(bundlePath, 'utf8')
  } catch {
    text = null
  }
  check(text !== null, `SNAPSHOT: ${name}’s bundle is readable, so the baseline below means something (${relative})`)
  if (text !== null) {
    const found = scanClientBundle(text).findings
    findingsByBundle.set(name, found)
    equal(
      found.length,
      expected,
      `SNAPSHOT: ${name}’s bundle has ${expected} contract findings today (${relative}/lib/client.js, ${text.length} chars, got ${JSON.stringify(found)})`,
    )
  }
}

/*
 * THE COUNT IS NOT ENOUGH: the framework's two must be the two that were ACCEPTED, by code AND by the
 * declaration they came from. Two different findings with the same count would satisfy the loop above and
 * would leave the acceptance note describing a rule that no longer trips — the kind of green that hides a
 * change. When this goes red after an edit to `core.css`, read the excerpts before touching the baseline:
 * a value moved into a token is an improvement (update the note), a new literal is a new violation.
 */
equal(
  (findingsByBundle.get('the framework') ?? []).map((finding) => `${finding.code} :: ${finding.evidence.excerpt}`),
  [
    `${CONTRACT_CODES.HARD_CODED_COLOUR} :: border: 1px solid rgb(255 255 255 / 45%)`,
    `${CONTRACT_CODES.HARD_CODED_COLOUR} :: background: rgb(255 255 255 / 32%)`,
  ],
  'SNAPSHOT: and the framework’s two are EXACTLY the accepted ones — a different pair with the same count is a new finding, not a baseline',
)

/* ── the scan reaches the listing, through the real profile scanner ──────────
 *
 * The A layer calls `scanClientBundle` directly; this layer drives `scanProfile` against a fixture
 * profile, which is the path a listing actually takes. Two claims, and the second one is the reason the
 * section exists: a row that was NOT judged must be distinguishable from a row that was judged clean —
 * through a JSON round trip, because that is how it reaches the page.
 */
process.stdout.write('\n== the contract scan through the profile scanner ==\n')

const guardedProfile = await makeProfile({
  dependencies: {
    'a-skin': 'link:./a-skin',
    'an-enhancement': 'link:./an-enhancement',
    'just-a-library': '^1.0.0',
    'huge-bundle': 'link:./huge-bundle',
  },
  bundles: ['a-skin', 'an-enhancement'],
  packages: {
    'a-skin': {
      dsh: uiProjectDsh(),
      files: {
        'lib/client.js': 'const a = 1\n<div role="custom-dialog">\n.card { background: #ffffff; }\n',
      },
    },
    /*
     * A PACKAGE THAT DECLARES A BUNDLE PATCH *AND* A CLIENT HALF — the shape every real plugin here has
     * (`dsh-cost-meter` and this framework both do), and the one the first version of the predicate
     * skipped: `kind` reports `bundle` for it, because it answers "what is this row in the listing", not
     * "does anything of it run in the page". The subject of the scan is `dsh.client`.
     */
    'an-enhancement': {
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
      files: {
        'cordis.patch.yml': '- insert:\n    - id: x\n      name: an-enhancement\n',
        'lib/client.js': 'const clean = { role: "dialog", colour: "var(--dsw-alias-bg-layer-1)" }\n',
      },
    },
    'just-a-library': { dsh: {}, files: { 'index.js': 'module.exports = 1\n' } },
    'huge-bundle': {
      dsh: { client: { platform: 'web' } },
      files: { 'lib/client.js': ' '.repeat(4 * 1024 * 1024 + 1) },
    },
  },
})
const guarded = await scanProfile({ profileDir: guardedProfile })
const byName = (name) => guarded.dependencies.find((dependency) => dependency.name === name)

equal(
  byName('a-skin')?.kind,
  'ui-project',
  'the fixture is a UI project package, which is the kind the scan is for',
)
equal(
  byName('a-skin')?.contract.findings.map((finding) => finding.code),
  [CONTRACT_CODES.NON_STANDARD_ROLE, CONTRACT_CODES.HARD_CODED_COLOUR],
  'and the scanner’s findings arrive on the scan, in source order',
)
equal(byName('a-skin')?.contract.scanned, true, 'with the row marked as judged')
equal(byName('a-skin')?.contract.reason, null, 'and no reason attached, because there was nothing to explain')
check(byName('a-skin')?.contract.bytes > 0, 'and the size it read, so a report can say what it looked at')
check(
  (byName('a-skin')?.contract.limits ?? []).some((limit) => limit.includes('rule 3')),
  'and the limits travel with the row, so the page can say what was NOT judged',
)
/*
 * THE COVERAGE NUMBERS ARE THE INSTRUMENT'S, NOT THE BUNDLE'S, so they are on every row — including the
 * rows nobody read, where the column must NOT print them (see the client's own case). The judged count is
 * asserted against the module's export rather than against `3`, so adding a rule to the scanner cannot
 * leave a stale number on the page; the total is pinned, because it changes when the CONTRACT changes.
 */
equal(
  [byName('a-skin')?.contract.rules, byName('just-a-library')?.contract.rules],
  [
    { judged: CONTRACT_RULES_JUDGED, total: CONTRACT_RULE_COUNT },
    { judged: CONTRACT_RULES_JUDGED, total: CONTRACT_RULE_COUNT },
  ],
  'every row, judged or not, carries the rule counts the column needs to say how much was covered',
)
equal(
  [CONTRACT_RULES_JUDGED, CONTRACT_RULE_COUNT],
  [3, 4],
  'three of the contract’s four rules are decidable by reading a bundle, and the fourth (rule 3) is the runtime one',
)
equal(
  byName('an-enhancement')?.kind,
  'bundle',
  'the second fixture reports the kind that made the first predicate skip it',
)
equal(
  byName('an-enhancement')?.contract.scanned,
  true,
  'and it is scanned anyway, because the subject is dsh.client and not the kind',
)
equal(
  byName('an-enhancement')?.contract.findings.length,
  0,
  'a client half with a standard role and a token is scanned and clean',
)
equal(
  byName('just-a-library')?.contract.scanned,
  false,
  'a package with no client half is not scanned at all',
)
check(
  String(byName('just-a-library')?.contract.reason).includes('dsh.client'),
  'and says why, so “nothing to scan” cannot be read as “clean”',
)
equal(
  byName('huge-bundle')?.contract.scanned,
  false,
  'a bundle over the scan cap is refused rather than read',
)
check(
  String(byName('huge-bundle')?.contract.reason).includes('scan cap'),
  'with the size in the reason, so the cap is visible rather than mysterious',
)

/*
 * EVERY ROW CARRIES THE FIELD, and `reason` survives JSON — which is the whole reason it is `null` instead
 * of `undefined`: `JSON.stringify` drops an undefined property, and the column would then have to guess
 * whether the host is old or the answer is "nothing to scan".
 */
const wire = JSON.parse(JSON.stringify(guarded.dependencies.map((dependency) => dependency.contract)))
equal(
  wire.every((contract) => contract !== undefined && Object.hasOwn(contract, 'reason')),
  true,
  'every dependency carries a contract object, and every one of them has `reason` after a JSON round trip',
)
equal(
  wire.filter((contract) => contract.scanned === false).every((contract) => typeof contract.reason === 'string'),
  true,
  'and every row that was not judged names a reason in words',
)

await rm(root, { recursive: true, force: true })
process.stdout.write(failed === 0 ? `\n${passed} assertions, 0 failing\n` : `\n${passed} assertions, ${failed} failing\n`)
process.exitCode = failed === 0 ? 0 : 1
