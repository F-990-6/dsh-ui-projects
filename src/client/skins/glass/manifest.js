/**
 * Liquid Glass — the manifest of the framework's BUILT-IN copy of it.
 *
 * A UI project's manifest is normally generated from the owning package's `package.json`
 * (`scripts/derive-manifest.mjs`), because a package is the thing that is installed, versioned and
 * uninstalled. A built-in project has no such package: the framework is what is installed. So this file
 * is written by hand, and the fields that differ from the package's own manifest are the ones that mean
 * something different here — each is called out below.
 *
 * FIVE FIELDS ARE THE BUILT-IN'S OWN — `package`, `builtIn`, `id` and the display `name` that goes with
 * it, and `version` (all four called out below). Every other field is the package's, word for word, so
 * the card a reader sees is the same card whichever copy is registered. `src/client/skins/index.js` reads
 * this manifest; the material itself lives beside it in `skin.js`, `tokens.css` and `glass.css`.
 *
 * THE ID IS DIFFERENT ON PURPOSE, and it is what lets both copies be installed at once. The package keeps
 * `liquid-glass`; this built-in is `glass`. Two ids mean there is no ownership conflict to resolve at all
 * — the service's "already registered by package X" refusal never fires — so a reader who has the package
 * installed sees TWO cards and picks one. They cannot both be on: `registry.conflictIds` keys on the
 * project's TYPE rather than on its id, so the one-skin policy already makes any two skins exclusive.
 *
 * THE CONSEQUENCE WORTH STATING: a reader who had the PACKAGE enabled has `liquid-glass` in their record,
 * and this built-in is a different id — so the built-in arrives OFF and is switched on once by hand. The
 * record is the reader's, and nothing migrates it.
 */

module.exports = {
  /*
   * `package` IS THE FRAMEWORK, not the skin package, and this is the field the service's ownership rule
   * reads: the id below belongs to whichever package name is here. With the ids differing, that rule has
   * nothing to refuse in the ordinary case — and it stays the right answer if a third party ever claims
   * `glass`, because two packages claiming one id is a mistake somebody has to see rather than a question
   * of precedence.
   */
  package: 'dsh-ui-projects',

  /*
   * `builtIn` MARKS THIS PROJECT AS THE FRAMEWORK'S OWN. It reaches the registry through `source`, and
   * that is where anything that needs to tell a built-in apart from an installed package reads it — the
   * panel's card and the diagnostics both get it from there. It used to be a yield switch for an id two
   * packages shared; the ids differ now, so it carries information rather than precedence.
   */
  builtIn: true,

  /*
   * THE VERSION IS THE MATERIAL'S, NOT THE FRAMEWORK'S, and this is a deliberate departure from the rule
   * `src/client/service.js` states for ordinary projects. The version is what a checklist confirmation is
   * stamped with, so tying it to the framework would invalidate every reader's confirmed checklist on
   * every framework patch — a change to the panel would mark the skin as unverified.
   *
   * IT USED TO TRACK THE SKIN PACKAGE, AND THAT PACKAGE IS GONE. This was the material's own line, continued
   * into this copy; the package froze on 2026-10-06 and was archived and deleted, so the line continues here.
   * 1.0.2 was the frost dropping to 2px and the first attempt at the reader's own message; 1.0.3 is that
   * message ACTUALLY following the material, because its own token had never been rebound and the selector
   * written for it could not do the job. Both on 2026-10-08.
   *
   * AND IT IS NOT DECORATION: it is the only thing in the settings card that says WHICH material is running.
   * It stayed at 1.0.1 across two visible changes, so the card went on claiming the old skin while the new
   * one was live — which is exactly how a reader concludes that a change never landed.
   */
  version: '1.0.3',

  schemaVersion: 1,
  pluginApiVersion: 1,
  id: 'glass',
  name: 'Glass',
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
  previewLabel: 'Glass frosted layers over a blue gradient',
}
