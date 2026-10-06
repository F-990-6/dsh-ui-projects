/**
 * Liquid Glass — the skin, as a PACKAGE's client half defines it.
 *
 * This file is behaviour and nothing else: `apply` and `cleanup`. Every field that describes what the
 * project IS — its id, its name, its version, the tier it was designed for, its checklist, its preview —
 * lives in `package.json` → `dsh.uiProject`, is generated into `./manifest.generated.js`, and reaches the
 * registry through `ctx.uiProjects.register(manifest, definition)`. Nothing is written twice, so nothing
 * can drift: `scripts/derive-manifest.mjs --check` fails the build if the generated manifest is stale.
 *
 * WHAT THAT COSTS, AND WHY IT IS STILL THE RIGHT SHAPE. The project's version is now the PACKAGE's
 * version, so the first release under this name invalidates any checklist record the framework-era skin
 * had stamped `3.0.0`: the card reads `stale` once and the three items are re-confirmed. That is the
 * honest behaviour — a stamp that could disagree with the installed package would make a stale checklist
 * unreadable — and it is written down in `CHANGELOG.md` where a reader will meet it.
 *
 * ## The two lifecycle rules it has to keep
 *
 * **`apply` never throws.** The runtime calls it when the user turns the skin on, and a throw there
 * surfaces as a broken settings page rather than as a skin that failed to load. The body is wrapped: a
 * failure is reported through `ctx.fail` — which the settings card renders — and the record is cleared so
 * the plugin is left in the OFF state rather than a half-applied one.
 *
 * **`cleanup` is idempotent and assumes nothing.** The runtime may call it after a partially failed
 * `apply`, or twice, or during unload. It reads its record, deletes it, and only then acts, so a second
 * call finds nothing to do.
 *
 * ## What it does not do
 *
 * It owns no DOM, runs no observer and starts no timer: everything it contributes is a stylesheet handed
 * to the runtime, which owns both the scoping and the teardown. An earlier version mounted an ambient
 * gradient field and re-homed it with a `MutationObserver`; that cost a DOM layer the shell had to measure
 * around, and the trade is recorded at the end of this file.
 */

const tokensCss = require('./tokens.css')
const glassCss = require('./glass.css')

/**
 * The behaviour this package contributes, as a FACTORY.
 *
 * A function rather than a module-level object because the definition is handed to
 * `ctx.uiProjects.register(manifest, definition)`, and a factory gives each registration its own state.
 * The framework's older built-in version exported the object directly, which was fine while exactly one
 * caller existed; a package should not assume that.
 * @returns {{ apply: (ctx: any) => void, cleanup: (ctx: any) => void }}
 */
function createLiquidGlass() {
  /**
   * Which project ids are currently applied.
   *
   * Per-definition rather than per-module, and it is the whole of `cleanup`'s idempotence: the entry is
   * deleted *before* anything else happens, so a second call finds nothing and does nothing.
   */
  const applied = new Set()

  return {
    /**
     * @param {import('dsh-ui-projects/registry').UiProjectContext} ctx
     */
    apply(ctx) {
      try {
        // Idempotent: a second apply must not stack a second set of stylesheets. The runtime does not
        // currently call it twice, but nothing in its contract forbids it either.
        if (applied.has(ctx.id)) return

        // Two sheets, in one deliberate order:
        //   1. `tokens.css` re-binds the shipped alias tokens to translucent fills, which is what turns
        //      every component that already consumes them to glass. This is the sanctioned extension
        //      point: no component is named, so nothing here can break when the client's markup changes.
        //   2. `glass.css` adds what a token cannot express — the frost layer, which needs a selector —
        //      plus the `--lg-*` vocabulary and the system background.
        // Both inserts are owned by the runtime and removed with this project.
        ctx.insertCss(tokensCss)
        ctx.insertCss(glassCss)

        // Ask the runtime to stamp the application's real layout columns. `glass.css` selects the frame
        // through `:has(> [data-ui-skin-column])`, so this call is what gives that selector something to
        // match — the frost has no other DOM hook.
        ctx.markColumns()

        // The shell's boot page is never removed once the application mounts, and the two share `#root`
        // as full-height children — so the container ends up about twice the viewport and the page
        // scrolls to a second screen. The runtime owns the judgement of when it is genuinely in the way;
        // this only asks.
        ctx.dismissBootPage?.()

        applied.add(ctx.id)
      } catch (error) {
        // Roll back to the OFF state rather than leaving a half-applied skin behind, then report it.
        // Swallowing the throw is the point: see the header. The stylesheets need no unwinding here —
        // `ctx.insertCss` handed them to the runtime, which removes them.
        applied.delete(ctx.id)
        ctx.fail(error instanceof Error ? error : new Error(String(error)))
        console.warn('[dsh-plugin-liquid-glass] apply failed; the skin was rolled back to off', error)
      }
    },

    /**
     * @param {import('dsh-ui-projects/registry').UiProjectContext} ctx
     */
    cleanup(ctx) {
      // Nothing to release, and that is the design: no DOM, no observer, no timer, and the stylesheets
      // belong to the runtime. Clearing the record is what makes a re-apply possible, and what makes a
      // second cleanup a no-op.
      applied.delete(ctx.id)
    },
  }
}

module.exports = { createLiquidGlass }

/*
 * ## What this version trades away, on purpose
 *
 * The ambient gradient field is gone, and with it the only content the frost had to refract. The
 * specification requires "content or a gradient" behind frosted glass, and on a still page over a flat
 * system background there is now neither: the material is visible through its fill, its hairline edge,
 * its shadow and its inner highlight, but the blur itself has almost nothing to act on.
 *
 * It is kept this way because the alternative proved expensive. A gradient layer means an element the
 * shell has to measure around, a host to find, and a watcher to keep it there — and two earlier attempts
 * at exactly that produced a collapsed sidebar and a background that silently went missing after a reload.
 *
 * Restoring visible refraction means giving the page a gradient instead of a flat colour, which is a
 * change in `glass.css` alone and nothing here.
 */
