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
src/host/index.js                 host row: the browser half's reachability, its settings
                                  namespace, and the first-paint injection
src/host/boot.css                 the first-paint subset of the skin, inlined into <head>
                                  (derived — see tools/derive-boot-css.mjs)
src/client/
  index.js                        composition root: registry + persistence + runtime + settings section
  project-constants.js            the shared vocabulary (skin/enhancement, light/dark/mobile,
                                  low/medium/high, and the tier ranking)
  registry.js                     what UI projects exist, and the enable/disable policy
  persist.js                      where state lives (dsh settings document, else localStorage)
  runtime.js                      the only DOM-touching module in project code; applies and
                                  cleans up. diagnostics.js adds a temporary overlay, never
                                  touching a project's own DOM.
  diagnostics.js                  the self-diagnosis overlay; a temporary instrument, off by default
  scope-css.js                    rewrites a project's CSS so it can only apply while active
  css-filter.js                   whether a stylesheet installs a blur, and which selectors carry it
  perf.js                         what the device can afford: signals, tiers, the frame probe
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
  perfLevel: 'high',             // 'low' | 'medium' | 'high' — what it was designed for
  priority: 100,                 // execution order among composable projects; lower runs first
  modifies: ['composer'],        // surfaces it changes, from the fixed region vocabulary
  testItems: [                   // what a person should check before calling it verified
    { id: 'text-readable', label: 'Text over the glass is comfortable to read' },
  ],
  preview: 'radial-gradient(…)', // a CSS background, or an image path
  apply(ctx) { … },              // runs while active
  cleanup(ctx) { … },            // optional extra teardown; must be idempotent
}
```

### Verifying a project by hand

Some things a test cannot judge and a person can: whether text over the glass is comfortable to
read, whether the settings dialog is centred, whether the first frame flashes. A project declares
those as `testItems`, and its card grows a disclosure with one checkbox each, a **Mark as passed**
button, and — once something has been recorded — a **Withdraw confirmation** button.

Each item is validated at registration, and all three rules are refusals rather than warnings:

| rule | why |
|---|---|
| `id` matches `^[a-z][a-z0-9-]{1,47}$` — lowercase letters, digits and dashes, 2–48 characters | the id is the key a checklist is stored under, and the same shape a project id uses |
| `label` is a non-empty string | a checkbox nobody can read is a checkbox nobody can tick honestly |
| the `id` appears **once** in the definition | every part of the system keys the checklist by that id, so two rows would share one tick and the record could not tell them apart — "each declared item was read" would stop being verifiable |

The uniqueness rule is stricter than the one for project ids, on purpose: a project id that arrives
twice means *replace* (that is how hot reload works), while a test item id that arrives twice inside
one definition means the definition contradicts itself. A duplicate is refused with a message naming
the id and both labels, because the two rows look identical on the card — it is the one mistake an
author cannot see from the interface.

The button refuses until every box is ticked, and confirming is deliberately not an automatic
consequence of ticking the last one: "I looked at all of these" is a claim a person makes, and the
record should say when they made it.

What is recorded is `{ version, items }`, inside the project's own settings record — no new
namespace, and one write rather than two, so the stamp cannot disagree with the ticks it validates.

That record is a claim about a **pair**: this version, and this list. A confirmation is therefore
current only while both are the ones it was made against, and the card has three things to say:

| state | when | what the reader is told |
|---|---|---|
| **current** | same version, every declared item ticked | "confirmed for 3.0.0" |
| **stale** | a different version | "confirmed for 1.0.0; this version needs confirming again" |
| **incomplete** | same version, an item missing from the record | "confirmed for 3.0.0, but the checklist changed since" |

Two states were not enough, and the third was not theoretical: a real settings document was found
holding `{version: '3.0.0', items: {}}` — a confirmation with nothing ticked in it — and the
version-only rule reported it as confirmed. The two failures also have different causes, and a
message that names the wrong one is worse than no message: a new version invalidates the claim
because it is about different code, a changed checklist because it is about a different list.

**Removing** an item from a checklist does *not* invalidate a confirmation, and that is deliberate:
everything still declared was read and holds, so the claim is intact. `storedChecks` keeps only the
items that are declared now and were ticked, which is what makes that true — and what makes the
subset test and the equality test the same test. The old record is reported rather than deleted:
"confirmed for 1.0.0, needs confirming again" tells a reader something an empty checkbox cannot, and
an out-of-date record still seeds the boxes it can, because a tick means "this was read" and only the
claim expires.

**Withdrawing** removes that key outright rather than emptying it, leaves the project's other options
alone, and takes the ticks with it: a fully ticked checklist standing beside no record is a reading
nobody can tell apart from the one that was just retracted. It is deliberately not the same action as
the card's reset — retracting a claim should not also cost a configuration, and the reset is a bigger
thing than someone who confirmed by mistake is asking for.

The card's reset **does** clear it, along with the project's other stored options: a button that says
"reset to its default" and leaves "confirmed for 3.0.0" behind is a partial reset wearing the name of
a complete one. The same is true of **Restore default UI**, whose docstring has always said it forgets
every user choice.

Withdrawal is owned by the runtime rather than by the project context, and that choice is the whole
reason it works: a context exists only while a project is applied, and a confirmation is *readable*
with the project switched off (see above), so it has to be withdrawable there too. Routed through the
context, the control would have done nothing in exactly the state where a stale confirmation is most
likely to be sitting on a card.

Confirming requires the project to be applied, which is the point rather than a limitation: a
checklist is confirmed by looking at the running thing. *Reading* a confirmation does not, so a card
can say "confirmed for 3.0.0" while the project is switched off.

The shipped skin declares three items, and they are the three failures this project actually had
reported back — unreadable text, a settings dialog collapsed into a column, and a first frame in the
default look. A checklist that repeats the specification is decoration; one that repeats the
incident history is worth ticking.

Reading a checklist is safe; **ticking one writes**. A browser run records a confirmation against
the current version, which overwrites whatever was confirmed by hand and accumulates on every
re-run. `--no-write` refuses that one write in flight:

```powershell
# a normal run: records a real confirmation in the settings document
node scripts/browser-verify.mjs "http://127.0.0.1:3081/?token=…"

