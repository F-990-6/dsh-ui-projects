# dsh-ui-projects

An extensible **UI project system** for the dsh Web GUI, plus the **Settings › UI**
section that manages it. The first UI project it ships is **Liquid Glass**, a
translucent skin in the iOS material tradition with the DeepSeek blue-violet accent.

Two properties define the design:

1. **Adding a UI project never touches the settings page.** The page renders whatever
   the registry contains — no project id, name or option is hard-coded there.
2. **Turning a project off leaves nothing behind.** Every effect a project creates is
   owned by the runtime and disposed on disable, and a project's stylesheet is scoped
   to a root marker so it cannot apply while the project is off — even by accident.

---

## Install

The plugin installs into a dsh **profile**, because a Loader row is what makes the
`dsh.client` declaration real and gets the browser half served.

```powershell
# 1. Build the browser bundle (no bundler needed; see scripts/build.mjs)
cd E:\dsh\plugins\dsh-ui-projects
npm run build

# 2. Register it in the web profile
dsh plugin --profile web add E:\dsh\plugins\dsh-ui-projects
```

That command links the package into `$DSH_HOME/profiles/web/node_modules`, adds it to
the profile's `dsh.profile.bundles`, and applies this package's `cordis.patch.yml`,
which inserts one host row:

```yaml
- insert:
    - id: ui-projects
      name: dsh-ui-projects
```

Restart the web process (`dsh web`) afterwards. Then open **Settings › UI**.

## Uninstall / roll back

Remove `dsh-ui-projects` from `dsh.profile.bundles` in
`$DSH_HOME/profiles/web/package.json` (and from `dependencies`), delete the link in
`$DSH_HOME/profiles/web/node_modules/`, and restart. Nothing else in dsh was modified:
no core package, no route, no business plugin. Any state the plugin persisted lives in
`ui-projects` in `$DSH_HOME/settings.yaml`, or under the `dsh.ui-projects.v1`
`localStorage` key.

---

## Architecture

```
src/host/index.js                 host row: makes the browser half reachable
src/client/
  index.js                        composition root: registry + persistence + runtime + settings section
  project-constants.js            the shared vocabulary (skin/enhancement, light/dark/mobile)
  registry.js                     what UI projects exist, and the enable/disable policy
  persist.js                      where state lives (dsh settings document, else localStorage)
  runtime.js                      the only module that touches the DOM; applies and cleans up
  scope-css.js                    rewrites a project's CSS so it can only apply while active
  store.js                        what the settings page reads
  panel.js                        the Settings › UI page, rendered from the registry alone
  locale.js                       copy for the two shipped locales
  styles/core.css                 the Settings › UI page chrome (`.uip-*`) and nothing else
  projects/liquid-glass/
    skin.js                       Liquid Glass: metadata, apply, cleanup
    tokens.css                    re-binds the shipped alias tokens to translucent fills
    glass.css                     the skin's own `--lg-*` vocabulary, the material, the gradient
```

### The shape of a UI project

```js
{
  id: 'liquid-glass',            // stable key; drives `data-ui-project-<id>` and persistence
  name: 'Liquid Glass',
  description: '…',              // one sentence, shown on the card
  version: '1.0.0',
  type: 'skin',                  // 'skin' | 'enhancement' — see policy below
  defaultEnabled: false,         // a skin ships off; the user turns it on
  scope: 'global',               // 'global' | 'layout' | 'component'
  supports: ['light', 'dark', 'mobile'],
  preview: 'radial-gradient(…)', // a CSS background, or an image path
  apply(ctx) { … },              // runs while active
  cleanup(ctx) { … },            // optional extra teardown; must be idempotent
}
```

### Policy

| | |
|---|---|
| `skin` | Global look. **Mutually exclusive** — enabling one disables the previous one first, so the document never carries two. |
| `enhancement` | Composable. Any number may be active at once. |
| `requires` | Ids that must be active too; the runtime enables them transitively before applying. |
| failure | A project whose `apply` throws is rolled back and its card reports the error instead of pretending it is on. |

### What `apply` receives

