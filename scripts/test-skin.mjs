/**
 * THE FRAMEWORK SUITE'S OWN SKIN, as data.
 *
 * One definition, in its own module, because more than one check needs it: `verify.mjs` mounts it through
 * the framework's service (the way an external package registers), and `host-check.mjs` hands its
 * stylesheet to `uiProjectsHost.bootRows` to assert the first-paint contract without naming any real
 * project. A second copy of these constants would be a fixture that could drift from the fixture.
 *
 * WHY A FIXTURE AT ALL. Until step 8 the framework shipped Liquid Glass inside itself and the suite used it
 * as its subject: every runtime, registry, panel and store test turned the skin on and asserted what
 * happened. That made the suite unable to tell "the framework works" from "Liquid Glass works". After 8c
 * the skin lives in its own package, so the framework needs a subject of its own — and its name says so:
 * `liquid-glass` in a framework test was always a borrowed noun.
 *
 * The package name is `test-skin-package` rather than the project id, deliberately: a card shows the
 * PACKAGE a project came from, and the fixture has to exercise that path to be worth anything.
 */

/** The project id the fixture contributes. */
export const TEST_SKIN_ID = 'test-skin'

/** The package the fixture claims to come from — distinct from the framework, which is the point. */
export const TEST_SKIN_PACKAGE = 'test-skin-package'

/** The manifest, shaped exactly like `dsh.uiProject`. */
export const TEST_SKIN_MANIFEST = {
  schemaVersion: 1,
  pluginApiVersion: 1,
  package: TEST_SKIN_PACKAGE,
  version: '1.0.0',
  id: TEST_SKIN_ID,
  name: 'Test Skin',
  description: 'The framework suite’s own skin. It exists to be a subject, not a look.',
  type: 'skin',
  scope: 'global',
  defaultEnabled: false,
  supports: ['light', 'dark', 'mobile'],
  perfLevel: 'high',
  testItems: [
    { id: 'one', label: 'The first thing a person should look at' },
    { id: 'two', label: 'The second thing' },
    { id: 'three', label: 'The third thing' },
  ],
  preview: 'linear-gradient(160deg, #f7f9ff 0%, #e6ecff 100%)',
  previewLabel: 'Test skin preview',
}

/**
 * The fixture's stylesheet, and every rule shape in it is there on purpose.
 *
 * A fixture that inserts one trivial rule would let thirty tests pass while testing nothing: the
 * framework's own claims are about what it does to REAL stylesheets — scoping conditionals, keeping
 * `:has()` in one piece, refusing an impossible selector, noticing a filter declaration, publishing a
 * tier. Each shape below exists because some assertion needs it:
 *
 *   1. a body-level token rule        → scoped to the marker itself; the first-paint shape
 *   2. a rule reaching a shipped surface by ARIA role → the "published interface, not a hash" rule
 *   3. `:has(… )::before` with a blur → the frost. The `::before` is NOT decoration: `backdrop-filter`
 *      creates a containing block, so a blur written directly on the column would capture every `fixed`
 *      descendant (the settings dialog). Liquid Glass learned that in 7d and the fixture keeps the shape
 *   4. an `@supports` branch           → a conditional the scoper must recurse into
 *   5. an `@supports not` branch       → the fallback shape a no-refraction device needs
 *   6. an `@media` branch              → the same, and the shape a contrast mode arrives in
 *   7. two tier variants               → `data-ui-perf` is read off the body, so the rule is authored
 *      as `body[data-ui-perf='…'] …` and the scoper must MERGE the marker into that compound rather
 *      than nest a second body inside it
 *
 * And two shapes it must NOT contain, because two rules kept in the framework suite as the skin author's
 * own contract assert their absence: no `backdrop-filter` on a container that holds every surface, and no
 * build-hashed class name.
 */
export const TEST_SKIN_CSS = `
:root {
  --ts-fill: rgb(255 255 255 / 82%);
  --ts-accent: #4d6bfe;
  --dsv-accent: var(--ts-accent);
}
[role='dialog'] {
  background: var(--ts-fill);
}
:has(> [data-ui-skin-column])::before {
  content: '';
  position: absolute;
  inset: 0;
  backdrop-filter: blur(20px);
}
@supports (backdrop-filter: blur(1px)) {
  [data-composer-card] {
    backdrop-filter: blur(20px);
  }
}
@supports not (backdrop-filter: blur(1px)) {
  :root {
    --ts-fill: rgb(255 255 255);
  }
}
@media (prefers-contrast: more) {
  :root {
    --ts-fill: rgb(255 255 255 / 97%);
  }
}
body[data-ui-perf='medium'] :has(> [data-ui-skin-column])::before {
  backdrop-filter: blur(16px);
}
body[data-ui-perf='low'] :has(> [data-ui-skin-column])::before {
  backdrop-filter: blur(12px);
}
`

/**
 * The fixture's FIRST-PAINT payload: already scoped, body-level rules only.
 *
 * A different thing from `TEST_SKIN_CSS` above, and the difference is the whole first-paint contract: the
 * runtime stylesheet is authored plainly and scoped by the client, while the sheet inlined into `<head>`
 * has no scoper to run — the host half inlines it verbatim — so a real skin's `boot.css` is written the way
 * the scoper WOULD have emitted it. `host-check.mjs` uses this one to assert the contract, because handing
 * it the runtime sheet would test the wrong shape (its selectors are deliberately unscoped).
 */
export const TEST_SKIN_BOOT_CSS = `body[data-ui-project-test-skin="on"]{ --ts-fill: rgb(255 255 255 / 82%); --ts-accent: #4d6bfe; }
@media (prefers-contrast: more){ body[data-ui-project-test-skin="on"]{ --ts-fill: rgb(255 255 255 / 97%); } }`

/** The fixture's definition: behaviour only, exactly as an external package hands one over. */
export const TEST_SKIN_DEFINITION = {
  apply(/** @type {any} */ ctx) {
    ctx.insertCss(TEST_SKIN_CSS)
    /*
     * Every skin that paints the frame needs the runtime's column seam (`data-ui-skin-column`), so the
     * fixture asks for it too — `glass.css` selects it through `:has(> [data-ui-skin-column])`, and the
     * retry/observer tests are about that request rather than about Liquid Glass.
     */
    ctx.markColumns()
  },
  cleanup() {},
}
