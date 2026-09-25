/**
 * Stylesheet scoping — the isolation guarantee of the UI project system.
 *
 * A UI project is authored as ordinary root-level CSS:
 *
 *   :root { --ds-accent: #4d6bfe; }
 *   .lg-glass { border-radius: 24px; }
 *   @media (max-width: 768px) { :root { --glass-blur: 14px; } }
 *
 * Before it reaches the document, every selector gains the project's own root
 * marker, so the sheet can only ever match while that project is on:
 *
 *   html[data-ui-project-liquid-glass="on"] { --ds-accent: #4d6bfe; }
 *   html[data-ui-project-liquid-glass="on"] .lg-glass { border-radius: 24px; }
 *   @media (max-width: 768px) { html[data-ui-project-liquid-glass="on"] { … } }
 *
 * Two consequences worth stating explicitly:
 *  - a project cannot leak styles into the default interface, even by accident;
 *  - `:root` becomes the marker itself rather than a descendant, so token
 *    declarations apply to the element every component inherits from.
 *
 * The transform is intentionally small: rule blocks, comma-separated selector
 * lists, nested conditional at-rules, comments. It is not a general CSS parser
 * and does not need to be — project sheets are authored by this repository.
 */

/**
 * @param {string} marker e.g. `html[data-ui-project-liquid-glass="on"]`
 * @param {string} css
 * @returns {string} scoped CSS
 */
export function scopeCss(marker, css) {
  const source = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
  let out = ''
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('{', index)
    if (open === -1) break
    const prelude = source.slice(index, open).trim()
    let depth = 1
    let cursor = open + 1
    while (cursor < source.length && depth > 0) {
      const ch = source[cursor]
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      cursor += 1
    }
    const body = source.slice(open + 1, cursor - 1)
    if (prelude.startsWith('@')) {
      // Conditional at-rules wrap style rules and are recursed into; every other
      // at-rule (`@keyframes`, `@font-face`, `@property`) declares global names,
      // so it is emitted unchanged inside the project's own sheet.
      const conditional = /^@(media|supports|container|layer|scope)\b/.test(prelude)
      out += `${prelude}{${conditional ? scopeCss(marker, body) : body}}\n`
    } else if (prelude.length > 0) {
      const selectors = splitSelectorList(prelude)
        .map((selector) => scopeSelector(marker, selector))
        .filter((selector) => selector.length > 0)
      if (selectors.length > 0) out += `${selectors.join(', ')}{${body}}\n`
    }
    index = cursor
  }
  return out
}

/**
 * Split a selector list on top-level commas only.
 *
 * A plain `split(',')` is wrong: `:where(a, b)` and `:is(a, b)` contain commas that
 * belong to ONE selector, and splitting there produced fragments like
 * `:where([role='dialog']` and `[role='menu'])` — each of which was then prefixed
 * separately, so the rule matched nothing and the skin silently lost its frost on
 * menus. Depth counting is the whole fix.
 * @param {string} prelude
 * @returns {string[]}
 */
export function splitSelectorList(prelude) {
  /** @type {string[]} */
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of String(prelude)) {
    if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current.trim())
  return parts.filter((part) => part.length > 0)
}

/**
 * Bind one authored selector to a project's marker.
 *
 * The marker is a selector for the marked `body`, so the first compound of the
 * authored selector decides how it binds:
 *
 *   `:root` / `html`  → the marker itself. The author is talking about the root,
 *                       and the marker names the element carrying it, so the
 *                       declaration must land on that element rather than below it.
 *   `body…`           → the marker with the selector's own suffix appended, NOT a
 *                       descendant. `body[data-ds-dark-theme]` means "the body in
 *                       dark mode", so it must become
 *                       `body[marker][data-ds-dark-theme]` — the same element with an
 *                       extra condition. Prefixing it instead produced
 *                       `body[marker] body[data-ds-dark-theme]`, which asks for a
 *                       body INSIDE the body and therefore matches nothing; that is
 *                       exactly how the skin's dark branch was silently dead.
 *   anything else     → a descendant of the marker, the common case.
 *
 * @param {string} marker
 * @param {string} selector
 * @returns {string}
 */
export function scopeSelector(marker, selector) {
  if (selector.length === 0) return selector
  if (selector.includes(marker)) return selector

  const scoped = (() => {
    /*
     * A pseudo-class function takes a SELECTOR LIST, and it is tokenized as one. That matters
     * more than it looks: `:where([role='dialog'], [role='menu'])` is two compounds, and an
     * earlier version scoped only the first — producing `:where([marker] [role='dialog'],
     * [role='menu'])`, where the SECOND branch was unscoped and therefore applied to the whole
     * document. A skin rule meant for menus was leaking everywhere.
     *
     * `:where(...)` and `:is(...)` also hide the compound inside from the binding decision:
     * `:where(html)` and `:where(body)` fell through to the descendant branch and became
     * `body[marker] :where(html)` and `body[marker] :where(body)` — the latter asking for a
     * `body` inside the `body`, which matches nothing on any page. `overflow: clip`, written as
     * `:where(html), :where(body)`, was silently dead for several rounds while looking perfectly
     * reasonable in the source.
     *
     * Specificity is preserved: `:where()` still contributes nothing, and a bare compound still
     * contributes what it always did.
     */
    const functional = /^:(where|is)\(([\s\S]*)\)$/.exec(selector)
    if (functional !== null) {
      const inner = splitSelectorList(functional[2])
        .map((part) => scopeCompound(marker, part))
        .join(', ')
      return `:${functional[1]}(${inner})`
    }
    return scopeCompound(marker, selector)
  })()

  /*
   * Refuse to emit the same attribute twice in one compound.
   *
   * This is the check that catches a whole class of silent failure rather than one instance of
   * it. The early return above leaves a selector that already contains the marker alone — which
   * is right, because a project may legitimately write the marker itself. But an author who spells
   * the marker out in a slightly different form (`body[data-ui-project-x='on'] …` against a
   * runtime marker of `body[data-ui-project-x="on"]`) defeats that check by a QUOTE CHARACTER,
   * and the selector is scoped a second time into `body[marker][marker] …` — the same attribute
   * twice on one element, matching nothing, on any page, forever.
   *
   * A doubled marker is never intentional and is never matchable, so failing loudly here is
   * strictly better than emitting it and letting a rule quietly do nothing.
   */
  if (new RegExp(`\\[data-ui-project-[a-z0-9-]+[^\\]]*\\][^\\s>+~]*\\[data-ui-project-`).test(scoped)) {
    throw new Error(
      `[dsh-ui-projects] refusing to emit a selector with the project marker twice: ${JSON.stringify(scoped)}`,
    )
  }
  return scoped
}

/**
 * Bind one compound selector to the marker.
 * @param {string} marker
 * @param {string} selector
 * @returns {string}
 */
function scopeCompound(marker, selector) {
  if (selector.length === 0) return selector

  const root = /^(:root|html)\b/.exec(selector)
  if (root !== null) return marker + selector.slice(root[0].length)

  const body = /^body\b/.exec(selector)
  if (body !== null) return marker + selector.slice(body[0].length)

  return `${marker} ${selector}`
}