A hermetic context. Anything that must be undone goes through it, so a project never
removes its own CSS:

| member | purpose |
|---|---|
| `insertCss(css)` | Inject project-owned CSS. The runtime scopes it to `html[data-ui-project-<id>="on"]` first, and removes it on cleanup. |
| `overrideTokens(source, tokens)` | Stack alias-token overrides over the active theme (`{ light, dark }` per token). Removed on cleanup. |
| `selector` / `root` | The project's marker selector and the document element. |
| `fail(err)` | Report a non-fatal problem; the card shows it. |
| `readSetting` / `writeSetting` | Project-private options, stored in this plugin's own record. |

A project that needs real DOM may create it in `apply` and remove it in `cleanup`. Liquid Glass
deliberately does NOT: the gradient its frost refracts is painted in CSS, and the one `::before`
layer the skin does create belongs to a stylesheet the runtime scopes and removes for it. An
earlier version mounted a DOM layer under `<body>` instead, and that is what collapsed the
sidebar to a rail.

### What else a project can declare

| member | purpose |
|---|---|
| `markColumns()` | Mark the application's layout columns with `data-ui-skin-column`, and return the disposer. Frost must go on the columns and never on the frame's whole-viewport overlay container — blurring that softens every column at once, including the one being read. The runtime finds the frame by asking the DOM (a grid with a multi-track template), keeps only the children that actually occupy it, and **retries**, because the shell has not mounted yet when a project is first applied. That retry is **bounded**: it stops as soon as the columns are marked, and five seconds after activation at the latest. The `MutationObserver` behind it is not bounded and is never disconnected — a re-render that replaces the columns is a DOM mutation, so it is the observer, not the timer, that keeps the marking correct for the life of the project. A retry that gives up does not call `fail()`: the project stays enabled and a frame that appears later is still marked. |
| `dismissBootPage()` | Remove the shell's boot page if it is still occupying `#root` beside the application. The shipped frontend never removes it, and both are full-height children of the same container, so the page ends up about twice the viewport tall — it scrolls to a second screen and the application's own layout is measured against a box twice the size of the window. Removes nothing unless the container is genuinely oversized, so a slow boot is untouched. `watchBootPage()` drives it with the same bounded retry, and tears the whole watcher down once the page is gone. |
| `controls` (on the definition) | Controls the settings card renders: `{ id, type: 'slider', labelKey, min, max, step, defaultValue, storageKey }`. Each control is self-describing, so neither the settings page nor the store needs any vocabulary of its own — a project declares a slider and gets one. **Liquid Glass declares none**: its material has one fixed look, described below. |

#### Two rules about `:where()`, learned the hard way

Selectors in a project stylesheet are scoped to the project's marker. Whether to reach for
`:where()` depends entirely on whether the shipped CSS already declares the property:

- **Use `:where()` to avoid a fight.** `:where()` has zero specificity, so a component that wants
  its own `backdrop-filter` still wins. The frost on columns and dialogs is written this way.
- **Do not use `:where()` to win one.** The cost-meter plugin declares `.cm-root{display:block}` —
  specificity `(0,1,0)` — so `:where(.cm-root){visibility:hidden}` at `(0,0,0)` loses, and the rule is
  silently dead. Anything that must beat the shipped styles is written with the marker in the
  selector so it carries real specificity.

The same applies to the scoper's own output: a compound inside `:where(...)` or `:is(...)` has to
be bound to the marker individually, or a rule meant for menus ends up applying to the document.

### Why transparency is not adjustable

There used to be an opacity slider. It was removed deliberately, and the reason is worth keeping
next to the design:

The slider mapped 0–100 onto a multiplier with a floor, so that the bottom of the scale meant
"very translucent" rather than "invisible". The floor was set to `0.45` of the nominal fill — which
put a surface at roughly **15% alpha**: technically present, invisible in practice. A user found the
bottom of the slider and reasonably concluded the skin had stopped working. That single number
caused a whole round of misdiagnosis.

Two lessons, both now enforced by tests:

1. **A control that can express a value the design was never tuned for will eventually be used to
   express it.** The material has one look; there is no dial to break it.