# a run that leaves no trace: the confirmation still appears, and provably does not survive a reload
node scripts/browser-verify.mjs "http://127.0.0.1:3081/?token=…" --no-write
```

It refuses only the mutations that carry `checks`, so the rest of the suite keeps its real
persistence — a skin toggle that did not survive a reload would fail the test that checks it. Both
modes assert the confirmation appears (the plugin updates its settings in memory before it persists,
and the store is notified, so the card redraws either way); they differ in what happens after the
reload, and `--no-write` also asserts that a request was actually refused — a pattern that matched
nothing would otherwise leave it passing while quietly writing.

### The effect tier

`perfLevel` is a **declaration**, not a measurement: the heaviest effect the project was designed
for. The device half lives in `perf.js`, and the two meet in exactly one place — an attribute on the
body:

```js
document.body.dataset.uiPerf   // 'low' | 'medium' | 'high', or absent when nothing is applied
```

`min(heaviest active declaration, what the device can afford)`. `saveData` is the strongest device
signal and the only statement of intent available; core count is a weak demoter, and an unreadable
count is treated as capable rather than suspect. A frame-time probe runs once, a second after the
skin is applied, and can only ever lower the tier. `deviceMemory` is deliberately not consulted —
Chromium-only and capped, so it would classify Firefox and Safari by the absence of an API.

The stylesheet then degrades itself, with no JavaScript in the rendering path:

```css
body[data-ui-perf='low'] :where(:has(> [data-ui-skin-column]))::before {
  backdrop-filter: blur(var(--lg-glass-blur-low)) saturate(var(--lg-glass-saturate));
}
```

**Authored against `body`, and that is load-bearing.** The scoper replaces a leading `html`/`:root`
with the project marker, and the marker is a `body[…]` selector — so `html[data-ui-perf='low']`
compiles to `body[data-ui-project-<id>="on"][data-ui-perf='low']` and works, while the same
attribute written on `<html>` by the runtime would match nothing at all. Naming the element the
attribute lives on makes that failure impossible to reintroduce by accident.

When the device demotes a project below what it declared, the settings card says so — a cheaper
material with no explanation reads as a rendering bug.

### Execution order

Composable projects can be active together, so they need an order. `priority` supplies it: **a lower
number is applied first**, `100` by default, ties broken by registration order. Only enhancements
show the badge — a skin is alone by policy and is never sorted.

The order is a **request**, and two things outrank it:

- **`requires` always wins.** A dependency is applied before whatever depends on it, whatever the
  numbers say, because that is correctness rather than preference.
- **A click does not re-order.** Enabling a higher-priority project while a lower-priority one is
  already running applies the new one last and leaves the session as it stands: re-applying live
  projects to reorder them would make the interface flicker, which is the thing this package spends
  its time removing. The card then says which project will move, and the next load applies the
  canonical order.

Before this existed the order was alphabetical by id — an accident of `activeIds()` sorting — so
renaming a project silently changed when it ran and nothing recorded that it had.

### Regions, and what a conflict warning means

A project may declare which surfaces it changes, in `modifies`. The vocabulary is fixed, and each
name is tied to a DOM hook so a declaration can be checked rather than argued about:

| region | what it is |
|---|---|
| `sidebar`, `center` | columns of the layout frame, marked `data-ui-skin-column` by the runtime |
| `rightbar` | the right column, `data-rightbar-col` |
| `overlay` | the frame's own overlay layer, `data-shell-overlay` — a container *above* the columns, which is why frosting it differs from frosting one |
| `composer` | the input area, `data-composer-*` |
| `dialogs` | floating surfaces by WAI-ARIA role: dialog, menu, listbox, tooltip |
| `tokens` | the `--dsw-alias-*` design-token layer every component reads |
| `background` | the page background on `body` |

Two names the specification's example list suggests are deliberately absent: `navbar`, because this
shell is a three-column frame with no navigation bar, and `settings`, because the settings surface
*is* a dialog and `dialogs` already covers it.

When two **active enhancements** claim the same region the settings page says so — once at the top
of the section, and once on each card naming the other project. The warning is **advisory**: two
projects may touch one region and still compose perfectly (one sets a colour, the other a radius),
so nothing blocks an enable.

**Skins are excluded from this check.** A skin declares a broad footprint — the shipped one touches
tokens, the background, the composer and dialogs — so including skins would make every enhancement
"conflict" with the skin, and a warning that is always present is not read. Skins are made mutually
exclusive by policy instead; that is the mechanism for skin-versus-skin.

Two projects that both claim a region **and both install a `backdrop-filter`** escalate to a
nesting warning, because a filtered element inside another filtered element is expensive and
changes what each layer samples. The blur is read from the CSS each project inserted, not from a
declaration — a manifest saying "I may blur" is a promise, while the stylesheet is the fact. That
also makes the analysis complete in a way a DOM query cannot be: the skin's own frost lives on a
`::before` **pseudo-element**, and no selector returns one.

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

**The composer is the one surface reached by a `data-` hook of its own.** It is not a floating surface
by role and it is not the frame, and it paints an opaque fill of its own
(`--dsw-specific-input-major` → `#fff` / `#2c2c2e`), so the frame's frost stopped at its edge. It gets
the material through `[data-composer-card]` — a hand-written attribute in `ui-conversation`, which the
shell's own layout code queries too — and its frost sits on `[data-composer-card]::before` with the
card carrying `isolation: isolate`. The blur is deliberately **not** on the card itself: the card is
already `position: relative` and has no `fixed` descendant today, so putting it there would work and
would also make the card a containing block for anything a future client renders inside it — the
failure this project has already paid for twice. The shared fill token is not rebound, because five
other surfaces paint with it.

