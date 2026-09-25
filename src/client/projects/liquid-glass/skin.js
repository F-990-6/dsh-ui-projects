/**
 * Liquid Glass — the first UI project.
 *
 * An iOS-style translucent material: frosted layers, hairline highlights, large radii, and
 * depth built from real translucency, in the restrained blue of the system accent.
 *
 * ## What this file is, and is not
 *
 * The registry definition and nothing else: identity, capability flags, and the two lifecycle
 * hooks. It owns **no DOM**, runs **no observer**, starts **no timer**, and names no component.
 * Everything it contributes is a stylesheet handed to the runtime, which owns both the scoping
 * and the teardown.
 *
 * That is a deliberate narrowing. An earlier version mounted an ambient gradient field behind
 * the application and re-homed it with a `MutationObserver`, because glass with nothing behind
 * it has nothing to refract. It cost a DOM layer the shell had to measure around, and it is
 * gone. What that trades away is written down at the end of this file.
 *
 * ## The two lifecycle rules it has to keep
 *
 * **`apply` never throws.** The runtime calls it when the user turns the skin on, and a throw
 * there surfaces as a broken settings page rather than as a skin that failed to load. The body
 * is wrapped: a failure is reported through `ctx.fail` — which the settings card renders — and
 * the record is cleared so the plugin is left in the OFF state rather than a half-applied one.
 *
 * **`cleanup` is idempotent and assumes nothing.** The runtime may call it after a partially
 * failed `apply`, or twice, or during unload. It reads its record, deletes it, and only then
 * acts, so a second call finds nothing to do.
 *
 * ## What it no longer does
 *
 * An earlier version forced the shipped settings dialog's geometry from outside, using dsh's
 * build-hashed CSS-module classes, inline `!important`, and a 400 ms re-apply interval. That is
 * gone. `glass.css` documents why, and what replaced it.
 */

const { TYPE_SKIN, FEATURE_LIGHT, FEATURE_DARK, FEATURE_MOBILE, PERF_HIGH } = require('../../project-constants.js')
const tokensCss = require('./tokens.css')
const glassCss = require('./glass.css')

/**
 * Thumbnail: the project's own material, in miniature.
 *
 * A CSS gradient rather than a shipped image, so the card costs no asset and cannot drift out
 * of date with the palette.
 */
const PREVIEW =
  'radial-gradient(120% 100% at 10% 0%, rgb(0 122 255 / 45%) 0%, transparent 60%),' +
  'radial-gradient(100% 100% at 90% 20%, rgb(10 132 255 / 40%) 0%, transparent 60%),' +
  'linear-gradient(160deg, #f7f9ff 0%, #e6ecff 100%)'

/**
 * Which project ids are currently applied.
 *
 * Module scope because the definition object is a singleton shared by the registry, while
 * `apply` and `cleanup` are called per activation. This set is also the whole of `cleanup`'s
 * idempotence: the entry is deleted *before* anything else happens, so a second call finds
 * nothing and does nothing.
 */
const applied = new Set()

