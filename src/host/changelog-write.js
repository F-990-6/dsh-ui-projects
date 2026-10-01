/**
 * THE ONLY MODULE IN THIS PLUGIN THAT WRITES A FILE (`UI第三阶段.txt:59-69`).
 *
 * Everything else produces data: `changelog-draft.js` classifies and suggests, `test-checklist.js` records
 * what a person confirmed, `profile-scan.js` reads profiles and is forbidden — by its own header and by an
 * assertion that scans the whole host directory — from ever writing anything. This file is the single
 * exception to that rule, which is why it is separate, small, and easy to point at when someone asks
 * "what may this plugin change on disk?".
 *
 * WHAT IT WRITES, EXACTLY TWO FILES, AND BY APPENDING:
 *   · `CHANGELOG.md` — a version-based section is APPENDED to whatever is already there. The older
 *     round-based sections stay; nothing is rewritten, reordered or deleted.
 *   · `package.json` — only `version` changes. Every other field is carried through untouched.
 *
 * WHAT IT NEVER DOES: it does not commit, does not publish, does not run a command of any kind, and does
 * not know where the harness home directory lives. Those are the user's acts and the user's paths, and the
 * suite asserts their absence from this file's source rather than trusting this paragraph.
 *
 * THE GATE IS HERE, WHERE THE WRITING HAPPENS. `checklistRecord` must satisfy `isComplete` — the same
 * strictly-`true` judgement the panel's checklist uses (`test-checklist.js`). A button that merely looks
 * disabled would not be a gate at all: this function is the only writer, so its refusal is the rule.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { renderVersionSection } from './changelog-draft.js'
import { isComplete, missingItems } from './test-checklist.js'

/** The changelog this writes into, relative to the package directory it is given. */
const CHANGELOG_FILE = 'CHANGELOG.md'

/** The manifest whose `version` this updates, relative to the same directory. */
const MANIFEST_FILE = 'package.json'

/**
 * Append one version-based section to a package's changelog and set its manifest version.
 *
 * REFUSES an unconfirmed checklist: the refusal names the missing items, because "you have not finished
 * the checklist" is only actionable when it says which items are left.
 *
 * A MISSING `CHANGELOG.md` IS NOT AN ERROR: a package that has never had one gets a new file with just the
 * heading the renderer produces, which is what a first release looks like.
 * @param {{ packageDir: string, version: string, date?: string | null, entries: Array<{ category: string, text: string }>, checklistRecord?: Record<string, unknown> | null }} input
 * @returns {Promise<{ changelog: string, manifest: string, version: string }>} the two files it wrote
 * @throws {TypeError} when the checklist is incomplete
 */
export async function writeChangelog({ packageDir, version, date, entries, checklistRecord }) {
  if (!isComplete(checklistRecord)) {
    const missing = missingItems(checklistRecord)
    throw new TypeError(
      `[dsh-ui-projects] refusing to write a changelog for ${String(version)}: the checklist is incomplete — ` +
        `${missing.length} item(s) not confirmed (${missing.join(', ')})`,
    )
  }
  if (typeof packageDir !== 'string' || packageDir.length === 0) {
    throw new TypeError('[dsh-ui-projects] writeChangelog needs the package directory to write into')
  }

  const changelogPath = join(packageDir, CHANGELOG_FILE)
  const manifestPath = join(packageDir, MANIFEST_FILE)

  /*
   * APPEND, NEVER REWRITE. A read that fails (no changelog yet) is an empty history rather than an error —
   * and the section is written with a blank line between it and whatever came before, so the file stays
   * readable whatever shape the previous author left it in.
   */
  const previous = await readFile(changelogPath, 'utf8').catch(() => '')
  const section = renderVersionSection({ version, date, entries })
  const spacer = previous.length === 0 || previous.endsWith('\n\n') ? '' : previous.endsWith('\n') ? '\n' : '\n\n'
  await writeFile(changelogPath, previous + spacer + section, 'utf8')

  /*
   * THE MANIFEST: `version` is the only field this touches. Parsing it strictly on purpose — a manifest
   * that does not parse is a fact the caller has to see, not something to paper over with a fresh object
   * that would silently drop every other field.
   */
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.version = version
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  return { changelog: changelogPath, manifest: manifestPath, version }
}
