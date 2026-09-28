/**
 * Unregister a dsh UI plugin package from a profile, reversibly.
 *
 * Removes the two places the profile names the plugin — `dsh.profile.bundles` and `dependencies` —
 * and backs both files up first, because this edits a live profile outside the workspace and getting
 * it wrong would leave dsh unable to start.
 *
 * Usage:
 *   node scripts/unregister-profile.mjs --check    show what would change
 *   node scripts/unregister-profile.mjs            back up, then change
 *   node scripts/unregister-profile.mjs --restore  put the newest backup back
 *
 * Flags:
 *   --package <name>      which package to unregister (default dsh-ui-projects)
 *   --profile <name>      profile name under $DSH_HOME/profiles (default web)
 *   --profile-dir <dir>   the profile directory itself, when it is not under $DSH_HOME
 */
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)

/**
 * One flag's value, or the fallback.
 *
 * A flag written without a value is a usage error rather than an empty string: `--package --check` would
 * otherwise unregister a package literally named `--check`, and the profile would be edited to say so.
 * @param {string} name @param {string} fallback
 */
function flag(name, fallback) {
  const at = argv.indexOf(name)
  if (at < 0) return fallback
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`${name} needs a value\n`)
    process.exit(2)
  }
  return value
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = resolve(flag('--profile-dir', join(dshHome, 'profiles', flag('--profile', 'web'))))
const PACKAGE = join(PROFILE, 'package.json')
const PLUGIN = flag('--package', 'dsh-ui-projects')
const mode = argv.includes('--check') ? 'check' : argv.includes('--restore') ? 'restore' : 'apply'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

if (mode === 'restore') {
  const backups = (await readdir(PROFILE)).filter((name) => name.startsWith('package.json.bak-')).sort()
  const newest = backups.at(-1)
  if (newest === undefined) {
    process.stdout.write('no backup found; nothing restored\n')
    process.exitCode = 1
  } else {
    await copyFile(join(PROFILE, newest), PACKAGE)
    process.stdout.write(`restored package.json from ${newest}\n`)
  }
} else {
  const before = await readFile(PACKAGE, 'utf8')
  const parsed = JSON.parse(before)
  process.stdout.write(`before:\n  bundles:      ${JSON.stringify(parsed.dsh?.profile?.bundles ?? [])}\n`)

  const bundles = (parsed.dsh?.profile?.bundles ?? []).filter((name) => name !== PLUGIN)
  const dependencies = { ...(parsed.dependencies ?? {}) }
  delete dependencies[PLUGIN]
  const after = { ...parsed, dependencies, dsh: { ...parsed.dsh, profile: { ...parsed.dsh?.profile, bundles } } }
  const text = `${JSON.stringify(after, null, 2)}\n`

  process.stdout.write(`after:\n  bundles:      ${JSON.stringify(bundles)}\n`)
  process.stdout.write(`  dependencies: ${JSON.stringify(Object.keys(dependencies))}\n`)

  if (mode === 'check') {
    process.stdout.write('\ncheck only; nothing written\n')
  } else {
    await copyFile(PACKAGE, join(PROFILE, `package.json.bak-${stamp}`))
    await writeFile(PACKAGE, text, 'utf8')
    process.stdout.write(`\nbacked up package.json.bak-${stamp} and wrote the new one\n`)
    process.stdout.write('restart dsh web for this to take effect\n')
  }
}
