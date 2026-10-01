/**
 * THE SIX CHANGELOG CATEGORIES, client-side mirror (decision 2026-09-30).
 *
 * The authority is `CHANGELOG_CATEGORIES` in `src/host/changelog-draft.js`. The two halves are separate
 * bundles and cannot import one another, so the panel's category dropdown reads this copy — and the suite
 * holds the pair equal, item by item, exactly as it does for `CHECKLIST_ITEMS`.
 *
 * WHY IT MATTERS HERE MORE THAN USUALLY: these strings are not decoration. They are the SAME words that
 * end up in `CHANGELOG.md`, and `renderVersionSection` groups by them — a dropdown offering a category the
 * writer does not know would produce a section nobody ever sees, silently.
 *
 * PURE DATA, ZERO DEPENDENCIES.
 * @type {ReadonlyArray<string>}
 */
export const CHANGELOG_CATEGORIES = ['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'Performance']
