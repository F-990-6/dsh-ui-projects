/**
 * What a project's stylesheet does with `backdrop-filter`.
 *
 * WHY THIS IS ITS OWN MODULE. Two different places need to answer "does this project install a
 * blur?": the settings page, which escalates a region conflict to a nesting warning when both
 * projects filter, and the diagnostics overlay, which looks for an actual chain of filtered
 * elements. Putting it in the overlay would make the settings data depend on a debug instrument;
 * putting it in the runtime would bury CSS parsing in the module that owns the DOM.
 *
 * It parses the CSS the runtime already holds — the scoped text of what each project inserted —
 * rather than asking the DOM, and that choice matters: the skin's frost lives on a `::before`
 * pseudo-element, which no selector can find and no `querySelectorAll` can return. Text is the only
 * complete record of what a project declared.
 *
 * Pure string functions, so the suite can feed them real stylesheets without a document.
 */

/**
 * Split a stylesheet into `{ prelude, body }` segments, one per top-level block.
 *
 * The same brace counter the other tools in this repository use. Comments are stripped first, so a
 * commented-out declaration cannot be mistaken for a live one.
 * @param {string} css
 * @returns {Array<{ prelude: string, body: string }>}
 */
function segments(css) {
  const source = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '{') continue
    let depth = 1
    let end = -1
    for (let scan = index + 1; scan < source.length; scan += 1) {
      if (source[scan] === '{') depth += 1
      else if (source[scan] === '}') {
        depth -= 1
        if (depth === 0) {
          end = scan
          break
        }
      }
    }
    if (end < 0) break
    out.push({ prelude: source.slice(start, index), body: source.slice(index + 1, end) })
    index = end
    start = end + 1
  }
  return out
}

/**
 * Walk a stylesheet and yield every rule together with the conditional at-rule wrapping it.
 * @param {string} css
 * @param {string} [condition]
 * @returns {Array<{ selector: string, body: string, condition: string }>}
 */
function rules(css, condition = '') {
  const out = []
  for (const segment of segments(css)) {
    const prelude = segment.prelude.trim()
    if (prelude === '') continue
    if (prelude.startsWith('@')) {
      // Only conditionals wrap style rules; `@keyframes`/`@font-face` bodies are not selectors.
      if (/^@(media|supports|container|layer|scope)\b/.test(prelude)) {
        out.push(...rules(segment.body, `${condition}${prelude} `))
      }
      continue
    }
    for (const selector of prelude.split(',')) {
      const trimmed = selector.trim()
      if (trimmed.length > 0) out.push({ selector: trimmed, body: segment.body, condition })
    }
  }
  return out
}

/**
 * Whether one declaration block turns the blur ON.
 *
 * `none` is what a rule that removes a blur declares, and it is the whole point of the skin's
 * `@supports not (backdrop-filter)` branch: treating it as "this project blurs" would report a
 * nesting between two projects whose rules cannot both be live.
 * @param {string} body
 * @returns {boolean}
 */
function enablesBackdropFilter(body) {
  for (const match of String(body).matchAll(/(?:^|;)\s*(?:-webkit-)?backdrop-filter\s*:\s*([^;}]+)/g)) {
    const value = match[1].trim().toLowerCase()
    if (value !== '' && value !== 'none' && value !== 'initial' && value !== 'unset') return true
  }
  return false
}

/**
 * Whether a stylesheet installs a `backdrop-filter` anywhere.
 * @param {string} css
 * @returns {boolean}
 */
export function declaresBackdropFilter(css) {
  return rules(css).some((rule) => enablesBackdropFilter(rule.body))
}

/**
 * Every selector a stylesheet gives a `backdrop-filter` to, with the condition it sits under.
 *
 * The condition is reported because it changes what a nesting claim means: two rules under
 * mutually exclusive conditions (`@supports not (…)` against the base rule) never apply together.
 * @param {string} css
 * @returns {Array<{ selector: string, condition: string }>}
 */
export function filteredSelectors(css) {
  return rules(css)
    .filter((rule) => enablesBackdropFilter(rule.body))
    .map((rule) => ({ selector: rule.selector, condition: rule.condition.trim() }))
}
