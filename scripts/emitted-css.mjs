/**
 * Print the rules a project's stylesheets emit, as the browser receives them.
 *
 * Assertions test properties; this shows the actual text. Every silent failure in this package
 * was a rule that looked right in the source and did something else once scoped — a marker on a
 * descendant instead of the element itself, a branch of a selector list left unscoped, a
 * `:where()` wrapper quietly conceding a specificity fight. Reading the output settles those in
 * one glance, which is why this exists next to `scope-peek.mjs`.
 *
 * Usage: node scripts/emitted-css.mjs [substring ...]
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scopeCss } from '../src/client/scope-css.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const marker = 'body[data-ui-project-liquid-glass="on"]'
const filters = process.argv.slice(2)

/** The stylesheets a project contributes, in the order `apply` inserts them. */
const files = ['tokens.css', 'glass.css']

for (const file of files) {
  const raw = await readFile(join(packageRoot, 'src', 'client', 'projects', 'liquid-glass', file), 'utf8')
  const scoped = scopeCss(marker, raw)
  const blocks = scoped.split('\n').filter((line) => line.trim().length > 0)

  process.stdout.write(`\n══ ${file} ══\n`)
  for (const line of blocks) {
    if (line.trimStart().startsWith('/*') || line.trimStart().startsWith('*')) continue
    if (filters.length > 0 && !filters.some((needle) => line.includes(needle))) continue
    process.stdout.write(`${line}\n`)
  }
}