The composer's frost is in **every** degradation list — both tiers, the mobile query, and all four
suppression branches — and under those four branches its fill goes opaque with every other one. That
completeness is the part that is easy to miss and impossible to see: a block that forgets the composer
leaves the one large card at full blur on the device or in the mode that asked for less.

**The seat around it is deliberately untouched.** The shipped rule on the seat ramps to
`var(--dsw-alias-bg-base)` over 36px and then holds that colour for the rest of the seat — invisible
only while the token matches the page around it, which is exactly what a translucent skin stops being
true. Restating it in glass terms was tried and seen in a screenshot of the running application: a
glass-tinted rectangle spanning the column below the card, with a hard edge where the seat ends. The
suite now asserts that the skin says nothing about the seat at all. A fade that dissolves content
instead of painting a fill is a `mask-image` on the scroller, which is a different change.

Two rules keep the result readable, and both are asserted by the suite:

- **Label tokens are never redefined.** Text keeps its shipped colour, so every
  foreground/background pair the design system validated still holds; only fills become
  translucent, and layer 3 / the overlay token stay essentially opaque for menus and
  dialogs, where dense text sits over arbitrary content.
- **Degradation is honest.** Without `backdrop-filter`, and under
  `prefers-reduced-transparency`, every fill returns to opaque and the blur is dropped:
  the layout, hierarchy and edges survive, the transparency does not.
