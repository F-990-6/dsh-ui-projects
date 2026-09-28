/**
 * UI Contract compliance: what a plugin's client bundle can be judged on BY READING IT.
 *
 * WHAT THIS MODULE MAY DO, and what it may never do: it reads TEXT. It does not execute the bundle, does
 * not load it in a `vm`, does not resolve its imports and does not touch the filesystem. The subject is a
 * third-party artefact this process did not write, and the whole point of a static scan is that reading it
 * cannot run it.
 *
 * WHY A SCANNER AND NOT A PARSER — measured in this workspace, not assumed:
 *
 *   - No JavaScript parser is reachable here: `acorn`, `@babel/parser`, `esprima`, `meriyah`, `espree` and
 *     `typescript` all fail to resolve, and the only `@babel` packages present are `code-frame`,
 *     `helper-validator-identifier` and `runtime`. Node exposes no public AST API. So an AST detector
 *     means adding a dependency to a package that deliberately has exactly one (`acorn` 8.18.0: MIT, zero
 *     runtime dependencies, 565327 bytes unpacked, 10 files).
 *   - What a parser would buy is small here, because the four contract rules are not four syntactic
 *     shapes. Measured on the three real bundles in this workspace: `role=` appears 11 times in the
 *     framework's bundle and 33 times in the skin's, of which **0 are in code** (7 are comments, the rest
 *     are CSS selectors inside strings); `--dsw-alias-*` appears 54 / 105 times and **0 are in code** (all
 *     inside the CSS strings). Distinguishing those is a comment/string question, and the scanner below
 *     answers it with byte offsets intact.
 *   - The rules this module can honestly decide are VIOLATIONS, not compliance. See `CONTRACT_LIMITS`.
 *
 * IT IS A WARNING-ONLY INSTRUMENT. Every finding has `severity: 'warning'`; nothing here refuses a
 * package, and a clean scan is not a promise that a plugin is coverable — it is the absence of the
 * violations a text scan can see.
 */

/**
 * The WAI-ARIA roles a skin can select by.
 *
 * SOURCE: WAI-ARIA 1.2, W3C Recommendation, 06 June 2023, section 5.3 "Categorization of Roles"
 * <https://www.w3.org/TR/wai-aria-1.2/#roles_categorization> — transcribed by hand into this file on
 * purpose, because the alternative is a dependency (see the header) for a list that changes when the
 * SPECIFICATION changes, not when a package does.
 *
 * 94 entries = the 82 non-abstract roles (5.3.2 widget 37 + 5.3.3 document structure 37 + 5.3.4 landmark
 * 8; the live-region and window roles are already inside those) **plus the 12 abstract roles** of 5.3.1.
 * The abstract ones are accepted deliberately: this scanner reports a role it cannot recognise, and
 * `role="widget"` is a real WAI-ARIA role even though no skin should select it. A warning-only instrument
 * must prefer a false negative to a false positive.
 *
 * `scripts/check-installed.test.mjs` pins the size, so editing this list is visible in a count.
 * @type {Set<string>}
 */
export const WAI_ARIA_ROLES = new Set([
  // 5.3.1 Abstract Roles (12)
  'command', 'composite', 'input', 'landmark', 'range', 'roletype', 'section', 'sectionhead', 'select',
  'structure', 'widget', 'window',
  // 5.3.2 Widget Roles (37)
  'alert', 'alertdialog', 'button', 'checkbox', 'combobox', 'dialog', 'grid', 'gridcell', 'link', 'listbox',
  'log', 'marquee', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'option',
  'progressbar', 'radio', 'radiogroup', 'scrollbar', 'searchbox', 'slider', 'spinbutton', 'status', 'switch',
  'tab', 'tablist', 'tabpanel', 'textbox', 'timer', 'tooltip', 'tree', 'treegrid', 'treeitem',
  // 5.3.3 Document Structure Roles (37)
  'application', 'article', 'blockquote', 'caption', 'cell', 'code', 'columnheader', 'definition',
  'deletion', 'directory', 'document', 'emphasis', 'feed', 'figure', 'generic', 'group', 'heading', 'img',
  'insertion', 'list', 'listitem', 'math', 'none', 'note', 'paragraph', 'presentation', 'row', 'rowgroup',
  'rowheader', 'separator', 'strong', 'subscript', 'superscript', 'table', 'term', 'time', 'toolbar',
  // 5.3.4 Landmark Roles (8)
  'banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search',
])

