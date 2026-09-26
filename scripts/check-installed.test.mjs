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
import { discoverProfiles, previewCommand, scanProfile } from '../src/host/profile-scan.js'

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
for (const relative of ['src/host/profile-scan.js', 'src/host/conformance.js', 'src/host/manifest-schema.js', 'scripts/check-installed.mjs']) {
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

await rm(root, { recursive: true, force: true })
process.stdout.write(failed === 0 ? `\n${passed} assertions, 0 failing\n` : `\n${passed} assertions, ${failed} failing\n`)
process.exitCode = failed === 0 ? 0 : 1