- **A contrast request is answered, not resisted.** Under `prefers-contrast: more` the fills go
  opaque, the hairlines get real weight, and the decorative gradient and the now-redundant blur go
  with them. That is a different request from `forced-colors`, which hands the palette to the
  platform, and from `prefers-reduced-transparency`, which is about seeing through things. The text
  colours are never redefined in any of the three: the design system validated every pair it ships,
  so the background is the only lever that can raise the ratio without inventing a relationship.

### First paint

A skin that arrives with the client bundle is a skin the first frame does not have: the shell
paints, and only afterwards does the bundle load and apply anything. The last state is meant to be
on screen from the first frame, so the part of it that can be is served inside the HTML.

The mechanism is the **host half**, through `webserver/index-inject` — the same route
`dsh-client-ui-theme` uses for its own bootstrap:

- `src/host/boot.css` is inlined as a `<style>` immediately after `<head>`. It is the body-level
  subset of the skin, already written in the marker form the runtime scoper emits, and the build
  proves it rule-for-rule against that scoper's output. Because every selector carries the marker,
  the sheet is **inert while the skin is off** — so it is emitted unconditionally, with no branch
  to get wrong.
- One `<script>` is emitted, immediately after `<body>` opens, and only when the settings document
  says the skin is on. It sets `data-ui-project-liquid-glass="on"` on the body and
  `data-ui-skin="liquid-glass"` on the root — before the application mounts and before anything
  paints. If the document cannot be read at all, no script is emitted and the page paints the
  default look.

The state comes from the **settings document**, read at render time, never from `localStorage`.
This is a deliberate departure from the specification, which asks for a head script that reads
`localStorage` synchronously: this plugin's durable state is the settings document, and the client
removes the `localStorage` copy after its first successful write — so a script reading that key
would find nothing on exactly the loads that matter.

**The physical boundary, stated rather than discovered.** A first frame gets the `--lg-*` tokens,
the re-bound `--dsw-alias-*` colours, the body background with its ambient gradient, and the base
text colours — the colours, the background and the material hierarchy. It does **not** get the
blur: the frost hangs off `data-ui-skin-column`, which the client runtime stamps once the
application's DOM exists, and no first frame can precede that. The blur lands a few milliseconds
later. "The first frame is already Liquid Glass" holds inside that boundary: no white flash, and no
default-look-to-skin jump.

Two deviations from the specification are recorded here rather than left to be rediscovered:

- **The marker is `data-ui-project-<id>`, not `data-ui-skin-<id>`.** The specification suggests the
  latter; the former is what the scoper emits into every project stylesheet, so the boot script
  marks what the CSS actually reads. Renaming would rewrite the scoper, every selector, every test
  and every snapshot, for no change in behaviour.
- **A non-loopback page can disagree for one frame.** There the client falls back to
  `localStorage` while the host still reads the settings document, so a first frame can be skinned
  and then have the marker removed by the runtime a moment later. Closing that needs the request's
  loopback-ness plumbed into the injection table, which is an upstream interface change; on
  `127.0.0.1` — the supported way to run this — it cannot happen.

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

### Build artefacts — `lib/` is complete only with all three files

| file | what it is |
|---|---|
| `lib/index.js` | the host half, copied from `src/host/index.js` after its package imports are checked |
| `lib/client.js` | the browser bundle, built from `src/client/**` |
| `lib/boot-css.js` | `src/host/boot.css` as a module — the first-paint stylesheet the host inlines |

`lib/index.js` imports `./boot-css.js`, so a `lib/` holding only `index.js` and `client.js` is
not merely stale: **dsh refuses the loader entry at boot**, and the GUI sits on "Loading
plugins…". `npm run build` produces all three together; nothing else does.

The third artefact is generated rather than copied because the host half ships as plain ESM and
cannot import CSS. Before writing it, the build proves `src/host/boot.css` is a subset of the CSS
the skin itself emits — rule by rule, whitespace-insensitively, with any drift failing the build
and naming the offending rule. That check is the only thing keeping two copies of the same
palette from becoming two different palettes.

`src/host/boot.css` itself is DERIVED, not written. After changing a body-level rule in
`tokens.css` or `glass.css` — adding a token, adding a conditional branch — regenerate it:

```powershell
node tools/derive-boot-css.mjs          # rewrite src/host/boot.css from the scoped skin CSS
node tools/derive-boot-css.mjs --check  # report drift and change nothing (exits 1 when stale)
```

