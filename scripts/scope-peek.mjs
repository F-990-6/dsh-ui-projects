/**
 * Print what the scoper emits for a given selector, using the real implementation.
 * Usage: node scripts/scope-peek.mjs [--marker "<body selector>"] "selector" ["selector2" ...]
 *
 * The marker is an ARGUMENT with a placeholder default, not a constant naming a project. This package
 * shipped a skin until step 8c and spelled that skin's marker here; a hard-coded id in a tool about
 * the SCOPERS would now be a fact about somebody else's package, and it would go stale the first time
 * that package renamed itself. The default below is deliberately not a real project id — pass
 * `--marker` to see a real project's output.
 */
import { scopeCss } from '../src/client/scope-css.js'

const USAGE = 'usage: node scripts/scope-peek.mjs [--marker "<body selector>"] "a, b { color: red }"\n'

const argv = process.argv.slice(2)
let marker = 'body[data-ui-project-example="on"]'
const markerAt = argv.indexOf('--marker')
if (markerAt !== -1) {
  const value = argv[markerAt + 1]
  if (value === undefined || value.startsWith('--')) {
    process.stdout.write(USAGE)
    process.exit(2)
  }
  marker = value
  argv.splice(markerAt, 2)
}

if (argv.length === 0) {
  process.stdout.write(USAGE)
  process.exit(0)
}

for (const selector of argv) {
  const css = selector.includes('{') ? selector : `${selector} { color: red }`
  process.stdout.write(`MARKER: ${marker}\n`)
  process.stdout.write(`IN : ${JSON.stringify(css)}\n`)
  process.stdout.write(`OUT: ${scopeCss(marker, css).trim()}\n\n`)
}
