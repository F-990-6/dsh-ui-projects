/**
 * A package's CHANGELOG, read for one row of Settings › UI plugins.
 *
 * WHY THE HOST READS IT. The CHANGELOG is the only field §五 asks for that has real CONTENT behind it
 * — the framework's own file is 284 KB — and the page cannot see a package directory at all: the
 * listing deliberately sends identity, composition state and problems, and never a path. So the
 * reading happens here, on demand, for one package at a time.
 *
 * THE RULES ARE `install.ps1`'s, and they are copied rather than reinvented, because the CLI already
 * prints these sections and two implementations of "which section is newest" would drift:
 *
 *   section start   a line matching `^##\s` — `###` does NOT start a section
 *   order           the file is newest-first, and the newest N sections are taken (N defaults to 1)
 *   cap             a section is at most 40 lines INCLUDING its heading, and the arithmetic counts
 *                   that heading: a heading plus 59 body lines is 60 lines, so 40 are kept and the
 *                   reader is told 20 were dropped
 *
 * The one deliberate difference: `install.ps1` prints the "… N more line(s)" sentence itself, while
 * this module reports `truncated`/`moreLines` as FACTS and the page renders the sentence from its own
 * dictionary. The CLI speaks English only; the settings page is bilingual, and a sentence assembled on
 * the host could not be translated there.
 *
 * The caller decides where a path comes from. Nothing in this module may be reached with a name from a
 * query string: the endpoint looks the name up in a scan and passes the entry's own resolved directory
 * (`installed-endpoint.js`, `createChangelogHandler`).
 */

import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** The file every package is asked for, by the name `install.ps1 -Snapshot` also records. */
export const CHANGELOG_FILE = 'CHANGELOG.md'

/** The most a changelog may be before the reader refuses it. The workspace's largest is 284 KB. */
export const CHANGELOG_MAX_BYTES = 1024 * 1024

/**
 * How much of a file the LISTING reads to find its newest heading.
 *
 * A folded row should name the section it will show, and asking the endpoint for every row would be
 * one request per package on every page open — the cost the on-demand design exists to avoid. So the
 * scan reads a bounded head instead: 64 KB is far more than any changelog's preamble, and the read is
 * capped rather than trusting a package not to ship a 40 MB file.
 */
export const CHANGELOG_HEAD_BYTES = 64 * 1024

/** One section's cap, heading included — `install.ps1`'s `$cap`. */
export const CHANGELOG_SECTION_LINES = 40

/** How many sections the page shows — `install.ps1`'s `$Changes`, whose default is one. */
export const CHANGELOG_SECTIONS = 1

/**
 * Every answer that is not a section list.
 *
 * Four of them are facts about the package (`no-file`, `no-sections`, `too-large`, `unreadable`) and
 * one is a fact about the REQUEST (`not-installed`: the name is not in this profile, which is also the
 * answer a path-traversal attempt gets). The page renders a sentence per code, because the same
 * absence needs different words depending on why it is absent.
 */
export const CHANGELOG_REASONS = Object.freeze({
  notInstalled: 'not-installed',
  noFile: 'no-file',
  noSections: 'no-sections',
  tooLarge: 'too-large',
  unreadable: 'unreadable',
})

/** A section start, and only that: `###` is a sub-heading inside one. */
const HEADING = /^##\s/

/**
 * The lines of a file, with line endings normalised.
 *
 * `\r` is dropped from every line rather than only at the end of the file: a CRLF file read on
 * Windows would otherwise put a carriage return into the rendered `<pre>` of every line, which shows
 * up as a stray box in some fonts and as nothing at all in others.
 * @param {unknown} text
 * @returns {string[]}
 */