It copies every rule whose selector is about the marked body element itself — those are the
declarations a first paint can use — and skips descendant rules like `body[marker] .lg-glass`, which
need DOM a first frame does not have. Editing the file by hand is how the first frame starts to
disagree with every later one.

The build then checks the result **in both directions**, and both are fatal: every rule in
`boot.css` must exist in the skin's emitted CSS (it may not invent anything), and every body-level
rule the skin declares must exist in `boot.css` (it may not be missing anything). One direction
alone would have missed the likelier mistake — a new body-level rule in the skin and no
re-derivation — and would have shipped a first frame quietly without it.

What counts as a body-level selector is decided in **one** place, `scripts/boot-css-rules.mjs`, which
both the tool above and `scripts/build.mjs` import. They each used to hold a copy; the copies agreed
with each other and were both wrong, and the sheet silently lost rules that decide the first frame.
The predicate answers three ways, not two — `body`, `other`, and `mixed` for a selector list that is
partly body-level — and `mixed` is fatal rather than skipped, because a sheet that omits half a rule
looks complete and is not. It also distinguishes a compound from a descendant: the space in
`body[marker] [role='menu']` is a combinator, so that rule is not body-level, while
`body[marker][data-ds-dark-theme]` is.

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

Pass `--no-write` to keep it from recording a checklist confirmation in the settings document it
points at — see the checklist section above for what each mode asserts.

It opens Settings › UI in the live DOM, clicks the real switch, and asserts against
**computed styles and rendered pixels**: the shipped tokens change value, shipped regions
measurably gain `backdrop-filter`, the state survives a reload, the console stays clean,
a mobile viewport gets the reduced blur with no overflow, and — measuring the actual
screenshot pixels — text over the glass stays readable. Turning the switch off must
restore the *exact* set of blurred surfaces and the original token values. It also checks the
dark palette, the `prefers-contrast: more` branch in BOTH themes, the reduced tier on a device
forced to be weak, the composer's own material and its step-downs (16px on a phone, 12px on a
two-core device), the checklist's confirmation and its withdrawal through the card's reset, and the
first frame with this bundle blocked (`--shot` writes `glass.png` and `glass-dark.png`).

Dark mode is entered the way a skin actually sees it: by setting `data-ds-dark-theme` on `body`,
which is the whole interface between the shipped theme feature and a skin. Driving the Appearance
control instead made the phase depend on which Settings section the dialog remembered — but note
what the attribute is: it is also the signal the shipped theme plugin persists its preference from,
so a run against an instance whose stored preference is `light` can leave that preference `dark`.
The suite restores the attribute it changed; the durable preference belongs to the shell, not to
this plugin, and it is recorded in the changelog rather than assumed away.

The suite is also identified by its arguments rather than their order: the page URL is found by its
`http(s)://` shape, so `--no-write` cannot be mistaken for the URL. It could: passing the flag alone
once turned every navigation into a failure and reported fifteen skin failures that were one bad
argument. A missing URL now exits 2 with usage before Chrome is started.

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

- **Persistence has two backends, and only one of them is authoritative.** The `ui-projects`
  namespace is registered by the host half (`src/host/index.js`) and bound on the client through
  `ctx.settingsScope`, so the record lives in `$DSH_HOME/settings.yaml` under `ui-projects`. That
  is the authoritative store and what a running instance uses. `window.localStorage` remains for
  the one case the settings document cannot serve: a page that is not loopback, where the Host
  keeps preferences process-local and the bound scope reports `mode: 'memory'`. The client half
  declares `settingsScope` in its `inject` list, so the adapter is chosen *after* the settings
  transport is up rather than racing it, and `runtime.start()` waits for the document's first read
  before applying a record — reading earlier would return the empty record and silently restore
  the shipped defaults. The card names the backend in use ("Saved with your dsh settings" or
  "Saved in this browser", from `persist.kind`), and the first successful write through the
  settings document deletes the `localStorage` copy, so the two can never become competing
  records. A skew or a waited-out deadline shows up as `persistKind` / `persistReady` /
  `persistDiverged` in the diagnostics overlay.
- **The scope transform is not a full CSS parser.** It handles rule blocks,
  comma-separated selector lists, nested conditional at-rules and comments — the shapes
  this repository authors. Minified or exotic CSS should be normalized first.
- **Preview images are optional and unoptimized.** A project may point `preview` at an
  image path or supply a CSS background; nothing resizes or caches either.
