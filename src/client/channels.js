/**
 * The update channel of a package, and how the column's rows are composed from three sources.
 *
 * WHERE A CHANNEL LIVES. In the settings record this plugin already owns — the `ui-projects` namespace of
 * the dsh settings document — as `settings['<package name>'].channel`. That is one document, one record
 * shape, and one place to look; a second storage key for one field would be a second thing that can
 * disagree with the first. The record's `settings` map is otherwise keyed by PROJECT id, and a package
 * name never looks like one (an id has no `/`), so the two key spaces cannot be confused by accident.
 *
 * WHY THE THREE NAMES ARE HERE AND ALSO IN THE HOST HALF. The two halves are separate bundles and share
 * no module, so the list is duplicated the same way the settings NAMESPACE already is — and for the same
 * reason it is a constant rather than a literal in two places. `scripts/host-check.mjs` asserts the
 * namespace agrees across the halves; the channel list is asserted against the host's checker in
 * `scripts/verify.mjs`, so a rename on one side is a red suite rather than a silent disagreement.
 *
 * WHAT `mergeUpdates` IS FOR. A row needs three facts from three places: the scan (what is installed and
 * what version), the settings record (which channel its user chose) and the registry answer (what that
 * channel's tag holds now). Composing them is pure — three in, one out — which is what makes "a check
 * that FAILED is not an update" a testable statement instead of a rendering accident.
 */

/** The three channels, in the order the UI offers them. Mirrors `src/host/update-check.js`. */
export const CHANNELS = ['stable', 'beta', 'canary']

/** What a package is on until its user says otherwise. */
export const DEFAULT_CHANNEL = 'stable'

/** Whether a value is a channel this build knows. */
export function isChannel(value) {
  return CHANNELS.includes(value)
}

/**
 * The channel a package is on, read out of the record.
 *
 * Anything that is not one of the three known names reads as the default: a record written by a newer
 * build, or edited by hand, must not be able to make a row undecidable.
 * @param {unknown} record @param {string} name
 */
export function read(record, name) {
  const entry = /** @type {any} */ (record)?.settings?.[name]
  return isChannel(entry?.channel) ? entry.channel : DEFAULT_CHANNEL
}

/**
 * Set a package's channel, refusing anything else BY NAME.
 *
 * A refusal rather than a fallback: silently storing `stable` for a typo would answer the next question
 * ("why is this package not on beta?") with a row that looks correct. The record is validated BEFORE it
 * is touched, so a refused write leaves the value it had.
 * @param {any} record @param {string} name @param {unknown} value
 */
export function write(record, name, value) {
  if (!isChannel(value)) {
    throw new Error(`unknown update channel ${JSON.stringify(value)}; this build knows ${CHANNELS.join(', ')}`)
  }
  if (record.settings === undefined || record.settings === null || typeof record.settings !== 'object') record.settings = {}
  const entry = record.settings[name]
  record.settings[name] = { ...(entry !== null && typeof entry === 'object' ? entry : {}), channel: value }
  return record
}

/**
 * The ten-item test checklist a package's per-package record carries, or `null` when nothing is recorded.
 *
 * SAME SHAPE AS THE CHANNEL (see `read` above), and the same strictness as the gate it feeds: only
 * `value === true` counts, because `isComplete` in `src/host/test-checklist.js` requires exactly `true`.
 * Being more generous here would produce the one outcome nobody could explain — a row that shows every box
 * ticked while the gate still refuses to mark the version tested.
 * @param {unknown} record @param {string} name
 * @returns {Record<string, boolean> | null}
 */
export function readChecklist(record, name) {
  const entry = /** @type {any} */ (record)?.settings?.[name]?.checklist
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  /** @type {Record<string, boolean>} */
  const out = {}
  for (const [key, value] of Object.entries(entry)) if (value === true) out[key] = true
  return out
}

/*
 * The checklist ids come from the client-side MIRROR (`checklist-items.js`), never from the host module:
 * the two halves are separate bundles, and this file is part of the client one. Declared here rather than
 * at the top only because this is where the change landed; ESM hoists imports.
 */
import { CHECKLIST_IDS } from './checklist-items.js'

/**
 * Confirm (or un-confirm) one checklist item, MERGING like the channel write does.
 *
 * `checklist` and `channel` live in the SAME per-package entry, so a write to one must not erase the
 * other — the record is the user's data, and half of it disappearing because they ticked a box would be
 * the kind of loss that is hard to notice and impossible to forgive.
 * @param {any} record @param {string} name @param {string} itemId @param {boolean} checked
 */
export function writeChecklist(record, name, itemId, checked) {
  /*
   * REFUSED BY NAME, like an unknown channel (`write` above): a checkbox wired to a typo — or a caller
   * that invented an id — must not be able to put a key in the user's record that no surface will ever
   * read or clear. The whitelist is DERIVED from the mirror, so adding an item cannot leave it behind.
   */
  if (!CHECKLIST_IDS.includes(itemId)) {
    throw new Error(
      `unknown checklist item ${JSON.stringify(itemId)}; this build checks ${CHECKLIST_IDS.join(', ')}`,
    )
  }
  if (record.settings === undefined || record.settings === null || typeof record.settings !== 'object') record.settings = {}
  const entry = record.settings[name]
  const kept = entry !== null && typeof entry === 'object' ? entry : {}
  const previous =
    kept.checklist !== null && typeof kept.checklist === 'object' && !Array.isArray(kept.checklist) ? kept.checklist : {}
  const checklist = { ...previous }
  if (checked === true) checklist[itemId] = true
  else delete checklist[itemId]
  record.settings[name] = { ...kept, checklist }
  return record
}

/**
 * The row data: the scan's dependencies, each carrying its channel and what the registry said.
 *
 * THREE STATES, AND ONLY ONE OF THEM IS AN UPDATE. A check that answered with a newer version, a check
 * that failed, and a package nobody asked about all end up with `update.available === false` unless the
 * registry really named a newer version — the failure keeps its `error`, so a row can say "could not
 * check" instead of implying "up to date", and a package with no result at all is simply not offered.
 * @param {any} scan @param {unknown} record @param {any} updates
 */
export function mergeUpdates(scan, record, updates) {
  const results = new Map()
  for (const entry of updates?.results ?? []) {
    if (entry !== null && typeof entry === 'object' && typeof entry.name === 'string') results.set(entry.name, entry)
  }
  return {
    ...scan,
    dependencies: (scan?.dependencies ?? []).map((dependency) => {
      const channel = read(record, dependency.name)
      /*
       * The checklist travels WITH the row, like the channel: the panel renders it from the row alone, and
       * `null` means "nothing recorded yet" — a different sentence from "recorded, nothing confirmed".
       */
      const checklist = readChecklist(record, dependency.name)
      const found = results.get(dependency.name)
      /*
       * "I could not check" must never read as "you are up to date", so a result that is absent OR that
       * carries a reason is not an update — and the reason travels with it, which is what lets a row say
       * which of the two happened.
       */
      const failed = found === undefined || (found.error !== null && found.error !== undefined)
      return {
        ...dependency,
        channel,
        checklist,
        update: {
          name: dependency.name,
          channel,
          tag: found?.tag ?? null,
          latest: found?.latest ?? null,
          available: failed ? false : found.available === true,
          error: found?.error ?? null,
          timedOut: found?.timedOut === true,
        },
      }
    }),
  }
}
