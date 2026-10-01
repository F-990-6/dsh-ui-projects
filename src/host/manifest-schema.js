/**
 * The `dsh.uiProject` manifest: its fields, its enumerations, and one validator.
 *
 * WHY THIS IS A MODULE AND NOT A LIST SOMEWHERE. Three consumers must agree on this field table:
 *
 *   `scripts/derive-manifest.mjs`  refuses an unknown field at BUILD time
 *   `src/host/conformance.js`      refuses it at CHECK time, for a package we did not build
 *   the client service (step 4)    validates at REGISTRATION time, and cannot import this file
 *
 * The first two import it. The third is a separate bundle and keeps its own minimal check, with a
 * test-time parity assertion instead of a shared import — the same arrangement
 * `PRESENCE_GLOBAL` and `UI_PROJECTS_SETTINGS_NAMESPACE` already use between the two halves.
 *
 * WHY UNKNOWN FIELDS ARE FATAL RATHER THAN IGNORED. `schemaVersion` says which version of THIS
 * table a package was written against. A package that declares a version we do not implement, or
 * a field this table does not contain, is a package whose author knows something we do not — and
 * the failure mode of carrying on is the bad one: the field is silently dropped, the project
 * registers with less than it declared, and nothing anywhere says so. Fail fast, name the field.
 *
 * (This is where step 1's wording was wrong: it lumped `schemaVersion` together with
 * `dshVersionHint` as "mismatch = warn". They are not the same kind of thing. `dshVersionHint` is
 * a claim about the dsh the package expects, and a claim can be advisory. `schemaVersion` is our
 * own contract version, and a mismatch means we cannot read the document at all.)
 */

/** The only manifest schema this build understands. */
export const SUPPORTED_MANIFEST_SCHEMA = 1

/** The plugin API majors this build understands — the entry↔framework contract, not the doc shape. */
export const SUPPORTED_PLUGIN_API = [1]

/**
 * Project kinds a PACKAGE may declare.
 *
 * Deliberately shorter than the registry's vocabulary: a package ships a look (`skin`) or an
 * addition to one (`enhancement`). Anything else the registry supports is the framework's own
 * business. `scripts/check-installed.test.mjs` asserts this list against `TYPE_*` in
 * `src/client/project-constants.js`, so the two cannot drift apart quietly.
 */
export const KNOWN_PROJECT_TYPES = ['skin', 'enhancement']

/** Scopes a package may declare. `component` is the registry's own default; `global` is a skin. */
export const KNOWN_SCOPES = ['global', 'component']

/** Capability flags the client understands, from `FEATURE_*` in `project-constants.js`. */
export const KNOWN_FEATURES = ['light', 'dark', 'mobile']

/** Effect tiers, from `PERF_*` in `project-constants.js`. */
export const KNOWN_PERF_LEVELS = ['low', 'medium', 'high']

/** The id shape the registry enforces. Duplicated there on purpose; asserted equal in the suite. */
export const ID_PATTERN = /^[a-z][a-z0-9-]{1,47}$/

/**
 * Every field of `dsh.uiProject`, in the order the generator writes them.
 *
 * `kind` is what the validator understands, not a JSON Schema: `enum` reads `values`, `enumList`
 * validates each element of an array, `testItems` and `controls` are the two structured lists.
 */
export const MANIFEST_FIELDS = [
  { field: 'schemaVersion', required: true, kind: 'number', note: 'which version of this table the package was written against' },
  { field: 'pluginApiVersion', required: true, kind: 'apiVersion' },
  { field: 'id', required: true, kind: 'id' },
  { field: 'name', required: true, kind: 'string' },
  { field: 'description', required: false, kind: 'string' },
  { field: 'type', required: true, kind: 'enum', values: KNOWN_PROJECT_TYPES },
  { field: 'scope', required: true, kind: 'enum', values: KNOWN_SCOPES },
  { field: 'defaultEnabled', required: false, kind: 'boolean' },
  { field: 'supports', required: false, kind: 'enumList', values: KNOWN_FEATURES },
  { field: 'perfLevel', required: false, kind: 'enum', values: KNOWN_PERF_LEVELS },
  { field: 'priority', required: false, kind: 'number' },
  { field: 'modifies', required: false, kind: 'stringList' },
  { field: 'requires', required: false, kind: 'idList' },
  { field: 'testItems', required: false, kind: 'testItems' },
  { field: 'preview', required: false, kind: 'string' },
  { field: 'previewLabel', required: false, kind: 'string' },
  { field: 'controls', required: false, kind: 'controls' },
  { field: 'dshVersionHint', required: false, kind: 'string', note: 'advisory: the checker does not compare it, the install flow does' },
  { field: 'runtimeDependencies', required: false, kind: 'stringList' },
]

