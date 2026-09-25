/**
 * Unregister dsh-ui-projects from the web profile, reversibly.
 *
 * Removes the two places the profile names the plugin — `dsh.profile.bundles` and `dependencies` —
 * and backs both files up first, because this edits a live profile outside the workspace and getting
 * it wrong would leave dsh unable to start.
 *
 * Usage:
 *   node scripts/unregister-profile.mjs --check    show what would change
 *   node scripts/unregister-profile.mjs            back up, then change
 *   node scripts/unregister-profile.mjs --restore  put the newest backup back
 */
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PROFILE = 'C:/Users/19103/.dsh/profiles/web'
const PACKAGE = join(PROFILE, 'package.json')
const PLUGIN = 'dsh-ui-projects'
const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--restore') ? 'restore' : 'apply'
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
