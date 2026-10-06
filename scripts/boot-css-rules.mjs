/*
 * What belongs in the first-paint stylesheet: the shared rule, in one place.
 *
 * `src/host/boot.css` is a DERIVED subset of the skin's own CSS — the declarations that decide the
 * colours and the background of the very first frame, before any client bundle has been fetched. It
 * is produced by `scripts/derive-boot-css.mjs` and consumed by `scripts/build.mjs`, and both have to
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
export const MARKER = 'body[data-ui-project-glass="on"]'

/*
 * WHAT THE FIRST-PAINT SHEET IS MADE OF, for the package that owns it.
 *
 * These four values used to be hard-coded in `tools/derive-boot-css.mjs` (the paths and the header) and
 * in `scripts/build.mjs` (the stylesheet list), which was correct while exactly one package had a skin
 * and wrong the moment a second one could. They belong with the predicate above because they answer the
 * same question — "which rules are the first paint's" — for one package, and the tool and the build both
 * read them from here so the two cannot disagree about the answer.
 *
 * `SKIN_DIR` and `BOOT_CSS_OUT` are relative to the package root, so a tool that is handed `--package
 * <dir>` can resolve either one without knowing which package it is looking at.
 */

/** Where this package's skin stylesheets live, relative to the package root. */
export const SKIN_DIR = 'src/client/skins/glass'

/** The stylesheets the first-paint subset may draw from, in `apply` order. */
export const SKIN_STYLESHEETS = ['tokens.css', 'glass.css']

/** The derived first-paint sheet, relative to the package root. */
export const BOOT_CSS_OUT = 'src/host/skins/glass/boot.css'

/**
 * The header `derive-boot-css.mjs` writes above the derived rules.
 *
 * Generated rather than hand-maintained, and it is part of the file the build compares: a header that
 * drifts would make `--check` report the sheet stale for a reason that has nothing to do with CSS.
 */
export const BOOT_CSS_HEADER = `/*
 * The first paint, inlined into <head> before anything else runs.
 *
 * WHY THIS FILE EXISTS. The shell paints before the client bundle is loaded, so a skin that only
 * arrives with that bundle is a skin the first frame does not have. This is the part of Liquid
 * Glass that a first paint can use, inlined by the host half through \`webserver/index-inject\` —
 * see \`src/host/index.js\`.
 *
 * IT IS A DERIVED SUBSET, NOT A SECOND SOURCE. Every block below also appears, character for
 * character, in the CSS the skin emits after the runtime scoper has run, and \`scripts/build.mjs\`
 * fails the build if that stops being true. Regenerate it with \`node scripts/derive-boot-css.mjs\` run in
 * this package's root, after changing a body-level rule in \`tokens.css\` or \`glass.css\` — never edit it by
 * hand.
 *
 * WHY IT IS ALREADY SCOPED. Project stylesheets are authored plainly and scoped at runtime. This
 * one is written the way the scoper would emit it (\`body[data-ui-project-glass="on"]\`),
 * because the host has no scoper and because it is inlined unconditionally: every selector carries
 * the marker, so with the skin off the whole sheet is inert and the host needs no branch.
 *
 * WHAT IS NOT HERE, ON PURPOSE. The frost. It hangs off \`data-ui-skin-column\`, which the client
 * runtime stamps once the application's DOM exists, so no first frame can have it. The blur lands
 * a few milliseconds later; the colours, the background and its ambient gradient — everything the
 * eye reads as "this is Liquid Glass" — are already correct here.
 *
 * Derived from tokens.css and glass.css; body-level rules only.
 */`

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