/**
 * Check one manifest against the table above.
 *
 * Pure: no filesystem, no Cordis, no ambient state. Returns every issue it finds rather than the
 * first, because a package author fixing one field at a time is a worse experience than seeing the
 * whole list — and because the host's listing renders them side by side.
 *
 * @param {unknown} manifest the value of `dsh.uiProject`
 * @returns {Array<{ field: string, message: string, action: string }>}
 */
export function validateManifest(manifest) {
  /** @type {Array<{ field: string, message: string, action: string }>} */
  const issues = []
  const at = (field) => `dsh.uiProject.${field}`
  const add = (field, message, action) => issues.push({ field: at(field), message, action })

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [
      {
        field: 'dsh.uiProject',
        message: `expected an object, got ${Array.isArray(manifest) ? 'an array' : typeof manifest}`,
        action: 'declare dsh.uiProject as an object, or remove it to ship the package as an ordinary plugin',
      },
    ]
  }

  const declared = new Set(Object.keys(manifest))
  for (const name of declared) {
    if (!MANIFEST_FIELDS.some((entry) => entry.field === name)) {
      add(
        name,
        `unknown field (schema ${SUPPORTED_MANIFEST_SCHEMA} has no "${name}")`,
        'remove it, or bump schemaVersion and this build with it — an unknown field is dropped silently, which is worse',
      )
    }
  }

  for (const entry of MANIFEST_FIELDS) {
    const present = declared.has(entry.field)
    const value = manifest[entry.field]
    if (!present) {
      if (entry.required) {
        add(entry.field, 'required field is missing', `declare ${at(entry.field)}`)
      }
      continue
    }
    const complaint = checkValue(entry, value)
    if (complaint !== undefined) add(entry.field, complaint.message, complaint.action)
  }

  if (Array.isArray(manifest.testItems)) checkTestItems(manifest.testItems, add)
  if (Array.isArray(manifest.controls)) checkControls(manifest.controls, add)
  return issues
}

/**
 * One field against its `kind`.
 * @returns {{ message: string, action: string } | undefined}
 */