/** The contract rules this scanner can judge, named as the contract names them. */
export const CONTRACT_RULES = {
  /** Rule 1: an overlay's role must be a WAI-ARIA role, or no skin can select it. */
  ROLE: 'role',
  /** Rule 2: colour belongs in a token declaration, not in a rule's declaration. */
  TOKENS: 'tokens',
  /** Rule 4: a closed shadow root cannot be reached by any skin's selectors. */
  SHADOW_DOM: 'shadow-dom',
}

/**
 * How many rules the UI Contract has, and how many of them this scanner can decide.
 *
 * THE TWO NUMBERS ARE DIFFERENT ON PURPOSE, and the settings column prints both where the badge is: rule 3
 * (a top-level overlay in `document.body` must be identifiable by a WAI-ARIA role) is a statement about the
 * page at runtime, and no reading of a file can settle it. The judged count is DERIVED from
 * `CONTRACT_RULES` rather than written beside it, so adding a rule here cannot leave it stale; the total
 * changes only when the contract itself does.
 */
export const CONTRACT_RULE_COUNT = 4
export const CONTRACT_RULES_JUDGED = Object.keys(CONTRACT_RULES).length

/**
 * Finding codes.
 *
 * A SEPARATE NAMESPACE from `conformance.js`'s `PROBLEM_CODES`, on purpose: those describe whether a
 * package may be admitted at all (`severity: 'error'`, the loader refuses it), these describe advice
 * about how it behaves once admitted (`severity: 'warning'`, nothing is refused). Same rendering surface,
 * different consequence — so they must not share a vocabulary that makes them look alike.
 */
export const CONTRACT_CODES = {
  NON_STANDARD_ROLE: 'UI_CONTRACT_NON_STANDARD_ROLE',
  HARD_CODED_COLOUR: 'UI_CONTRACT_HARD_COLOUR',
  CLOSED_SHADOW_ROOT: 'UI_CONTRACT_CLOSED_SHADOW_ROOT',
}

/**
 * WHAT THIS INSTRUMENT CANNOT SEE, carried with every result so the UI can say it where it matters.
 *
 * The first entry is the one a reader needs most: a clean scan is not a clean plugin.
 */
export const CONTRACT_LIMITS = [
  'rule 3 (a top-level overlay must be identifiable by WAI-ARIA role) needs a runtime probe and is not scanned here',
  'a violation inside an event handler or an effect is invisible to a static scan: only what is written can be read',
  'a role computed at runtime (from a variable or a template) cannot be judged statically and is not reported',
]

/**
 * The properties whose value the shipped palette owns.
 *
 * Rule 2 is scoped to these, and the scoping is the rule's whole definition rather than a heuristic: the
 * contract's example is `background: #ffffff`, and what breaks skin coverage is a surface or a text colour
 * that ignores the tokens. A `background-image` gradient, a `box-shadow`, a `filter` are decoration a
 * plugin may legitimately author — and a skin that draws its own ambient gradient would otherwise be the
 * workspace's worst "violator" for doing the one thing a skin is for. Custom properties are exempt
 * everywhere: DECLARING a colour is how a token comes to exist, and the measured case is the skin's 156
 * in-bundle literals, every one of them a `--*:` value.
 */
const PALETTE_PROPERTIES = /^(?:background|background-color|color|border|border-(?:top|right|bottom|left)|border-color|outline|outline-color|fill|stroke|caret-color|accent-color|text-decoration-color)$/

/** A colour written literally, in any of the three syntaxes CSS accepts. */
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g

/**
 * Blank what is not code, and remember what is a string.
 *
 * Two things this has to get right, both measured rather than reasoned:
 *   - comments are blanked, because 7 of the framework's 11 raw `role=` hits are its own prose;
 *   - strings are KEPT but TAGGED, because `--dsw-alias-*` appears only inside CSS strings (54 / 105
 *     hits) and the skin's `role=` hits are all CSS selectors inside strings. Blanking strings would
 *     report "this plugin uses no tokens", which is the opposite of the truth.
 *
 * Regex literals are recognised by the usual "what came before" heuristic; a mis-detected one can only
 * blank a little more text, which costs a false negative and never a false positive.
 * @param {string} text
 * @returns {{ blanked: string, inString: boolean[], lines: number[] }}
 */
