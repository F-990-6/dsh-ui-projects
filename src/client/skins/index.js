/**
 * The built-in UI projects this package ships.
 *
 * ONE LIST, ONE ENTRY PER SKIN, and the client half registers whatever is here — so adding a built-in
 * skin is a directory beside this file and one line below, and nothing in `src/client/index.js` moves.
 * That is the same shape the registry gives external packages (`ctx.uiProjects.register(manifest,
 * definition)`), which is the point: a built-in project is not a special kind of project, it is one whose
 * manifest happens to live in this package.
 *
 * WHAT AN ENTRY IS, and why these three things:
 *
 *   manifest        the fields the card shows and the registry keys on. Hand-written here for a built-in
 *                   (see `./glass/manifest.js`), generated from `package.json` for a package.
 *   create()        the behaviour — `apply` and `cleanup` and nothing else. A FACTORY, because a
 *                   registration owns its own state and the registry may register the same definition
 *                   twice across a reload.
 *   installOverlay() an optional sheet inserted outside the scoped path, for the surfaces the scoped path
 *                   cannot out-specify. Most projects have none; see `./glass/overlay.js` for why
 *                   this one does.
 *
 * NOTHING HERE IS REQUIRED AT LOAD TIME BY `src/client/index.js`'s MODULE SCOPE — only from inside
 * `apply`. The framework's client half is under a load-time contract (its own suite asserts it): the dsh
 * loader materializes the module before it calls `apply`, against a module table that answers only the
 * shell's frozen modules, so a load-time `require` of anything outside that table makes the whole plugin
 * fail to load.
 */
const manifest = require('./glass/manifest.js')
const { createLiquidGlass } = require('./glass/skin.js')
const { installOverlay, removeOverlay } = require('./glass/overlay.js')

module.exports = {
  BUILT_IN_PROJECTS: [{ manifest, create: createLiquidGlass, installOverlay, removeOverlay }],
}
