/**
 * Print the rules for a set of selectors from a stylesheet.
 *
 * Reading a stylesheet by eye is how a wrong value survives review: `grid-template-columns: 116px
 * minmax(0, 1fr)` looks reasonable in isolation and squeezes a card into a vertical-text strip when
 * its container is narrower than the first track. Printing one selector's declarations at a time
 * makes the arithmetic visible.
 *
 * Usage: node scripts/css-peek.mjs <file> [selector ...]
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const file = resolve(process.argv[2] ?? 'src/client/styles/core.css')
const wanted = process.argv.slice(3)
const css = await readFile(file, 'utf8')

/**
 * Every rule whose selector mentions one of the wanted fragments.
 * A deliberately simple scan: this file's own CSS is flat, with no nesting to untangle.
 * @param {string} needle
 */
function rules(needle) {
  const found = []
  const pattern = new RegExp(`([^{}]*${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{}]*)\\{([^}]*)\\}`, 'g')
  for (const match of css.matchAll(pattern)) {
    found.push({ selector: match[1].trim(), body: match[2].trim() })
  }
  return found
}

if (wanted.length === 0) {
  process.stdout.write('pass selector fragments, e.g. node scripts/css-peek.mjs src/client/styles/core.css uip-card uip-preview\n')
  process.exit(0)
}

for (const needle of wanted) {
  process.stdout.write(`══ ${needle}\n`)
  const found = rules(needle)
  if (found.length === 0) process.stdout.write('  (no rule)\n')
  for (const rule of found) {
    process.stdout.write(`  ${rule.selector}\n`)
    for (const line of rule.body.split(/\s*;\s*/).filter(Boolean)) process.stdout.write(`      ${line}\n`)
  }
  process.stdout.write('\n')
}