function checkValue(entry, value) {
  const list = (kind) => Array.isArray(value) && value.every((item) => kind(item))
  switch (entry.kind) {
    case 'number':
    case 'apiVersion':
      if (typeof value === 'number' && Number.isFinite(value)) return undefined
      if (entry.kind === 'apiVersion' && SUPPORTED_PLUGIN_API.includes(value)) return undefined
      if (entry.kind === 'apiVersion') {
        /*
         * THE REFUSAL CARRIES ITS OWN WAY OUT (E4, `UI第三阶段.txt:33-35`).
         *
         * The validation was already right — an unsupported API is refused, and `action` has said what to
         * do since it was written. What a reader SEES first, though, is the `message`, and "is not
         * supported" answers only half the question. Measured 2026-09-30: the desktop shell has no
         * `pluginApiVersion` concept at all (an asar scan found zero occurrences), so this sentence is the
         * whole of the guidance a user gets.
         */
        return {
          message: `pluginApiVersion ${JSON.stringify(value)} is not supported; upgrade dsh to a version that supports pluginApiVersion ${JSON.stringify(value)}, or install a build for ${SUPPORTED_PLUGIN_API.join(', ')}`,
          action: 'rebuild the package against a supported plugin API, or upgrade the framework first',
        }
      }
      return { message: `expected a number, got ${JSON.stringify(value)}`, action: `set ${entry.field} to a number` }
    case 'string':
      if (typeof value === 'string' && value.length > 0) return undefined
      return { message: `expected a non-empty string, got ${JSON.stringify(value)}`, action: `set ${entry.field} to a string` }
    case 'boolean':
      if (typeof value === 'boolean') return undefined
      return { message: `expected true or false, got ${JSON.stringify(value)}`, action: `set ${entry.field} to a boolean` }
    case 'id':
      if (typeof value === 'string' && ID_PATTERN.test(value)) return undefined
      return {
        message: `${JSON.stringify(value)} does not match ${ID_PATTERN}`,
        action: 'use 2–48 characters: a lowercase letter, then lowercase letters, digits or hyphens',
      }
    case 'enum':
      if (entry.values.includes(value)) return undefined
      return {
        message: `${JSON.stringify(value)} is not one of ${entry.values.join(', ')}`,
        action: `set ${entry.field} to ${entry.values.join(' or ')}`,
      }
    case 'stringList':
      if (list((item) => typeof item === 'string')) return undefined
      return { message: 'expected an array of strings', action: `set ${entry.field} to an array of strings` }
    case 'idList':
      if (list((item) => typeof item === 'string' && ID_PATTERN.test(item))) return undefined
      return { message: 'expected an array of project ids', action: `set ${entry.field} to an array of ids` }
    case 'enumList':
      if (list((item) => entry.values.includes(item))) return undefined
      return {
        message: `expected an array drawn from ${entry.values.join(', ')}`,
        action: `set ${entry.field} to a subset of ${entry.values.join(', ')}`,
      }
    case 'testItems':
      if (Array.isArray(value)) return undefined
      return { message: 'expected an array of { id, label }', action: 'declare testItems as an array' }
    case 'controls':
      if (Array.isArray(value)) return undefined
      return { message: 'expected an array of controls', action: 'declare controls as an array' }
    default:
      return { message: `unhandled field kind ${entry.kind}`, action: 'report this: the field table is inconsistent' }
  }
}

/**
 * The manual checklist.
 *
 * Ids must be unique, and that is not tidiness: the ticks are stored per id in the settings
 * document, so two items sharing an id would share a checkbox and one of them could never be
 * ticked on its own. The registry refuses this at registration too; catching it here means the
 * package author hears about it before installing.
 */
function checkTestItems(items, add) {
  const seen = new Map()
  items.forEach((item, index) => {
    const at = `testItems[${index}]`
    if (item === null || typeof item !== 'object') {
      add(at, 'expected an object with an id and a label', 'declare each test item as { id, label }')
      return
    }
    if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) {
      add(`${at}.id`, `${JSON.stringify(item.id)} does not match ${ID_PATTERN}`, 'use a lowercase hyphenated id')
      return
    }
    if (typeof item.label !== 'string' || item.label.trim() === '') {
      add(`${at}.label`, 'expected a non-empty label', 'write the sentence a person should confirm')
    }
    if (seen.has(item.id)) {
      add(
        `${at}.id`,
        `duplicate id ${JSON.stringify(item.id)}, already used by testItems[${seen.get(item.id)}]`,
        'give each item its own id — the ticks are stored per id, so duplicates share one checkbox',
      )
    } else {
      seen.set(item.id, index)
    }
  })
}

/**
 * The settings controls a project may declare.
 *
 * The shape is the one `store.js` binds: a project declares id/type/labelKey/min/max/step and the
 * runtime supplies the live value and the write path. Only `slider` exists today, and validating
 * the type here is what keeps a package from shipping a control the panel cannot render.
 */
function checkControls(controls, add) {
  controls.forEach((control, index) => {
    const at = `controls[${index}]`
    if (control === null || typeof control !== 'object') {
      add(at, 'expected an object', 'declare each control as { id, type, min, max, step, … }')
      return
    }
    if (typeof control.id !== 'string' || !ID_PATTERN.test(control.id)) {
      add(`${at}.id`, `${JSON.stringify(control.id)} does not match ${ID_PATTERN}`, 'use a lowercase hyphenated id')
    }
    if (control.type !== 'slider') {
      add(`${at}.type`, `${JSON.stringify(control.type)} is not a control this panel renders`, "use 'slider'")
    }
    for (const numeric of ['min', 'max', 'step', 'defaultValue']) {
      if (control[numeric] !== undefined && typeof control[numeric] !== 'number') {
        add(`${at}.${numeric}`, `expected a number, got ${JSON.stringify(control[numeric])}`, `set ${numeric} to a number`)
      }
    }
  })
}