function readText(text) {
  const out = text.split('')
  const inString = new Array(text.length).fill(false)
  let i = 0
  let prev = ''
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' '
      continue
    }
    if (c === '/' && next === '*') {
      /*
       * EVERY character through the comment's closing delimiter is blanked, newlines included — offsets
       * must not move, because `lines` maps offsets to line numbers and is computed from the ORIGINAL text.
       *
       * The first version of this loop advanced `i` and forgot `out[i] = ' '`, so comments stayed in the
       * text the detectors read: a role written in a comment was reported as a role set by code. The probe
       * this file was built from got it right, and the hardened rewrite of it lost that — which is why the
       * A-layer case for a comment exists.
       */
      out[i++] = ' '
      out[i++] = ' '
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) out[i++] = ' '
      if (i < text.length) {
        out[i++] = ' '
        out[i++] = ' '
      }
      continue
    }
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)) {
      out[i++] = ' '
      let inClass = false
      while (i < text.length) {
        if (text[i] === '\\') {
          out[i++] = ' '
          out[i++] = ' '
          continue
        }
        if (text[i] === '[') inClass = true
        if (text[i] === ']') inClass = false
        if (text[i] === '/' && !inClass) break
        out[i++] = ' '
      }
      if (i < text.length) out[i++] = ' '
      prev = '/'
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      inString[i] = true
      i += 1
      while (i < text.length) {
        if (text[i] === '\\') {
          inString[i] = true
          inString[i + 1] = true
          i += 2
          continue
        }
        if (text[i] === quote) break
        inString[i] = true
        i += 1
      }
      inString[i] = true
      i += 1
      prev = quote
      continue
    }
    if (c !== '\n') prev = c
    i += 1
  }
  const blanked = out.join('')
  /** Line number per offset, so a finding can name where it came from. */
  const lines = new Array(text.length + 1).fill(1)
  for (let index = 0; index < text.length; index += 1) {
    lines[index + 1] = lines[index] + (text[index] === '\n' ? 1 : 0)
  }
  return { blanked, inString, lines }
}

/** The trimmed source line a finding came from, short enough to render. */
function evidenceAt(text, lines, index) {
  const line = lines[index] ?? 1
  const all = text.split('\n')
  return { line, excerpt: (all[line - 1] ?? '').trim().slice(0, 120) }
}

/**
 * Every `role` value this text ASSIGNS, with the offsets that say so.
 *
 * Three forms, and the exclusion of a fourth, all measured:
 *   `role="dialog"` (an HTML string), `role: 'dialog'` (an object property — how this workspace writes
 *   roles: `role: 'switch'` twice in the framework's bundle), `setAttribute('role', 'x')`;
 *   and NOT `[role='dialog']`, which is a CSS selector and says nothing about any element's role. The
 *   probe that produced this inventory matched both selector and attribute with one pattern (20 = 20 hits
 *   in the framework, 66 = 66 in the skin), which is exactly the false positive this check removes.
 *
 * A ROLE QUOTED IN A LABEL IS NOT AN ASSIGNMENT, and this test took two passes:
 *   - the first version said "a markup attribute does not start its own string literal". That is right for
 *     `title: 'role="custom-dialog"'` — the case the two-sided example package produced — and WRONG for
 *     `'foo role="custom-dialog" bar'`, a sentence that names a role the way a person writes a sentence;
 *   - this version asks the question the first one approximated: did a TAG start inside the literal, and is
 *     it still open? `<div role="x">` is markup; `'<span>see role="x"'` is not, because the tag that opened
 *     already closed. That is why the pattern looks for a `<name` with no `>` after it rather than for a
 *     `<` anywhere in the string.
 * @param {string} blanked @param {boolean[]} inString
 */
