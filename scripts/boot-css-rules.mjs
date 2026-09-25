/*
 * What belongs in the first-paint stylesheet: the shared rule, in one place.
 *
 * `src/host/boot.css` is a DERIVED subset of the skin's own CSS — the declarations that decide the
 * colours and the background of the very first frame, before any client bundle has been fetched. It
 * is produced by `tools/derive-boot-css.mjs` and consumed by `scripts/build.mjs`, and both have to
 * agree exactly on which rules qualify: the tool decides what goes in, the build asserts that
 * everything that should be in it is.
 *
 * They used to hold a copy each, with a comment claiming a disagreement would fail loudly. It would
 * not have. Both copies had the same blind spot — a comma-separated selector list was skipped on
 * sight — so when a suppression had to be written as `body, body[data-ds-dark-theme]` to outrank the
 * themed rule, both dropped it, both agreed, and three `background-image: none` blocks left the
 * first-paint sheet without anything failing. Two copies of a rule only catch the mistakes that one
 * of them does not make.
 */

/** The marker the scoper puts on the body element, and the only selector a first-paint rule takes. */
export const MARKER = 'body[data-ui-project-liquid-glass="on"]'

/**
 * Split a prelude on its top-level commas only.
 *
 * Commas inside `:where(…)`, `:is(…)` or `:has(…)` separate selectors in a list the function owns as
 * a single unit; splitting on them produces fragments that match nothing and classify as anything.
 * @param {string} prelude
 * @returns {string[]}
 */
export function splitTopLevel(prelude) {
  const parts = []
  let depth = 0
  let start = 0
  for (let index = 0; index < prelude.length; index += 1) {
    const char = prelude[index]
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) {
      parts.push(prelude.slice(start, index))
      start = index + 1
    }
  }
  parts.push(prelude.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * Whether a string is nothing but attribute selectors, back to back.
 *
 * Whitespace inside the brackets is part of a value (`[aria-label="a b"]`); whitespace outside them
 * is a descendant combinator. That distinction is the whole test, and looking only at the first
 * character of the remainder cannot make it: `body[marker][data-ui-perf='low'] :where(…)::before`
 * begins with `[` and is a rule about a descendant, while `body[marker][data-ui-perf='low']` begins
 * the same way and is a rule about the body.
 * @param {string} text
 */
export function isAttributeRun(text) {
  let index = 0
  while (index < text.length) {
    if (text[index] !== '[') return false
    let depth = 0
    let end = -1
    for (let scan = index; scan < text.length; scan += 1) {
      if (text[scan] === '[') depth += 1
      else if (text[scan] === ']') {
        depth -= 1
        if (depth === 0) {
          end = scan
          break
        }
      }
    }
    if (end === -1) return false
    index = end + 1
  }
  return true
}

/**
 * Whether one selector (a single compound, no commas) is a rule ABOUT the body element rather than a
 * descendant of it.
 *
 * The distinction is the whole point: `body[marker]{--lg-accent:…}` is first-paint material, while
 * `body[marker] .lg-glass{…}` and `body[marker] [role='dialog']{…}` merely start with the same text
 * and need DOM the first frame does not have. So the marker must be followed by attribute selectors
 * and nothing else — never by a combinator, a class, or a pseudo-element. The remainder is inspected
 * WITHOUT trimming, because a leading space IS the descendant combinator.
 * @param {string} selector
 */
export function isBodyCompound(selector) {
  const text = selector.trim()
  if (!text.startsWith(MARKER)) return false
  const rest = text.slice(MARKER.length)
  return rest === '' || isAttributeRun(rest)
}

/**
 * Classify a prelude that may be a comma-separated list: `body` when every selector is about the body
 * element, `other` when none is, and `mixed` when only some are.
 *
 * A list used to be dropped on sight, which was wrong in a way that left no trace. `mixed` is
 * reported rather than guessed at: keeping only the body half would produce a first-paint sheet that
 * looks complete and is not, and the other half can matter too — the application frame is mounted
 * before this plugin's bundle is fetched, so its elements can be on screen in the first frame.
 * Splitting such a rule is a decision for whoever wrote it.
 * @param {string} prelude
 * @returns {'body' | 'other' | 'mixed'}
 */
export function classifyPrelude(prelude) {
  const parts = splitTopLevel(prelude)
  const flags = parts.map((part) => isBodyCompound(part))
  if (flags.length > 0 && flags.every(Boolean)) return 'body'
  if (flags.some(Boolean)) return 'mixed'
  return 'other'
}

/**
 * The message for a rule that cannot be represented faithfully.
 * @param {string} prelude
 * @param {string} where
 */
export function mixedSelectorError(prelude, where) {
  return new Error(
    `a rule mixes body-level and other selectors, so the first-paint sheet cannot include it faithfully:\n` +
      `  ${prelude.trim()}\n` +
      `  (${where})\n` +
      `Split it into separate rules: the body-level one belongs in the first-paint sheet, the other one does not.`,
  )
}
