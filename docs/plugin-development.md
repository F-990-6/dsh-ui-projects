# Writing a UI project package, and a plain client plugin

Two shapes reach the browser, and the difference decides what a skin can do to them. A **UI project
package** registers a project with the framework: it hands over a manifest and behaviour, gets a card in
**Settings › UI**, a switch, a checklist and a maintenance block, and — if it is a skin — its stylesheets
are scoped to its own body marker and removed when it is turned off. A **plain client plugin** does none
of that: it is an ordinary Cordis client plugin that mounts its own DOM, and it is exactly the case the
UI Contract exists for, because nothing it does is scoped, registered or reversible by the framework.

This is the author-facing guide. It states the contract, the two facts about CSS and skins that the last
round learned the hard way, the smallest working shape of each kind of package — the two example packages
under `E:\dsh\plugins\` are readable copies of both — and where the maintenance commands have to be run.
The material a package *ships* (install flow, uninstall, update and rollback) is written down separately
in `docs/uninstall.md` and `docs/update-and-rollback.md` in this directory.

## The UI Contract, in four rules

The contract is what makes a third-party surface reachable by a skin. Three of the four rules can be
decided by reading a built bundle; the fourth is about the page at runtime and is **not** scanned yet.
Every finding the scanner produces is `severity: 'warning'`: nothing is refused, and a clean card is not a
promise that a package is good — it is the absence of the violations a text scan can see.

| Rule | Code | What it is about |
| --- | --- | --- |
| 1 | `UI_CONTRACT_NON_STANDARD_ROLE` | a `role` that is not a WAI-ARIA role, so no skin can select what it marks |
| 2 | `UI_CONTRACT_HARD_COLOUR` | a colour written literally where the shipped palette owns the value |
| 3 | *(not scanned)* | a top-level overlay that cannot be identified by role — a runtime fact |
| 4 | `UI_CONTRACT_CLOSED_SHADOW_ROOT` | `attachShadow({ mode: 'closed' })`, which no stylesheet can reach |

**Rule 1 — `UI_CONTRACT_NON_STANDARD_ROLE`.** The scanner reports:
`role="custom-dialog" is not a WAI-ARIA role, so no UI skin can select what it marks`, and its advice is
`use a WAI-ARIA role (dialog, menu, listbox, tooltip for a floating surface) or a native element that
already carries one`. The role list is WAI-ARIA 1.2 (W3C Recommendation, 06 June 2023, §5.3): the 82
non-abstract roles **plus the 12 abstract ones**, accepted deliberately, because a warning-only instrument
must prefer a false negative to a false positive. A role is read in three forms only — a markup attribute
(`<div role="dialog">`), an object property (`{ role: 'dialog' }`, including after a comma), and
`setAttribute('role', 'dialog')` — and a role quoted inside a display label, or named inside a CSS
selector (`[role='dialog']`), is **not** an assignment.

**Rule 2 — `UI_CONTRACT_HARD_COLOUR`.** The message is
`a colour is written literally where the shipped palette owns the value: <the declaration>`, and the advice
is `use a --dsw-alias-* token (bg-layer-1/-2/-3/-overlay, border-l1/-l2/-l3, text-*), or declare the value
as a custom property`. The rule is scoped to the properties the palette owns (`background`,
`background-color`, `color`, `border*`, `outline*`, `fill`, `stroke`, `caret-color`, `accent-color`,
`text-decoration-color`); it skips `--*:` declarations, because declaring a colour is how a token comes to
exist; and it exempts the fallback half of `var(--dsw-alias-something, #fff)`, because a package that reads
the token and names a fallback is doing the contract, not breaking it.

**Rule 4 — `UI_CONTRACT_CLOSED_SHADOW_ROOT`.** The message is
`attachShadow({ mode: "closed" }) cannot be reached by any stylesheet, so a skin cannot style what is
inside it`, and the advice is `use mode: "open", so the content stays reachable by a skin's selectors`.

**Rule 3 — the overlay rule, and its criterion.** It is about a floating surface a package appends to the
page: such a surface has to be identifiable **by role**, because a role is the only published interface a
skin can select on without knowing the package's class names, markup or version. The criterion, as
recorded when this step was scoped:

> `document.body` 的顶层子元素必须带 WAI-ARIA role；判据是元素能否被 role 识别，不是是否调用了
> `appendChild`；本阶段只做静态扫描三项，运行时判据推后。

In English: the top-level children of `document.body` must carry a WAI-ARIA role, and the test is whether
the element can be **recognised by role** — not whether `appendChild` was called. Appending is not the
violation; appending something unreachable is. This round scans the three rules above statically and
defers the runtime criterion.

**Two consequences worth stating plainly.**

- `CONTRACT_LIMITS` travels with every scan result and is rendered under the badge, so a reader can see
  what the instrument cannot: rule 3 needs a runtime probe; a violation written inside an event handler or
  an effect is invisible to a text scan; a role computed at runtime (`role: name`, a template) cannot be
  judged and is only **counted** (`N role assignment(s) in this bundle have a computed value and were not
  judged`).
- **There is no portal service to point at yet.** Rule 3 is usually summarised as "use dsh's portal
  mechanism", and that phrase currently has no name behind it: none of the 47 `@deepseek-ai/dsh-client*`
  packages provides a portal service, and React's `createPortal` appears only inside them, as an
  implementation detail. Until a portal service exists, the honest reading of rule 3 is: whatever you
  append to the body must carry a WAI-ARIA role, and while it is attached it is the page's problem —
  `dsh-ui-projects` cannot scope, move or remove DOM it does not own.

## Two facts to know before you write a line of CSS

**1. A rule you write with `:where()` ends up with ZERO specificity, on purpose.** Project stylesheets are
scoped by `src/client/scope-css.js`, which places the project's marker inside a functional `:where()`, so

```css
:where([role='dialog'], [role='menu'], [role='listbox'], [role='tooltip']) { … }
```

is emitted as `:where(body[data-ui-project-liquid-glass="on"] [role='dialog'], …)` — and `:where()`
contributes no specificity at all. A component's own `.example-dialog { box-shadow: … }` therefore **wins**,
whatever the project intends. That is the design, not an accident: the skin's dialog rule says so in its own
comment ("a component that wants its own material can still have it"). The payoff rule 1 buys you is that the
surface is **selectable** — a skin can find it without knowing its markup — not that the skin can override
what the component declares for itself. If you need to win against a shipped class, write the rule with a
real selector (`.lg-glass`, `[data-composer-card]::before`), not with `:where()`.

**2. One global look at a time: skins are exclusive.** `registry.conflictIds(id)` returns the other
**active** skins, and `runtime.#enable` disables them before enabling the new one ("at most one global look,
so the previous one goes first"), moving `data-ui-skin` to the new skin and taking the previous one's body
marker down with it. So enabling a second skin package is a **hand-over**, not a second layer. Two
`enhancement` projects can be active together; two skins cannot.

**Open question, observed and not fixed.** Under that policy the *record* can still name both skins:
`runtime.#remember` computes the enabled list from `record.enabled` (see `src/client/runtime.js`), while the
conflict repair that disabled the previous skin runs with `persist: false`. A run therefore wrote
`enabled: ["liquid-glass","example"]` with only one of them active, and which one wins on the next boot
depends on the enable order. Either `#remember` should derive the list from the runtime's active set, or the
conflict repair should participate in persistence; recorded in `CHANGELOG.md` (Round 50, 9b-5) and left for
a ruling.

## Writing a minimal UI project package

The reference is `E:\dsh\plugins\dsh-plugin-example\` (`@xjl-resources/dsh-plugin-example`): the smallest
package that is compliant, and the one the framework's scanner must find nothing in.

### `package.json`

```json
{
  "name": "@xjl-resources/dsh-plugin-example",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" },
    "compatibility": { "dsh": ">=0.1.5-rc.1" },
    "uiProject": {
      "schemaVersion": 1,
      "pluginApiVersion": 1,
      "id": "example",
      "name": "Example",
      "description": "…",
      "type": "skin",
      "scope": "global",
      "defaultEnabled": false,
      "supports": ["light", "dark"],
      "perfLevel": "low",
      "preview": "linear-gradient(135deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-3))",
      "testItems": [{ "id": "background-follows", "label": "…" }]
    }
  },
  "peerDependencies": { "dsh-ui-projects": "^0.1.0" },
  "scripts": { "build": "node scripts/build.mjs", "check": "node scripts/check.mjs" },
  "engines": { "node": ">=20" }
}
```

- **`dsh.bundle.patch`** is what admits the package to the layer stack. `dsh plugin add` reconciles
  `dsh.profile.bundles` against installed packages, and only a dependency whose manifest declares
  `dsh.bundle` joins it — so without this field the package installs and never runs.
- **`dsh.client.platform: "web"`** is what makes a browser bundle reachable, and it is also the predicate
  the framework's contract scan uses: a package is scanned when it declares `dsh.client`, whatever its
  `kind` in the listing says.
- **`dsh.uiProject`** is the manifest the framework validates. `schemaVersion` is *our* contract version
  (this build reads `1`); `pluginApiVersion` is the entry↔framework contract; `type` must be one of
  `skin` / `enhancement`; `scope` one of `global` / `layout` / `component`. A type this build does not
  implement is reported as its own problem (`unknown-project-type`), because that means a project nothing
  here can apply — not a field with the wrong shape.
- **`peerDependencies`** on the framework, because the package reaches it through a service (`uiProjects`),
  and a peer declaration is what makes that relationship visible instead of implicit.
- `private: true` for a package installed from disk; `lib/` and `node_modules/` belong in `.gitignore`.

### The patch file

`cordis.patch.yml` inserts exactly one row, and the row is this package's own id so two UI project
packages never collide:

```yaml
- insert:
    - id: ui-project-example
      name: "@xjl-resources/dsh-plugin-example"
```

### The host half — three statements

`src/host/index.js`:

```js
const PROJECT_ID = 'example'
export const name = 'ui-project-example'
export const inject = ['uiProjectsHost']
export function apply(ctx) {
  ctx.on('webserver/index-inject', (table) => {
    table.push(...ctx.uiProjectsHost.bootRows(PROJECT_ID))
  })
}
```

`bootRows(id)` emits the first-paint rows for that project — presence, then style, then the marker — so the
served HTML already carries `body[data-ui-project-example="on"]` before any client bundle runs. A skin
passes its own derived fragment as the second argument; that fragment is generated from the package's
stylesheet by `E:\dsh\tools\derive-boot-css.mjs --package <dir>`, which keeps **body-level rules only**.
`PROJECT_ID` is the one value here that is not derived, and `scripts/build.mjs` asserts it against
`package.json` → `dsh.uiProject.id`.

### The client half — register, and carry behaviour only

`src/client/index.js`:

```js
const { createExampleProject } = require('./projects/example/skin.js')
const manifest = require('./manifest.generated.js')

module.exports = {
  name: `ui-project-${manifest.id}`,
  inject: ['uiProjects'],
  apply(ctx) {
    ctx.uiProjects.register(manifest, createExampleProject())
  },
}
```

- `inject: ['uiProjects']` is a **hard** dependency: Cordis parks the plugin until the framework's service
  exists, which is what makes "register during `apply`" safe in any composition order. The registration's
  lifetime is the calling fiber's, so unloading the package withdraws the project.
- The manifest is passed **explicitly** — caller identity in Cordis stops at the fiber — and
  `src/client/manifest.generated.js` is generated from `package.json` by
  `E:\dsh\plugins\dsh-ui-projects\scripts\derive-manifest.mjs --package <dir>` (wire it as
  `npm run manifest`, which runs it with `--check`).
- The definition carries **behaviour only**: `apply(ctx)` / `cleanup(ctx)`. `ctx.insertCss(css)` hands over
  a stylesheet the runtime will scope and remove; `ctx.markColumns()` asks for the frame's column seam;
  `ctx.fail(error)` reports a failure on the card. Everything else — including the version a checklist
  confirmation is stamped with — comes from the manifest, so there is no second copy to drift.
- Nothing in the bundle may `require` React or another plugin at module scope: the shell materializes the
  module before `apply` runs, with a table that answers only what the shell ships.

### `scripts/build.mjs` and `scripts/check.mjs`

The build is thin on purpose: the ESM→CJS rewrite and the module-registry wrapper live once, in
`E:\dsh\plugins\dsh-ui-projects\scripts\bundle-client.mjs`, and a package's own build names the graph:

```js
const MODULE_ORDER = ['projects/example/skin.css', 'projects/example/skin.js', 'manifest.generated.js', 'index.js']
```

`src/client/**/*.js` becomes `lib/client.js` (one lazy-CJS bundle, keyed by the package name); CSS under
`src/client` becomes a string module inside that graph; `src/host/**/*.js` is copied **verbatim** to
`lib/`, because it runs in Node. The build refuses a file that exists under `src/client` but is missing from
`MODULE_ORDER` — a module that would silently not ship is the failure that guard exists for.

`scripts/check.mjs` asserts what a package can know about itself, with no composition and no browser: that
the two halves were built; that the host half announces the project `package.json` declares; that the patch
file inserts exactly one row naming this package; that `dsh.bundle`, `dsh.client`, `dsh.uiProject` and
`compatibility` are all declared; and that the four contract rules hold **over its own sources** (no
`attachShadow`, nothing appended to `document.body`, no role assigned, no colour literal in a
palette-owned declaration, and the colour it does set comes from `var(--dsw-alias-…`). Strip comments
before scanning: the file's own prose discusses roles and shadow roots by name.

A package that does append to the body keeps the stronger property optionally — the smallest example
appends nothing at all, and asserts that — but the contract's test is the one above: the elements it does
append must be recognisable by role.

### The rest of the package

`README.md` (what it declares, the two halves, why it is compliant rule by rule, how to build/install,
maintenance) and `CHANGELOG.md` (one section per version, stating how the change was verified — see the
conventions at the top of any package's changelog) are not decoration: `install.ps1 -Update` prints the
newest `-Changes` changelog section(s) as part of its read-only plan, and the card's maintenance block
prints the three commands with the directory rule above. Finally, a first-class package is registered in
**two** histories: git, and `E:\dsh\tools\snapshot.mjs`'s `ROOTS` — `scripts/verify.mjs` asserts that every
package under `E:\dsh\plugins\` is covered by a snapshot root, so a package added tomorrow cannot be
forgotten (CONTRIBUTING rule 6).

### Installing it

```powershell
dsh plugin --profile web add E:\dsh\plugins\dsh-plugin-example
# then stop dsh web (Ctrl+C) and start it again
```

The composition is read at boot, so the running process does not see the package until it restarts. On the
next boot the card appears in **Settings › UI plugins** with its contract badge, and in **Settings › UI**
with a switch, the maintenance block, and a checklist when the manifest declares `testItems`.

## Writing a plain client plugin

The reference is `E:\dsh\plugins\dsh-plugin-example-dialog\`
(`@xjl-resources/dsh-plugin-example-dialog`): a third-party plugin written the way such a plugin usually is.
It knows nothing about `dsh-ui-projects`, injects no service, and mounts its own DOM.

- `package.json` declares `dsh.bundle`, `dsh.client` and `compatibility` — and **no** `dsh.uiProject`, and
  no `peerDependencies`. That is what makes it a plain client plugin rather than a UI project package, and
  it is why the framework has no card, no switch and no scoped stylesheet for it.
- Its client half is an ordinary Cordis plugin. It creates a `<style>` element and two surfaces, appends
  them to `document.body` in `ctx.effect(() => …)`, and returns a disposer that removes them — every side
  effect belongs to the plugin's own fiber.
- The pair of surfaces is the contract made visible: one carries `role="dialog"` (a published interface a
  skin can select without knowing the package) and one carries `role="custom-dialog"` (a string only its
  author can name). The first will be frosted by Liquid Glass; the second cannot be reached by any
  stylesheet, and that is the violation rule 1 exists to report.
- Its `scripts/check.mjs` **imports the framework's real scanner** rather than re-implementing a rule:

  ```js
  const { scanClientBundle, CONTRACT_CODES } = await import(
    pathToFileURL(join(packageRoot, '..', 'dsh-ui-projects', 'src', 'host', 'contract-scan.js')).href
  )
  ```

  and asserts exactly one finding, whose excerpt names `custom-dialog`. A package may reasonably assert its
  own violation like this — the point is that the verdict comes from the same instrument the card uses, not
  from a copy of its rules. (One check like this already earned its keep: it is what exposed the scanner's
  second false-positive class, a display label that quotes a role.)
- `pointer-events: none` on an example surface is not politeness: an example sitting beside a real
  application must not swallow a click meant for the page.

## Where to run the maintenance commands

Both shapes print the same three commands, and the commands act on the **package**, not on a project or a
page. Two rules decide the working directory, and both are read out of the script:

- a package that ships its **own** `install.ps1` (a thin wrapper pointing the framework's script at its own
  directory) is maintained from **its own directory**;
- a package that ships **none** — both example packages, deliberately — is maintained from
  `E:\dsh\plugins\dsh-ui-projects\` with `-Package <name>`.

One sentence per switch, as the source implements them (`plugins/dsh-ui-projects/install.ps1`):

| Switch | What it does |
| --- | --- |
| `-Package <name>` | names the package this run is about, when it cannot be read from the source directory's own `package.json`; it selects the install record (`.dsh-ui-projects-install.<versions dir name>.json`) and the versions directory (`<profile>\.dsh-ui-projects-versions\<versions dir name>\`), where the versions dir name is the package name with `/` replaced by `+` for a scoped one (`@xjl-resources/dsh-plugin-liquid-glass` → `@xjl-resources+dsh-plugin-liquid-glass`); it is **not** an install switch |
| `-Snapshot` | records the version that is running now — `package.json`, `cordis.patch.yml`, `CHANGELOG.md` and `lib/**`, plus a manifest with a sha256 per file — under the profile's versions directory, reads every written file back, and keeps the newest `-Keep` (default 3) |
| `-Update` | the read-only plan: it fingerprints the source tree (excluding `.git`, `node_modules`, `lib`), prints the newest `-Changes` (default 1) changelog section(s), reports the registry capability instead of querying it, and records `lastVerified` beside the existing baseline; it never restores, never installs and never calls git |
| `-Rollback -To <name>` | the only mode allowed to write inside the source tree, and it writes exactly two things: `package.json` and `lib/**`, after backing up what was there and verifying the snapshot against its own manifest; `cordis.patch.yml` and `CHANGELOG.md` are in the snapshot and are deliberately not restored (*stop `dsh web` first*) |
| `-Uninstall` | removes the package from the profile with `dsh plugin --profile <name> remove <name>` and verifies the removal; it leaves the version snapshots and the backups in place, because a package going away is not a reason to forget a version |

Companions worth knowing: `-Rollback -List` (and `-ListVersions`) list the recordings and verify each one
against its manifest without writing anything — the exit code is 1 if any of them does not verify — and
`-DryRun` prints any mode's plan and executes nothing. `-Force` exists for exactly one refusal: a rollback
whose snapshot's `cordis.patch.yml` differs from the tree's is refused unless you pass `-Force`, and even
then that file is not restored. `-Profile` defaults to `web`, `-ProfileDir` overrides it, `-SourceDir`
defaults to the directory the script lives in, `-Name` names a snapshot (a directory name: `^[A-Za-z0-9._-]+$`),
`-Revision` is recorded in the update plan without ever calling git, and `-DshCommand` overrides which
`dsh` is invoked.

The full workflow — the order of the three commands, the on-disk layout, retention, the six refusals before
a restore writes anything, and the manual acceptance list — is `docs/update-and-rollback.md`; what an
uninstall removes and what it keeps is `docs/uninstall.md`.

**No suite runs `install.ps1`.** It writes `$DSH_HOME`, so it is the user's to run, deliberately, after a
dry run; the interface only prints the commands. What the suites do is read the script's text and assert
that each mode still writes only what it promises.

## Verifying what you wrote

```powershell
cd E:\dsh\plugins\<your-package>
node scripts/build.mjs            # src/** → lib/**; the suites and the browser both load lib/
node scripts/check.mjs            # the source-level shape, no composition needed
npm run manifest                  # derive src/client/manifest.generated.js from package.json --check

cd E:\dsh\plugins\dsh-ui-projects
node scripts/check-installed.mjs  # the read-only report: every package, its contract findings, its limits
node scripts/verify.mjs           # the framework's own behavioural suite
```

Then the real machine, because none of the above can answer whether the running application changed:

```powershell
node scripts/browser-verify.mjs --self-check                            # no browser: rule + expression gates
node scripts/browser-verify.mjs "http://127.0.0.1:3081/?token=…" --verify-refusal   # the live gate
node scripts/browser-verify.mjs "http://127.0.0.1:3081/?token=…" --no-write         # the full run
```

`--no-write` installs the interceptor that refuses writes to the `settings` key and runs the refusal gate
first; the gate passes only after it has seen a real write and refused it. Two habits from
`CONTRIBUTING.md` apply to everything above: **rebuild before verifying** (the suites and the browser load
`lib/`, so a stale build makes correct code fail), and **assert the property, not the spelling** — the
summary sentence, the count and the element you read are all things a test can be wrong about while the
feature is fine.