function linesOf(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/**
 * The first section heading in a file, or `null`.
 *
 * The listing's half of the story: one line, on every row, without a request.
 * @param {unknown} text
 * @returns {string | null}
 */
export function firstHeadingOf(text) {
  for (const line of linesOf(text)) if (HEADING.test(line)) return line
  return null
}

/**
 * The newest sections of a changelog, capped the way the CLI caps them.
 *
 * A trailing newline is not a line: `'## A\nx\n'` has two lines, not three, and the CLI's own reader
 * agrees (it splits on line endings, not on a final empty string).
 * @param {unknown} text
 * @param {{ maxSections?: number, maxLines?: number }} [options]
 * @returns {{ sections: Array<{ heading: string, lines: string[], truncated: boolean, moreLines: number }>, reason: string | null }}
 */
export function summarizeChangelog(text, options = {}) {
  const maxSections = options.maxSections ?? CHANGELOG_SECTIONS
  const maxLines = options.maxLines ?? CHANGELOG_SECTION_LINES
  const all = linesOf(text)
  if (all.length > 0 && all[all.length - 1] === '') all.pop()

  const starts = []
  for (let index = 0; index < all.length; index += 1) if (HEADING.test(all[index])) starts.push(index)
  if (starts.length === 0) return { sections: [], reason: CHANGELOG_REASONS.noSections }

  const sections = []
  for (let at = 0; at < Math.min(maxSections, starts.length); at += 1) {
    const from = starts[at]
    const to = at + 1 < starts.length ? starts[at + 1] : all.length
    const body = all.slice(from, to)
    const truncated = body.length > maxLines
    const kept = truncated ? body.slice(0, maxLines) : body
    sections.push({
      heading: kept[0],
      lines: kept.slice(1),
      truncated,
      moreLines: truncated ? body.length - maxLines : 0,
    })
  }
  return { sections, reason: null }
}

/**
 * One package directory's changelog, or the reason there is none.
 *
 * `stat` BEFORE `read`, so an oversized file is refused without being loaded: the cap exists to keep a
 * careless or hostile package from turning one row into a memory spike, and reading it first would
 * defeat exactly that.
 *
 * `ok: false` with a reason rather than a throw, because every one of these outcomes is a sentence the
 * row can show; the only throw left is one a caller cannot act on, and the endpoint catches that too.
 * @param {string} dir the package's own resolved directory
 * @returns {Promise<{ ok: true, text: string } | { ok: false, reason: string, detail: string | null }>}
 */
export async function readChangelogAt(dir) {
  const path = join(dir, CHANGELOG_FILE)
  let info
  try {
    info = await stat(path)
  } catch (error) {
    /*
     * ENOENT is "this package ships no changelog", which is a fact about the package. Anything else —
     * a permission problem, a broken symlink, a directory that is not there any more — is a fact about
     * the READ, and reporting it as "no changelog" would send a reader looking for the wrong thing.
     */
    const missing = error?.code === 'ENOENT'
    return {
      ok: false,
      reason: missing ? CHANGELOG_REASONS.noFile : CHANGELOG_REASONS.unreadable,
      detail: missing ? null : String(error?.message ?? error),
    }
  }
  if (!info.isFile()) return { ok: false, reason: CHANGELOG_REASONS.noFile, detail: null }
  if (info.size > CHANGELOG_MAX_BYTES) {
    return {
      ok: false,
      reason: CHANGELOG_REASONS.tooLarge,
      detail: `${info.size} bytes, over the ${CHANGELOG_MAX_BYTES}-byte cap`,
    }
  }
  try {
    return { ok: true, text: await readFile(path, 'utf8') }
  } catch (error) {
    return { ok: false, reason: CHANGELOG_REASONS.unreadable, detail: String(error?.message ?? error) }
  }
}

/**
 * The first heading of a package's changelog, read from a bounded head of the file.
 *
 * THE PARTIAL LINE IS DROPPED when the cap was reached, and that is the whole subtlety: the 64 KB cut
 * can land in the middle of a line, and a half-line that happens to begin with `## ` would be reported
 * as a heading that does not exist. Reading the whole file instead would remove the subtlety at the
 * cost of the read this function exists to avoid, and the field it feeds is a folded row's summary
 * rather than a claim about the file.
 *
 * Every failure is `null`: this is a listing field, and a package with an unreadable changelog must not
 * be able to fail the listing that describes it.
 * @param {string} dir
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function readFirstHeading(dir, options = {}) {
  const maxBytes = options.maxBytes ?? CHANGELOG_HEAD_BYTES
  let handle
  try {
    handle = await open(join(dir, CHANGELOG_FILE), 'r')
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    const text = buffer.toString('utf8', 0, bytesRead)
    const complete = bytesRead < maxBytes ? text : text.slice(0, Math.max(0, text.lastIndexOf('\n')))
    return firstHeadingOf(complete)
  } catch {
    return null
  } finally {
    // Released whatever happened: a listing walks every dependency, and a leaked handle per package
    // would exhaust the process on a profile with a few hundred of them.
    await handle?.close?.()
  }
}
