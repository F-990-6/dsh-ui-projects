/**
 * The vocabulary shared by the registry and the UI projects it holds.
 *
 * These constants live in their own module so the dependency graph stays acyclic
 * and shallow — projects → constants, registry → constants, and never the reverse:
 *
 *   entry ─┬─> registry ──> constants
 *          ├─> runtime  ──> registry, scope-css
 *          └─> project  ──> constants, its own stylesheet
 *
 * A UI project can therefore describe itself without importing the registry that
 * will hold it, and can be loaded, tested or deleted on its own.
 */

/** Global look. Only one skin may be active at a time; enabling one disables the others. */
export const TYPE_SKIN = 'skin'
/** Composable layer. Any number of enhancements may be active together. */
export const TYPE_ENHANCEMENT = 'enhancement'

/** Opt-in feature flags a project may declare in its `supports` list. */
export const FEATURE_LIGHT = 'light'
export const FEATURE_DARK = 'dark'
export const FEATURE_MOBILE = 'mobile'

/** Every value `type` may take. */
export const PROJECT_TYPES = [TYPE_SKIN, TYPE_ENHANCEMENT]

/** Every value `scope` may take, widest first. */
export const PROJECT_SCOPES = ['global', 'layout', 'component']

/**
 * Execution order for composable projects: a LOWER number is applied FIRST.
 *
 * 100 sits in the middle of the useful range on purpose, so a project can ask to run before the
 * default (any smaller number) or after it (any larger one) without touching anything else. Ties
 * are broken by registration order, which is what makes the sequence reproducible: the previous
 * behaviour was alphabetical by id — an accident of `activeIds()` sorting — so renaming a project
 * silently changed when it ran, and nothing about the order related to what any project needed.
 */
export const DEFAULT_PRIORITY = 100

/** Every value `supports` may take. */
export const PROJECT_FEATURES = [FEATURE_LIGHT, FEATURE_DARK, FEATURE_MOBILE]

/**
 * The surfaces a project may declare it changes, in `modifies`.
 *
 * A vocabulary rather than free text, because it is only useful if two projects can be compared:
 * `['composer']` and `['input area']` describe the same thing and would never collide. Every entry
 * below names the DOM hook it actually refers to, so a declaration can be checked against the DOM
 * rather than argued about.
 *
 *   sidebar     a column of the layout frame — marked `data-ui-skin-column` by the runtime
 *   center      the main column, same marking
 *   rightbar    the right column, `data-rightbar-col`
 *   overlay     the frame's own overlay layer, `data-shell-overlay` — a container ABOVE the
 *               columns, which is why frosting it has consequences a column does not
 *   composer    the input area, `data-composer-*`
 *   dialogs     floating surfaces by WAI-ARIA role: dialog, menu, listbox, tooltip
 *   tokens      the `--dsw-alias-*` design-token layer every component reads
 *   background  the page background on `body`
 *
 * Two names the specification's example list suggests are deliberately absent. `navbar`: this shell
 * is a three-column frame and has no navigation bar. `settings`: the settings surface is a `dialog`
 * and is already covered by `dialogs`. Declaring a region that cannot be pointed at would make
 * every `modifies` list slightly less meaningful.
 */
export const REGION_SIDEBAR = 'sidebar'
export const REGION_CENTER = 'center'
export const REGION_RIGHTBAR = 'rightbar'
export const REGION_OVERLAY = 'overlay'
export const REGION_COMPOSER = 'composer'
export const REGION_DIALOGS = 'dialogs'
export const REGION_TOKENS = 'tokens'
export const REGION_BACKGROUND = 'background'

/** Every value `modifies` may contain. */
export const PROJECT_REGIONS = [
  REGION_SIDEBAR,
  REGION_CENTER,
  REGION_RIGHTBAR,
  REGION_OVERLAY,
  REGION_COMPOSER,
  REGION_DIALOGS,
  REGION_TOKENS,
  REGION_BACKGROUND,
]

/**
 * Rendering-budget tiers a project may declare in `perfLevel`, cheapest first.
 *
 * A tier is a DECLARATION, not a measurement: it is the heaviest effect the project was designed
 * for. The runtime compares the heaviest declared tier among the active projects against what the
 * device can afford, and publishes the LOWER of the two as `data-ui-perf` on the body. A stylesheet
 * reads that attribute as "the tier allowed right now", so `high` on a weak device gets the low
 * treatment, and a project declaring `low` never gets more than it asked for.
 */
export const PERF_LOW = 'low'
export const PERF_MEDIUM = 'medium'
export const PERF_HIGH = 'high'

/** Every value `perfLevel` may take, cheapest first — the ORDER is part of the contract. */
export const PROJECT_PERF_LEVELS = [PERF_LOW, PERF_MEDIUM, PERF_HIGH]

/**
 * Rank one tier for comparison. The order of `PROJECT_PERF_LEVELS` is the contract; this is only
 * its arithmetic — which is why it lives beside the list and not in `perf.js`: the registry needs
 * to compare tiers, and it has no business knowing anything about device signals.
 *
 * An unrecognised value ranks as the middle tier instead of throwing. Registration refuses unknown
 * tiers outright, so this is only reachable by a caller passing something odd, and a comparison
 * inside a diagnostic must never be the thing that takes a page down.
 * @param {unknown} level
 * @returns {number}
 */
export function rankOf(level) {
  if (level === PERF_LOW) return 0
  if (level === PERF_HIGH) return 2
  return 1
}
