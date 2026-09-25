/**
 * Where the settings dialog's geometry actually comes from.
 *
 * The panel has been squeezed twice and neither cause was guessable: the flex chain, the mask and
 * the panel's own fixed sizing all interact, and a screenshot shows only the result. This prints
 * the chain — every ancestor of the panel with its size, display, and the properties that decide
 * whether it can be squeezed — so the constraint can be read instead of inferred.
 *
 * Usage: node scripts/dialog-geometry.mjs [settings-dir]
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? 'C:/Users/19103/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai')

/** Every client bundle in the install, so a rule can be found wherever it lives. */
const bundles = []
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const candidate = join(root, entry.name, 'lib', 'client.js')
  try {
    bundles.push({ name: entry.name, text: await readFile(candidate, 'utf8') })
  } catch {
    // Not every package ships a client half.
  }
}

process.stdout.write(`scanned ${bundles.length} client bundles\n\n`)

/** Print every rule whose selector mentions a needle, with the file it came from. */
const report = (/** @type {string} */ needle, /** @type {string} */ label) => {
  process.stdout.write(`══ ${label} — rules mentioning ${JSON.stringify(needle)}\n`)
  let found = 0
  for (const bundle of bundles) {
    const pattern = new RegExp(`[^{}]*${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{}]*\\{[^}]*\\}`, 'g')
    for (const match of bundle.text.match(pattern) ?? []) {
      found += 1
      process.stdout.write(`  [${bundle.name.replace('dsh-client-ui-', '')}] ${match.slice(0, 400)}\n`)
    }
  }
  if (found === 0) process.stdout.write('  (none)\n')
  process.stdout.write('\n')
}

report('VOzbGW_panel', 'the dialog panel')
report('VOzbGW_mask', 'the dialog mask')
report('VOzbGW_root', 'the dialog root')
report('VOzbGW_nav', 'the dialog navigation column')
