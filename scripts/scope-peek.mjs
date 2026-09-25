/**
 * Print what the scoper emits for a given selector, using the real implementation.
 * Usage: node scripts/scope-peek.mjs "selector" ["selector2" ...]
 */
import { scopeCss } from '../src/client/scope-css.js'

const marker = 'body[data-ui-project-liquid-glass="on"]'
const selectors = process.argv.slice(2)
if (selectors.length === 0) {
  process.stdout.write('usage: node scripts/scope-peek.mjs "a, b { color: red }"\n')
  process.exit(0)
}

for (const selector of selectors) {
  const css = selector.includes('{') ? selector : `${selector} { color: red }`
  process.stdout.write(`IN : ${JSON.stringify(css)}\n`)
  process.stdout.write(`OUT: ${scopeCss(marker, css).trim()}\n\n`)
}
