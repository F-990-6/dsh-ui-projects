/**
 * Liquid Glass — the manifest of the framework's BUILT-IN copy of it.
 *
 * A UI project's manifest is normally generated from the owning package's `package.json`
 * (`scripts/derive-manifest.mjs`), because a package is the thing that is installed, versioned and
 * uninstalled. A built-in project has no such package: the framework is what is installed. So this file
 * is written by hand, and the three fields that differ from the package's own manifest are the ones that
 * mean something different here — each is called out below.
 *
 * EVERY OTHER FIELD IS THE PACKAGE'S, WORD FOR WORD, and that is deliberate: the card a reader sees has
 * to be the same card whichever copy is registered. `src/client/skins/index.js` reads this manifest; the
 * material itself lives beside it in `skin.js`, `tokens.css` and `glass.css`.
 */

module.exports = {
  /*
   * `package` IS THE FRAMEWORK, not the skin package, and this is the field the service's ownership rule
   * reads: the id below is owned by whichever package name is here, and that is what lets the framework
   * tell its own default apart from a third party's project with the same id. See the takeover rule in
   * `src/client/service.js` — a built-in copy yields to the package that owns the id.
   */
  package: 'dsh-ui-projects',

  /*
   * `builtIn` IS THE FLAG THAT MAKES IT YIELD. It reaches the registry through `source`, and the service
   * treats an id owned by a built-in entry as a DEFAULT rather than as an occupied id: a package that
   * registers the same id takes it over, and the built-in is retired rather than the package refused.
   */
  builtIn: true,

  /*
   * THE VERSION IS THE MATERIAL'S, NOT THE FRAMEWORK'S, and this is a deliberate departure from the rule
   * `src/client/service.js` states for ordinary projects. The version is what a checklist confirmation is
   * stamped with, so tying it to the framework would invalidate every reader's confirmed checklist on
   * every framework patch — a change to the panel would mark the skin as unverified. It tracks the
   * version of the skin package this copy came from, and moves when the material moves.
   */
  version: '1.0.1',

  schemaVersion: 1,
  pluginApiVersion: 1,
  id: 'liquid-glass',
  name: 'Liquid Glass',
  description:
    'Translucent frosted layers with the system accent and generous rounding. Real blur over the system background, in light and dark.',
  type: 'skin',
  scope: 'global',
  defaultEnabled: false,
  supports: ['light', 'dark', 'mobile'],
  perfLevel: 'high',
  testItems: [
    { id: 'text-readable', label: 'Text over the glass is comfortable to read, in light and dark' },
    { id: 'settings-centred', label: 'Settings opens centred over the whole window, not inside a column' },
    { id: 'no-first-frame-flash', label: 'Reopening dsh shows the skin on the first frame, with no flash' },
  ],
  preview:
    'radial-gradient(120% 100% at 10% 0%, rgb(0 122 255 / 45%) 0%, transparent 60%),radial-gradient(100% 100% at 90% 20%, rgb(10 132 255 / 40%) 0%, transparent 60%),linear-gradient(160deg, #f7f9ff 0%, #e6ecff 100%)',
  previewLabel: 'Liquid Glass frosted layers over a blue gradient',
}
