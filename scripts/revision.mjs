/**
 * Confirm the built bundle's revision hash, and that named fixes are present in it.
 *
 * The browser caches a plugin revision, so "the fix did not work" and "the fix is not loaded" look
 * identical from a screenshot — an ambiguity that has cost several rounds. This prints the hash the
 * host will serve, so a page can be compared against it: the diagnostics overlay reports its own
 * `run` string, and if that does not match here, the page is running stale code.
 *
 * Usage: node scripts/revision.mjs [needle ...]
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const file = join(packageRoot, 'lib', 'client.js')
const text = await readFile(file, 'utf8')

const sha = createHash('sha256').update(text).digest('hex').slice(0, 12)
process.stdout.write(`lib/client.js  ${text.length} bytes  sha256:${sha}\n`)

/** The revision the diagnostics overlay reports for itself. */
const run = /run:\s*'([^']+)'/.exec(text)
process.stdout.write(`diagnostics run id: ${run === null ? '(not found)' : run[1]}\n\n`)

const needles = process.argv.slice(2)
if (needles.length === 0) {
  process.stdout.write('pass needles to confirm specific fixes:\n')
  process.stdout.write('  node scripts/revision.mjs VOzbGW_panel "position: fixed" .cm-root\n')
} else {
  for (const needle of needles) {
    const count = text.split(needle).length - 1
    process.stdout.write(`  ${count > 0 ? 'present' : 'MISSING'}  ${needle} (${count})\n`)
  }
}