2. **"Subtle" and "absent" are hard to tell apart on a white page.** Transparency values are
   asserted against rendered contrast, not chosen by eye.

### How Liquid Glass is built

The skin deliberately does **not** style components one by one. The shipped client paints
almost everything from its own alias tokens, so the skin re-binds those tokens
(`tokens.css`) and every component that already reads them — sidebar, cards, menus,
dialogs, inputs, buttons — becomes glass, without the skin knowing a single class name.
That is also what makes it robust: a component whose markup changes still reads the token.

A token cannot express refraction, because `backdrop-filter` needs a selector rather than a value —
and the selector is the hard part. So the skin's entire material is **one frost layer on the
application frame**:

```css
:where(:has(> [data-ui-skin-column])) { isolation: isolate }

:where(:has(> [data-ui-skin-column]))::before {
  content: ''; position: absolute; inset: 0; z-index: -1;
  backdrop-filter: blur(var(--lg-glass-blur)) saturate(var(--lg-glass-saturate));
}
```

`:has(> [data-ui-skin-column])` finds the frame because the runtime marks its columns, and the frame
is the only element whose *direct children* carry that marker — no build-hashed class named, and no
new marker invented for the purpose. Floating surfaces are reached by ARIA role instead,
`:where([role='dialog'], [role='menu'], [role='listbox'], [role='tooltip'])`, because a WAI-ARIA role
is a published interface rather than somebody's markup. Every selector sits in `:where()` at zero
specificity, so a component that wants its own material still wins.

Three constraints decide that shape, and each was measured rather than reasoned about — the probe
cases are named in `glass.css`:

- **Never on a column**, for two independent reasons. `backdrop-filter` creates a containing block
  for `position: fixed` descendants, and dsh renders its settings dialog — `position: fixed;
  inset: 0` — *inside a layout column*: frosting a column captures that dialog and confines it to
  the column, and the reported symptom was the settings panel collapsing into a narrow strip on the
  left. The dialog was never the cause, and the skin cannot repair it from the outside. Separately,
  the shipped columns are `position: static` while the frame is `position: relative`, so an
  absolutely positioned child written inside a column resolves against the frame anyway — probe
  case 7 measured a frost on a static 169px column as a **351px** box, the frame's width. On the
  columns it would have been one frame-sized layer *per column*, stacked over the same area.
- **The stacking context comes from `isolation`, not from the blur.** `z-index: -1` needs a
  stacking context to land in, or the layer escapes to an outer one and can end up behind the page
  background. `isolation: isolate` supplies it — and, unlike `backdrop-filter`, `transform`,
  `filter`, `perspective` or `contain`, it does **not** create a containing block for
  `position: fixed` descendants. That is precisely what keeps the settings dialog attached to the
  viewport while the frame is frosted.
- **The layer paints between the frame's fill and the columns.** That is what a transparent
  `--dsw-alias-bg-base` is for, and it is why the text survives: `backdrop-filter` blurs what is
  behind a surface, never what is painted on it, so a see-through column keeps crisp type while the
  ambient gradient behind the frame is refracted.

If a browser lacks `:has()`, none of the above matches and the skin degrades to translucent fills
alone — nothing captured, nothing leaked.

Two rules keep the result readable, and both are asserted by the suite:

- **Label tokens are never redefined.** Text keeps its shipped colour, so every
  foreground/background pair the design system validated still holds; only fills become
  translucent, and layer 3 / the overlay token stay essentially opaque for menus and
  dialogs, where dense text sits over arbitrary content.
- **Degradation is honest.** Without `backdrop-filter`, and under
  `prefers-reduced-transparency`, every fill returns to opaque and the blur is dropped:
  the layout, hierarchy and edges survive, the transparency does not.

### Persistence

```jsonc
// $DSH_HOME/settings.yaml → `ui-projects` (preferred), else localStorage
{ "v": 1, "initialized": true, "enabled": ["liquid-glass"], "settings": {}, "touched": true }
```