/** @type {import('../../registry.js').UiProjectDefinition} */
module.exports = {
  id: 'liquid-glass',
  name: 'Liquid Glass',
  description:
    'Translucent frosted layers with the system accent and generous rounding. Real blur over the system background, in light and dark.',
  // 3.0.0: the material is rebuilt around one frame-level frost layer, and the skin no longer
  // mounts anything into the DOM. The major moved because the visual result changes.
  version: '3.0.0',
  type: TYPE_SKIN,
  defaultEnabled: false,
  scope: 'global',
  supports: [FEATURE_LIGHT, FEATURE_DARK, FEATURE_MOBILE],
  /*
   * `high`, honestly: this is a full-viewport `backdrop-filter`-backed material, and the tier
   * exists so that a device which cannot afford it gets the 16px or 12px treatment instead of the
   * full 20px. Declaring `medium` here to "be safe" would move the decision away from the device,
   * which is the only thing that can actually measure it.
   */
  perfLevel: PERF_HIGH,
  /*
   * What a person should look at before calling this skin verified.
   *
   * These are the three failures this project actually shipped and had reported back, in the order
   * they hurt: text that could not be read over the glass, a settings dialog that collapsed into the
   * left column, and a first frame that arrived in the default look before switching. A checklist
   * that repeats the specification is decoration; one that repeats the incident history is worth
   * ticking.
   */
  testItems: [
    { id: 'text-readable', label: 'Text over the glass is comfortable to read, in light and dark' },
    { id: 'settings-centred', label: 'Settings opens centred over the whole window, not inside a column' },
    { id: 'no-first-frame-flash', label: 'Reopening dsh shows the skin on the first frame, with no flash' },
  ],
  preview: PREVIEW,
  previewLabel: 'Liquid Glass frosted layers over a blue gradient',

  /**
   * @param {import('../../registry.js').UiProjectContext} ctx
   */
  apply(ctx) {
    try {
      // Idempotent: a second apply must not stack a second set of stylesheets. The runtime does
      // not currently call it twice, but nothing in its contract forbids it either.
      if (applied.has(ctx.id)) return

      // Two sheets, in one deliberate order:
      //   1. `tokens.css` re-binds the shipped alias tokens to translucent fills, which is what
      //      turns every component that already consumes them to glass. This is the sanctioned
      //      extension point: no component is named, so nothing here can break when the
      //      client's markup changes.
      //   2. `glass.css` adds what a token cannot express — the frost layer, which needs a
      //      selector — plus the `--lg-*` vocabulary and the system background.
      // Both inserts are owned by the runtime and removed with this project.
      ctx.insertCss(tokensCss)
      ctx.insertCss(glassCss)

      // Ask the runtime to stamp the application's real layout columns. `glass.css` selects the
      // frame through `:has(> [data-ui-skin-column])`, so this call is what gives that selector
      // something to match — the frost has no other DOM hook.
      ctx.markColumns()

      // The shell's boot page is never removed once the application mounts, and the two share
      // `#root` as full-height children — so the container ends up about twice the viewport and
      // the page scrolls to a second screen. The runtime owns the judgement of when it is
      // genuinely in the way; this only asks.
      ctx.dismissBootPage?.()

      applied.add(ctx.id)
    } catch (error) {
      // Roll back to the OFF state rather than leaving a half-applied skin behind, then report
      // it. Swallowing the throw is the point: see the header. The stylesheets need no
      // unwinding here — `ctx.insertCss` handed them to the runtime, which removes them.
      applied.delete(ctx.id)
      ctx.fail(error instanceof Error ? error : new Error(String(error)))
      console.warn('[dsh-ui-projects] liquid-glass: apply failed; the skin was rolled back to off', error)
    }
  },

  /**
   * @param {import('../../registry.js').UiProjectContext} ctx
   */
  cleanup(ctx) {
    // Nothing to release, and that is the design: no DOM, no observer, no timer, and the
    // stylesheets belong to the runtime. Clearing the record is what makes a re-apply possible,
    // and what makes a second cleanup a no-op.
    applied.delete(ctx.id)
  },

  /**
   * No controls.
   *
   * The material is fixed at the setting the design holds together at, and it is deliberately
   * not a user-tunable: an opacity dial invites setting the material to a value it was never
   * tuned for.
   *
   * A project MAY declare controls here, and the settings page renders whatever it finds
   * without knowing what any of it means — `store.js` documents the shape. If one is ever
   * added, its value persists through `ctx.writeSetting`, which lands in the shared
   * `ui-projects` settings record. Never a project-specific storage key.
   */
  controls: [],
}

/*
 * ## What this version trades away, on purpose
 *
 * The ambient gradient field is gone, and with it the only content the frost had to refract.
 * The specification requires "content or a gradient" behind frosted glass, and on a still page
 * over a flat system background there is now neither: the material is visible through its fill,
 * its hairline edge, its shadow and its inner highlight, but the blur itself has almost nothing
 * to act on.
 *
 * It is kept this way because the alternative proved expensive. A gradient layer means an
 * element the shell has to measure around, a host to find, and a watcher to keep it there — and
 * two earlier attempts at exactly that produced a collapsed sidebar and a background that
 * silently went missing after a reload.
 *
 * Restoring visible refraction means giving the page a gradient instead of a flat colour, which
 * is a change in `glass.css` alone and nothing here. That is the intended next step if the
 * material reads too flat in use.
 */