function roleAssignments(blanked, inString) {
  /** @type {Array<{ index: number, value: string }>} */
  const found = []
  /*
   * `(?<![\w-])` is load-bearing: without it, `data-role="x"` and `userRole: 'x'` are both read as role
   * assignments, and a plugin that carries its own `data-role` would be reported for a role it never set.
   */
  const prefix = (at) => blanked.slice(Math.max(0, at - 40), at)
  const isSelector = (at) => /\[\s*$/.test(prefix(at))
  /** An object property is a key: `{ role: 'x' }` or `, role: 'x'`. */
  const isPropertyKey = (at) => /(?:\{|,)\s*$/.test(prefix(at))
  /** The offset of the quote that OPENED the literal containing `at` (strings are kept, not blanked). */
  const stringStart = (at) => {
    let index = at
    while (index > 0 && inString[index - 1] === true) index -= 1
    return index
  }
  /** A tag opened inside this literal and has not closed yet: `<div class="c" ` yes, `'<span>see ` no. */
  const insideTag = (at) => /<[a-zA-Z][\w:-]*[^<>]*$/.test(blanked.slice(stringStart(at), at))
  /*
   * A markup attribute sits inside a string, but not at its START: `<div role="x">` is an attribute,
   * `'role="x"'` is a label that quotes one. In CODE a `role=` is judged as markup — nothing in this
   * workspace writes one there, and the two ways of writing a role in code are covered elsewhere:
   * the object property above, and `setAttribute('role', …)` below.
   */
  const isMarkupAttribute = (at) => {
    if (/["'`]\s*$/.test(prefix(at))) return false
    return inString[at] !== true || insideTag(at)
  }
  for (const match of blanked.matchAll(/(?<![\w-])role\s*:\s*(["'`])([^"'`]*)\1/g)) {
    const at = match.index ?? 0
    if (isSelector(at) || !isPropertyKey(at)) continue
    found.push({ index: at, value: match[2] })
  }
  for (const match of blanked.matchAll(/(?<![\w-])role\s*=\s*(["'`])([^"'`]*)\1/g)) {
    const at = match.index ?? 0
    if (isSelector(at) || !isMarkupAttribute(at)) continue
    found.push({ index: at, value: match[2] })
  }
  for (const match of blanked.matchAll(/setAttribute\s*\(\s*(["'`])role\1\s*,\s*(["'`])([^"'`]*)\2\s*\)/g)) {
    found.push({ index: match.index ?? 0, value: match[3] })
  }
  /*
   * A role whose value is not a literal (`role: roleName`, a template) cannot be judged, and is counted
   * rather than reported — the limit line says so, and a silent skip would look like compliance.
   *
   * WHICH OF THE TWO ASSIGNMENT FORMS THIS IS comes from the matched operator, not from `blanked[at + 4]`:
   * that offset is right for `role:` and wrong for `role =` (it lands on the space), which sent a spaced
   * `=` through the object-key test and could count a computed markup attribute as nothing at all.
   */
  let unjudged = 0
  for (const match of blanked.matchAll(/(?<![\w-])role\s*[:=]\s*(?!["'`])/g)) {
    const at = match.index ?? 0
    if (isSelector(at)) continue
    const before = match[0].includes('=') ? isMarkupAttribute(at) : isPropertyKey(at)
    if (!before) continue
    unjudged += 1
  }
  return { found, unjudged }
}

/**
 * The ranges of a declaration's value that a `var()` FALLBACK occupies.
 *
 * Found by running the scanner against a real third-party plugin (`dsh-cost-meter`), which writes
 * `background: var(--dsw-alias-bg-hover,rgba(127,127,127,.08))` in five places. The first version of this
 * rule reported all five, and that finding was wrong: the plugin READS the token, and a literal fallback
 * shows only if the token is undefined — in which case there is no palette to be covered by anyway.
 * Reporting it would have told a compliant plugin to do what it was already doing.
 *
 * Only the fallback half is exempt, and only when the `var()`'s first argument is a custom property.
 * @param {string} value
 * @returns {Array<[number, number]>}
 */
function tokenFallbackRanges(value) {
  /** @type {Array<[number, number]>} */
  const ranges = []
  for (const match of value.matchAll(/var\(/g)) {
    const open = (match.index ?? 0) + match[0].length
    let depth = 1
    let index = open
    while (index < value.length && depth > 0) {
      if (value[index] === '(') depth += 1
      else if (value[index] === ')') depth -= 1
      index += 1
    }
    const inner = value.slice(open, depth === 0 ? index - 1 : value.length)
    // The first comma at paren depth 0 separates the token name from its fallback.
    let comma = -1
    let nested = 0
    for (let at = 0; at < inner.length; at += 1) {
      if (inner[at] === '(') nested += 1
      else if (inner[at] === ')') nested -= 1
      else if (inner[at] === ',' && nested === 0) {
        comma = at
        break
      }
    }
    if (comma < 0) continue
    if (!inner.slice(0, comma).trim().startsWith('--')) continue
    ranges.push([open + comma + 1, open + inner.length])
  }
  return ranges
}

/** Colour literals written in the declarations of properties the palette owns, outside a `var()` fallback. */
function hardCodedColours(blanked) {
  /** @type {Array<{ index: number, excerpt: string }>} */
  const found = []
  for (const declaration of blanked.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]*)/g)) {
    const property = declaration[1]
    const value = declaration[2]
    if (property.startsWith('--')) continue
    if (!PALETTE_PROPERTIES.test(property)) continue
    const exempt = tokenFallbackRanges(value)
    const literal = [...value.matchAll(COLOUR_LITERAL)].find(
      (match) => !exempt.some(([from, to]) => (match.index ?? 0) >= from && (match.index ?? 0) < to),
    )
    if (literal === undefined) continue
    const valueStart = (declaration.index ?? 0) + declaration[0].indexOf(value)
    found.push({
      index: valueStart + (literal.index ?? 0),
      excerpt: `${property}: ${value.trim().slice(0, 60)}`,
    })
  }
  return found
}

/** `attachShadow({ mode: 'closed' })`, in code — a comment mentioning it is not one. */
function closedShadowRoots(blanked) {
  /** @type {Array<{ index: number }>} */
  const found = []
  for (const match of blanked.matchAll(/attachShadow\s*\(([\s\S]{0,120}?)\)/g)) {
    if (/mode\s*:\s*['"`]closed['"`]/.test(match[1])) found.push({ index: match.index ?? 0 })
  }
  return found
}

/**
 * Scan one client bundle's text for contract violations.
 *
 * Never throws: a non-string, an empty string or a megabyte of minified nonsense all produce a result.
 * The caller adds `scanned`/`reason`/`bytes`; this function knows only about text.
 * @param {string} text the bundle as text
 * @returns {{ findings: Array<{ rule: string, code: string, severity: string, message: string, action: string, evidence: { line: number, excerpt: string } }>, limits: string[] }}
 */
export function scanClientBundle(text) {
  const source = typeof text === 'string' ? text : ''
  const { blanked, inString, lines } = readText(source)
  const limits = [...CONTRACT_LIMITS]
  /** @type {Array<{ rule: string, code: string, message: string, action: string, at: number, excerpt?: string }>} */
  const raw = []

  const roles = roleAssignments(blanked, inString)
  for (const assignment of roles.found) {
    const tokens = assignment.value.trim().split(/\s+/).filter((token) => token.length > 0)
    if (tokens.length === 0) continue
    if (tokens.some((token) => WAI_ARIA_ROLES.has(token))) continue
    raw.push({
      rule: CONTRACT_RULES.ROLE,
      code: CONTRACT_CODES.NON_STANDARD_ROLE,
      message: `role="${assignment.value}" is not a WAI-ARIA role, so no UI skin can select what it marks`,
      action: 'use a WAI-ARIA role (dialog, menu, listbox, tooltip for a floating surface) or a native element that already carries one',
      at: assignment.index,
    })
  }
  if (roles.unjudged > 0) {
    limits.push(`${roles.unjudged} role assignment(s) in this bundle have a computed value and were not judged`)
  }

  for (const colour of hardCodedColours(blanked)) {
    raw.push({
      rule: CONTRACT_RULES.TOKENS,
      code: CONTRACT_CODES.HARD_CODED_COLOUR,
      message: `a colour is written literally where the shipped palette owns the value: ${colour.excerpt}`,
      action: 'use a --dsw-alias-* token (bg-layer-1/-2/-3/-overlay, border-l1/-l2/-l3, text-*), or declare the value as a custom property',
      at: colour.index,
      excerpt: colour.excerpt,
    })
  }

  for (const shadow of closedShadowRoots(blanked)) {
    raw.push({
      rule: CONTRACT_RULES.SHADOW_DOM,
      code: CONTRACT_CODES.CLOSED_SHADOW_ROOT,
      message: 'attachShadow({ mode: "closed" }) cannot be reached by any stylesheet, so a skin cannot style what is inside it',
      action: 'use mode: "open", so the content stays reachable by a skin’s selectors',
      at: shadow.index,
    })
  }

  /*
   * ORDER: `(line, rule, code)`, and it is part of the result rather than an accident of discovery.
   * A dictionary of hits would come out in insertion order, which depends on which pattern happened to
   * run first — so two runs of the same file could differ, and a diff of two reports would be noise.
   */
  const findings = raw
    .map((finding) => ({
      rule: finding.rule,
      code: finding.code,
      severity: 'warning',
      message: finding.message,
      action: finding.action,
      evidence: { ...evidenceAt(source, lines, finding.at), excerpt: finding.excerpt ?? evidenceAt(source, lines, finding.at).excerpt },
    }))
    .sort((a, b) => a.evidence.line - b.evidence.line || a.rule.localeCompare(b.rule) || a.code.localeCompare(b.code))

  return { findings, limits }
}