`enabled` is the **complete** set the user wants on. Storing "what is on" rather than a
list of overrides is what lets a project that defaults off stay on after a reload, and
one that defaults on stay off. `initialized: false` means "no choice recorded yet — use
each project's default". The plugin prefers the dsh settings document (read and written
through `ctx.settingsScope`) and falls back to `localStorage` on a non-loopback page or
in a composition without the settings service.

---

## Adding a UI project

Three steps, none of which touches the settings page.

**1. Write the project.** Either a new module under `src/client/projects/<id>/`:

```js
// src/client/projects/my-project/skin.js
const { TYPE_ENHANCEMENT, FEATURE_LIGHT, FEATURE_DARK } = require('../../project-constants.js')
const myCss = require('./my.css')

module.exports = {
  id: 'my-project',
  name: 'My Project',
  description: 'What it does, in one sentence.',
  version: '1.0.0',
  type: TYPE_ENHANCEMENT,
  defaultEnabled: false,
  scope: 'component',
  supports: [FEATURE_LIGHT, FEATURE_DARK],
  apply(ctx) {
    ctx.insertCss(myCss)   // scoped to the project's marker automatically
  },
}
```

**2. Register it** in `installBuiltInProjects` (`src/client/index.js`):

```js
function installBuiltInProjects(target) {
  target.register(require('./projects/liquid-glass/skin.js'))
  target.register(require('./projects/my-project/skin.js'))
}
```

**3. Add both files to `MODULE_ORDER`** in `scripts/build.mjs`, then `npm run build` and
`npm test`. The build fails loudly if a module is present but not declared, so the list
cannot silently drift.

The project now appears in Settings › UI with its name, description, version, badges,
preview, switch and reset button. Nothing else changes.

### Writing a project's CSS

Write ordinary root-level CSS. `:root` declarations become the project's marker element
(so tokens are one level deep), and every other selector gains the marker prefix:

```css
/* authored */                          /* as delivered */
:root { --brand: #4d6bfe; }             html[data-ui-project-my-project="on"] { --brand: #4d6bfe; }
.card { border-radius: 20px; }          html[data-ui-project-my-project="on"] .card { border-radius: 20px; }
@media (max-width: 768px) { … }          @media (max-width: 768px) { html[data-ui-project-my-project="on"] … }
@keyframes spin { … }                   @keyframes spin { … }   /* at-rules with global names pass through */
```

Two consequences worth knowing: a project cannot leak into the default interface, and a
project cannot reach outside `.card`-style selectors — author against the shipped markup
and tokens rather than adding global resets.

### Recording the project's own options

```js
const blur = ctx.readSetting('blur') ?? '20px'
await ctx.writeSetting('blur', '28px')
```

Options live in the same record, under `settings[<project id>]`.

### Contributing from another plugin

The registry is published on the plugin object, so a separate package can add a project
without editing this one:

```js
const uiProjects = require('dsh-ui-projects/client')
uiProjects.registry.register({ id: 'other-skin', /* … */ })
```

Unregistering happens through the disposer `register` returns, and the plugin's own
lifetime owns everything it registers.

---

## Development

```powershell
npm run build   # src/client/**  →  lib/client.js (one lazy-CJS module graph)
npm test        # loads the bundle through a __ModuleLoader__ facade and asserts the contract
```

There is no bundler dependency. `scripts/build.mjs` is the whole build: it rewrites the
source's ESM imports/exports into one CommonJS graph, converts `*.css` files into string
modules, and wraps the result in the registration block the dsh shell expects. React is
the only external it requests, resolved from the shell's frozen module table.

### Verifying against a running dsh

`npm test` normally runs the freshly built bundle. Point it at a served bundle to check
the bytes a browser actually receives — same composition, same `dsh.client` scan, same
bundle route:

```powershell
# start a second instance on a free port (never disturb the one you are using)
dsh --profile web --port 3081 --no-open
# copy the combo URL from that instance's index page, then:
npm test "http://127.0.0.1:3081/plugins/??dsh-ui-projects/client.js&rev=…"
```

If the plugin fails to compose at all, that instance's startup output and its index page
are where the reason appears (a missing built bundle fails activation loudly, with a
build instruction and a package path).

### Verifying in a real browser

