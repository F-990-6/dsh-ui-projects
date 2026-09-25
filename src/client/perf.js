/**
 * What the device can afford, and the effect tier that follows from it.
 *
 * WHY THIS IS A MODULE OF ITS OWN. Two things decide how heavy a skin is allowed to be, and they
 * come from opposite directions: a PROJECT declares what it was designed for (`perfLevel`), while
 * the DEVICE reports — always weakly — what it can render. The runtime combines them and publishes
 * one attribute; the device half lives here.
 *
 * Keeping it here is also what makes it testable. This suite's sandbox has no `navigator` and no
 * `requestAnimationFrame`, so any policy written as an effect on globals could not be exercised at
 * all; written as pure functions over a signals object, every branch is a unit test.
 *
 * EVERY THRESHOLD BELOW IS A HEURISTIC. They are named constants with their reasoning attached so
 * that a later reader can tune them against measurements instead of guessing at intent.
 */

import { PERF_LOW, PERF_MEDIUM, PERF_HIGH, rankOf } from './project-constants.js'

/** Core counts at or below which the device is assumed unable to afford the full treatment. */
export const LOW_CORE_COUNT = 2
export const MEDIUM_CORE_COUNT = 4

/**
 * Median frame interval (ms) above which the measured device is demoted.
 *
 * A 60Hz display delivers a frame every ~16.7ms, so `MEDIUM_FRAME_MS` is roughly "missing the
 * occasional frame" and `LOW_FRAME_MS` is roughly "missing one in three". Medians rather than means
 * because a single long frame during load must not decide the tier.
 */
export const MEDIUM_FRAME_MS = 18
export const LOW_FRAME_MS = 25

/** How long to let the page settle before measuring, how long to measure, and the floor to trust. */
export const FRAME_SETTLE_MS = 1200
export const FRAME_WINDOW_MS = 1000
export const FRAME_MIN_SAMPLES = 20

/**
 * The device signals available to this module, normalized to a plain object.
 *
 * `navigator.connection` is Chromium-only; absent means "no opinion", never "no". Both fields are
 * optional for that reason, and every consumer below tolerates an empty object.
 * @returns {{ saveData: boolean, cores: number | undefined }}
 */
export function readSignals() {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  const connection = nav?.connection
  return {
    saveData: connection?.saveData === true,
    cores: typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
  }
}

/**
 * The tier the device signals alone justify.
 *
 * `saveData` is the strongest signal available and the only one that is a statement of intent
 * rather than an inference: the user has asked the browser to spend less, and decoration is the
 * first thing that should obey. Core count is a weak proxy — coarse, and frequently wrong under
 * virtualisation — so it can only DEMOTE, and an unreadable count is treated as capable rather than
 * as suspect.
 *
 * `navigator.deviceMemory` is deliberately not consulted. It is Chromium-only and capped, so using
 * it would classify Firefox and Safari users by the absence of an API rather than by their
 * hardware.
 * @param {{ saveData?: boolean, cores?: number }} [signals]
 * @returns {'low'|'medium'|'high'}
 */
export function deviceLevel(signals = {}) {
  if (signals.saveData === true) return PERF_LOW
  const cores = signals.cores
  if (typeof cores !== 'number' || !Number.isFinite(cores) || cores <= 0) return PERF_HIGH
  if (cores <= LOW_CORE_COUNT) return PERF_LOW
  if (cores <= MEDIUM_CORE_COUNT) return PERF_MEDIUM
  return PERF_HIGH
}

/**
 * The lower of two tiers. `undefined` means "no opinion" and defers to the other side, which is
 * what lets an unmeasured device and an empty active set flow through the same code path.
 * @param {string | undefined} a
 * @param {string | undefined} b
 * @returns {string | undefined}
 */
export function minLevel(a, b) {
  if (a === undefined) return b
  if (b === undefined) return a
  return rankOf(a) <= rankOf(b) ? a : b
}

/**
 * The tier in force: the heaviest demand among the active projects, capped by the device.
 *
 * Returns `undefined` when nothing is active, and that is meaningful rather than an edge case — it
 * is what removes the attribute, so a page with no UI project carries no tier at all.
 * @param {Iterable<string | undefined>} demands
 * @param {string | undefined} device
 * @returns {string | undefined}
 */
export function combineLevels(demands, device) {
  let highest
  for (const level of demands ?? []) {
    if (typeof level !== 'string') continue
    if (highest === undefined || rankOf(level) > rankOf(highest)) highest = level
  }
  if (highest === undefined) return undefined
  return minLevel(highest, device)
}

/**
 * The median of a list of numbers, or `undefined` for an empty or unusable one.
 * @param {number[]} values
 * @returns {number | undefined}
 */
export function median(values) {
  const usable = (values ?? []).filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (usable.length === 0) return undefined
  const sorted = [...usable].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * The tier a measured median frame interval justifies, or `undefined` if there is nothing to judge.
 * @param {number | undefined} medianMs
 * @returns {'low'|'medium'|'high'|undefined}
 */
export function levelForFrameInterval(medianMs) {
  if (typeof medianMs !== 'number' || !Number.isFinite(medianMs) || medianMs <= 0) return undefined
  if (medianMs > LOW_FRAME_MS) return PERF_LOW
  if (medianMs > MEDIUM_FRAME_MS) return PERF_MEDIUM
  return PERF_HIGH
}

/**
 * Watch the frame interval for a moment and report the tier it justifies. Returns a disposer.
 *
 * Deliberately the only impure thing in this file, and deliberately the last resort: it runs a
 * second after the skin is applied (measuring during load would report the page's own work as the
 * skin's cost), takes a median rather than a mean, and refuses to judge on fewer than
 * `FRAME_MIN_SAMPLES` frames. A host without `requestAnimationFrame` — including this package's own
 * test sandbox — gets a no-op disposer rather than an exception.
 *
 * It can only ever DEMOTE: the caller lowers its device class to whatever comes back, so a fast
 * measurement never promotes a device that `saveData` already demoted.
 * @param {{ onLevel?: (level: string) => void, settleMs?: number, windowMs?: number, minSamples?: number }} [options]
 * @returns {() => void}
 */
export function createFrameProbe(options = {}) {
  const { onLevel } = options
  const settleMs = options.settleMs ?? FRAME_SETTLE_MS
  const windowMs = options.windowMs ?? FRAME_WINDOW_MS
  const minSamples = options.minSamples ?? FRAME_MIN_SAMPLES
  if (typeof onLevel !== 'function') return () => {}
  if (typeof requestAnimationFrame !== 'function' || typeof setTimeout !== 'function') return () => {}

  let cancelled = false
  /** @type {any} */
  let settle
  /** @type {any} */
  let frame
  /** @type {number[]} */
  const samples = []
  let previous
  let started

  const finish = () => {
    if (cancelled) return
    if (samples.length < minSamples) return
    const level = levelForFrameInterval(median(samples))
    if (level !== undefined) onLevel(level)
  }

  /** @param {number} timestamp */
  const tick = (timestamp) => {
    if (cancelled) return
    if (typeof timestamp === 'number') {
      if (previous !== undefined) samples.push(timestamp - previous)
      previous = timestamp
      if (started === undefined) started = timestamp
      if (timestamp - started >= windowMs) {
        finish()
        return
      }
    }
    frame = requestAnimationFrame(tick)
  }

  settle = setTimeout(() => {
    settle = undefined
    frame = requestAnimationFrame(tick)
  }, settleMs)

  return () => {
    cancelled = true
    if (settle !== undefined && typeof clearTimeout === 'function') clearTimeout(settle)
    if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  }
}
