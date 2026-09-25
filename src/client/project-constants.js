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

/** Every value `supports` may take. */
export const PROJECT_FEATURES = [FEATURE_LIGHT, FEATURE_DARK, FEATURE_MOBILE]