The Node suite cannot answer the question a skin ultimately has to answer — *does the
running application actually become glass, and does it actually come back?* — so
`scripts/browser-verify.mjs` drives a real Chrome over the DevTools Protocol (Node's
own `WebSocket`; no dependency) against a running instance:

```powershell
node scripts/browser-verify.mjs "http://127.0.0.1:3081/?token=…" --shot glass.png
```

It opens Settings › UI in the live DOM, clicks the real switch, and asserts against
**computed styles and rendered pixels**: the shipped tokens change value, shipped regions
measurably gain `backdrop-filter`, the state survives a reload, the console stays clean,
a mobile viewport gets the reduced blur with no overflow, and — measuring the actual
screenshot pixels — text over the glass stays readable. Turning the switch off must
restore the *exact* set of blurred surfaces and the original token values. It also drives
the real Appearance control into dark mode, checks the fill becomes translucent
blue-black rather than the light one, and re-measures contrast there (`--shot` writes
`glass.png` and `glass-dark.png`).

The contrast check measures the **darkest-to-lightest pixel spread** inside each text box.
That is a deliberately coarse instrument: it cannot prove a 4.5:1 ratio, but on a
translucent surface a genuine wash-out shows up as a collapsed spread, which is the
failure worth catching. It measures only unobstructed text — with the settings dialog
open, the application behind it sits under the dialog's scrim, and measuring a scrimmed
label would report a failure nobody is experiencing.

Three things this checked that nothing else can:

1. **Load-time imports.** The shell materializes the entry module before calling `apply`
   with a module table that answers only React. An earlier version imported React and the
   project at load time and died in the browser with `slot "settings.section" is not
   declared`; `npm test` has since grown a case that reproduces that exact load contract.
2. **Registration order.** `runtime.start()` walks the registry, so a project registered
   *after* it did not come back on reload.
3. **Which element owns the tokens.** The shipped client declares its design tokens on
   `body`, and a token declared on an element always wins for that element over an
   inherited one — so a stylesheet scoped to `html` was silently ignored. Project
   stylesheets are therefore bound to `body[data-ui-project-<id>="on"]`, which is also why
   the runtime sets the marker on `body`.
4. **How a selector about the body binds.** The skin's dark branch is written as
   `body[data-ds-dark-theme]`, the shipped client's own signal. The scoper used to prefix
   it, producing `body[marker] body[data-ds-dark-theme]` — "a body inside a body" — which
   matches nothing, so dark mode was completely dead while every token test still passed.
   A selector that starts with `body` or `html` now gains the marker on that same element
   instead of being nested under it, and the scoper's own tests cover the case.

### What the suite covers

`scripts/verify.mjs` boots the real bundle against a fake Cordis context and a minimal
DOM, then asserts: registry validation (including that an id is CSS-selector-safe),
skin exclusivity, markers and stylesheets while on, *no* residue after off, CSS scoping
including at-rules, rollback of a failing project, persistence and reload in both
directions, the settings-document adapter, the rendered card markup (`role="switch"`,
`aria-checked`, its label), and — for the palette — that every token the skin re-binds
is one the **installed** design system really declares, and that turning the skin off
removes every token it introduced.

### Module resolution in the bundle

A module id drops the extension and collapses a directory index (`a/index.js` → `a`), so
"is this id a module or a directory?" cannot be read off the id. Rather than guess, the
builder records each module's containing directory as data and the bundle resolves
relative requests against it. The package entry is renamed to `entry` for the same
reason: an id literally named `index` would be indistinguishable from a collapse.

---

## Deliberate limits

- **No host-side settings namespace yet.** The client prefers `ctx.settingsScope` and
  falls back to `localStorage`; registering a Host namespace for `ui-projects` would make
  the settings-document path the only one, with no client change.
- **The scope transform is not a full CSS parser.** It handles rule blocks,
  comma-separated selector lists, nested conditional at-rules and comments — the shapes
  this repository authors. Minified or exotic CSS should be normalized first.
- **Preview images are optional and unoptimized.** A project may point `preview` at an
  image path or supply a CSS background; nothing resizes or caches either.
