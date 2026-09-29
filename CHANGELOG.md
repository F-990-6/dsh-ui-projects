# Changelog — dsh-ui-projects

A record of what changed, how it was verified, and what the outcome was. The format exists
because of a specific failure: the settings-dialog problem below was worked on for nine rounds
without a single record of which round changed what, so afterwards the regression point could
only be *inferred* from conversation history rather than looked up.

Two rules make this file useful rather than decorative:

- **Every entry states how the change was verified**, and whether that verification was in a real
  browser. "The stylesheet contains the rule" is not verification that the rule does anything.
- **Negative results are recorded.** A change that was made and did NOT fix the problem is worth
  more than one that was never tried, because it eliminates a hypothesis.

Verification vocabulary used below:

| term | meaning |
|---|---|
| `suite` | `node scripts/verify.mjs` — behavioural assertions against the built bundle |
| `host` | `node scripts/host-check.mjs` — the host half loads, `apply` runs, and it answers the index injection |
| `browser` | measured in a real Chrome over CDP, with screenshots |
| `browser (user)` | confirmed by the user looking at their own running instance |
| `emitted` | `scope-peek.mjs` here, and `emitted-css.mjs` in the package that owns the CSS (it moved to `dsh-plugin-liquid-glass` in 8c) — the CSS the browser actually receives |
| **unverified** | written from reasoning about the source; never observed running |

---

## Round 56i — the snapshot index comes under version control, and the listing learns to skip dot-directories

**Status: done — two commits by the agent, one by the user, red-then-green end to end, and no self-injury to
disclose. Offline at the end, all exit 0: `suite` 1134 / 0 (1131 → 1134), `conformance` 130 / 0, `load` 91 / 0,
`host` loadable, `browser --self-check` green. `lib/client.js` is `a524d5921ef0` throughout, because this
round changed one guard in `scripts/verify.mjs`, one line in `tools/snapshot.mjs`, and two files that live
outside every repository. No browser run for that reason: nothing that ships changed.**

| step | commit | what it did | evidence |
| --- | --- | --- | --- |
| 56i-0 | `07fc82b` (framework), `63a5c79` (tools) | the snapshot listing skips dotted directories, with a guard that says so | `suite` red 1133 / 1 → green 1134 / 0 (+3) |
| 56i-1 | — (files outside every repository) | `.snapshots/.gitignore` (193 B) and two paragraphs in its `README.md` | pure append: 870 bytes, 10 lines, pre-change file an exact byte prefix |
| 56i-2 | `248079b` (`.snapshots`, by the user) | `git init` and the root commit | 3 files changed, 5456 insertions; `ls-files` exactly three |
| 56i-3 | this entry | B.3 closed in `docs/phase2-scope.md` | — |

### The decision, and the option that was measured out

`docs/phase2-scope.md`'s B.3 had been open since Round 53: `.snapshots/README.md` — the file that explains
the snapshots — was itself under no version control, because `.snapshots` is an `EXCLUDE` entry in
`tools/snapshot.mjs` and `E:\dsh` is not a repository. Two ways to close it were scouted before either was
chosen.

- **Folding it into `E:\dsh\tools` was rejected by measurement, not by taste.** With
  `git --git-dir=E:\dsh\tools\.git --work-tree=E:\dsh`, the index's paths are repo-root-relative and now
  resolve where nothing exists: `git status --porcelain` reported **all 17 tracked files as deleted** (46
  entries in total, 3441 with `--untracked-files=all`), which one `git add -A` in that state would have turned
  into a real deletion of the whole tools repository. Keeping a second copy of the file inside `tools/` was
  rejected as well: 56h-3 had just edited the original by one byte, and a copy would not have followed.
- **A repository of its own was chosen.** `.snapshots` got a `.gitignore` with one general pattern (`/*` plus
  three negations) instead of an enumeration that would need an edit for every future snapshot, and a root
  commit holding exactly the three things that have no other history: `.gitignore`, `README.md`, and
  `pre-build/client.js` (the one hand-recovered bundle, 262 KB, included on purpose for that reason).

### The interaction that would not have shown up until it bit

`tools/snapshot.mjs`'s `snapshots()` enumerates every DIRECTORY under `.snapshots` and asks each one to
describe itself, excluding only `pre-build`. A `.git` directory there would have been read as a
**legacy-layout snapshot** — it holds no root subdirectories, so `readSnapshot` maps its whole contents onto
the `plugin` root — and `--list` would have reported it as a snapshot while `--diff .git` compared git's own
internals against the plugin tree. **That was an inference read from the source, never an observation**
(observing it would have required the `.git` to exist). The fix therefore landed before the repository did:
the filter is now `!e.name.startsWith('.') && e.name !== 'pre-build'`, and the new guard in `verify.mjs`
asserts that filter LINE rather than the file's text, with `pre-build` as the control — so rewriting the
listing fails the guard instead of sliding past it.

Measured afterwards, which is the part that matters: `node tools/snapshot.mjs --list` still reports
**47 snapshot(s)**, and `--diff 47-step8b` prints exactly what the pre-change tool printed (80 / 80 lines,
`Compare-Object` differences 0).

### Verification of the new repository

- `git ls-files` → exactly `.gitignore`, `README.md`, `pre-build/client.js`; `git status --short` clean;
  `git status --ignored` lists exactly **47** entries. Ignored is not the same as absent, and both facts are
  now written into `.snapshots/README.md`'s known-defects list, together with the warning that `git clean`
  there would treat the archive itself as disposable (2519 files, 31.6 MiB).
- The `.gitignore` semantics were the one thing the agent could not test — testing them needs `git init`,
  which it does not run — so they were handed to the first `git status --short` after the init: it listed the
  three files and nothing else.
- `README.md`'s edit is proved to be a **pure append**: the pre-change file is an exact byte prefix of the
  post-change one (870 bytes and 10 lines added; sha256 `91b1cb4f5be9…` → `aaf2d96d4255…`), and both files
  decode as strict UTF-8 with zero U+FFFD and no BOM.

### Recorded observations

- **CRLF.** Git prints "LF will be replaced by CRLF the next time Git touches it" for files written by the
  file tools. It performs that conversion itself; recorded as an observation, not as a defect.
- **No self-injury this round, stated rather than assumed**: the tools change is `+1 / −1`, the guard is
  `+23 / −0`, the `.snapshots` README edit is a byte-prefix append, and all four other repositories were clean
  at every checkpoint.
- **One method correction, disclosed for completeness.** The first comparison of `--diff` output against the
  pre-change tool ran it as `git show … | node --input-type=module -- --diff …`, and Node read `--diff` as a
  script path (`Cannot find module '--diff'`): that comparison was void, not evidence. The working method was
  a temporary copy of the old tool inside `E:\dsh\tools\` — its `ROOT` is derived from its own location, so it
  has to sit there — which was deleted immediately afterwards.

## Round 56h — six small items, one tool moved out of the workspace's `tools/`, and the rule that keeps a heading from being eaten

**Status: done — five commits, one per framework item, and NO browser run: this round changed no product
code, so `lib/client.js` is `a524d5921ef0` (375108 bytes) and `lib/index.js` `426313c951a1` before and
after, and Round 56d's browser numbers (239 / 0) still describe what ships. Offline at the end, run by the
agent, all exit 0: `suite` 1131 / 0, `conformance` 130 / 0, `load` 91 / 0, `host` loadable,
`browser --self-check` green.**

| item | commit | what it did | evidence |
| --- | --- | --- | --- |
| 56h-1 | `048b996` | the CLI's name column is derived per section instead of a written-down 34 | `conformance` red 128 / 2 → green 130 / 0 |
| 56h-2 | `a9225eb` | the README names all three files `--shot` writes | one hunk, `+2 / −1` |
| 56h-4 | `9700299` | the dead `matchesWithAncestors` deleted, and the scope document's group B closed | `fake-dom.mjs` `+0 / −29`; `suite` 1122 → 1124 |
| 56h-6 | `ee44c50` | `CONTRIBUTING.md`'s ninth rule, and a guard that counts the rules | `suite` 1124 → 1131 |
| 56h-5b | `0469d87` | seven framework documents stop pointing at `tools/derive-boot-css.mjs` | 7 files, `+35 / −29` |

The other half of 56h-5 is the tool move itself, recorded where it happened: `dsh-plugin-liquid-glass`
(56h-5a `b4a215e`, the follow-up 56h-5c `f82452b`), `tools` (56h-5d `d770a66`) and `dsh-plugin-example`
(56h-5e `f475fe3`) — nine commits across four repositories.

### 56h-1 — the name column is as wide as the names in it

`scripts/check-installed.mjs` padded its name column to a written-down `34`, and `padEnd` pads without
truncating, so a scoped name longer than the column ran straight into the field after it. Both symptoms were
on a real profile and both were already recorded in `docs/phase2-scope.md` (group B, first item):
`@xjl-resources/dsh-plugin-example-dialog` (40 characters) printed as `…-dialog1.0.0`, and
`@xjl-resources/dsh-plugin-liquid-glass` (38) printed as `…liquid-glassno findings`.

- **`scripts/installed-columns.mjs` (new)**: `NAME_COLUMN_FLOOR` (34), `nameColumnWidth(cells)` =
  `max(34, longest + 1)` — one space of separation, so a cell as wide as the column still cannot touch the
  field after it — and the `pad` the CLI used to keep privately. It is a module of its own because the CLI
  can be neither imported (it scans a profile at the top level and calls `process.exit`) nor spawned with a
  captured pipe where this tooling runs; the width rule has to live where a suite can call it.
- **Six call sites, one width each**: `DEPENDENCIES`, `BUNDLES`, `UI PROJECT PACKAGES`, `UI CONTRACT`,
  `NOT SCANNED`, `UNATTRIBUTED VERSION DIRECTORIES`. A section of short names is still exactly 34 wide —
  that is what the floor is for — and a 40-character name widens only the section it appears in.
- **Names are never truncated.** A shortened package name is a wrong identity, which is worse than a wide
  column. **Known residual, recorded rather than fixed:** the `version` column is still a fixed `10`, so a
  version like `1.0.0-beta.1` (12 characters) can still reach the field after it.
- **Red, then green.** The red was taken with today's behaviour extracted and unchanged (`nameColumnWidth`
  returning the floor, the six sites calling it): `128 assertions, 2 failing` —
  `a section holding a 40-character name is wider than that name` (got `false`) and
  `the version column starts at the same offset whether the name is 40 characters or 14` (got `40`, expected
  `34`). With the rule in place: `130 assertions, 0 failing`. Worth reading carefully: that summary line
  prints the PASSING count beside the failing count rather than their sum, so `128 assertions, 2 failing` was
  130 assertions in total — and `conformance` went 122 / 0 → 130 / 0 across this round (eight new: seven
  assertions, plus one more file in the write-API guard's list).
- **A source guard, because behaviour here is unreachable**: `check-installed.test.mjs` reads the CLI and
  asserts that no name column is padded to the written-down `34` any more and that exactly six sites ask for
  a width — its label enumerates the six sections, so a seventh has to be a decision rather than a silent
  addition.
- **Real profile, before and after** (`node scripts/check-installed.mjs`, profile `web`, read-only): the two
  recorded strings are now `@xjl-resources/dsh-plugin-example-dialog 1 finding(s)` and
  `@xjl-resources/dsh-plugin-liquid-glass   no findings`, and the version column starts at the same offset
  in every row of each section. The cost is disclosed where it is paid: inside a section that holds the
  40-character name, short rows are padded to 41 (the `dsh-cost-meter` row gains seven spaces).

### 56h-2 — the README says how many files `--shot` writes

`README.md` said "`--shot` writes `glass.png` and `glass-dark.png`". The flag writes three files, and the
moments are all in `scripts/browser-verify.mjs`: the dialog open (`:2147-2150`), the dialog closed with
Escape (`:2168-2170`, the key itself sent at `:2161-2162`), and dark mode (`:2414-2417`). The sentence now
names all three — `glass.png` / `glass-closed.png` / `glass-dark.png` — with the wording taken from the note
that had recorded the discrepancy since Round 51. **No assertion was added**: locking one sentence would pin
a spelling, and the file's own documentation-guard rule says what that costs.

### 56h-4 — the dead matcher, and closing what had already shipped

`scripts/fake-dom.mjs` `+0 / −29` (393 → 364 lines): `matchesWithAncestors` had no caller anywhere in the
tree. `parseCompound` stayed — it is still used inside `matches`, and it is what the new guard's control
assertion reads — and neither consumer's import line moved (`load-check.mjs:40`, `verify.mjs:130`).

- **The guard is two-way.** `verify.mjs` reads the export list, first asserts that a live export
  (`parseCompound`) was FOUND — a guard over an export list can otherwise pass by reading nothing at all —
  and then that `matchesWithAncestors` is absent. The name coming back fails it; so does a reformatting that
  stops the list being read.
- **`docs/phase2-scope.md` closes what shipped** (`+7 / −1`): B.1 (this round's CLI column), B.2 (the
  `--shot` sentence) and B.4 (the snapshot index's heading said "20 – 38" while its prose said 20 through 37)
  each carry a `**Closed in 56h-N**` line with the original record left intact, and the group C row now reads
  "`matchesWithAncestors` is deleted (56h-4) and the derivation tool has moved into the skin package
  (56h-5); the other two still stand."
- **B.3 stays open on purpose.** `.snapshots/README.md` is under no version control at all — `.snapshots` is
  an `EXCLUDE` entry in `tools/snapshot.mjs` and `E:\dsh` is not a repository — so which repository should
  hold it is a decision nobody has made yet. Its heading was corrected on disk in 56h-3 (`.snapshots` is not
  in git, so the change exists on this machine only), and the correction was proved byte-wise: one byte, one
  line, sha256 `edc565235e16…` → `91b1cb4f5be9`.

### 56h-6 — the ninth rule, and a guard that counts the rules

Three times an insertion into this file consumed the heading of the round it was placed before: Round 50 ate
Round 49's heading, Round 55's heading went the same way, and Round 56a's was eaten by the entry inserted
above it. So `CONTRIBUTING.md` gained a ninth verification rule — **an insertion is proven by what it did not
delete**: the anchor is the boundary **together with the whole line that follows it**, that line comes back
verbatim in the replacement, a pure insertion is one whose `git diff --numstat` deletion column is `0`, and
the `## Round` heading count moves by exactly one.

- `Eight rules` → `Nine rules`, and the kinship paragraph gained the sentence that says rule 9 is the same
  discipline applied to the edit itself.
- **The guard**: `verify.mjs` reads `## Verification discipline`, asserts the numbered items are exactly
  `[1..9]` — no gap, no duplicate, no tenth — that the introduction's own word is `Nine rules`, and that the
  ninth rule names `anchor`, `## Round` and `numstat`. It does not lock the sentences, for the same reason
  56h-2 added no assertion.
- **The round used the rule on itself**: every insertion in it was anchored with the following line, and
  `git diff | grep '^[+-]## '` was empty in all nine commits.

### 56h-5b — the documents follow the tool out of `tools/`

Seven files, `+35 / −29`: `README.md` (four places), `docs/plugin-development.md`, `docs/phase2-scope.md`
(two), `src/host/service.js`, `scripts/build.mjs`, `scripts/verify.mjs` and `CONTRIBUTING.md` — whose rule 6
said "`E:\dsh\tools` … holds the only copy of `snapshot.mjs` and `derive-boot-css.mjs`", which stopped being
true the moment the tool moved. The framework's `README.md` no longer claims a move that had not happened
either: it said the derivation tool "moved to the package that owns the CSS" from step 8c on, and this round
is what made that sentence true.

### Process deviations, disclosed

- **56h-4's guard first failed for the wrong reason.** The first red read `check is not defined`: this suite
  has `equal`, `truthy` and `contains`, and no `check`. The assertion never ran (the count stayed at 1122,
  which is what said so), the helper was corrected, and the red was taken again — `expected false, got true`,
  1124 / 1.
- **One change landed outside the item list, deliberately and after asking.** `README.md:399-403` carried the
  same stale `tools/` path as the three places that were listed; leaving it would have been the exact defect
  the item exists to remove.
- **No browser run, and that is a decision rather than an omission**: this round touched `scripts/**` and
  documents, `lib/` is byte-identical, and the browser suite asserts a running interface.

## Round 56b–56d — the CHANGELOG arrives on demand, and the row folds down to what a reader needs

**Status: done — four sub-rounds, one commit each, and one of them a repair of the one before it:**

| sub-round | commit | what it did | `suite` | browser |
| --- | --- | --- | --- | --- |
| 56b | `a685891` | the per-package CHANGELOG endpoint, folded on demand | 1029 / 0 | 239 / 0 |
| 56c | `54893c6` | the row folds the noise away, folds get one look, commands get copy buttons | 1080 / 0 | **232 / 1** |
| 56c fix | `07ca174` | `CommandRow` becomes a component instead of a function call | 1084 / 0 | 239 / 0 |
| 56d | `36a5ca7` | the layout redone, every fold starts closed | 1122 / 0 | 239 / 0 |

Offline, run by the agent, all exit 0 at the end: `suite` 1122 / 0, `conformance` 122 / 0, `load` 91 / 0,
`host` 41 ok / 0 failing, `browser --self-check` green. `lib/index.js` did not change once in the three
rounds (`sha256:426313c951a1`, 13665 bytes) — no host entry was touched — while `lib/client.js` moved
four times, `9bddd1319152` → `1b841db51e4f` → `462ace47381c` → `a524d5921ef0` (375108 bytes), and
`lib/changelog.js` was born in 56b (`44af689b32e6`, 9316 bytes) and changed in 56d
(`b0f978c1eb05`, 10483 bytes).**

### 56b — §五's CHANGELOG, read on demand

The one field §五 asks for that has real CONTENT behind it (the framework's own file is 284 KB), and the
page cannot see a package directory at all: the listing sends identity, composition state and problems,
and never a path. So the reading happens on the host, for one package at a time, when a reader opens the
row.

- **`src/host/changelog.js` (new)**: `summarizeChangelog`, `firstHeadingOf`, `readChangelogAt`,
  `readFirstHeading`, and the constants the CLI's own behaviour is copied into — `CHANGELOG_MAX_BYTES`
  (1 MB), `CHANGELOG_HEAD_BYTES` (64 KB), `CHANGELOG_SECTION_LINES` (40), `CHANGELOG_SECTIONS` (1), and
  `CHANGELOG_REASONS` (five codes: `not-installed`, `no-file`, `no-sections`, `too-large`,
  `unreadable`).
- **`profile-scan.js`**: each dependency carries `changelogHeading`, read from a bounded **64 KB head** of
  its file — a folded row should name the section it will show without costing one request per package on
  every page open, and the partial last line is dropped so a heading cut in half by the cap cannot be
  reported as a heading that exists.
- **`installed-endpoint.js`**: `CHANGELOG_PATH` and `createChangelogHandler({ scan, read })`. The route
  rides the same `/api` fence as the listing, and it is registered in the same function so that "the
  routes this package mounts" stays one list.
- **The name is a LOOKUP KEY, never a path segment.** `?name=` is matched against the same scan the
  listing comes from, and the directory read is the one that entry resolved — so `../../secret` is
  answered `not-installed` **without touching a filesystem**.
- **`installed.js`**: `loadChangelog(name)` with a per-package cache, one in-flight request per package,
  and `refresh()` as the single invalidation point; a result that arrives after a refresh is dropped and
  forgotten — the store's `generation` counter is what decides — the same rule the listing follows.
- **`panel-plugins.js`**: `ChangelogBlock`, a `<details>` whose summary drives the load from an
  `onClick` on the summary — React has no `onToggle` synthetic event and the `toggle` event does not
  bubble, so `<details onToggle>` would be a control that looks wired and reads nothing.
- **The truncation arithmetic is `install.ps1`'s**, including its off-by-one: the cap counts the heading,
  so a heading plus 59 body lines is 60 lines, 40 are kept, and the reader is told 20 were dropped. The
  one deliberate difference: the CLI prints the "… N more line(s)" sentence itself, while this module
  reports `truncated`/`moreLines` as facts and the page renders the sentence from its own dictionary —
  the CLI speaks English, the settings page is bilingual.

The red, before any product change:

```
953 assertions, 7 failing

  FAIL the column reads the dictionary it is actually given
         every key the column reads exists in the en dictionary: expected [], got ["changelogTitle", "changelogLoading", "changelogFailed", "changelogNoFile", "changelogNoSections", "changelogUnreadable", …2 more]
  FAIL the changelog endpoint looks the name up and never joins it into a path
         installedEndpoint.createChangelogHandler is not a function
  FAIL the changelog summariser keeps install.ps1 rules, including its arithmetic
         changelog.summarizeChangelog is not a function
  FAIL the changelog reader tells its own answers apart, without reading a file it refuses
         the reader publishes a one-megabyte cap, and the sparse file below is one byte over it: expected 1048576, got undefined
  FAIL the changelog is fetched on demand, cached per package, and invalidated by a refresh
         store.changelog is not a function
  FAIL the row folds its changelog away, and renders all three answers
         expected to find "data-uip-changelog=\"skin-pkg\""
  FAIL the changelog loads when a row is opened, and not when it is closed
         plugin.__internals.createChangelogToggle is not a function
```

Green: `suite` **1029 / 0** (965 → 1029, +64) and `load` **91 / 0** (85 → 91) — the second one matters
because 56b changed the host's route table, and `load-check.mjs` is the suite that watches it.

**Self-inflicted, three of them.** (1) The first version of the reader test failed on its own
SCAFFOLDING — `truncate(NaN)` from a constant that did not exist yet — instead of on a named assertion;
it now asserts the cap first and builds the sparse file from a literal. (2) `load-check.mjs`'s `equal` is
strict identity, so a new assertion comparing `sections` to `[]` could never pass (`[] !== []`); it
asserts `.length` now. (3) An `import` was first written among the constants of `installed-endpoint.js`
instead of at the module head — legal, and moved before anything ran.

### 56c — the row folds the noise away, folds get one look, commands get copy buttons

The column had grown to where a reader met a wall of commands, hints and "not declared" sentences before
learning anything about the package. This sub-round folded all of it and gave the folds one appearance.

- `panel-plugins.js`: `RowHeadFacts` (the description line, and the project id) / `RowFoldFacts` (the
  author, the four project chips, the switch mirror) / `CommandRow` / `copyCommandText`; the row gained an
  outer `<details data-uip-row-details>`; `MaintenanceBlock` and `CommandBlock` became folds of their own;
  `ContractPanel` took an `open` prop; `ChangelogBlock`'s summary joined the shared hook.
- `core.css`: ONE rule for every fold summary through the shared `data-uip-fold-summary` hook — background
  `--dsw-alias-bg-layer-2`, a 3px brand-coloured left border, a `▶` that rotates, 12px bold — plus
  `padding-left: 16px` for content, a separator above it, and the four declarations that stop a command
  from scrolling sideways (`pre-wrap`, `break-all`, `max-width: 100%`, `overflow-x: hidden`).
- `locale.js`: seven keys in both languages. The "not declared" sentences stopped being read at all: a
  field with no value renders nothing, because eight rows of "not declared" is a page nobody reads.

The red:

```
1038 assertions, 4 failing

  FAIL a row answers three questions by default, and folds the rest away
         expected to find "data-uip-row-details"
  FAIL every fold has the shared summary hook, and no content block does
         the row has several folds (2): expected truthy, got false
  FAIL the copy buttons carry exactly the commands their blocks print
         the snapshot command has a copy button: expected truthy, got false
  FAIL a clean contract keeps its badge and stays folded; a finding opens
         while a row with a finding opens its panel for the reader: expected true, got false
```

Green: `suite` **1080 / 0** (1029 → 1080, +51).

**Self-inflicted, three of them, and two are worth reading.** (1) A missing closing parenthesis in the row
assembly left the source syntactically invalid — and **the build printed success anyway**, because
`scripts/bundle-client.mjs` rewrites ESM into CJS with pattern matching and passes each module's body
through as text inside a factory wrapper ("the only transformation is ESM → CJS plus the module
registration wrapper", its own header); the suite died loading the bundle, and `node --check` on the
touched source found it in a second. "The build succeeded" is not "the source loads". (2) An assertion
looked for the fold marker inside the slice taken BEFORE the fold — a test that could never pass. (3) The
contract-panel assertion sliced from the attribute while its regex required the tag to start with
`<details`, so the "clean row stays folded" half was passing because the regex could never match at all;
the failing half next to it is what exposed it.

**Four existing assertions had to change**, because this sub-round removed the behaviour they pinned:
the two "not declared" sentences and the two "not applicable" ones now assert the ABSENCE of the line or
chip instead. Each carries a comment saying that the specification changed rather than that the code was
wrong.

### 56c fix — `CommandRow` becomes a component, and a source guard keeps it that way

The browser reported **React error #310**, "Rendered more hooks than during the previous render", with the
stack pointing at `CommandRow` — and the column rendered blank.

- **The cause was not a conditional hook.** `CommandRow` called `useState` unconditionally; it was
  **called as a plain function** at four sites, and a plain call is not a component boundary, so its hooks
  were registered on `UiPluginsSection`, four per row, inside a loop over the dependencies. The loading
  render had three hooks and the first render with data had 3 + 4N. The offline suite could not see it:
  `renderToStaticMarkup` mounts once and never reconciles, so there is no previous render to compare
  against.
- **The fix** is four call sites: `CommandRow({…})` → `React.createElement(CommandRow, {…})`. Its
  implementation was not touched, and neither was anything else — including the `UiPluginsSection` root
  call in `index.js`, which is the session root and has a constant hook count.
- **The guard** in `verify.mjs` reads `panel-plugins.js` with comments blanked (so failure line numbers
  are the file's own), collects the functions whose bodies call a hook, and asserts that set is EXACTLY
  `['UiPluginsSection', 'CommandRow']` — named, not implied — and that neither name is ever called
  plainly. A new hook in any of this file's element factories now fails the suite instead of a browser.

The red, against the code as 56c shipped it:

```
1083 assertions, 1 failing

  FAIL a hook lives in a component, and components are created rather than called
         CommandRow is CREATED as an element, never called as a plain function — a plain call puts its hooks on the enclosing component: expected [], got ["L729: CommandRow({ copy, React, kind: 'snapshot', source: 'install.ps1", "L730: CommandRow({ copy, React, kind: 'update', source: 'install.ps1 -", "L731: CommandRow({", "L788: CommandRow({ copy, React, kind: 'uninstall', source: command }),"]
```

Green: `suite` **1084 / 0**, and the browser back to **239 / 0**.

**Self-inflicted, one.** The guard's own first version matched `NAME(`, and `createElement(CommandRow, {…})`
is followed by a comma — so after the fix it reported zero element call sites and failed on its own last
assertion. It was found by running the guard **against the fixed code as well as the broken code**, which
is the lesson: a guard has to be exercised in both directions, or it fails for the wrong reason.

### 56d — the layout redone, every fold starts closed, and the copy button comes back

- **The default row** is preview, name@version, the badges, one line of description cut at 80 characters,
  and one `▶ 详情`. The project id and the switch mirror moved into the fold: the default row answers
  "what is this package", and which project it contributes is the first thing wanted after opening it.
- **Inside the fold, in the reader's order**: author (when declared) → contract → maintenance →
  uninstall → changelog, every one of them folded, and one level deeper still the prose that explains the
  commands (`data-uip-hint`). Opening the row must not open four panels with it.
- **Every `<details>` carries `open: false` explicitly**, and nothing is remembered: no store, no
  `localStorage`, no key of its own. React writes the attribute on mount and only when the prop CHANGES,
  so a reader's own open/close survives ordinary re-renders while a fresh mount always starts closed.
- **`ContractPanel` is folded whatever the scan found.** 56c had it open itself when a finding existed,
  which pushed the rest of the row off the screen and broke the browser assertion `the panels start
  folded, so a row stays a row` — that assertion is green again.
- **The copy button recovers.** It says `Copied` (or why it could not), and 1.5 s later says `Copy`
  again; the timer lives in a `useRef`, is armed by one `useEffect`, and `clearTimeout` runs in that
  effect's cleanup so an unmount cannot leave a timer behind. The button is never disabled.
- **The changelog summary reads `CHANGELOG · 1.0.0 — Step 8c`**: the version it belongs to, then the
  heading with its markdown `##` taken off and cut at sixty characters. The body is the section's lines
  and does NOT repeat the heading, which used to be printed twice.
- **`src/host/changelog.js` gained `stripMarkdown`**: `**bold**`, `__bold__` and `` `code` `` lose their
  marks before the payload is sent, because the row renders plain text and asterisks read as a rendering
  fault. A `###` line is kept as the plain text it looks like, and links, images and list markers are NOT
  rewritten — structure a plain `<pre>` cannot express is left as written rather than quietly flattened.
- **`core.css`**: 8px between sibling folds, 8px between a summary and its content, an 8px radius on the
  summary.

Green: `suite` **1122 / 0** (1084 → 1122, +38), and the browser **239 / 0**.

**Six existing assertions changed**, all for the same reason and each with a comment saying so: two
pinned the raw `## ` heading in the summary, one pinned the project id in the default view, one pinned
the contract panel opening on a finding, and two pinned the maintenance title naming the package (the
package is now named by the fold's own hook and by the row header).

**Self-inflicted, four of them.** (1) and (2): a new test callback used `await` without being `async`,
twice, and both times the suite died at load with no output at all — a one-second `node --check` would
have found either. (3) The React stand-in used to walk the column as data did not INVOKE function
components, which real React does, so the tree stopped at the component boundary and the test could not
find the button it was looking for. (4) The first attempt at a fake clock replaced `globalThis.setTimeout`
— which cannot work, because the bundle captured its own `setTimeout` in the sandbox it was evaluated in;
the harness's `boot({ fakeTimers: true })` clock is the one the component actually calls, and the test now
reads the 1500 ms deadline out of `harness.timers`.

### The process deviation of this batch, stated plainly

**56d was not red-first.** Its tests and its implementation were written in one pass, and the first suite
run happened after the code was in — so the three failures it produced were not "new assertions failing",
they were an existing assertion the new specification reverses, a test of mine that was wrong, and a
second existing assertion the same reversal caught. The red-first discipline held for 56b, 56c and the
56c fix, and it did not hold for 56d; the record should say which round broke it rather than implying all
four were the same.

### Browser verification, per sub-round

`browser (user)`, and it caught what no offline assertion could: 56b → **239 / 0**; 56c → **232 / 1**, the
failure being `the panels start folded, so a row stays a row` (the contract panel opened itself); 56c fix →
**239 / 0**, which is also the proof that the hooks regression is gone; 56d → **239 / 0**. The counts moved
because a failure aborts the phases after it, so "232 with one failure" is one broken assertion rather than
seven missing ones.

### Left to verify by hand, and what it would take to fix

**Whether leaving Settings › UI plugins and coming back really closes every fold.** The component carries
no remembered open state, and a fresh mount renders every fold closed — that is asserted offline. What
offline cannot know is whether the SHELL unmounts the section or merely hides it: a hidden tree keeps its
DOM, and DOM `<details>` state is not React's to reset. If the browser check finds folds still open after
a round trip, the fix is a `mountId` counter in `index.js` — the render handler already runs once per
entry, so it can pass a number that becomes part of each row's `key`. `index.js` was outside this batch's
file list, so that is a next-round item with a known shape rather than a guess.

---

## Round 56a — the installed-package row reads its own facts, and the preview rule gets one home

**Status: done — ten files changed: `src/host/profile-scan.js` (+92 / −1),
`src/host/installed-endpoint.js` (+11), `src/client/preview.js` (new, 3247 bytes), `src/client/panel.js`
(+6 / −28), `src/client/panel-plugins.js` (+217 / −39), `src/client/index.js` (+6 / −1),
`src/client/locale.js` (+102 / −26), `src/client/styles/core.css` (+74), `scripts/verify.mjs`
(+307 / −1), and `scripts/build.mjs` (+1 — the plan had missed this file: `MODULE_ORDER` is a hard
list, and a new client module that is not registered in it fails the build). Offline, run by the agent,
all exit 0: `suite` **965 / 0** (878 before, six tests added), `conformance` 122 / 0, `load` 85 / 0,
`host` 41 ok / 0 failing, `browser --self-check` green. `lib/client.js` moves from
`sha256:6185ed77fe76` (330400 bytes) to `sha256:6228749b2535` (347672 bytes); `lib/index.js` stays
`sha256:426313c951a1` (13665 bytes) because the host ENTRY did not change — while
`lib/profile-scan.js` (`sha256:f703bcceb9eb`, 32711 bytes) and `lib/installed-endpoint.js`
(`sha256:6137012ddc8a`, 6542 bytes) do carry this round. `lib/**` is gitignored; the snapshot is what
keeps it. Live: **the browser suite 239 / 0, `browser (user)`.**

### The goal: §五's first batch, and one rule with one home

The plugins column rendered name, version, kind, composition state, the contract badge and panel,
problems, the maintenance commands and the uninstall block — and none of the identity facts §五 opens
with: 作者、描述、预览. It also rendered `.uip-plugin`, `.uip-plugin-head` and `.uip-plugin-name` with
**no stylesheet rules at all** (the classes existed only in the component), which is half of why the
column read as unfinished.

This round carries the package's own facts from `package.json` to the row, gives the preview a single
implementation shared by both settings pages, and — the part that turned out to need a decision —
renders §五's 启用开关 as a **read-only mirror** of the projects page's switch rather than as a second
switch. §二.2 already divides the labour ("UI 栏目管外观项目启停，插件栏目管安装来源、版本、更新、
卸载"), and a second switch in this column would be a second writer for one state.

### What changed

- `profile-scan.js`: three exported pure mappings — `displayAuthor` (npm's string form passed through
  unparsed, its object form assembled, everything else `null`), `uiProjectSubset` (exactly the seven
  fields a row renders, every absent one `null`, and an EMPTY `modifies`/`requires` list collapsed to
  the same `null` so one fact has one spelling), and `packageFacts` (the description comes from the
  package's own `package.json`, not from `dsh.uiProject.description` — two different sentences about
  two different things).
- `installed-endpoint.js`: the projection gains `description`, `author`, `uiProject`. All three are
  always present (`null` when the package declares nothing), so "declared nothing" and "this host is
  older than this page" cannot collapse into one another — the rule `contract.reason` already states.
  `INSTALLED_SCHEMA_VERSION` is deliberately NOT bumped: the fields are additive, and bumping would
  demand a restart on both sides to agree.
- `preview.js` (new) + `panel.js`: `createPreview` moved out so that "is this an image path or a CSS
  material", and "what does a screen reader call it", have one answer for both columns;
  `previewKindOf` was added because the installed-package column needs the same decision TWICE for one
  row (once for `data-uip-preview`, which the stylesheet keys the layout off, and once to decide
  whether to render anything) — a second regex there would have been the defect this move removes.
- `panel-plugins.js`: the row is `li.uip-plugin[data-uip-preview="image|gradient|none"]` with an
  optional preview column and a `div.uip-plugin-body`; new `FactsBlock` (description, author, four
  project chips, project id, mirror), `metaChip`, `priorityTextOf` and `projectStateOf`; a new optional
  `projects` prop with its own subscription; the project-id line moved up into the facts block.
- `index.js`: `UiPluginsSection({ …, projects: store })` — the projects store, read-only, the same way
  the projects page already receives the installed store.
- `locale.js`: 16 new keys per language, plus a `SHARED` object holding the four vocabularies BOTH
  pages read (perf tiers, the priority sentence, the eight region names, the preview alt text).
  `plugins.perf` and `perf` are the SAME object, not two equal ones — asserted by reference, because
  "equal today" is what drifts.
- `core.css`: a new `/* ── installed package row ── */` block. Every selector is scoped to
  `.uip-plugin`, INCLUDING the ones that size a preview, because `.uip-preview` is shared with the
  projects page and its own rules own the default size.

### The red

```
875 assertions, 7 failing

  FAIL the column reads the dictionary it is actually given
         every key the column reads exists in the en dictionary: expected [], got ["descriptionNotDeclared", "authorNotDeclared", "author", "hostFieldMissing", "previewNotDeclared", "perfNotDeclared", …14 more]
  FAIL displayAuthor renders every npm author shape, and refuses to invent one
         profileScan.displayAuthor is not a function
  FAIL the uiProject subset carries exactly the seven fields the row reads
         profileScan.uiProjectSubset is not a function
  FAIL packageFacts reads the package manifest, and never invents an author
         profileScan.packageFacts is not a function
  FAIL the wire projection carries the row facts, and null is not the same as a missing key
         the key is PRESENT even when the answer is null: "declared nothing" and "this host is older" must not collapse: expected true, got false
  FAIL the row shows its own facts, and a package without a uiProject gets none of the project ones
         the dictionary carries the sentences this row is about to render: expected [], got ["descriptionNotDeclared", "authorNotDeclared", "author", "previewNotDeclared", "perfNotDeclared", "priorityNotApplicable", …4 more]
  FAIL the switch mirror reports the project state, and degrades when there is no project store
         expected to find "data-uip-project-state=\"on\""
```

**The first red run was not a red at all.** The new tests imported `displayAuthor` and friends BY NAME,
and an export that does not exist yet is a module-load `SyntaxError`: the whole suite died before a
single test ran, so nothing could be shown about the existing 878. Switching to a namespace import
(`import * as profileScan …`) turns a missing export into `undefined`, the call into a TypeError inside
its own test, and the failure into a named one — which is the shape above. **No pre-existing test went
red**: the seven failures are the six new tests plus the dictionary test this round extended, and the
source guard that forbids a direct `t.<key>` read in `panel-plugins.js` stayed green — it is the test
named "the column reads its copy through the plugins namespace", cited by NAME rather than by line
number because this round added three hundred lines above it.

### The green

`suite` 965 / 0 (878 → 965, +87 assertions). `conformance` 122 / 0, `load` 85 / 0,
`host` 41 ok / 0 failing and `browser --self-check` are unchanged — the host suites matter here because
this round changed the scan and the wire projection, and `check-installed.test.mjs` is the suite that
watches them.

### Self-inflicted, three of them

1. **The first red run was not a red.** Named imports of exports that do not exist yet are a
   module-load `SyntaxError`, so the suite died before any test ran. Stated in full under "The red",
   because the fix — a namespace import — is the reason the red above is readable at all.
2. **A wrong assertion of mine, not wrong code.** The author test asserted the raw string
   `Ada <ada@example.com>`, but `renderToStaticMarkup` escapes it: the markup carries
   `Ada &lt;ada@example.com&gt;`. The implementation was right; the assertion was rewritten to pin the
   property that actually matters — **a package cannot inject markup through its own `package.json`** —
   rather than the spelling of a string. (The tempting fix here is to the renderer, which is why the
   test now says out loud which behaviour it is asserting.)
3. **A draft that never ran.** The first version of the mirror subscription cleared a
   `setProjectsRevision` it declared further down the component (a temporal-dead-zone hazard). It was
   replaced with the same "hold the snapshot" pattern the installed state already uses, before any run.

### The five answers this round had to give

- **The projection carries exactly seven keys.** Asserted twice, with `Object.keys(...).sort()` — once
  on `uiProjectSubset` and once on the wire entry `projectScan` produced — because "only what a row
  reads crosses" is the endpoint's stated doctrine and a leak of `testItems`/`controls`/`id`/`name`
  would be invisible in any behavioural test. A third assertion pins that every absent field is `null`
  and never `undefined`, so `JSON.stringify` cannot drop one.
- **Every npm author shape is covered.** Five declared forms (a string passed through unparsed,
  `{name}`, `{name,email}`, `{email}`, `{url}`) and four that declare nothing (`{}`, `null`, a number, a
  list) — nine assertions, plus one that `packageFacts` reads `manifest.author` rather than
  `dsh.author`.
- **The mirror's degradation is safe.** With no `projects` prop the column renders, throws nothing, and
  shows **no mirror at all** — asserted as the absence of `data-uip-project-mirror` anywhere, because
  "some mirror" would pass a weaker test while inventing a state. The three states are pinned
  individually: `on`, `off`, and `absent` (installed, but this session never mounted its client half),
  which is explicitly not `off`.
- **The shared vocabularies are one object, not two equal ones.** `perf`, `priority`, `regions` and
  `previewAlt` are asserted by **reference** (`dictionary.plugins.regions === dictionary.regions`) in
  both languages, and the premise was checked first: `strings(locale)` returns the same dictionary
  object every call (`locale.js`), so a reference comparison means what it says.
- **`panel.js` lost a function and changed nothing else.** A probe compared the moved function against
  the file at HEAD line by line: 18 non-blank lines then, 17 now, and the only difference is the two
  lines that were deliberately replaced (the local `isImage` regex → the shared
  `previewKindOf(...) === 'image'` call); the other sixteen are byte-identical. The probe
  (`node_modules/.probe-56/`, gitignored) also documents why the comparison is of CODE and not of
  screenshots. On top of that, the round added the assertion the move needed: the three branches are
  pinned on the **card itself** (gradient, image path, nothing), so a future edit to the shared helper
  cannot silently restyle the projects page.

### A finding, recorded: the row had no stylesheet at all

`.uip-plugin`, `.uip-plugin-head` and `.uip-plugin-name` existed **only in the component** — `core.css`
had rules for `.uip-list`, `.uip-title`, `.uip-badge*` and `.uip-preview*`, and none for these three. So
the column has been rendering unstyled since it was built, which is most of why it read as unfinished.
This round adds the block (a grid with a 116px preview column and `container-type: inline-size`, because
the settings dialog can be 300px wide inside a wide window — the same reasoning the project card's own
container query records).

Every selector in it is scoped to `.uip-plugin`, including the preview sizing: `.uip-preview` is shared
with the projects page, and a bare rule here would resize that page's cards from this column's
stylesheet.

### What the rows will show today, and why that is not a bug

Recorded because a later reader will see it and file it: **no package in this workspace declares an
`author`** (`contributors`, `homepage` and `repository` are absent too), **no package declares
`modifies`, `priority` or `requires`**, and `perfLevel` exists on two of the five. So §五's four chips
render their "not declared" / "enhancements only" sentences for every row right now, and the author line
says `package.json` has none. That is the honest report of what is installed rather than a rendering
fault — and adding the metadata to the packages is a packaging decision, deliberately left out of this
round.

### The browser run

**239 / 0, `browser (user)`.** The class of assertion most at risk was the text-based few (a row's
`textContent` now carries a description, an author line and up to four chips that were not there
before), and they passed. Structural assertions were never at risk: the row gained a wrapper and a
preview sibling, while every existing hook (`data-uip-plugin`, `data-uip-contract*`,
`data-uip-maintenance*`, `data-uip-command*`, `data-uip-restart*`) is unchanged.

### What this round does not include

The CHANGELOG panel and its on-demand endpoint (56b), the copy buttons and the "copy diagnostics"
control (56c), and `author` declarations in the five `package.json`s (a packaging decision, not a
rendering one).

---

## Round 55 — T3: an unknown record is not an empty one, and the first frame answers while it lasts

**Status: done — five files changed: `src/client/persist.js` (+83 / −20), `src/client/runtime.js`
(+189 / −21), `src/client/index.js` (+19 / −1), `src/client/diagnostics.js` (+11 / −0), and
`scripts/verify.mjs` (+296 / −3). Offline, run by the agent, all exit 0: `suite` **878 / 0** (844 before,
six tests added), `conformance` 122 / 0, `load` 85 / 0, `host` 41 ok / 0 failing, `browser --self-check`
green (eleven cases). `lib/client.js` moves from `sha256:b5eccae3678f` (315101 bytes) to
`sha256:6185ed77fe76` (330400 bytes) — the first change under `src/**` since the step-9b work
(`f82ee85`, `9820a38`; `git log -- src` reproduces that), so the hash moving IS this
round rather than a regression — and `lib/index.js` stays `sha256:426313c951a1` (13665 bytes)
because the host half was not touched. The browser half of `browser-verify.mjs` was not run; see the last
section.**

### The goal: stop answering "I do not know" with "you chose nothing"

`persist.read()` had one answer for two different situations. While the settings document was still in
flight it returned the EMPTY record, whose only meaning is "the user has never chosen anything" — so
`#wantedIds()` fell back to each project's shipped default, and a skin the document said was ON came back
OFF. Meanwhile the HOST half had already painted it on: the host reads the same document at emit time and
stamps `data-ui-project-<id>="on"` on `<body>` before this bundle exists. The page then ran in two minds —
the frame showed the skin, the registry said it was off, the panel's switch read `false` — and the next
toggle recomputed `enabled` from an empty active set, which turns "the transport was slow for two seconds"
into "the user turned it off". That is **B.2's twin**: same window, one plane over.

T3 separates the two. `read()` returns `undefined` while the record is unknown, and the wanted set now has
three honest answers instead of two: the record when it has been read, the shipped defaults when the
document says nobody has ever chosen, and **what the first frame already painted** while the record has not
arrived. When the document finally answers, `#reconcile()` replaces the frame's answer with the record's,
in both directions.

### What changed

- `persist.js`: `current()` returns `cached` instead of `cached ?? emptyRecord()`; the typedef says
  `read(): UiProjectRecord | undefined` and spells out that `undefined` is a fact about the TRANSPORT while
  the empty record is a fact about the USER; `subscribe(listener)` is added to both backends (the settings
  one notifies from the scope callback it already had, the local one after a write) and `dispose()` clears
  the set. The long `READY_TIMEOUT_MS` comment — which had described the old behaviour as intended — now
  describes this one, keeping "never hangs" and dropping "falls back to the defaults".
- `runtime.js`: `start()` tolerates an undefined record, seeds `frameAdopted`, splits the walk into
  `#applyWanted()`, and subscribes to the record when it never arrived; `#reconcile()` (serialized, and
  writing nothing) applies the record, disables what it does not want, clears `frameAdopted` and notifies
  the panel; `#wantedIds()` grew the unknown branch plus `#frameWantedIds()`/`#defaultWantedIds()`;
  `#remember()`'s seed is `record?.initialized === true`; `resetOne()` no longer dereferences an unknown
  record; `dispose()` unsubscribes; `diagnostics()` reports `adoptedFromFrame`.
- `index.js`: `enabledIds: () => persist.read()?.enabled ?? []`, and `bootEvidence: { announced:
  presenceAtBoot, markerPresent: bodyMarkerPresent }` handed to the runtime — the presence snapshot was
  already read here for the service, so this is one reader with two consumers rather than a second reader.
- `diagnostics.js`: `persistAdopted`, next to `persistReady`. A non-empty list with `'timeout'` is "the skin
  survived a slow load because the frame said so"; an EMPTY list with `'timeout'` is "the host plane said
  nothing and the shipped defaults were used". Without the field those are the same picture and they need
  different fixes.

### The red, before any product change

```
857 assertions, 2 failing

  FAIL an unknown record adopts the host first frame instead of the empty record
         and "never read" is not "the user chose nothing": expected undefined, got {"v":1,"initialized":false,"enabled":[],"settings":{},"touched":false}
  FAIL a readiness timeout adopts the frame, and the late record corrects it
         the frame is adopted instead of the empty record: expected true, got false
```

Four reds were designed and two appear, because `equal` throws and ends its test at the first failure: the
masked pair are "the client agrees with the frame" in the first test (the assertion after the record one)
and "the marker goes with it" in the second (nothing had ever unmarked it). All four pass after the change,
which is what the green run proves. This round could be red-first — unlike Round 54 — because the red is
offline: no Chrome and no `settings.yaml` edit are involved.

### The green

`suite` 878 / 0, with six new tests: the failed-read adoption, the timeout-then-reconcile, the no-host-plane
fallback to defaults, the subscription's loop check, a user action during the unknown window, and the panel
rendering with an unknown record. `conformance` 122 / 0, `load` 85 / 0, `host` 41 ok / 0 failing, and
`browser --self-check` are unchanged, which is the point of the harness options defaulting to "no host
plane": every test written before this round keeps booting the composition it was written against.

### Self-inflicted, four of them, all found and fixed

1. **A registry leak of my own making.** The first red run reported 9 failures instead of 2: the new
   "no host plane" test had registered a `defaultOn` project straight onto the registry, and the registry
   is ONE object for the whole process, shared by every boot in the file — so the definition outlived its
   test and landed in the inventory of the seven tests that followed. Mounting it through a fiber
   (`mountTestSkin(harness, { manifest: { defaultEnabled: true } })`) makes the cleanup automatic. The same
   hazard exists in this file's `default-on-a/b` test, which survives only because it sits near the end;
   recorded, not fixed.
2. **`resetOne()` dereferenced an unknown record.** Found by a grep AUDIT after the implementation, not by
   a test: with an unknown record it read `record.enabled` on `undefined`, which inside a button handler
   reads as a broken panel rather than an unwritten record. Fixed with the same seed `#remember()` uses, and
   pinned by a test so the audit is not the only thing standing between this and a regression.
3. **A wrong expectation of mine, not wrong code.** The timeout test asserted that the late record would
   turn `readiness` into `'ready'`. It does not: `settle()` is once-only by design, and `readiness` records
   how the WAIT ended. What the late answer changes is `read()`. The assertion now pins the real contract.
4. **The fake host was not on the fake clock.** `createCtx` runs in the suite's own realm, so its
   `setTimeout` is Node's real one while the injected clock only replaces what the bundle sees — the scope's
   delayed release sat on wall-clock time and `fireDeadline(5000)` fired the runtime's own deadline instead.
   The harness now hands the same clock to both.
   (One edit accident is worth a line for completeness: an insertion deleted a `const harness = await boot(…)`
   line, noticed and restored in the next edit, never present in any run.)

### The call sites, the write count, and the subscription

- **Nine `persist.read()` call sites, all handled**: eight in `runtime.js` — `start()` :263, `#reconcile()`
  :319, `resetAll()` :467, `resetOne()` :506, `clearChecks()` :550, the settings write :913,
  `#wantedIds()` :969, `#remember()` :1039 — and one in `index.js` :147. (An earlier count of "eight" in
  this round's own review had folded two of them together; the grep is the authority.) A bare `read().`
  dereference matches **nowhere** any more; the spread sites are legal on `undefined` and their writes are
  refused by the adapter and reported.
- **The reconcile writes nothing**, by code and by count: `#reconcile()` contains no `#write`/`#remember`
  call, and two tests read the fake document's write counter — the timeout test after the reconcile, and
  the loop test after a user toggle — and both demand the number not move.
- **The long-lived subscription cannot loop.** A loop needs the reconcile to write, because the write is
  what would call it back. The loop test asks the question with a counter: a real `enable()` on a
  subscribed runtime, the write count recorded, one tick, the same number — and the project still on, so
  the reconcile also demonstrably does not undo the user.

### Recorded, not fixed

- **The write path in the degraded window** (this round's risk 4, and T4's candidate). A user toggle before
  the document answers still fails to persist: `persist.write()` refuses a scope that is not `ready`. The
  choice takes effect in the page, the refusal is recorded as a `persistError` that both the card
  (`store.js:306`) and the overlay show, and a reload loses it. The new test that pins this is the one to
  change when a write QUEUE (hold the choice until the document answers) lands.
- **The fourth diagnostic state** (risk 5). `service.js`'s three-state diagnosis reads `enabledIds()`, which
  is `[]` while the record is unknown, so a project adopted from the frame reports `state: 'off'` on a
  surface that `load-check.mjs:394` and the suite both assert — while the card's switch, which reads the
  registry, says on. It resolves when the record lands (`registry.notify()` re-renders with a real
  `enabledIds()`); if the record never arrives it lasts for the session. An `unknown` state is not
  implemented.

### Two behaviours a reader has to know

- **`readiness` stays `'timeout'` after the record arrives, and that is the contract.** It records how the
  WAIT ended, once. Anything that wants to know whether the record is known NOW must read `persist.read()`;
  `persistAdopted` emptying is the visible half of the same fact.
- **`#reconcile()` replaces the in-memory settings with the record's, so a choice made during the degraded
  window is reverted when the document answers.** The window needs the transport to exceed two seconds AND
  the user to act before it lands, and the write had already been reported as unpersisted — but pre-T3 such
  a choice stayed in memory until the reload, so this is a behaviour change and it is the price of "the
  document wins". A write queue changes the calculus and must re-rule it. Read off the code rather than
  pinned by a test: the loop test asserts the OPPOSITE direction (a toggle after the record has arrived must
  survive), and this direction is one for the write queue's round to pin.

### What was not run

The browser half of `browser-verify.mjs`. Its offline guard (`--self-check`, eleven cases) is green and the
suite's browser expressions were not touched this round, but the live run is the user's, as every browser
run in this project is. The interesting observation is `Ctrl+Shift+R` on a load slow enough to exceed the
deadline: the skin should now stay on, with `persistAdopted` naming it and the panel agreeing. Staging that
in a real browser is a matter of luck rather than a test, so the six offline tests are this round's primary
evidence and a browser run is a regression check rather than a reproduction.

---

## Round 54 — B.2 fixed: the gate resolves the project it drives, and fails by name when it cannot

**Status: done — one code file changed, `scripts/browser-verify.mjs` (`+157 / −27`), plus this entry.
Nothing under `src/**` was touched, so `lib/client.js` stays `sha256:b5eccae3678f` (315101 bytes) and
`lib/index.js` `sha256:426313c951a1` (13665 bytes). Offline, run by the agent, all exit 0: `suite`
844 / 0, `conformance` 122 / 0, `load` 85 / 0, `host` 41 ok / 0 failing, `browser --self-check` green
(eleven cases, nine registered page expressions). Live, run by the user — `browser (user)`: the red below
at exit 1, then the gate 11 / 0 and the full `--no-write` run 239 / 0.**

B.2 was a defect in the gate itself, and the worst kind for one: it NAMED the project it drove
(`details.uip-tests[data-project="liquid-glass"]`, written out at four places), so on a machine whose
`enabled` list left another skin active the click was dropped in silence and the run reported
`the interceptor saw and refused at least one write (0)` — a sentence about the refusal rule, issued by a
run where the rule never got to speak. Round 52's first gate run failed exactly this way, and its own
conclusion was that the reason was a state rather than a rule.

### What changed

- `resolveChecklistTarget(session)` (`scripts/browser-verify.mjs:394`) resolves the target from the page:
  the FIRST project that is BOTH carrying a checklist (`details.uip-tests[data-project=…]` with at least
  one checkbox) and on (its card's `[role=switch]` reads `aria-checked="true"`). No project id appears in
  the gate's path any more; `enabled` in somebody's document decides.
- The precondition is asserted before anything is clicked, and it fails by name: `PRECONDITION NOT MET`,
  with the switch state of every project and the `ui-projects.enabled` line read out of `settings.yaml`
  — read-only, through the same block rule the gate already used for `settings:`, now
  `readUiProjectsBlock(key)`, one reader for both keys.
- `driveChecklistConfirm(session, id)` and `driveChecklistWithdraw(session, id)` take the id, so the
  confirmation and the withdrawal come from the same card: the withdrawal is the write shape WITHOUT a
  record, and it is only offered where the confirmation just created one.
- The successful path says what it drove — `note  the gate drives liquid-glass: switch on, checklist
  present` — because which project a run drove is part of its evidence.

### The evidence

The red, `browser (user)`, with `enabled: []` in the profile's `settings.yaml`:

```
PRECONDITION NOT MET — no project is both ON and carrying a checklist, …
  switch states: liquid-glass: switch=false, boxes=3; example: switch=false, boxes=1
  ui-projects.enabled: enabled: []
```

(The `…` truncates the sentence; the log indents these lines under the `FAIL` block rather than to the left
margin. The three facts and exit 1 are as reported.)

exit 1. Green after restoring `enabled` to `liquid-glass`: the gate **11 / 0**
(`describe ×9, mutate ×5, other ×0`) with the new note naming `liquid-glass`, then the full `--no-write`
run **239 / 0**.

### The process deviation, stated plainly

**This round was implemented before the red was observed**, so it is not a "red first" round in the sense
the rest of this file uses. The reason is not a preference: the agent's sandbox cannot launch Chrome
(`the browser exited early with code 4294930433` at `launchChrome`), and the red requires editing
`C:\Users\19103\.dsh\settings.yaml`, which belongs to the user and which the agent does not write. The red
above was therefore produced by the user, by hand, after the change was written and the offline suites
were green.

Two facts belong with that. The scenario first proposed for the red — `enabled: [example]` — cannot
produce one: `example` ships a checklist (`package.json:36-41`), so the fixed gate correctly resolves
`example` and passes, which is the fix working rather than a red; the state that fires the assertion is
one where no active project has a checklist, and `enabled: []` is the smallest such state. And a probe
written for this round (`node_modules/.probe-54/`, gitignored, not part of the suite) parses all 64
page-code-shaped template literals in the file under both interpolation substitutions, because the
id-taking expressions live inside functions and the file's own registered guard says it does not cover
those.

---

## Round 53 — Phase 2 closes: the scope document, and three items descoped on purpose

**Status: done, documentation only — no code changed, and the offline suites are unchanged at `suite`
844 / 0, `conformance` 122 / 0, `load` 85 / 0, `host` 41 ok / 0 failing, `browser --self-check` green.
`lib/client.js` stays `sha256:b5eccae3678f` (315101 bytes) and `lib/index.js`
`sha256:426313c951a1` (13665 bytes), because nothing under `src/**` was touched.**

Phase 2 is closed by `docs/phase2-scope.md`, which is the audit's result written down where a later reader
finds it rather than in a conversation: what shipped with evidence per spec step, what was **descoped on
purpose** with the reason and the re-entry condition, what was implemented differently from the spec's
proposal and what measurement decided each difference, what is recorded but not blocking, and what is
already itemised for later rounds. A phase that reports only what it built is a phase whose gaps are
rediscovered later as bugs; that sentence is the document's whole justification.

### The descope ruling, and what stands in for each item

The user ruled that group A is **descoped, not deferred into a "补做" round**, and the reasons are facts
about this workspace rather than preferences:

- **A1, the registry/tarball install flow** (spec §四 items 1–10, plus item 14's `ui-projects.installed`
  field): every package here is a local `link:` dependency, so there is no registry entry, tarball or
  `dist.integrity` to inspect — the update plan prints exactly that (`link:*`, "no registry version to
  query"). Registry packages are installed through `dsh plugin add`, a pnpm forwarder: pnpm fetches,
  downloads, verifies integrity against the lockfile, and blocks `prepare` builds until allowed. Standing
  in today: `dsh plugin` for fetch and integrity, `conformance.js` + `manifest-schema.js` at activation (a
  package this build cannot run says so with a code and an action before doing anything),
  `check-installed.mjs` for the human verdict, and the profile's own `dependencies` as the installed
  record — which is why no `installed` copy is written into `settings.yaml`: a second source that can
  drift from the first is the failure family this project has paid for repeatedly. Re-entry: a package
  arriving from a registry without pnpm doing the work.
- **A2, display items** (spec §五): the author and the CHANGELOG are publishing metadata and this phase
  installs from local directories that have neither; the "copy diagnostics" control is not built while
  `src/client/diagnostics.js` already collects the data (`persistKind`, `persistReady`, `persistDiverged`,
  `persistError`, `regionConflicts`, `layers`); `modifies` / `perfLevel` / `priority` / `requires` are
  shown on the UI page's project cards, which is the spec's own §二.2 division of labour.
- **A3, the publish flow** (spec §六.2): all six packages are `private: true` and installed by `link:`, so
  a publish document would be unverified prose — the one thing this project's documentation is not
  allowed to be. Re-entry: a registry-facing package.

### The repositories, and the tag phase 2 should carry

All six are clean at the time of writing:

| repository | HEAD |
| --- | --- |
| `E:\dsh\plugins\dsh-ui-projects` | `8d06f34 Step 11 docs: Round 52 closes the self-test, and the gate's precondition is written down` |
| `E:\dsh\plugins\dsh-plugin-liquid-glass` | `a19e82b Step 8e-1: forward named parameters, not a positional remainder` |
| `E:\dsh\plugins\dsh-plugin-example` | `6c78817 Step 9b: the smallest compliant UI skin (example package)` |
| `E:\dsh\plugins\dsh-plugin-example-dialog` | `2201f8b Step 9b: a third-party client plugin with one compliant and one non-compliant overlay` |
| `E:\dsh\plugins\dsh-ui-project-skeleton` | `42bc7ea initial: minimal UI project package (reference + loader fixture)` |
| `E:\dsh\tools` | `a607110 Step 9b: snapshot covers the two example packages` |

Phase 1 ended in tags (`step1-complete`, `step1-cleanup-complete`, `step1-persist-complete`,
`step5-first-paint`, `step1-final` in the framework; `step7c-complete` on the skin), and the spec's iron
rule 4 asks for that reminder at every phase boundary: **tag `step2-complete`** — framework and tools at
least, the three package repositories too if the tag is meant to describe the workspace. Tagging is the
user's step, as every write to their environment is.

---

## Round 52 — Step 11: the self-test closes, and the gate fails on a state nobody had told it about

**Status: done, and this round changed no code — the self-test is a record of what the previous rounds
produced. Offline (run by the agent, all exit 0): `suite` 844 / 0, `conformance` 122 / 0, `load` 85 / 0,
`host` 41 ok / 0 failing with `host half is loadable`, `browser --self-check` green (nine page expressions
parsed, the refusal rule agreeing with real payload shapes), `example` check 16 / 0, `example-dialog` check
14 / 0, the skin's `check` 26 / 0 and its `suite` 237 / 0, the skeleton's check 13 / 0, and the read-only
report: `DEPENDENCIES (5)`, `UI CONTRACT (5 client bundle(s) scanned, 3 with findings)` — skin 0, example
0, example-dialog 1, `dsh-cost-meter` 18, the framework's own 2 accepted — `PROBLEMS (0)`. Baseline: all six
repositories clean, `lib/client.js` `sha256:b5eccae3678f` (315101 bytes) and `lib/index.js`
`sha256:426313c951a1` (13665 bytes), both unchanged from Round 50/51. Run by the user in a normal
PowerShell, because this machine's sandbox cannot launch Chrome: the gate `--verify-refusal` **11 / 0**,
the full `--no-write` run **239 / 0**, `install.ps1 -Uninstall -DryRun` **exit 0 with the six fingerprints
identical (zero writes)**, and `install.ps1 -Update -DryRun` **exit 0**, naming the build as different from
the record and writing nothing. `install.ps1` was therefore run twice in this round, and **both times with
`-DryRun`**.**

### The gate failed first, and the reason is a state, not a rule

The first `--verify-refusal` failed with `the interceptor saw and refused at least one write (0)` and
**`mutate ×0`** in the pause summary — the page READ the settings document (that is how `example` came to
be the active skin at all) and never wrote one. The cause: the profile's `settings.yaml` had
`ui-projects.enabled` naming BOTH `example` and `liquid-glass`, and under the one-skin policy only `example`
was active — while the gate drives a FIXED project id and clicked Liquid Glass, whose write context does
not exist, so `store.confirmChecks` returned silently and nothing was ever sent. That is the known gap
recorded here as **B.2: the gate does not check that the project it drives is active**, and it stays
unfixed — its own round. Converging `enabled` to `liquid-glass` alone made the gate pass with **11 / 0**
(`describe ×9, mutate ×5, other ×0`) and the full run follow at **239 / 0**, which is the proof that the
failing run was a precondition rather than a broken rule.

The state that produced it is Round 50's open question (9b-5): `#remember` computes the enabled list from
the RECORD rather than from the runtime's active set, so the file can name two skins while only one runs.
B.2 and that question are two ends of the same thing, and both are open.

### What the four spec items mean now

`UI第二阶段.txt`'s step 11 is the four-line 【测试】 block, and each line has an automated counterpart:
`role="dialog"` covered and `role="custom-dialog"` not (browser tests A and B), both surfaces returning to
their own look when the skin is switched off (C), the contract badge in the plugins column (D), and a
violating package showing the warning badge with its reasons (D/E). The 239 / 0 run is that evidence, and
the VISUAL half — the two-command-per-row check that closed the 8d review — is the user's screenshot
recorded in Round 51.

### Open, and deliberately not closed here

- **B.2** — the gate drives a fixed project id and does not check that the project is active; a state that
  makes the click a no-op reads exactly like a broken refusal rule. The pause summary is the diagnostic
  that separates them in the meantime.
- **A hard refresh (`Ctrl+Shift+R`) can come back with the skin off.** The client's settings read has a
  two-second budget (`src/client/persist.js`, `READY_TIMEOUT_MS`); when it settles as a timeout the runtime
  proceeds with the EMPTY record, so nothing is enabled client-side while the host's first paint still marks
  the body from the document it read — the page looks skinned and the client has nothing applied. Recorded,
  not diagnosed to a fix, and separate from B.2 even though both are "the client's record was empty".

---

## Round 51 — Step 8e closed: the wrapper's whole surface is driven, and two of the three sub-rounds were already recorded

**Status: done. `suite` 844 / 0 (840 → 844), `host` 41 ok / 0 failing, `load` 85 / 0, `conformance`
122 / 0, `browser --self-check` green, and the real-browser half stands at **239 / 0** (Round 50). The
only code change was in Round 50's successor commit `a3f5c78` — one file, `+76` lines, tests only.
`lib/client.js` is unchanged at `sha256:b5eccae3678f` and `lib/index.js` at 13665 bytes, because nothing
under `src/**` was touched. `install.ps1` was not run, and no run in this round wrote `$DSH_HOME`.**

This round closes Step 8e. Its first sub-round needed work; the other two had already shipped, and the
round's real product is the record of WHICH is which — an audit that says "already done, here is the
evidence" instead of re-implementing a fix and calling it progress.

### 8e-1 — the wrapper's parameter surface, driven end to end

`@xjl-resources/dsh-plugin-liquid-glass/install.ps1` declares the framework's whole surface one for one
minus `SourceDir` (which it sets itself) and forwards what was BOUND by name, excluding its own
`-FrameworkDir` — the fix Round 49 made after `install.ps1 -Snapshot` silently ran an INSTALL. What that
round left open was the PROOF: the stub-run table drove 9 of the 18 forwarded names. Commit `a3f5c78`
drives the entire surface in one invocation and asserts the received map name by name, with the sample
value chosen by the parsed TYPE and a closed sample table — a type the test cannot pass fails instead of
being skipped — plus a coverage assertion, plus a refusal check that `-SourceDir C:\elsewhere` makes the
wrapper exit non-zero rather than replacing the package it was pointed at.

Two red evidences, both produced by temporarily breaking the NEW code (never the wrapper):

| red | what was broken | what failed |
| --- | --- | --- |
| 1 | `Int32` removed from the sample table | `every declared parameter has a sample value this test knows how to pass: expected [], got ["Keep: Int32", "Changes: Int32"]` |
| 2 | the drive loop skipped one name | `and no declared parameter was left unexercised: expected [], got ["DryRun"]` |

**Red 2 passed on its first attempt, and that mattered.** The first version of the block asserted
coverage over the SAME list it had driven, so dropping a name removed it from both sides and the
assertion could not fail — a guard that cannot fail is the exact thing this test exists to prevent (the
same family as "the rule refused nothing" in Round 50's gate). The drive loop and the coverage assertion
now read the parsed surface separately, and the comment says so where the next reader will look.

### 8e-2 — already done in Round 49, and stronger than the wording lock this round asked for

`src/host/index.js` describes the wait as a STATE ("still waiting for the connection service after 5s: the
installed-package endpoint mounts when it arrives…"), finishes the pair when the service arrives late, and
names the failure when it arrives but cannot mount; `console.error` is kept for the reason 7e gave (a wait
that never ends must not be invisible). `scripts/host-check.mjs` section 7 pins all of it with 15
BEHAVIOURAL assertions — the row is run in-process with `setTimeout`/`clearTimeout`/`console.error`
swapped, so the channel is part of what is asserted: a line sent through `ctx.logger` would never be
collected and the assertions would fail. That is why this round added no wording lock: a lock over the
sentence would have been weaker than what is already there. The three fallbacks this round also carried
are done too, with the guard `a project registered without a source does not borrow the framework's name`.

### 8e-3 — the browser evidence, and the one piece a suite cannot produce

The real-browser half is Round 50's **239 / 0**, which includes the Round 48 test that started this
thread (`the block each row offers to copy repeats that row's own removal command`). The VISUAL evidence
is a screenshot, and it is a person's: `--shot` writes three files (dialog open, dialog closed with
Escape, dark mode) and **none of them can show the plugins column**, because no capture happens in that
group. The user took the screenshot by hand, and the check is per row — the command on its own line and
the block a person copies must name the SAME package:

| row | what the screenshot shows |
| --- | --- |
| `@xjl-resources/dsh-plugin-example` | both places: `dsh plugin --profile web remove @xjl-resources/dsh-plugin-example` |
| `@xjl-resources/dsh-plugin-example-dialog` | both places carry the same package name |
| `@xjl-resources/dsh-plugin-liquid-glass` | both places carry the same package name |
| `dsh-cost-meter` | both places: `dsh plugin --profile web remove dsh-cost-meter` |
| `dsh-ui-projects` | no removal block at all, only the maintenance block — by design |

That closes the last item of the 8d UI review. One documentation nit stays open and was NOT fixed here
(this round writes documentation, not README repairs): `README.md` says `--shot` writes "`glass.png` and
`glass-dark.png`", and the code writes three files including `-closed`.

### The deferred items, restated with a disposition each

- **(b) move `derive-boot-css.mjs` into the skin package** — next round. The skin's build already prefers
  a copy beside itself and falls back to `E:\dsh\tools` (`plugins/dsh-plugin-liquid-glass/scripts/build.mjs`),
  so the move is a copy, a delete and a path update across five or six files.
- **(c) `.snapshots/README.md` rows** — this round added the pointer sentence for `46-step8a` / `47-step8b`
  next to the declared 20–37 gap; no rows are invented from directory names.
- **(d) `matchesWithAncestors` in `scripts/fake-dom.mjs`** — dead (no caller anywhere); next round,
  bundled with any other touch to that file.
- **(e) `install.ps1` decision-tree comments** — deferred again, until a round has another reason to touch
  that file; the mode order and the `-Rollback -List` branch are documented in
  `docs/plugin-development.md` and `docs/update-and-rollback.md`, which is where a reader looks first.

---

## Round 50 — Step 9b: the contract scanner, the badge, the two-sided example, and four assertions that measured the wrong thing

**Status: done. `suite` 840 / 0 (758 → 840), `host` 41 / 0, `load` 85 / 0, `conformance` 122 / 0
(67 → 122 across 9a and 9b), `skeleton` 13 / 0, the skin's `check` 26 / 0 and its `suite` 237 / 0, and
`browser` under `--no-write`: **239 assertions / 0 failing** (184 → 239) — run BY THE USER in a normal
PowerShell, because this machine's agent sandbox refuses to launch Chrome (`the browser exited early with
code 4294930433`, twice, before any page loaded; the same suite had run from that sandbox in earlier
rounds). The gate's own line from that run: `[gate] settings pauses: describe ×9, mutate ×5, other ×0
(total 14; judged writes 5, reads 9)`. `lib/client.js` is `sha256:b5eccae3678f` (Round 49 recorded
`153df2477a82`; `lib/` is ignored by git, so the hashes this round passed through are not in the
repository, only in the round reports), `lib/index.js` 13665 bytes (unchanged). The two example packages
were installed into the `web` profile by the user with `dsh plugin --profile web add <path>`; `install.ps1`
was NOT run in this round, and every browser run was `--no-write`, which refused the writes carrying the
`settings` key and let `enabled` through (both visible in the paused-request log).**

Step 9 is the step that makes the contract *checkable*: a scanner that judges a client bundle by reading
it, two example packages that show both sides of the contract in a real page, and a badge in Settings ›
UI plugins that tells a reader which of the two they are looking at. It ends with four browser assertions
being wrong in four different ways, which is 9b-4.

### 9a — a scanner, not a parser, and the false positives real consumers found

**A scanner, because there is no parser to reach for, and that was measured rather than assumed:**
`acorn`, `@babel/parser`, `esprima`, `meriyah`, `espree` and `typescript` all fail to resolve in this
workspace, and the only `@babel` packages present are `code-frame`, `helper-validator-identifier` and
`runtime`. Node exposes no public AST API, so an AST detector means a new dependency in a package that
deliberately has exactly one — `acorn` 8.18.0 is MIT, has zero runtime dependencies, and unpacks to
565,327 bytes in 10 files. What a parser would buy is also small here, because the four rules are not four
syntactic shapes. The inventory this decision rests on:

| bundle | raw `role=` | in code | in strings | in comments |
| --- | --- | --- | --- | --- |
| `dsh-ui-projects/lib/client.js` | 11 | 0 | 4 | 7 |
| `dsh-plugin-liquid-glass/lib/client.js` | 33 | 0 | 33 (all CSS selectors) | 0 |

and the skin carries 156 colour literals of which **every one** is the value of a `--*:` declaration — a
rule that reported those would make the skin the workspace's worst "violator" for doing the one thing a
skin is for. `src/host/contract-scan.js` therefore reads text: it blanks comments, tags strings, never
executes the bundle, never loads it in a `vm`, never resolves an import and never throws.

**Three decidable rules**, in their own code namespace (`UI_CONTRACT_*`, deliberately not
`conformance.js`'s `PROBLEM_CODES`: those refuse a package, these advise about one), every finding
`severity: 'warning'`, nothing refused:

- rule 1 — `UI_CONTRACT_NON_STANDARD_ROLE`: the WAI-ARIA 1.2 role list, transcribed by hand (94 entries =
  the 82 non-abstract roles of §5.3.2–5.3.4 plus the 12 abstract roles of §5.3.1, W3C Recommendation,
  06 June 2023). The abstract ones are accepted on purpose: a warning-only instrument reports a role it
  cannot RECOGNISE, and `role="widget"` is a real role.
- rule 2 — `UI_CONTRACT_HARD_COLOUR`: scoped to the properties the palette owns, skipping `--*:`
  declarations, and exempting the fallback half of a `var(--token, fallback)`.
- rule 4 — `UI_CONTRACT_CLOSED_SHADOW_ROOT`: `attachShadow({ mode: 'closed' })` in code, not in a comment.
- **rule 3 is not scanned, and the criterion is written down rather than implied:** "`document.body`'s
  top-level children must carry a WAI-ARIA role. The test is whether the appended element can be
  recognised BY role, not whether `appendChild` was called; this round scans three rules statically and
  defers the runtime one." `CONTRACT_LIMITS` travels with every result, so a clean scan cannot be read as
  a clean plugin.

**Five false-positive classes, every one found by a real consumer** (this is the part worth keeping):

| found by | what was reported | why it was wrong | the fix |
| --- | --- | --- | --- |
| `dsh-cost-meter` (a real third-party package) | 5 colour findings | the plugin WRITES `var(--dsw-alias-bg-hover, rgba(127,127,127,.08))` — it reads the token and names a fallback, which is the contract, not a violation | the fallback half of a `var()` whose first argument is a custom property is exempt (23 → 18 findings for that bundle) |
| the `@xjl-resources/dsh-plugin-example-dialog` package's own `check.mjs` | a second role violation | the package's display label is the string `role="custom-dialog"`, and the first rule read any `role=` as an assignment | an assignment is an object key or a markup attribute; a role quoted inside a label is neither |
| the 9b review | a role named in a sentence, `'foo role="custom-dialog" bar'` | "not at the start of the string" is true of a label and false of prose | inside a string, a `role=` is an attribute only if a tag is still open in front of it (`<div role="x">` yes, `'<span>see role="x"'` no) |
| the 9a probes | 20 = 20 hits on the framework, 66 = 66 on the skin | a CSS selector `[role='dialog']` says nothing about any element's role | selectors are excluded, and `data-role` / `userRole` never match at all (`(?<![\w-])`) |
| the 9a probes | the skin's 156 literals | they are `--*:` declarations, which is how a token comes to exist | custom-property declarations are exempt |

The false positives are the reason the scanner is shaped the way it is, and each one is pinned by an
A-layer case in `scripts/check-installed.test.mjs`, so the class cannot come back silently.

**What it reports today, as a SNAPSHOT** (the layer says so in its own comments): the framework's own
bundle **2** — `styles/core.css`'s `.uip-previewGlass` writes `border: 1px solid rgb(255 255 255 / 45%)`
and `background: rgb(255 255 255 / 32%)`, which by the contract as written ARE hard-coded colours;
they are recorded and accepted because changing them would move the preview's visual, and the assertion
goes red if the pair ever becomes a different pair. The skin 0, the skeleton 0, and in the profile:
`dsh-cost-meter` 18, `@xjl-resources/dsh-plugin-example` 0, `@xjl-resources/dsh-plugin-example-dialog` 1.
Cost, measured: 296,614 characters in 14.52 ms, all three bundles including file reads 15.40 ms, with a
4 MB cap that reports `scanned: false` and the size rather than pretending it looked.

### 9b-1 — the two example packages

`@xjl-resources/dsh-plugin-example` is a UI project package (id `example`, type `skin`, one body rule
reading a `--dsw-alias-*` token) and `@xjl-resources/dsh-plugin-example-dialog` is a plain client plugin:
no `dsh.uiProject`, no `peerDependencies`, no framework service — it mounts two surfaces on
`document.body` that differ in one attribute, `role="dialog"` and `role="custom-dialog"`. That pair is the
contract made visible: one role is a published interface a skin can select, the other is a string only its
own author can name. Both packages are `private: true`, both are scoped, and neither ships an
`install.ps1` — which is why the maintenance copy now says where to run the printed commands (in the
package's own directory when it ships one, otherwise from `plugins/dsh-ui-projects` with
`-Package <name>`), and why that hint is asserted against the dictionary's own sentence rather than
against a literal.

Each package checks itself (`16 assertions / 0` and `14 assertions / 0`), and the dialog's check is the
one that matters: it imports the framework's REAL `scanClientBundle` from
`plugins/dsh-ui-projects/src/host/contract-scan.js` and asserts exactly one finding whose excerpt names
`custom-dialog`. That check is what turned the package's own display label into the second false-positive
class above. `E:\dsh\tools\snapshot.mjs`'s `ROOTS` gained both packages, and the guard that made the
omission visible printed the red evidence by name:
`uncovered: ["dsh-plugin-example","dsh-plugin-example-dialog"]`.

### 9b-2 — the badge, and the framework's own row

Settings › UI plugins gained a fourth badge per row, four states, and a disclosure under it:

- `ok` the scanner read the bundle and found nothing, `warn` it found something (the panel lists it),
  `none` nothing was read — not installed, no client half, no bundle, over the cap — with the host's own
  `reason`, and `na` not judged on purpose: the framework's own row.
- The findings are the HOST'S OWN ENGLISH, rendered verbatim. They are the output of a measurement, and a
  localized paraphrase of a measurement is a second instrument with no calibration.
- The coverage line counts from the payload: `contractFor` is `judgeContract` plus `rules: { judged, total }`,
  attached in ONE place rather than repeated at `judgeContract`'s six returns, with `judged` derived from
  `Object.keys(CONTRACT_RULES).length` so adding a rule cannot leave the number stale.
- **Two style gaps were closed on the way past:** `.uip-badge-warn` had been rendered by the "not composed"
  badge since Round 8f and had NO rule anywhere in the stylesheet, so a warning colour nobody could see;
  `.uip-badge-ok` did not exist. Both now use the tokens the shipped shell itself uses for the same
  meaning, read out of the frontend bundle rather than guessed (`--dsw-alias-state-warn-primary`,
  **not** `-warning-`), and neither may be a colour literal — this stylesheet travels inside
  `lib/client.js`, which the framework's own scanner reads.
- The review decision on the framework's row: keep the `na` badge AND open the panel. The first version
  showed `na` and nothing else, which hid two findings that are in the payload and in the CLI report; a
  reader who never opens a terminal could not see them. The row now says "the contract does not apply
  (2 accepted)", lists them, and carries a note saying they are recorded rather than fixed in this round.

### 9b-3 — the gate counts every settings pause (B.1)

A gate run reported `the interceptor saw and refused at least one write (0)` and the honest reading of that
was not available, because the interceptor logged only requests it had JUDGED to be writes: settings READS
were continued silently, so "the page never touched the settings API" and "the page made a hundred settings
reads" produced exactly the same output — nothing. The state around it was contradictory in a way that
took a separate read-only pass to explain: `settings.yaml` said `ui-projects.enabled: [liquid-glass]` while
the panel said `已开启 0 项`, and the served HTML's first frame carried
`body[data-ui-project-liquid-glass="on"]` — painted by the HOST from the document, which is why the page
looked skinned while the client had nothing enabled.

The fix is accounting, not judgement: every paused request under `/api/settings/*` is counted before
anything decides what it is — a total, three buckets by the request's last path segment
(`describe` / `mutate` / `other`), a write/read split, a log capped at 20 lines per bucket with one
rollover line, a one-line summary at the gate's close
(`[gate] settings pauses: describe ×a, mutate ×b, other ×c (total N; judged writes W, reads R)`), and a
CONCLUSION line when `describe = 0` and `mutate = 0`: *this page never used the settings API, so
`--no-write` had nothing to refuse and the rule was never exercised*. In the next full run the API was in
use and the conclusion correctly did not print — the numbers above are that line.

### 9b-4 — four assertions that measured the wrong thing

The first full `--no-write` run of A–F: **229 assertions / 4 failing**, every one of them a test that was
asserting a spelling rather than a property. They are recorded here because the rule they produced
(`CONTRIBUTING.md` rule 8) is the deliverable, not the fixes.

```
FAIL a role="dialog" surface from a third-party plugin is reached by the skin
       with the shadow from the skin's own rule winning over the surface's stylesheet
       ({"role":"dialog","backdropFilter":"blur(30px) saturate(1.8)","boxShadow":"none"}): expected truthy, got false
FAIL a second project package switches independently, scoped to its own marker
       and switching one project does not move another: expected true, got false
FAIL the plugins column shows the four contract states, and the framework row explains its own
       while the sentence on it counts the same number of findings the panel lists: expected 2, got 0
FAIL a real third-party plugin shows the warning state, with its own findings and the limits
       with the instrument's own limits under them, so a warning is never read as a verdict: expected truthy, got false
```

- **The shadow.** The skin's dialog rule is `:where([role='dialog'], [role='menu'], [role='listbox'],
  [role='tooltip']) { … box-shadow: var(--lg-glass-shadow), var(--lg-glass-inner-highlight) }`, and
  `scopeCss` puts the project marker INSIDE a functional `:where()`, so the scoped selector's specificity
  is **zero** — lower than the example surface's own `.example-dialog`, whose
  `box-shadow: var(--dsw-alias-shadow-l2, none)` therefore wins. The shipped palette has no
  `--dsw-alias-shadow*` token at all, so that resolves to its `none` fallback, which is exactly what was
  measured. The frost, by contrast, has no competing declaration (the shipped CSS contains no `blur(30px)`
  and no `saturate(1.8)`), so the same zero-specificity rule applied. The assertion now measures the
  property across the skin being off and on: the filter must change, the component's own shadow must not.
- **The policy.** `registry.conflictIds(id)` returns the other ACTIVE skins, and `runtime.#enable` disables
  them first ("at most one global look, so the previous one goes first"), moving `data-ui-skin` to the new
  skin. So enabling the second project package TAKES OVER, and the assertion that demanded independence was
  asking for the one thing the framework forbids.
- **The count.** The framework row's summary was checked by parsing the first number out of the row's whole
  `textContent`, which begins with `dsh-ui-projects@0.1.0` — the assertion read the version's `0` and called
  a correct panel broken. The panel's `<summary>` and its limits list now carry hooks of their own
  (`data-uip-contract-summary`, `data-uip-contract-limits`) and the assertion reads them.
- **The hook that never existed.** The limits assertion selected `[data-uip-contract-limits]`, an attribute
  the component never published — the mirror image of the same mistake, fixed by publishing the hook rather
  than by selecting the class name.

After the fixes: **239 assertions / 0 failing**, and the gate's pause summary above comes from that run.

### 9b-5 — negative results, and one open question

- **The sandbox cannot launch a browser here.** Twice this round `--verify-refusal`/`--no-write` died in
  `launchChrome` with the browser exiting before it reported a port (`code 4294930433`), before any page
  loaded. That is recorded as an environment limit, not a code failure: the suite's offline gates
  (`--self-check`) and every other suite ran in the sandbox, and the real-browser half was run by the user.
  The offline gate grew a companion in this round for the same reason — `--self-check` now parses every
  top-level page expression before Chrome is launched, because an expression is a STRING and `node --check`
  validates the file that builds it, not the string.
- **Two self-inflicted failures, both caught before the suites ran.** A comment inside a page-expression
  template literal contained a backtick, which ended the outer template (`node --check`:
  `SyntaxError: missing ) after argument list`); and one careless edit deleted a line's trailing newline and
  joined two statements, found by reading the region back. The first is a textbook instance of
  `## Tool discipline` in `CONTRIBUTING.md`.
- **Open question, observed and not fixed:** under the one-skin policy the RECORD can name both skins.
  `#remember` computes the enabled list from `record.enabled` (`src/client/runtime.js`), while the conflict
  repair that disabled the previous skin runs with `persist: false` — so the run wrote
  `enabled: ["liquid-glass","example"]` with only one of them active, and which one wins on the next boot
  depends on the enable order. Either `#remember` should derive the list from the runtime's active set, or
  the conflict repair should participate in persistence. Not this round's business, and it needs a ruling.

---

## Round 49 — Step 8e: the wrapper forwards what it was given, and the wait stops reporting a verdict

**Status: done, in three sub-rounds. `suite` 758 assertions / 0 failing (735 → 752 in 8e-1 → 758 in
8e-2), `host` 41 ok / 0 failing (26 → 41), `load` 85 / 0, `conformance` 67 / 0, `skeleton` 13 / 0, the
skin's `check` 26 / 0 (23 → 26) and its `suite` 237 / 0, `browser --self-check` green, and — the first
real-machine run of this round — `browser` under `--no-write`: **184 assertions / 0 failing**, with the
gate (`--verify-refusal`) **11 / 0**. `lib/client.js` is `sha256:153df2477a82` (was `e792766ad7eb`) and
`lib/index.js` 13665 bytes (was 11000). `install.ps1` was executed ONCE in this round, by the user, as
`-Snapshot -DryRun` from the skin package's directory — see 8e-3. Nothing under `$DSH_HOME` was written by
this round's work.**

Round 49 closes the extraction: 47 moved the last project out, 48 fixed the copy the extraction exposed,
and this round fixes the two things the extraction left behind in the *tooling and the diagnostics* — a
wrapper that silently ran the wrong mode, and a host log line that reported a five-second sample as a
permanent fact.

### 8e-1 — `install.ps1 -Snapshot` used to run an INSTALL

The card prints `install.ps1 -Snapshot`, `-Update`, `-Rollback -To <name>` and says to run them in the
package's own directory. The skin's wrapper forwarded them through a positional remainder:

```powershell
[Parameter(ValueFromRemainingArguments = $true)] $Rest
…
& (Join-Path $framework 'install.ps1') -SourceDir $PSScriptRoot @Rest
```

`ValueFromRemainingArguments` collects a SWITCH as the string `'-Snapshot'`, and `@Rest` splats that
string **positionally**, where it binds to the first positional-capable parameter — `-To`. A stub carrying
the framework's real parameter block and the wrapper's real forwarding line, run in a real
`powershell.exe`, printed exactly what the framework received:

| wrapper invoked with | what the framework bound |
| --- | --- |
| `-Snapshot` | `{SourceDir: 'SRC', To: '-Snapshot'}` |
| `-Rollback -To 03-v1.0.0` | `{SourceDir: 'SRC', To: '-Rollback', Name: '-To', Revision: '03-v1.0.0'}` |
| `-DryRun` | `{SourceDir: 'SRC', To: '-DryRun'}` |

**And the framework's mode selection falls through to INSTALL when no verb is bound**
(`install.ps1`: `$mode = if ($Uninstall) … elseif ($Rollback) { 'ROLLBACK' } else { 'INSTALL' }`). So the
maintenance command did not fail — it **ran the install path**. That is a whole severity class worse than
a dropped argument: a command whose printed promise is "record a version" instead relinked the package
into the profile. The user's own review of this round's plan named it: "静默错参比参数丢失严重一档".

The fix declares the framework's whole surface (its 19 parameters minus the `SourceDir` this file sets
from `$PSScriptRoot`, plus its own `FrameworkDir` — 19 again), **with no defaults of its own**, and
forwards by name:

```powershell
$forward = @{}
foreach ($key in $PSBoundParameters.Keys) {
    if ($key -eq 'FrameworkDir') { continue }
    $forward[$key] = $PSBoundParameters[$key]
}
$forward['SourceDir'] = $PSScriptRoot
& (Join-Path $framework 'install.ps1') @forward
```

Omitting the defaults is the other half of the fix and not tidiness: `$PSBoundParameters` holds only what
the caller passed, so the framework's own `-Profile web` / `-Keep 3` / `-Changes 1` stay the single source.
A copy of them here would be a second source — the same family of bug, one level down.

### 8e-1 — the guard reads the parser, not a regular expression

`scripts/param-surface.ps1` (new) parses both scripts with
`[System.Management.Automation.Language.Parser]::ParseFile` and reports
`Parameters[i].StaticType.Name` per parameter, plus the param block's own text. A text scan was rejected
for three shapes that are all present in these two files: `[switch]$Snapshot` and `[string]$Snapshot` are
the same words to a regex and the difference decides whether `-Snapshot $false` is accepted; a parameter's
attributes may sit on their own line; and a `param(` block nests parentheses. `[CmdletBinding()]` is an
ATTRIBUTE of the param block and is NOT inside `ParamBlock.Extent.Text` — measured, and the reason the
tool emits attributes and extent together.

The tests compare names **and types** (a `[switch]` that became a `[string]` would pass a name-only check),
and the two sides are `(framework − SourceDir) ∪ {FrameworkDir}` versus the wrapper — a set equality, so a
parameter added to the framework tomorrow fails until the wrapper carries it.

**The red run, before the wrapper was touched:**

```
FAIL the wrapper accepts the framework’s whole parameter surface, with the same types
       the wrapper declares every parameter the framework accepts, except the source directory it sets itself:
       expected [], got ["DryRun", "Uninstall", "Update", "Snapshot", "ListVersions", "Rollback", …12 more]
framework params : 19      wrapper params : 2
missing (18): DryRun … DshCommand        spurious (1): Rest
```

and the behavioural half, against the real wrapper (its own test, because "declared" and "forwarded" are
different claims):

```
FAIL every argument the card prints arrives at the framework as the parameter it names
       the framework receives a snapshot ({"SourceDir":"E:\\dsh\\plugins\\dsh-plugin-liquid-glass","To":"-Snapshot"}):
       expected {"Snapshot":"True","SourceDir":"…"}   got {"SourceDir":"…","To":"-Snapshot"}
```

### 8e-1 — running the wrapper against a fake framework, and why that obeys the iron rule

The behavioural test executes the REAL wrapper with `-FrameworkDir` pointing at a temp directory holding a
FAKE `install.ps1` — whose parameter block is generated from the framework's own AST, and whose entire body
writes one JSON file beside itself and exits. The framework's `install.ps1` is never run.

**That claim is a guard, not a paragraph.** Two assertions read the generated fake back and refuse it if it
names `DSH_HOME`, `$HOME`, `profiles`, `settings`, `Remove-Item`, `New-Item`, `Set-Content` or
`Start-Process`, or if it contains **any** absolute path at all — the one file it writes is built from
`$PSScriptRoot`, inside the `mkdtemp` this test removes. A future edit that reaches for the environment "to
make the fake more realistic" fails there. The wrapper's own execution path was audited the same way: read
`DSH_HOME` into a variable, `Test-Path` a candidate list that short-circuits on the first hit, one
`Write-Host`, one call, `exit`.

Sensitivity is built in: the old shape is written as an inline stub and asserted to misbind
(`misbound.To === '-Snapshot'`), because a probe proven only against the fixed file proves that the probe
runs.

### 8e-1 — `tools` gets a repository

`E:\dsh\tools` held the only copy of `snapshot.mjs` and `derive-boot-css.mjs` and was not under version
control: a tree the snapshot protected while nothing protected the snapshot, which is exactly the exposure
CONTRIBUTING rule 6 exists to prevent. It now has a repository (`3c5a623`) with a README that states what
each of the 17 files is **from its own header**, why there is no `.gitignore` (nothing there is generated),
and the encoding facts (all valid UTF-8, no BOMs, the three `.ps1` files ASCII-only — PowerShell 5.1 decodes
a BOM-less script as ANSI). The commit itself was made by the user, deliberately: the iron rule forbids
this project's tooling from running git, and that rule does not get an exception for a convenient command.

### 8e-1 — the trap that cost the tool its first two runs (→ CONTRIBUTING rule 7)

`param-surface.ps1` failed twice with

```
The property 'surface' cannot be found on this object. Verify that the property exists.
```

because the script held the parsed result in a local named `$framework`, spelled like its own parameter
`[string]$Framework` — and **a typed parameter is a type-constrained variable for the whole life of the
script**, so the assignment silently coerced the `[pscustomobject]` to a string. The error appears one
statement LATER than the mistake and points at the wrong place. The fix renames the locals
(`$frameworkInfo`), with a comment so nobody tidies them back. It is now CONTRIBUTING rule 7.

### 8e-2 — the wait notice: a sample, not a verdict

`src/host/index.js` armed a one-shot `setTimeout(5000)` whose whole body was one line:

```
[dsh-ui-projects] the connection service has not appeared, so the installed-package endpoint is not mounted; …
```

Three facts, read rather than assumed. **The timer is a sample**: it prints once, is never re-armed, is
never retracted, and is cleared only when the row unloads. **The wording is a verdict**: it states a
permanent fact about a state that can change one millisecond later, and nothing ever follows it. **And the
service really is late in a real composition** — the row's own comment records why (the connection row's
`apply` is async and lives in an earlier layer), and the user observed this repository's page print that
line and then list three packages, which needs a successful authenticated request through that very
service.

So the line became a state, with its duration derived from the constant that arms the timer:

```
[dsh-ui-projects] still waiting for the connection service after 5s: the installed-package endpoint mounts when it arrives, and Settings › UI plugins says it cannot read the listing until then
```

and when the service arrives after that line has been printed, the pair gets its ending:

```
[dsh-ui-projects] the connection service arrived after N.Ns; the installed-package endpoint is mounted
```

A log cannot unsay a line, so "retract" is not the shape: the honest shape is **either nothing at all, or
waiting → arrived**, on the same channel (`console.error`, because a composition without a logger exporter
swallows `ctx.logger`). The arrival line prints only when the notice actually fired.

### 8e-2 — three compositions, one sentence (and 8e-3 measured the third)

| composition | connection service | what the log says |
| --- | --- | --- |
| a test composition (`load-check.mjs`), Electron over `file://`, a headless profile | **never** | the waiting line, once — and it stays true |
| the profile this was reviewed on | **late** (after 5 s) | the waiting line, then the arrival line |
| the same profile, freshly restarted in 8e-3 | **fast** (inside 5 s) | nothing at all |

All three are real, and the wording is the only one of the two candidates that is true in all three: a
"failed to mount after N seconds" sentence would have been **false** in the two compositions where the
endpoint does mount. 8e-3 is also the correction to this round's own assumption — the plan predicted the
reviewer's instance was late, and the restart produced **no line at all**, which is the fast case. The
prediction was right about the code and wrong about the machine, which is why the third row is in this
table rather than in a footnote.

### 8e-2 — the flag, the failure it hid, and the ending

`endpointMounted = true` was set BEFORE `registerInstalledEndpoint(...)`. That call does not throw for a
missing service (it logs `logger.warn` and returns a no-op disposer), but `connection.fetch.register`
itself can throw — and then the flag was already true, so the notice was suppressed, this row said nothing
at all, and only Cordis reported the failure. The flag moved after the call (with the note that an async
version must move it after the `await`), and the throw now gets its own line before being rethrown
unchanged, so Cordis's handling is untouched and the row's pair of facts has an ending either way.

### 8e-2 — three fallbacks to the framework's name become `null`

Three places answered "this project did not say which package it belongs to" with `'dsh-ui-projects'`:
`store.js` (the snapshot field), `panel.js` (the card's version lookup) and `panel.js` again (the
maintenance heading). Three derivations of one fact, each free to disagree, each naming THIS package for
somebody else's project — a card that would print the framework's maintenance commands, look up the
framework's snapshot list and compare the framework's installed version against it.

Why it is a real bug even though it is unreachable today: `registry.register(definition)` is a public seam
(`__internals.Registry`, one argument, no manifest), the registry does not require `source`, and that is the
shape every built-in project used to take. 8c deleted the last caller; nothing stops the next one.
(`CONTRACT_FIELDS` in `service.js` excludes `package`, so `source.package` is the only carrier of identity —
checked, not assumed.)

`packageNameOf(project)` in `store.js` is now the single derivation and returns **`null`**, not a
placeholder string: these values flow into a heading and into the `-SourceDir` argument of a command, and
something that LOOKS like a package name eventually gets used as one. Without a name the card asks the
scan nothing at all (the old code would have reported "this profile recorded no snapshot of it" about a
package it cannot name, and told the reader to run `-Snapshot` for it), and the heading uses a new sentence
in both languages (`maintenanceTitleUnknown`) rather than teaching the template to format `null` — a
template that renders "the null package" renders the bug.

**The red run:**

```
FAIL a project registered without a source does not borrow the framework’s name
       and the snapshot reports NO package instead of the framework’s name: expected null, got "dsh-ui-projects"
```

### 8e-2 — the guard is a behaviour test, not a wording lock

The plan originally proposed a wording lock and an explanation of why a behaviour test was impossible. That
was wrong, and the reviewer changed the ruling after reading the argument: the row arms a bare GLOBAL
`setTimeout` and `host-check.mjs` runs the real host half in-process, so swapping `setTimeout`,
`clearTimeout` and `console.error` around `apply` is enough to decide when the sample is taken. A wording
lock would have proven the string was still there; it could not prove that a late arrival gets its ending,
that a fast arrival stays silent, or that unloading clears the timer — the three semantics this round
actually changed.

`host-check.mjs` grew `options.connection` (`'now'` / `'never'` / `'manual'` with `releaseConnection()`),
`options.registerThrows`, effect disposers kept for `disposeEffects()`, and §7's fifteen assertions over
five scenarios. The swap is restored in `finally`, because a leaked fake `setTimeout` would hang every
later assertion in that file rather than fail one. **The red run, before the host half was touched, was
`ok=34 FAIL=7`:**

```
FAIL  the line no longer reads as a state: "[dsh-ui-projects] the connection service has not appeared, …"
FAIL  the line still reports a verdict the page cannot support: ["has not appeared","is not mounted"]
FAIL  the line lost the duration or the symptom: "[dsh-ui-projects] the connection service has not appeared, …"
FAIL  expected the waiting line and the arrival line, got ["[dsh-ui-projects] the connection service has not appeared, …"]
FAIL  the arrival line is not the measured form: "undefined"
FAIL  the waiting line was replaced or not followed: ["[dsh-ui-projects] the connection service has not appeared, …"]
FAIL  expected one "could not be mounted" line, got []
```

### 8e-3 — the wrapper on the real machine

The user ran, in `E:\dsh\plugins\dsh-plugin-liquid-glass`:

```powershell
powershell -File install.ps1 -Snapshot -DryRun
```

and the mode line read **`SNAPSHOT (dry run)`** — not `INSTALL (dry run)`, which is what the old forwarding
produced. The plan predicted that output line by line from the source before the run (six section heads:
Target → Preflight → Snapshot plan → What this run found → Retention → Dry run; payload `6 files, 82703
bytes`; `keeping the newest 3; nothing would be pruned`), and the prediction held. The one write this mode
performs is the script's own link-capability probe inside `%TEMP%` (created and removed by the script,
documented as intentional in `-DryRun` too); `$DSH_HOME` is not touched, and no snapshot is written.

### 8e-3 — the assertion arithmetic, and why a browser total is not comparable

The plan said the browser total would rise by three; the measurement was 184 against a remembered 182, so
**+2 for a +3 change**. Chased to the end, because a count that does not add up is how a suite starts
lying:

- **The last RECORDED browser total is 182 / 0**, from Round 44 (7d-2c) — `CHANGELOG.md` records it twice,
  with the note that `178 → 182` was that round's new test. So 182 does not include Round 48's test.
- **The suite's own source grew by exactly three.** Assertion call sites in `scripts/browser-verify.mjs`:
  **169** at `8207608` (7d-2c), **169** at `bae6ab2` (8c — this round's only earlier change there was a
  `glass.css` path fix), **172** at `8cd9808` (Round 48). Round 48's new test asserts exactly three things.
- **So the comparable quantity is the site count (+3) and the measured total moved by +2.** The difference
  is not a source change: `setSkin()` returns early — and asserts nothing — when the skin is already in the
  wanted state (`if ((await skinIsOn(session)) === wantOn) return`), and it has **six** call sites. Each one
  contributes 0 or 1 depending on the live page at that moment, so the suite's total is a function of the
  page as well as of its source.

That is why this entry records both numbers and compares the right ones. Future rounds should quote the
site count (or per-test `ok` lines) when they mean "the suite grew", and treat the total as evidence about
a RUN — which is what it is.

### Smaller pieces

- **The wrapper's two em dashes became ASCII** (`--`). The file has no BOM, so PowerShell 5.1 decodes it as
  ANSI and any non-ASCII in it is a latent mojibake source — harmless in that comment, not harmless as a
  pattern.
- **A sentinel that checked a spelling rather than a property failed on its own correct fix**:
  `check.mjs` looked for the literal `-SourceDir $PSScriptRoot`, which the new forwarding no longer contains.
  It now names the property — the wrapper tells the framework which directory to maintain, and does not let
  a caller name another — with the behavioural version in the framework's suite. This is CONTRIBUTING's
  "test the path, not the function", one level down.
- **`check.mjs` strips comments before scanning** (`stripComments`): the wrapper's header explains the
  `$Rest` bug **by name**, so a raw scan would have failed on its own documentation. Rule 5's fourth outing.
- **Two stale comments about identity were corrected** (`store.js`, `locale.js`): both still said the
  framework and the built-in skin ship as one package, which step 8c ended.
- **A silent fixture fallback became a stated precondition**: `verify.mjs`'s version-state test read the
  package name as `… ?? 'dsh-ui-projects'` — the exact fallback this round removed from the product — and
  now asserts the fixture names a package before using it.
- **CONTRIBUTING's "Five rules" became "Seven rules".** The count in the prose had been wrong since rule 6
  was added; the file now says seven and has seven.

### What this round did NOT verify

- **This round's tooling never ran `install.ps1` in any mode.** The single execution was the user's
  `-Snapshot -DryRun`, and it was `-DryRun`: no install, no update, no rollback, no uninstall, no
  `-ListVersions`. Those four modes' argument handling is covered by the new surface guard and the
  behavioural test, not by a run.
- **Nothing under `$DSH_HOME` was written by this round's work.** The reads were: the profile's
  `settings.yaml` (hashed as evidence, never copied), the version store (listing snapshots for the retention
  line), and `git status`/`git log` on the two repositories.
- **The browser run was the user's**, against their own restarted instance: gate 11 / 0 and 184 / 0 under
  `--no-write`. `--no-write`'s promise is narrower than it reads — the `settings` key only; `enabled`,
  `initialized`, `touched` and `v` still write, because the suite's own reload assertions need the enabled
  set to persist (CONTRIBUTING records the counted 42 attempts / 8 refused / 34 through).
- **The host wording cannot be verified from the browser.** It goes to the host process's stderr at
  startup; the run that matters is the restart, and it produced no line because the service arrived inside
  the window.

---

## Round 48 — Step 8d review: the copied block repeats the row's own command

**Status: done. `suite` 735 assertions / 0 failing (725 → 735, the new test's ten), `host` 26 ok / 0
failing, `load` 85 / 0, `conformance` 67 / 0, `skeleton` 13 / 0, `browser --self-check` green.
`lib/client.js` is `sha256:e792766ad7eb` (297388 bytes). The new browser-side test is written and has NOT
been executed — it needs a page running the rebuilt bundle, which is 8e's run. `install.ps1` was not
executed, and nothing under `$DSH_HOME` was written.**

### The bug, and the layer it was in

The user read two different removal commands off one row of the UI plugins page:

```
要卸载它，在 PowerShell 里执行：
dsh plugin --profile web remove @xjl-resources/dsh-plugin-liquid-glass      ← the row's own name

# 1. 在 PowerShell 里
dsh plugin --profile web remove dsh-ui-projects                             ← hard-coded
```

**It was ours, not dsh's.** The whole column is `src/client/panel-plugins.js`; the second block was
`copy.restartBlock`, and `src/client/locale.js` held it as a LITERAL with the framework's name typed into
it, once for English (`:88`) and once for Chinese (`:222`), while the first command four lines above was
built from `profileName` and the row's `name`. Two sources for one command, so they were free to disagree —
and they did, on every row that is not the framework.

It stayed invisible because the framework's row is the ONE row that renders no removal command at all (it is
the thing rendering the list), so a profile holding only the framework had no block to be wrong. Three
packages sharing the template is what exposed it.

### Why five suites were green over it

The literal was never compared against anything:

- No assertion anywhere read the block's TEXT. `browser-verify.mjs` asserted the hook exists
  (`[data-uip-restart="block"]`) and that *some* `[data-uip-command] pre` starts with `dsh plugin ` — the
  first such line it finds, which is the correct standalone command.
- The one assertion that would have caught it — *"carries no command that would remove the thing rendering
  the list"* — ran against a **flat fixture that supplies its own `restartBlock`**. The fixture replaced
  exactly the string under test, so the literal never entered the markup it inspected. `verify.mjs` already
  records this lesson in its own words, one test earlier: *"These render the REAL dictionaries. A fixture is
  a dictionary that does not exist, and this file was tested against one while production threw."* This is
  the second incident of that rule, and the same shape as Round 46's `source`-whitelist defect: a value that
  was correct by accident for the only row anyone had.

### The fix: one command, one source

`CommandBlock` builds the command once (`'dsh plugin --profile ' + profileName + ' remove ' + name`) and
passes it to the dictionary, which is now a function of it in both languages:

```js
restartBlock: (command) => `# 1. in PowerShell\n${command}\n\n# 2. stop dsh web (Ctrl+C), then start it again`,
```

The line under the hint and the line inside the block are the same string, so they cannot disagree again.
Function-valued entries are already the shape of this dictionary (`failed`, `project`, `orphaned`,
`maintenanceTitle`, `snapshotNames`), and the key-list guard in `verify.mjs` pins the key, not its type — so
the change showed up exactly where it should: in the two fixtures that had to become functions.

### The regression test, and its sensitivity

`the restart block repeats each row's own command, in both languages` renders the **REAL** dictionaries —
which is the whole point, since a fixture is what hid the bug — over a scan with the framework plus two
removable packages, and asserts per locale: one command line per removable row and none for the framework,
one block per command, every block containing that row's own command, and no block naming the framework.

**It was shown to fail against the old shape rather than only to pass against the new one.** The literal was
written back into both dictionaries, the bundle rebuilt, and the filtered run reported:

```
4 assertions, 1 failing
  FAIL the restart block repeats each row's own command, in both languages
         en: the copied block repeats "dsh plugin --profile web remove @scope/example-skin" instead of a second, hard-coded one
```

`locale.js` was then restored byte-identically (sha `e6d44ef3a64d` before and after) and the bundle rebuilt.
The demonstration also shows the abort: four assertions ran, so the rows after the failure were skipped —
which is why a partial count is never the final count.

A matching test was added to `browser-verify.mjs` (`the block each row offers to copy repeats that row's own
removal command`), because the page is the layer where the bug was seen. It compares the block against the
standalone command **within each row**, taking neither the profile name nor the package names from a
fixture. Its first execution is 8e's browser run.

### What this round did NOT verify

- **No browser run.** `--self-check` is green and the script loads, which proves the new test parses and its
  helpers resolve; it does not prove the DOM query. The page the user is looking at still runs the bundle
  built before this round.
- **The fix is not on that page yet.** `lib/client.js` changed, so the profile must be given the new bundle
  (the usual reinstall + `dsh web` restart) before the two blocks agree on screen.

---

## Round 47 — Step 8c: the framework ships no project

**Status: done. `suite` 725 assertions / 0 failing (737 → 725, and every one of the twelve is accounted
for: the derivation-predicate test moved to the skin), `host` 26 ok / 0 failing, `load` 85 / 0,
`conformance` 67 / 0, `skeleton` 13 / 0, `browser --self-check` green. The skin package: `check` 23 / 0,
`suite` 237 / 0 (225 → 237, +12 = the same twelve cases), build green with `lib/client.js` at
`sha256:425444fe2bf2` — UNCHANGED, because 8c touched no statement in it. The framework's
`lib/client.js` is `sha256:0a9aeb5dab4c` (296277 bytes, 17 modules; it was 20 modules and 351854 bytes).
`derive-boot-css --package <skin> --check` → 13 blocks / 10484 bytes; `derive-boot-css --check` with no
`--package` now exits 1 here, which is the first expected consequence below. NO browser run: this round
installs nothing, and the running page is unchanged — see the intermediate state at the end.
`install.ps1` was NOT executed in any mode, and nothing under `$DSH_HOME` was written.**

The framework now registers nothing, names no project, contains no CSS, and derives no first-paint sheet.
`src/**` code mentions a project id in exactly one place — `persist.js`'s `LEGACY_LOCAL_KEYS`, which is a
migration constant and has to keep the old spelling.

### What left, file by file

| Gone from this package | Where it went |
|---|---|
| `src/client/projects/liquid-glass/{skin.js,tokens.css,glass.css}` | the skin package, unchanged |
| `src/host/boot.css` | the skin package, unchanged (it was already derived from the two sheets above) |
| `scripts/boot-css-rules.mjs` | the skin package, byte-identical — the predicate is a statement about THAT CSS |
| `scripts/emitted-css.mjs` | the skin package, and it stopped holding copies of its own parameters: the marker and the sheet list now come from `boot-css-rules.mjs` |
| `scripts/capture-skin.mjs` | the skin package, byte-identical; it held no framework path, so the move changed no statement |
| `lib/boot-css.js` | deleted outright — a build artefact nothing imports now |

Deleted with them: `installBuiltInProjects` and both of its call sites, the `__internals.liquidGlass`
getter, `SHIPPED_SKIN_ID` with its `ctx.on('webserver/index-inject')` push and the `BOOT_CSS` import,
`writeBootCss()` with `cssSegments` / `normalizeCss` / `leafRules` / `ruleKey`, the guard that refused a
`src/host/boot-css.js`, the `MARKER` import and `LIQUID_GLASS_SELECTOR`, and the twelve-case predicate
test.

### The one semantic risk, and what replaced it

The framework registered its own skin **before** `runtime.start()` walked the registry, and the comment
at that call site explained why the order mattered: a project added later missed the restore, so a skin
enabled in a previous session came back off after a reload. Deleting the call deletes the ordering
guarantee with it, and the comment that stated the guarantee would then have been describing code that
was not there.

**No guarantee was lost, and the claim is testable rather than argued.** A project now arrives from its
own package, whenever that package's fiber applies; `service.register()` calls `deps.adopt(id)` after the
definition lands, and `runtime.adopt()` applies a project the restored record already asks for without
persisting anything. Both orders are therefore correct, and that is not new code — it is the mechanism
8b's fixture exercises, pinned by name in `verify.mjs` as *"a record that arrives after the bind is still
restored"*. The comment was rewritten to say that instead, and the rewritten text points at that test
rather than at the deleted function. `runtime.js`'s own comment referred to the old `index.js` note as
"the phase-1 comment"; it now refers to the behaviour.

### The assertion arithmetic, and the two claims that had to change value

Twelve assertions left with the predicate test, and nothing else changed count. Three assertions changed
VALUE, each because it had been stating the 8b world:

- `verify.mjs`, the fixture's own contract: *"and the framework still ships its own skin until 8c moves
  it"* asserted `ids().includes('liquid-glass') === true`. It now asserts the registry holds exactly one
  project — the fixture — and names no package: a count, not a name, because this suite must not depend on
  which packages are installed beside it.
- `verify.mjs`, the package-less probe: `probe.registry.ids().length` was `1` (the built-in skin, the one
  registration that skipped the service) and is now `0`.
- `load-check.mjs`: the presence rows in a two-package composition were `2` and are now `1`, because the
  second one was the framework's own. Together with `aloneTable` — a package with no framework emits
  nothing — the pair still says "one row per mounted package", with the framework contributing none.

### A test that had been agreeing with the product by accident

The suite went green except for **one** assertion, in *"the card says which state the version information
is in"*: it expected `data-uip-version-state="same"` and got `different`. The cause was not in the product.
The test read the package name off `projects[0]` and then keyed its version map with it, while
`scanWith()` hard-coded `dsh-ui-projects` in the scan's `dependencies` — so it passed for as long as
`projects[0]` was a registration with no `package` field, which is exactly what the framework's built-in
skin was. 8c removed it, `projects[0]` became the fixture (`test-skin-package`), the card's lookup found
no entries for that name, and the state came out `different`. The fixture now builds the pair explicitly
(`scanFor`), so the map key and the dependency row cannot disagree again.

The failure ALSO explains a five-assertion gap that a first reading of the total could not: `contains()`
throws on a miss, so the failing assertion aborted the rest of its test body. 719 + 1 was never the final
count — with the fixture fixed the run is 725 / 0.

### `lib/boot-css.js` was generated, not written

The guard this round deleted refused a `src/host/boot-css.js`, because the host-copy loop would have
overwritten the generated `lib/boot-css.js`. Before deleting it, the artefact was checked rather than
assumed: its first line says `GENERATED by scripts/build.mjs — do not edit`, `lib/` is in `.gitignore`,
and `git ls-files lib` is empty — so the only writer was `writeBootCss()`, and the collision it prevented
cannot happen once that function is gone. Deleting the guard is therefore a deletion and not a
weakening, and the loop now carries a comment saying so, including that a `lib/boot-css.js` found in a
working tree is a leftover from before this round that nothing reads. The stale artefact in this tree was
removed by hand.

### Diagnostics: one field becomes a table

`diagnostics.js` reported `projectMarker: body.getAttribute('data-ui-project-liquid-glass')` — the one
skin this package shipped, named inside the instrument whose job is to explain why a skin is not working.
A field that asks about an id nobody registered reads `null` on a healthy page. It is now
`projectMarkers`, keyed by the ids the registry actually holds. Nothing asserted the old field, so this
is a pure widening; it is also the second thing this round that would have become a lie about somebody
else's package.

### `browser-verify.mjs` keeps its references, and what they mean

Its 64 mentions of the skin across 29 tests are not a framework dependency, and the ruling for this round
recorded why they stay: **`scripts/browser-verify.mjs` drives the INSTALLED skin in a real browser, which
after step 8d is the normal state of this workspace.** Parameterizing it by project id is a separate
piece of work. The target this round is met without it — `src/**` CODE names no project — and this
paragraph exists so a later reader does not measure the 64 as a leftover.

One of them was a real path and is fixed: the mobile-blur token is read out of `glass.css`, and that file
moved. The read now points at the sibling package, the same arrangement `load-check.mjs` uses to mount its
real bundle. Without it `--self-check` would not have loaded.

### Smaller pieces

- **`scope-peek.mjs` takes `--marker`** and defaults to a placeholder (`example` is not a project). It is a
  tool about the SCOPERS, so a hard-coded project id in it was a fact about a package that could rename
  itself; the skin's `--marker` value is now passed in.
- **`bundle-client.mjs`'s comments use a neutral example** (`a/b/index.js` → `a/b`) where they used the skin's
  directory to explain id collapsing. This is the one place the round neutralized an existing name, per the
  ruling; every other name in a comment is a record of a real incident and was left alone.
- **`host-check.mjs`'s schema round-trip fixture** used `liquid-glass` as the id inside a record. It uses the
  suite's fixture now: a schema round-trip is about the SHAPE, and the fixture is the only id this
  repository is entitled to name.
- **`src/host/index.js` has no `webserver/index-inject` subscription at all.** A listener whose only
  statement would be `table.push(...[])` is a line claiming a job it does not do. The contract stays tested
  from both sides: `host-check.mjs` drives `bootRows` over a fixture sheet with this package's real host
  half mounted, and `load-check.mjs` mounts a real package's rows.
- **`package.json`'s `description`** said this package ships Liquid Glass. It says it ships no UI project.

### Documentation

- **The framework README** lost two sections that describe a PACKAGE's CSS — *why transparency is not
  adjustable* and *how Liquid Glass is built* (the `:has()` frame frost, its three measured constraints,
  the composer, the seat left untouched). Both moved into the skin's README, next to the stylesheets whose
  rules they explain; a short section here says where they went and what stayed. Rewritten in place: the
  "step 8 is in progress" note (now a statement of what this package is not), the `src/` tree, the project
  definition template (id `my-project`, with a note that it is a placeholder because the framework
  registers nothing), the *First paint* section (the contract, with the three rows written out and the
  read/write split named), and *Build artefacts* — **"`lib/` is complete only with both files"** now, with
  the third artefact's story kept as the reason the derivation is built the way it is, because that reason
  applies to every package that has CSS.
- **`CONTRIBUTING.md`** gained the rule this round creates: *this package ships no UI project, and a test
  that names one is a test that names a package it does not own* — where fixtures come from, why the two
  suites may still mount an installed package by path, and the two deliberate exceptions that keep a name
  in `src/**`.
- **`CHANGELOG.md`'s verification vocabulary** listed `scripts/emitted-css.mjs`, which no longer lives
  here.

### The first expected consequence, and the intermediate state

**`node tools/derive-boot-css.mjs --check`, run in this directory, now exits 1** with *cannot read the
first-paint rules of …\dsh-ui-projects*. That is correct and is the intended result, not a regression: the
tool reads the target package's `scripts/boot-css-rules.mjs`, and a package with no CSS has no first-paint
rules to state. The command belongs in the package that owns the sheet —
`node tools/derive-boot-css.mjs --package <package dir> --check` — and the skin's build runs exactly that
before it writes anything.

**Between 8c and 8d the workspace is in a state nobody should run.** The framework no longer ships Liquid
Glass and the skin package is not installed in the profile yet, so restarting `dsh web` in this window
shows no Liquid Glass card and no material. The two rounds must be adjacent and the web process must not be
restarted between them. This is written down because it is the only way this pair of rounds can be
mistaken for a broken build.

### Negative results and things that went wrong on the way

- **The build.mjs block deletion left three lines behind on its first run.** The two anchors matched, the
  write happened, and the residual scan then found `writeBootCss` still called from inside `build()` —
  below the second anchor, so outside the slice. The leftover call, the guard and the output line were
  removed with anchored edits and the file was re-checked. The lesson is the one this file keeps
  relearning: a patch script that verifies AFTER writing can leave a described half-state, and the
  residual scan is what made it a two-minute fix instead of a broken build.
- **The README move refused on a phrase that straddled a newline.** The check `'bottom of the slider'`
  failed against text that reads `A user found the` / `bottom of the slider` — prose anchors are not
  stable across wrapping. The retry matched WHOLE LINES and passed. Nothing was written by the failed run.
- **A filtered run's count is not a suite's count.** The single failing test was measured at 6 assertions
  on its own (5 passed + 1 failed, and the remaining 5 skipped by the throw), which is how the 720 total
  was traced to that one test rather than to lost coverage.

### What this round did NOT verify

- **No browser run, at all.** The `--verify-refusal` / `--self-check` leg is green, and nothing else could
  be: this round installs no package, and 8d is the round that puts the skin into the profile. Everything
  about the running page — the card, the material, the first frame — is verified in 8d.
- **`install.ps1` was not executed in any mode**, including `-DryRun`, and nothing under `$DSH_HOME` was
  read or written. The workspace's own profile is untouched.
- **The 64 skin references in `browser-verify.mjs` are unchanged and unexercised**: they cannot pass until
  8d installs the package.

---

## Round 46 — Step 8b: the framework gets a skin of its own, and the material moves out

**Status: done, with the framework still shipping its own copy of Liquid Glass (8c removes it). `suite` 732
assertions / 0 failing (939 → 732: thirteen material tests moved to the skin package, and two of them
returned as framework-side rule checks), `load` 85 / 0 (70 → 85), `host` green, `conformance` 67 / 0 (63 →
67), `skeleton` 13 / 0, `derive-boot-css --check` unchanged for the framework and green for the skin
(13 blocks / 10484 bytes each — the two sheets are byte-identical), `browser --self-check` green. NO
browser run: this round installs nothing, so the running page is unchanged. `install.ps1` was NOT executed
in any mode, and nothing under `$DSH_HOME` was written.**

### The fixture: a subject the framework owns

The suite used Liquid Glass as its subject for thirty-one tests — the runtime, the registry, the service,
the store, the panel, persistence, scoping, tiers. That made it unable to tell "the framework works" from
"Liquid Glass works", and after 8c those tests would have had to reach across packages. They now use
`test-skin`, a fixture the framework mounts through the same call an external package makes:
`ctx.uiProjects.register(manifest, definition)`.

The fixture's name says what it is, and one detail is deliberate: its PACKAGE is `test-skin-package`, not
`dsh-ui-projects`. That is what **found a defect that had been shipping since 7d** — see below.

**The harness had to learn Cordis's traceable-service contract to mount it.** `service.js` declares
`[Symbol.for('cordis.tracker')] = { property: 'ctx', noShadow: true }`, and Cordis hands a service back to
each caller wrapped so that `this.ctx` is the caller's context. The fake context did not do that, so a
fixture calling `ctx.uiProjects.register(...)` — the call every real package makes — was refused with
"must be called as ctx.uiProjects.register(...)". It now wraps services the same way (per accessing
context, cached per context so identity holds), and `ctx.child()` gives a package a fiber of its own, which
is what makes "unloading the package withdraws its project" testable inside this suite.

**The fixture's stylesheet carries seven rule shapes on purpose** (a body-level token rule, an ARIA-role
rule, `:has(… )::before`, `@supports` and `@supports not`, `@media`, two `[data-ui-perf]` variants), because
the framework's claims are about what it does to REAL stylesheets. And its `::before` is not decoration:
`backdrop-filter` creates a containing block, so a blur written directly on a column captures every `fixed`
descendant — the settings dialog. Liquid Glass learned that in 7d; the fixture keeps the shape.

### A defect the fixture found, and how long it had been there

`registry.normalize()` is a strict whitelist — a deliberate design, so a project cannot smuggle arbitrary
state into the registry — and it did not list `source`. The service stamps `source` on every registration
(`{ package, version, registeredBy }`), `store.js` reads `project.source?.package ?? 'dsh-ui-projects'` for
the package name on the card, and the whitelist dropped the field in between. **So every card named
`dsh-ui-projects`**, which was correct by accident for the framework's own skin and a lie for any other
package. It had been that way since the maintenance block was introduced in 7d; no test could see it,
because the only project in the suite was the framework's own — the fallback and the truth were the same
string. A fixture whose package is distinguishable is what surfaced it.

The fix is one line in the whitelist (`source`, frozen), and the fixture's contract test asserts it.

### The material moves to `@xjl-resources/dsh-plugin-liquid-glass`

A new package in this workspace, with its own `package.json` (`dsh.uiProject`, `dsh.bundle.patch`,
`dsh.client.platform: web`, `peerDependencies: { dsh-ui-projects: ^0.1.0 }`), its own patch row, its own
build, its own first-paint derivation, its own self-check, its own suite, and a thin `install.ps1` that
finds this framework's script and points it at itself. What moved: `tokens.css`, `glass.css`, the
definition — now behaviour only, because identity, copy, tier, checklist and preview come from the manifest
— and thirteen tests.

Its suite has three legs and an honest boundary: the MATERIAL (the stylesheets through this framework's real
scoper), the FIRST PAINT (the payload's shape), and the REGISTRATION CONTRACT (its own `lib/client.js` in a
sandbox with a fake service). It does NOT drive this framework's runtime; that is asserted here, and by
`load-check.mjs` mounting the skin's real bundle through the real Cordis.

**One user-visible consequence, recorded because it is the kind a person notices:** the framework registers
a project's version as the PACKAGE's version, so the skin package's first release stamps `1.0.0` where the
framework-era skin stamped `3.0.0`. A confirmed checklist therefore reads `stale` once. Publishing the
package as `3.0.0` to avoid that was rejected — a version that exists to make a stamp match is a version
that lies about what changed. It is written down in the skin's CHANGELOG.

### The two rules that stayed, now two-sided

`the frost goes on surfaces, never on a container of them` and `the skin names no CSS-module hash` are
rules for SKIN AUTHORS rather than facts about one skin, so they stayed here — pointing at the fixture —
with a change of shape: the predicate is a local function, the fixture must pass it, and **the shapes the
rule forbids must fail it**. A rule checker run only against a stylesheet that obeys it proves that the
checker RUNS, not that it REFUSES. Three synthetic violations (a blur on `[data-shell-overlay]`, on the bare
body, and on a container reached through the marker) and two hash shapes are asserted alongside the
fixture's clean sheet.

### `host-check.mjs` stops naming a project, and `load-check.mjs` loads the real one

`host-check`'s seven assertions about the framework's own first-paint push now hand the fixture's
PRE-SCOPED stylesheet (`TEST_SKIN_BOOT_CSS`, a different thing from the runtime sheet, and the difference is
the whole first-paint contract) to `uiProjectsHost.bootRows` and assert the contract: presence, then the
stylesheet, then the marker, with the marker only when the record says the project is on. The framework's
own push is one client of that service and disappears in 8c; the contract is what remains.

`load-check` gained the five assertions that matter for a package other than the skeleton: the skin's
generated manifest (scoped name, project id, PACKAGE version), its REAL built bundle mounted through the
real Cordis (registered, owned by the right package, listed by the service), a cross-package id clash
refused by name on an isolated root, unloading the package withdrawing its project, and its declaration
passing the conformance checker.

### `unattributed` gets its outlet

8a made the scan report version-store directories whose snapshots record no package — and a fact the page
cannot render is a fact nobody sees. `check-installed.mjs` now prints an `UNATTRIBUTED VERSION DIRECTORIES`
section (with each directory's snapshot count and why the name is not decoded back), and
`install.ps1 -ListVersions` warns per snapshot and counts them in its summary. Both are asserted: the CLI by
reading its wiring (a section that is never printed is what could silently rot), the script by its guard.

### The assertion arithmetic, recorded by the next round because this one did not

`939 → 732` is thirteen tests and **211** assertions leaving for the skin package, plus four assertions
added here in their place (two for the two-sided `#42` rule check, and two for the `unattributed` outlet),
with `#26` rewritten two-sided at no net change: `939 − 211 + 4 = 732`. The status line above stops there;
the third commit of this step — the snapshot-root guard that keeps every package in `tools/snapshot.mjs` —
added five more, and the suite stood at **737** when step 8c began, which is the number 8c then measured
against.

One thing is deliberately NOT claimed: that the skin's 225 is "the 211 plus fourteen". It is 211 + 14
arithmetically, and the 14 are the skin's own new legs (thirteen registration assertions and the bundle-id
one) — but a per-TEST correspondence between the 211 that left and the assertions the skin now makes was
never recorded, so the sum is a coincidence of totals rather than a ledger. Anyone re-deriving this should
count tests, not totals.

### Negative results and things that failed on the way

- **The skin's own guard failed on its own documentation.** Its first run asserted that `skin.js` never
  reaches for `MutationObserver` — and `skin.js`'s header explains the ambient-gradient layer that was
  removed, using that word. Comments are stripped before scanning now. That is CONTRIBUTING rule 5's second
  incident, one round after the rule was written (the first was this repository's `-Update` ordering guard).
- **The `8b` rename script reported thirty changes it had not made.** Its `swap()` helper read the ORIGINAL
  string every time instead of the accumulator, so only the last swap survived; the report counted matches
  in the original and the file kept the old ids. Fixed, and the script now re-reads what it wrote and
  refuses to claim success otherwise. The token half HAD landed, which is how the suite failed on `--ts-fill`
  in a file that still said `liquid-glass`.
- **The move script's first refusal was right and its second was not needed**: deleting thirteen test blocks
  is a mechanical operation, and asserting the count before and after is what made it safe to run at all.
- **`load-check`'s `equal` compares with `===`**, so two array comparisons failed with the confusing
  message `got [], expected []`. They compare lengths now.
- **A refusal is recorded on the service it happened on.** The first version of the clash test ran on the
  shared service, which made a LATER test fail with `got 2, expected 1`. It runs on an isolated root now.

---

## Round 45 — Step 8a: the installer learns which package it is maintaining

**Status: done. `suite` 934 assertions / 0 failing (909 → 934), `load` 70 / 0, `host` green,
`conformance` 63 / 0 (49 → 63), `skeleton` 13 / 0, `derive-boot-css --check` unchanged
(13 blocks, 10484 bytes — byte-identical), `browser --self-check` green. `lib/client.js` is unchanged:
`sha256:ccc2a7c7d569`, the same value it had before this round, because nothing in the browser half moved.
NO browser run. `install.ps1` was NOT executed in any mode, and nothing under `$DSH_HOME` was written.**

Step 8 splits Liquid Glass out of this package. This round is the groundwork that makes a second package
possible while the framework still ships its own, and it is deliberately behaviour-free: the framework's
own maintenance commands produce the same output and the same exit codes, and its snapshot store keeps its
directory and its record file name.

### One script, many packages

`-Package` names the package a run is about; without it the name comes from the `name` field of
`<SourceDir>\package.json`, which is the document the installer already trusts for `dsh.bundle.patch`.
The two must agree, and a disagreement is a **usage** error (exit 2) that prints both values — the usual
cause is a `-SourceDir` one directory too high, and "expected X" alone sends the reader to the wrong file.

The name is resolved **before** any path derived from it, because three of them are: the node_modules
link (a scoped package lives one level deeper), the version store's directory, and the install record.
`$PackageName` stayed the variable it always was, so the ~35 places that use it needed no edit at all —
most of why this round is reviewable.

### The version store: `@scope+name`, and no decoding

A scoped package name is not a directory name: `@xjl-resources/dsh-plugin-liquid-glass` contains a `/`,
the store is read exactly one level deep, so the two have to be different things with one agreed
translation. `install.ps1`'s `Get-VersionsDirName` writes `@scope+name`; `+` is the separator because npm
forbids it in a package name and because pnpm's lockfile already uses it; an unscoped name maps to itself,
which is what leaves every existing snapshot where it is.

**The reading half decodes nothing.** `readVersions` keys its map by the `package` field each snapshot's
manifest has carried since 7b, so the client still looks up `versions[project.source.package]` and knows
nothing about the layout. A directory whose snapshots record no package is reported as *unattributed*
rather than reverse-mapped from its name: `@scope+name` is a spelling this project chose, and turning it
back into a name would invent an authority the file on disk never claimed. **The reverse function the plan
sketched was therefore not written at all** — the case it existed for is the case that must be reported.

### The parity check runs PowerShell instead of reading it

Every other guard on `install.ps1` scans its text, and `docs/uninstall.md` states the limit plainly: a
source scan catches a check being deleted or moved, never one being weakened. The mapping is the one rule
in this round that **both halves implement**, so it is the one that can be checked by running both:
`scripts/verify.mjs` slices `Get-VersionsDirName` out of the script, evaluates it in a fresh
`powershell.exe`, and compares its answers with the host half's `versionsDirNameOf` over the same names.

**It earned its keep before it was finished.** The first JS version used `String.replace('/', '+')`, which
replaces ONE separator; PowerShell's `String.Replace` replaces all of them. Real package names contain one
slash, so no unit test could have caught it — the table includes `@a/b/c` precisely because two
implementations must agree on *any* input, and with the single-replace version the check fails with
`powershell "@a+b+c", host "@a+b/c"`. The JS half now splits and joins, and both agree.

**The answer comes back through a file, not stdout.** A piped child fails under this project's sandbox
(`spawnSync ... EPERM`, the documented no-named-pipes boundary), and a check that only works when nobody is
looking is not a check — PowerShell writes JSON to a temp file, which also survives a stray warning on
stdout.

### `-Update` cannot walk a record it does not have

Reported in the 8a plan as "a path never really walked", then corrected before implementing it:
`Preconditions` has always counted a missing record as a failure and refused on it, so the loop over
`$recorded.PSObject.Properties` was never reachable with a null record. The protection was **indirect** —
one counter shared with two unrelated preconditions — so this round adds a local short-circuit in front of
the record write *and* a guard that locks the order, with a line scan asserting that every
`$recorded.<field>` read comes after it. The short-circuit is unreachable today on purpose, and says so
where it is written.

**Two things went wrong on the way in, and both are recorded.** The ordering guard failed its own first
run by scanning the branch's raw text, where it tripped on *its own explanatory comment* — a comment that
names `$recorded.PSObject.Properties` while saying why the short-circuit exists (comment-only lines and
`<# … #>` blocks are now excluded; it is the same "guard reads its own documentation" mistake the column's
copy guard records in Round 43). And the first sensitivity demonstration proved nothing: it reworded the
refusal message while leaving the short-circuit in place, so the guard correctly kept passing. Removing the
block outright is what fails it, and that is the demonstration that was kept.

### Smaller pieces

- **`derive-boot-css.mjs` takes `--package <dir>`**, defaulting to the framework package, so today's
  `--check` prints exactly what it always printed. The marker, the stylesheet list, the output path and the
  header moved into the target package's `scripts/boot-css-rules.mjs` — one place per package instead of
  one copy in the tool and another in `build.mjs`, which is the arrangement that once let three suppression
  blocks vanish from the first-paint sheet while both copies agreed.
- **`unregister-profile.mjs` takes `--package` / `--profile` / `--profile-dir`.** It is a Node script, so
  its flags are `--`-prefixed; its hard-coded `C:/Users/19103/.dsh/profiles/web` is gone, and a flag
  written without a value is now a usage error rather than a package named `--check`.
- **`docs/update-and-rollback.md`** documents the scoped directory spelling, one record per package, the
  `-Package` resolution rule, and the executed parity check — including what the other guards still cannot
  do.

### What this round did NOT change

The framework still registers Liquid Glass from inside its own client half, still pushes its own
first-paint rows, and still owns `src/client/projects/liquid-glass/**` and `src/host/boot.css`. No file
moved, and nothing about the running page changes. 8b creates the skin package and re-fixtures the suite;
8c is the switch.

---

## Round 44 — Step 7e: the maintenance workflow is written down, and a stamp a person can read

**Status: done. `suite` 909 assertions / 0 failing (891 → 909), `load` 70 / 0, `host` green,
`conformance` 49 / 0, `skeleton` 13 / 0, `derive-boot-css --check` unchanged (13 blocks, 10484 bytes),
`browser --self-check` green. NO browser run of this round: the URL token this session held had been
invalidated by a restart (401 on the page, 404 on the bundle route), so the browser suite was left to the
user — `browser (user)` is the pending step, and it is one look at Settings › UI. `install.ps1` was NOT
executed in any mode, and nothing under `$DSH_HOME` was written while preparing this round.**

### `docs/update-and-rollback.md` — the workflow, its layout, and what each mode refuses

Three commands with three promises, and the ORDER is the part that is easy to get wrong, so the document
states it first: `-Snapshot` records a restorable version, `git pull && npm run build` brings the new one,
`-Update` records it as the new baseline, and `-Rollback -To` — the only mode allowed to write inside the
source tree — puts an older one back. It then documents the on-disk layout
(`.dsh-ui-projects-versions/<pkg>/<name>/{manifest.json,payload/**}`, every manifest field), retention
(`-Keep`, default 3, with the detail that **snapshots sort by `createdAt` and backups by name**, because a
backup name embeds the UTC stamp), the restore rules (exactly `package.json` + `lib/**`; `cordis.patch.yml`
and `CHANGELOG.md` are in the snapshot and deliberately not restored), the seven refusals that all happen
BEFORE anything is written, the rollback's rollback, the read-only modes and the three exit codes, and one
operational trap: **preflight is unconditional**, so even `-ListVersions` needs a resolvable `dsh` launcher
and `pnpm` on PATH.

Every behavioural claim cites the `install.ps1` line it came from, and the document says plainly what only
a real run can verify — the same boundary `docs/uninstall.md` draws. Its manual acceptance list ends with
the truncation negative case: take a scratch snapshot, truncate one file inside it, and watch all three of
`-ListVersions` (exit 1), `-Rollback -List` (`NOT restorable`, exit 1) and `-Rollback -To` (refused before
the backup, source tree untouched) refuse it.

A narrow guard accompanies it — `the maintenance workflow is written down, and names the three commands` —
asserting that the document exists and names them. It does not lock the prose: a documentation guard that
fails on a reworded sentence teaches people to edit the guard instead of the document.

### A stamp a person can read

`createdAt` reached the screen exactly as the host records it — `2026-09-27T04:47:12.2663764Z`, seven
fractional digits and all — which is right to RECORD and wrong to SHOW. `locale.js` now exports
`formatStamp`, which renders a UTC stamp as `2026-09-27 04:47 UTC` and returns anything it does not
recognize **unchanged**. Two decisions in it are deliberate: the `Z` is required before the word UTC may be
printed (labelling a value that never said it was UTC would be a nicer-looking lie, so an offset like
`+08:00` is left as it arrived), and it is string surgery rather than `new Date(...)`, so no reader's
timezone can move the number. Both dictionaries go through the one formatter. `-ListVersions` still prints
the raw value, because that is a machine-readable listing and not a sentence.

The four-state test's `same` fixture now uses the host's REAL 7-digit shape rather than a tidied
`…T08:15:00Z`, and a new test asserts both directions: the readable form is present, the raw one is absent,
no seven-digit fraction survives, and the unrecognized shapes come back as themselves. +18 assertions:
12 in the new test, 2 in the four-state one, 4 in the document guard.

### `CONTRIBUTING.md` gained the standing rules, and lost a stale number

A new `## Verification discipline` section states four rules in one line each, each pointing at the
incident in this file that produced it: **rebuild before verifying** (Round 43, lesson 1), **an assertion
inside an existing `test()` prints nothing of its own** (lesson 2), **verify the artifact the source
becomes** — `lib/index.js` is the entry only; the host half is copied file by file ("And one about
verifying a build"), and **never round-trip a file through PowerShell text cmdlets** (lesson 5, added to
Round 43 in this same round). The reasoning behind that split: a changelog is where an incident is
recorded and forgotten, a contributing guide is what the next reader meets before writing code, and these
four are met by anyone who changes `src/**`, adds an assertion, checks a build, or edits a file from a
shell.

Two smaller corrections went with it: the `docs/` row now names both documents, and `npm test`'s stale
`# 649 assertions` became a sentence saying where the count is recorded — a number in a standing document
goes stale, a number in a round does not.

### Negative results

- **The browser suite could not be run this round.** The page answered 401 and the bundle route 404 with
  the token this session held, and no token is readable from `$DSH_HOME`, so the gate and `--no-write` were
  not attempted rather than run against a page that would have failed for an unrelated reason. The
  formatting change is therefore `suite`-verified and `browser (user)`-pending.
- **The first version of 7d-2c's offline trigger test measured zero requests** while the code under it was
  correct, because it patched Node's `globalThis.fetch` instead of the sandbox's. Recorded in Round 43's
  7d-2c section, where the fix and the reason live.

---

## Round 43 — Step 7d: the interface offers the commands, and says only what it knows

**Status: done. `suite` 891 assertions / 0 failing (829 → 891), `load` 70 / 0 (65 → 70), `host` green,
`conformance` 49 / 0, `skeleton` 13 / 0, `derive-boot-css --check` unchanged, and the first real browser
runs of this phase: gate 11 / 0, then a run that ended **172 / 1** — the one failure a TEST ISOLATION bug
introduced and fixed inside this same round (see Lesson 4), not a product defect — and after 7d-2c a full
`--no-write` run of **182 / 0**. The numbers are recorded as they happened rather than as they should have
been; the 178 → 182 step is 7d-2c's new browser test, which asserts four things of its own.** Five steps,
seven commits:

| Step | Commit |
| --- | --- |
| 7d-1 — the plugins column prints the maintenance commands | `03afaa6` |
| 7d-2 — the projects panel: the card's own block, first half | `c648f5b` |
| 7d-2a — the card's block, tested | `c33ea5f` |
| 7d-2b — the card hook test, the load-check version assertions, this changelog | `4319e1e` |
| 7d-2b — again, with the test-isolation fix | `96cfe3a` |
| 7d-2 — the maintenance block reaches every row, and the version store is read correctly | `f154b43` |
| 7d-2c — the projects page asks the host itself, and listens for the answer | `8207608` |

A step name appearing twice is not a mistake: a follow-up commit that repairs the step it belongs to keeps
the step's name, and both are listed so the history stays traceable.

### What a person can now see

The plugins column prints, per package, a maintenance block: `-Snapshot`, `-Update`, `-Rollback -To <name>`
and `-Rollback -List`, with the restart reminder. A project's card carries the same commands folded into a
`<details>` whose summary takes a badge when a recorded version differs from the installed one — folded but
not hidden, because a collapsed block that conceals the only thing that changed conceals its own reason for
existing.

**The commands act on a PACKAGE, and both blocks say so out loud.** Today the framework and the built-in
skin ship in one package, so a person reading the Liquid Glass card would reasonably take
`install.ps1 -Update` for Liquid Glass maintenance. Once step 8 splits the skin out, the same field
(`project.source?.package`) is what makes a `-SourceDir` argument possible.

### The host reads the version store, read-only

`profile-scan.js` gained `readVersions`: it reads `<profile>/.dsh-ui-projects-versions/<pkg>/*/manifest.json`
and sends `{ name, version, createdAt, files, bytes, ours }`, newest first, at most five, with **no absolute
paths** — a snapshot NAME is what a person pastes, and where it lives is not the page's business. The
endpoint adds it as an optional field and the schema version is deliberately **not** bumped.

**`undefined` is not `[]`, and the interface says different things about them.** A host whose code predates
the field sends no `versions` object at all — a restart that has not happened, and the card says so. An
empty list is a fact about the profile: nothing recorded yet. With no store, or one that is idle, loading
or failed, the card claims **nothing at all** — not even "no snapshots", because nothing has been read.
Four states, three of them claims.

The panel reads the store **synchronously** (`props.installed?.state()`), never awaited — and since 7d-2c
it is no longer passive: this panel both asks for the read and listens for the answer (see
"The reader's route" below). The property the two columns' no-shared-state test protects is asserted from
both sides: a failed, loading, idle or absent store renders every card and every command, with no
`[data-uip-version-state]` in the markup.

### The reader's route (7d-2c): nothing had asked the host

**The version sentence was missing on the one page a person actually opens.** The user opened Settings › UI
and nothing else, expanded the Liquid Glass card, and found the three commands and no version line. The
suite was green at that moment — 178 / 0 — because it reaches that page along its own route: the plugins
column opens FIRST, and opening it is what asks the host, so by the time the card test visits the projects
page the listing has been in hand since long before the first card rendered. Suite and code were both
walking the other road.

Two halves were missing, and only the first is the obvious one:

1. **Nothing triggered the read from this page.** The trigger now sits in the section's own render, by the
   same rule the plugins column uses (this slot API has no mount hook, and a listing fetched at boot would
   be a request for a page most sessions never open). It fires only while the store is `idle`, and `refresh`
   publishes `loading` **synchronously**, so a React double render, a remount or a second visit asks nothing
   more — measured, not assumed: the browser test counts requests to that path and asserts exactly one.
2. **The panel read the store once per render and never subscribed to it.** The answer necessarily lands
   AFTER the first paint — that is what triggering from the render means — and a store read once and never
   subscribed to cannot report that anything arrived. Without this half the fix would have turned "never
   asked" into "asked and nobody listened", which looks identical on the screen. The plugins column has
   always subscribed (`panel-plugins.js`); the projects panel now does too, with the same shape, and
   re-reads the state on mount so an answer that lands between render and effect is not lost.

**A test-harness fact worth recording, because it cost a false negative:** the first version of the offline
trigger test measured **zero** requests while the code under it was already correct. It patched Node's
`globalThis.fetch`; the bundle's module factories were created inside the suite's `vm` context, so a bare
`fetch` in the client half resolves against the SANDBOX's globals and never saw the patch. The test now
installs its fake on `sandbox.fetch` — the bundle's own global — and measures one request on the first
render, none on the second or third, and the state sentence on the render after the answer.

**How it was verified.** `suite` grew 878 → 891 (the trigger test, and a source guard pinning the
subscription, since a static render cannot observe a hook). Browser: a new independent test that reloads
the page, opens ONLY the projects page, waits, expands the cards and asserts that a card states its version
situation, that the sentence is visible, and that the page asked exactly once; the next test's refresh
control still works because the test hands the panel back on the plugins page in a `finally`. Full
`--no-write`: **182 / 0**. `browser (user)`: the sentence appeared on the reporter's own screen — "最新快照
是 0.1.0-20260927T044712Z（包 v0.1.0，2026-09-27T04:47:12.2663764Z）；与当前安装的一致。" — whose
timestamp is what Round 44 then made readable.

### Five lessons from this round

1. **Changing `src/**` means rebuilding before verifying.** The first run of 7d-1's tests failed on two
   assertions that looked like real defects and were nothing of the kind: the suite loads `lib/client.js`,
   and `lib/` had not been rebuilt.
2. **An assertion inside an existing `test()` prints nothing of its own.** Two browser assertions added in
   7d-1 were read as "not run" because no new line appeared; they had run, and the count moving from 171 to
   173 was the only evidence. The third is therefore its own `test()`: a failure there should read as "the
   card's block did not render", not as one of a dozen assertions in a bigger test.
3. **The entry module must not touch React while it loads.** Exporting the projects section from
   `__internals` with a plain `require` broke exactly that contract, and two existing tests named it
   (`module-table miss: the shell exposes no "react"`; `nothing is requested at load time: got ["react"]`).
   A **getter** defers the require to first access and restores both.
4. **An independent `test()` makes a failure readable; it does not make its side effects go away.** The new
   card test opened with `ensurePanel`, whose name suggests "the panel is open" and whose behaviour is
   "the PROJECTS page is visible" (it early-returns on `.uip-root` and otherwise clicks the UI section). It
   therefore switched the panel away from the plugins page and left it there, and the next test — the one
   that has guarded the unreadable-listing path for five rounds — failed with `no refresh control`. A real
   FAIL, caused entirely by the previous test's leftovers.

   **The remedy is symmetric, and the first attempt at it was not** — which is worth recording, because the
   mistake is the instructive part. That attempt deleted the test's `ensurePanel` opening and kept its
   switch back at the end: the "go" without the "return". The test then looked for the projects page's hook
   while the panel was still on the plugins page and failed with `[]`, so the repair had moved the failure
   rather than removed it. What the earlier test left dirty was never "having switched" but "not switching
   back"; both halves now live in the same test, which is also the contract written where it is kept.

   **The chosen form is (c) from the report that found it — the test that changes the page state restores
   it, and says so in a comment the next person can copy.** Not an `afterEach` hook, because this suite is a
   linear script and the state that matters is *which page the panel is showing*: a property of the journey,
   not of any one test, and a hook that reset it would silently change what every test is allowed to assume.
   Not "each test returns to a default state first" either, because the tests that follow need the plugins
   page and the ones before need the projects page — such a rule would have to be re-derived per test
   anyway. Stating the contract where it is kept is the version a reader can verify by reading.

5. **A demonstration must not leave the tree in a state that only a test could have caught.** The source
   guard added by 7d-2c was being shown sensitive — delete the line, watch the guard fail, put it back — and
   the "put it back" was a PowerShell round-trip of `src/client/panel.js`:
   `Get-Content -Raw` followed by `Set-Content`, which on the Windows PowerShell available here decodes and
   re-encodes through the ANSI code page. Fifteen lines lost their `—`, `·` and `›` to U+FFFD, and one CRLF
   inside a block comment collapsed. Three properties kept it out of sight:

   - **The suite stayed green through it** — 891 / 0 — because the damage was in comments and one error
     string. A green suite says nothing about bytes it never reads.
   - **The check that appeared to confirm the restore passed.** It was
     `(Get-Content -Raw).Contains('<needle>')`, and the needle was ASCII; **a verification that only inspects
     ASCII cannot see an encoding change.**
   - **What caught it was a habit, not a test:** reading `git diff` before reporting. Fifteen lines showed
     as changed that were supposed to be untouched.

   The repair is the part worth copying: `git checkout -- <file>` for the committed bytes, re-apply every
   edit with the file tools, rebuild, and then PROVE it — a U+FFFD scan over every touched file returning 0,
   and the rebuilt bundle's `sha256` back at exactly `9735cff5f874`, the value it had before the incident.
   The standing rule lives in `CONTRIBUTING.md` under "Verification discipline", beside the other three it
   belongs with: rebuild before verifying, an assertion inside an existing `test()` prints nothing of its
   own, and verify the artifact the source becomes.

### The maintenance block shipped broken twice, and both causes are recorded

**The version sentence never rendered.** The section got the installed store only if `index.js` passed it,
and the shell calls a registered renderer with **no arguments** — a section can reach only what its own
closure holds. It now receives `installed: installedStore` there, and a browser assertion guards that
wiring, because the unit tests could not: they call the section directly and hand it a store of their own.

**Then it still rendered nothing, and the cause was two-layered.** `readVersions` was handed a list of
names from `uiProjectPackages`, which holds only packages declaring `dsh.uiProject`. The framework declares
none (it IS the framework), so it was never asked about and `versions` came back `{}` while its snapshots
sat on disk. **The versions directory is the list**: it now scans `.dsh-ui-projects-versions/` itself.

**And the fourth state was wrong.** With `versions: {}` the lookup `versions[pkg]` is `undefined`, and the
code treated "missing" as unreadable and stayed **silent** — leaving a person an empty block and no hint
that `-Snapshot` is the answer. Once the store is READY, "no entry" and "empty entry" both mean this profile
has recorded no snapshot of that package, and both now say so. Only "nothing has been read yet"
(`idle`/`loading`/`failed`/no store) stays silent: the one case where no claim can be supported.

**Two diagnostic lessons:**

- **Optional chaining removes the proof, not the bug.** `props.installed?.state()` short-circuits on
  `undefined`, so the section rendered its silent state without throwing — and "the panel still renders" was
  read as evidence the prop had arrived. It was evidence of nothing. When absence is indistinguishable from
  emptiness, print the value.
- **A host-side `console.log` appears in the `dsh web` terminal, not the browser console.** The endpoint runs
  in the dsh process, so the diagnostics appeared in a window nobody was watching.

**And one about verifying a build:** `lib/index.js` is only the entry; the host half is copied **file by
file** into `lib/*.js`, so a constant added to `profile-scan.js` lives in `lib/profile-scan.js` and nowhere
else. Searching the entry for it and concluding "the build did not run" was wrong twice over — **look in the
file the source becomes.**

### A number that needed reconciling

The three new 7d-2a tests reported 10, 14 and 3 assertions while the suite grew by 24, so the arithmetic
looked wrong. It was not: **every filtered run also counts the suite's one module-level assertion**, so the
tests' own totals are 9, 13 and 2. Recorded because the next person to add three tests will meet the same
gap, and a report whose numbers do not reconcile is a report nobody can check.

---

## Round 42 — Step 7c: recording a state, and the one command allowed to write the source tree

**Status: done. `suite` 829 assertions / 0 failing (794 → 829), `load` 65 / 0, `host` green,
`conformance` 49 / 0, `skeleton` 13 / 0, `derive-boot-css --check` unchanged, `browser --self-check`
green. No browser run. `install.ps1` was NOT executed in any mode here**: the record write and the
rollback are the user's manual acceptance steps, and both were run there — which is how the bug recorded
at the end of this entry was found.

### The manual run found a copy that landed one level up

The rollback's own safety net caught it, before anything was written to the source tree:

```
REFUSED  the backup did not verify (missing: lib/boot-css.js; missing: lib/client.js;
missing: lib/conformance.js; missing: lib/index.js; missing: lib/installed-endpoint.js)
```

**Root cause, in the backup loop.** The copy destination used the name relative to `lib/` while the
manifest recorded that name with a `lib/` prefix. So every file was copied to `payload\<name>` and then
looked for at `payload\lib\<name>`: the verification was right and the layout was wrong. All eight files
were on disk, one level too high. The SNAPSHOT branch had the same shape and was consistent — which is
why 7b passed and 7c did not.

**A second defect hid the first one's extent.** The refusal printed only the first five problems
(`Select-Object -First 5`), so a total layout failure read exactly like a partial copy: five missing, three
"present". The message now prints the problem count and up to eight names, with the remainder counted.

**The safety properties held**, and they are worth stating because they were the point of the design: the
refusal happened *before* the first write into the source tree, fingerprint 7 (the source tree) was
unchanged, `git status` was clean, `before` was untouched, and `lastRollback` was never written.

**Fixed** by giving the copy and the manifest ONE name (`$relFull`, built once with the `lib/` prefix) —
and the guard now asserts that those two lines cannot drift apart again, plus that the backup copies,
then writes its manifest, then verifies it, in that order. A probe over a `%TEMP%` fixture showed the rule
behaviourally: consistent naming → PASS; the 7c defect → CAUGHT with 8 problems; a copy of only five of
eight → CAUGHT with the three missing names.

**Third time this pattern is the finding**: a source guard proves a shape, and only a run proves it works.
Round 39 was a weakened check, Round 40 a check that could not execute, and this one a correct check
reading a layout the code never produced.

### `-Update`: verify, then record

The mode now writes exactly **one file**: the install record, and only a new `lastVerified` field beside
the record's own `before`. That baseline is what the install wrote and what `-Uninstall` compares
against, so it is never rewritten. `settings.yaml` is opened for reading only — the `ui-projects` block
is fingerprinted as evidence, never touched.

Preconditions are reported in **both** modes (the profile must still link this source; the record must
exist; `lib/client.js` must exist), because a dry run that cannot say whether the real run would refuse
is a plan with a hole in it. The write goes through `$StateNew` (`"$StatePath.new"`), is parsed back, and
only then replaces the record: `Write-TextFile` truncates first, and a half-written record is worse than
a stale one. On a bad read-back the original is untouched and the partial file is left where the message
says it is — deleting it would be a second write, and this mode has exactly one.

### `-Rollback -To <name>`: the only mode that writes the tree

It restores **`package.json` and `lib/**`** and nothing else. `cordis.patch.yml` and `CHANGELOG.md` are
in the snapshot and are deliberately not restored: making the running version correct does not require
them, and every extra write is a risk this project has paid for twice.

The order is the safety property, and it is asserted positionally:

1. the snapshot must verify against its own manifest — **`does not verify, so it will not be restored`**,
   and the refusal happens before this mode has written anything, including before the backup;
2. it must be a directory this tool wrote (`ours`), its `sourceDir` must be this tree, and its manifest
   must record `package.json` and `lib/**`;
3. if `cordis.patch.yml` differs between the snapshot and the tree, the run stops with **`patch differs`**
   and asks for `-Force` (or a hand-aligned patch) — the file is not restored either way, so what matters
   is that the difference is visible rather than silent;
4. **backup before writing**: the current `package.json` and `lib/**` are copied into
   `.rollback-backup\<name>-<stamp>\` **using the snapshot format**, so `Test-VersionSnapshot` verifies
   the backup too — the rollback of the rollback is a rollback;
5. the backup is read back and verified **before** the first write into the tree;
6. the tree is written, then **re-verified** file by file against the snapshot. A mismatch puts the tree
   back from the backup and stops with both paths printed, writing nothing further.

The backup lives **beside** the package directories, never inside one: `-ListVersions` walks those, and a
backup parked there would be listed as a version somebody could roll back to. Backups are pruned to the
newest three, by name, and only the ones this tool wrote.

`lastRollback` joins `lastVerified`, written the same way (new field, read back, moved over). The one
thing this mode cannot do is check whether dsh is running — Windows does not lock a file for reading, and
nothing here can see another process's memory. So it says so, in the plan and in the docs, instead of
pretending.

### The guards: five slices, and a permission granted where it is used

Sections are now UNINSTALL → UPDATE → SNAPSHOT → ROLLBACK → INSTALL, each with its own slice and its own
anchor. Two anchors moved (the update guard's end to SNAPSHOT, the snapshot guard's to ROLLBACK), and the
snapshot guard's write allowlist was tightened to the snapshot's own paths — the parent directory is no
longer an allowed destination.

The update guard's assertion changed shape rather than disappearing: 7a asserted "no write of any kind",
and 7c asserts "the only writes are the two aimed at `$StateNew`/`$StatePath`". The permission is granted
in the same round that starts writing, which is how the 7b guard's comment said it should be.

The pair refusal (`-Snapshot -ListVersions`) moved back into the mode matrix, because a preflight failure
would otherwise be reported instead of two modes being named; the snapshot section's own copy was deleted
rather than left unreachable, and the guard now checks the matrix — including that the section no longer
carries a second copy.

### Two near misses, caught by reading rather than by running

The new rollback section first read `$currentTreeSha` for the record's `from` side (never defined) and
`$StateNew` (defined in the UPDATE branch). Both are the Round 40 defect — a branch reading a name it does
not define — and both were caught while writing, because that round's comment says to look for exactly
this. The record's `from` side also now computes the tree fingerprint *before* the restore, since after it
there would be nothing left to measure.

### What this round does NOT show

The record has never been written, and nothing has ever been rolled back. Static guarantees here are about
WHERE writes may go and in WHAT ORDER; they say nothing about whether the write succeeds, whether the
tree ends up matching the snapshot, or what a real dsh does with a tree swapped underneath it. Those are
the manual steps, and they are the only evidence there will be.

---

## Round 41 — Step 7b: version snapshots, and the check that makes a truncated copy visible

**Status: done. `suite` 794 assertions / 0 failing (779 → 794), `load` 65 / 0, `host` green,
`conformance` 49 / 0, `skeleton` 13 / 0, `derive-boot-css --check` unchanged, `browser --self-check`
green. No browser run. `install.ps1` was NOT executed in any mode**: the snapshot has never been taken
here. Its output, its read-back verification, the retention pruning and the truncation case are the
user's manual acceptance steps; what this round verifies is static (three source guards) plus the
suites.

### Five modes, five promises

| Mode | Promise |
| --- | --- |
| `-Install` (default) | wires the profile through `dsh plugin`, then verifies |
| `-Uninstall` | removes what the PACKAGE owns, keeps what the USER owns |
| `-Update` | writes nothing at all (7a) |
| `-Snapshot` | **writes only under** `profiles\<p>\ .dsh-ui-projects-versions\` |
| `-ListVersions` | reads only |

`-Snapshot` and `-ListVersions` are refused **together** at the top of the snapshot section, with both
names in the check, before either opens the directory they share — the pair a person is most likely to
combine by accident, since one writes there and the other only reads. The general mode matrix leaves
that pair to this check on purpose, so the refusal sits with the two names it is about rather than
becoming dead code behind a broader guard.

### What a snapshot is

```
profiles\web\.dsh-ui-projects-versions\dsh-ui-projects\<version>-<stamp>\
├── payload\   package.json, cordis.patch.yml, CHANGELOG.md, lib\**
└── manifest.json   schemaVersion, tool, name, version, revision, createdAt, sourceDir,
                    payload {files,bytes,sha256}, sourceTree {…}, settingsBlockSha256,
                    files [ {rel, bytes, sha256} … ]
```

A package, not somebody's working directory: `lib/**` is the build output the profile actually loads,
and `package.json`/`cordis.patch.yml`/`CHANGELOG.md` are what a version IS. **The user's settings
record is not copied** — only a sha of its block, as evidence that it was untouched; a restore never
reads it, because a record belongs to dsh and the user (Round 36).

`-Name` is validated as a directory name (`^[A-Za-z0-9._-]+$`, no separators, no `..`) because that is
what it becomes.

### The verification, in three places and one direction

The same comparison — every recorded file present and byte-identical, and no unrecorded file in the
payload — runs (a) immediately after writing, (b) on every `-ListVersions`, and (c) before any restore
(7c). A copy nobody re-read is a copy nobody has checked.

- **(a) write-time**: a mismatch **deletes the incomplete snapshot** and exits 1; older snapshots are
  never touched. Pruning happens only after this passes, so a failed snapshot cannot cost an old one.
- **(b) list-time**: `-ListVersions` reports `OK n/n` or `WARN … changed: lib/client.js`, exits **1**
  if any snapshot fails, and a manifest with an unknown `schemaVersion` is a WARN that still lists what
  it can read.
- **(c) restore-time**: the contract `-Rollback` will honour — refuse, never half-restore.

The read-back is honest about its reach, in a comment where the check lives: the source side is read in
the same process at the same moment, so it proves the copy matched the source **as it was then**. It
cannot see a concurrent writer changing the source tree afterwards, and saying otherwise would be the
more dangerous claim.

Retention keeps the newest 3 by default (`-Keep` overrides it; the default is deliberate, and the
comment says so). Pruning deletes only directories whose manifest says `tool = install.ps1 -Snapshot`;
anything else in that folder is reported and left alone.

### The guard, and the inconsistency it caught on its first run

Four sections now, each guarded by its own slice: UNINSTALL → UPDATE → SNAPSHOT → INSTALL. Two anchors
had to move, and both moves are the same lesson: the uninstall guard already ended at UPDATE, and the
update guard's end anchor moved from INSTALL to SNAPSHOT — an anchor that skips a section lets that
section's text satisfy the wrong guard.

The snapshot guard splits its section at the listing header: **above** it every write verb must name
the version store (`$SnapshotDir`, `$SnapshotPayload`, `$OldSnapshotDir`, `$VersionsDir`,
`$PackageVersionsDir`, `$PruneTarget` — line-scoped, because a destination is the only thing a source
scan can honestly judge); **below** it no write verb may appear at all. It also asserts the order —
`if ($DryRun)` < the read-back marker < the first `Remove-Item` — because pruning after verifying is what
keeps a bad snapshot from costing a good one.

**It failed on its first run, on a real inconsistency**: the new snapshot locals were written camelCase
(`$snapshotDir`) while the guard and the rest of the file use PascalCase (`$NodeModulesDir`,
`$StatePath`). Six identifiers were renamed rather than the guard being loosened, and the assertion that
caught it is the one that exists to keep every write pointed at the version store.

### What this round does NOT show

No snapshot has been taken: not the copy, not the read-back, not the pruning, not the truncation case.
A source guard proves the checks are still written down; only running the mode proves they hold — Round
40's lesson, applied before the fact this time.

---

## Round 40 — Step 7a: `-Update` as a read-only plan

**Status: done. `suite` 777 assertions / 0 failing (760 → 777), `load` 65 / 0, `host` green,
`conformance` 49 / 0, `skeleton` 13 / 0, `derive-boot-css --check` unchanged, `browser --self-check`
green. No browser run: nothing user-visible changed.**
**`install.ps1` was NOT executed in any mode, including `-DryRun`.** That is this round's discipline, and
it splits the evidence: the dry run's actual output, its exit code and the "nothing moved" invariance are
the user's manual acceptance step, while what is verified here is static — the two source guards — plus
the suites.

### Three modes, three promises

`-Update` verifies and reports. It writes **nothing at all**: not the source tree, not the install
record, not the profile. The duties live in three separate commands because the ORDER is the part that
is easy to get wrong:

```
install.ps1 -Snapshot          record the version that is running now      (7b)
git pull && npm run build      the user brings the new version
install.ps1 -Update            verify what is there, report the difference
```

Without `-DryRun` the mode **refuses** (`exit 2`) with a diagnosis naming the round that implements it,
rather than half-working. `-Uninstall` and `-Update` together are refused the same way: each mode has a
different promise about what it writes, and a command readable as two of them has no honest promise.

The plan prints: the recorded baseline (install record's timestamp and two hashes), the current version,
whether `package.json` and `lib/client.js` moved since the record, the `lib/**` fingerprint, the source
tree fingerprint, a verdict, the registry **capability** (a `link:` spec is reported as "no registry
version to query" — the query itself lands after step 8), the newest CHANGELOG section(s), the recorded
`ui-projects` block as evidence, and the four things it will not touch.

### The helper: a self-consistent tree fingerprint

`Get-TreeFingerprint` hashes every file under a root as `"<rel> <sha256>"` lines, sorted and joined, then
hashes that. Relative paths use `/`; the sort is PowerShell's default string sort, the same one the
manual command uses, which is what makes the two agree. It is a fingerprint for comparing one machine
against itself, **not** a canonical cross-tool hash, and it says so. It excludes what it is told to:
`.git`, `node_modules` and `lib` for the source tree, since `lib/` is the build output under test and
`.git` is the user's own history.

### The three corrections to the approved plan

1. The plan line no longer claims to record: `then report the diff; nothing is written in this mode (7c
   implements recording)`. 7a writes no record, so a promise to write one would have been false.
2. The guard asserts the **absence of every write** — `Invoke-Dsh`, `Remove-Item`, `Copy-Item`,
   `New-Item`, `Set-Content`, `Add-Content`, `Write-TextFile` — instead of permitting exactly one. With
   the non-dry-run mode refusing, a permitted `Write-TextFile` would have been unreachable code that the
   guard protected; 7c grants the permission in the same edit that starts writing.
3. The dry-run footer no longer says "re-run without `-DryRun` to apply", which was misleading while the
   mode refuses. It now says what is true.

### The guard, and its sensitivity

The uninstall guard's slice now ends at the **UPDATE** header rather than the INSTALL one: with three
branches in the file, an end anchor that skips one would let the update mode's text satisfy the uninstall
guard. A second guard covers the update branch itself, and its sensitivity was demonstrated in memory
(the script is not this round's to mutate):

| Control | Result |
| --- | --- |
| untouched | PASS |
| A: 7c adds `Write-TextFile` without widening the guard | caught — `Write-TextFile` |
| B: the mode starts calling `Invoke-Dsh` | caught — `Invoke-Dsh` |
| C: the refusal is dropped, so `-Update` silently does nothing | caught — 0 refuse gates |
| D: the diagnosis stops naming the round | caught — no `(7c implements it)` |

Slice 8,566 characters against a 2,000-character floor, so scanning a fragment or an empty string fails
instead of passing.

### The first manual run found a crash the guards could not

The dry run died before printing anything:

```
install.ps1 : 检索不到变量"$sourceBundle"，因为未设置该变量。   (VariableIsUndefined)
```

`$sourceBundle` was defined in the UNINSTALL branch and read in UPDATE, and `Set-StrictMode -Version 2.0`
turns a reference to an undefined variable into a thrown error. Two source guards were green, the whole
suite was green, and the mode could not run at all.

Fixed, as three things rather than one line:

- the branch resolves `$sourceBundle` itself, with a comment saying why: a branch that reads a name must
  define it, even when the same name exists further up the file;
- a missing `lib/client.js` is now a WARN naming the fix (`node scripts/build.mjs`) instead of a crash;
- the same class was found next door — `'n/a'.Substring(0, 16)` throws, and every short hash in the
  branch now goes through `Get-ShortSha`. The guard asserts that no raw `Substring(0, 16)` remains in the
  slice, so the class cannot creep back one call site at a time;
- and the guard now compares **positions**: `$sourceBundle = Join-Path` must appear before
  `Get-Sha256 $sourceBundle`. A guard that only asserted the check EXISTS would have stayed green through
  exactly this defect, because the check was there — it just could not run.

**This is Round 39's lesson again, in a sharper form.** There, a source guard could not catch a check
being weakened; here it could not catch a check that never executes. A source guard proves a promise is
still written down. Only running the thing proves it holds. One mitigation did work as designed: the
crash happened **before any write**, and the fingerprint check showed the profile byte-identical
afterwards — the mode was broken, not dangerous.

### What this round does NOT show

The dry run has never been executed here: not its output, not its exit code, not the fingerprint
invariance. A source guard can prove a check is still written down; it cannot prove the check runs. If
the manual run disagrees with the plan — a missing section, a wrong exit code, a fingerprint that moves
— that is a 7a fix in the next round, not a footnote.

### Also

`tools/snapshot.mjs`'s header no longer claims "git is not installed on this machine": git is available
now, and the plugin repo has its own history. The tool still covers the trees git does not.

---

## Round 39 — Step 6d: the uninstall list, its proof, and its limits

**Status: done. `suite` 760 assertions / 0 failing (729 → 760), `load` 65 / 0 (64 → 65), `host` green,
`conformance` 49 / 0, `skeleton` 13 / 0, `derive-boot-css --check` unchanged, `browser --self-check`
green. No browser run: nothing user-visible changed, and the three new tests are offline by design.**
(The three filtered runs report 12, 8 and 14 assertions; each of those includes the suite's one
module-level assertion, so the new tests contribute 11, 7 and 13 — 31 in total, which is the difference
between 729 and 760.)

### The inventory, corrected by reading the tests

The audit's mapping was right for four items and wrong for six, and the corrections are the point of
this round. Items 1–5 and 9 came from step 4, not from 6a. Items 8 and 10 are **implemented but never
executed**: every check Round 38 added lives inside the non-dry-run branch of `install.ps1`, after its
`exit 0`, and no suite read that file at all (zero references — measured). Item 11's only assertion ran
on the `disable` path; item 12's `withdraw` notification was stubbed to a no-op in the real-Cordis
harness. Both were genuine gaps.

### The three new tests

- **`a project's timer and the runtime's own observer are gone once the package is retired`** (item 9,
  12 assertions). Two halves, two contracts: a project's own interval is the project's to clear — the
  runtime's promise is that `cleanup()` runs — and the observer plus backstop interval from
  `ctx.markColumns()` are the RUNTIME's, disposed from its owned list. Period-scoped rather than counted,
  because the runtime arms periods of its own (500 ms boot-page watch, 250 ms marking backstop, both
  already asserted at `verify.mjs`), and the first assertion pins that premise instead of assuming it.
- **`retiring the active skin returns the shipped interface, not a half-applied one`** (item 11, 8
  assertions). The root marker is deliberately NOT asserted here: `data-ui-projects` is set in `start()`
  and cleared in `dispose()` (`runtime.js:233`, `:457`) — it means "this plugin is mounted", not "a
  project is applied". The first draft of this test asserted its removal, which would have failed and
  pointed at a defect that does not exist; the premise check caught it before the test was written.
- **`the panel is asked to re-render exactly once`** (item 12, in `load-check.mjs`). A DELTA, not a
  count: `deps.notify()` fires from `register` (`service.js:138`) and from `withdraw` (`:195`), so an
  absolute number would drift with registration.

### The source guard, and what it cannot do

Nothing read `install.ps1`, so every check Round 38 added could have been deleted with the suite green.
A guard now asserts the branch still contains each check, still names the four things the dry run
promises not to touch, and still orders `if ($DryRun)` < `exit 0` < `Write-Head 'Removing'`, with
exactly one dry-run gate so the position compared is unambiguous.

**It catches a check being deleted, renamed or moved. It cannot catch one being weakened** — a
comparison replaced by something that always passes reads the same to a source scan. The real
verification is a real uninstall, which is why the manual acceptance steps live in `docs/uninstall.md`.

Sensitivity was demonstrated without touching the script (its file is not this round's to change): the
guard's own logic re-run over in-memory mutations. Untouched: clean. Drop `$settingsBlockAfter`: the
settings-block assertion reports it. Drop `.ignored_*`: the tombstone assertion reports it. Move the
removal above the exit: the position assertion reports it. Slice length 16,504 characters against a
2,000-character floor, so the vacuous case — scanning a fragment or an empty string — fails instead of
passing.

### A hang, and why it was one

The first draft of the timer test used the bare `setInterval` inside a project defined in the suite
file. A project defined there is a HOST-realm function, so that was Node's real timer: the fake ledger
never saw it, and the real handle held the process open, so the run looked like a hang rather than
failing. It now uses `sandbox.setInterval` — the same globals the bundle sees, which is what a package
gets for free in a browser where its realm IS the page's. Recorded because a hang is the most expensive
way to learn it.

A second lesson from the same attempt: with the sandbox's timers in charge, a boot that expects the
frame to be present already waits on a timer nobody will fire. Both existing fake-timer tests boot with
`detachedFrame`; this one now does too, and mounts the frame by hand — which also puts the observer's
marking path under the assertion.

### `docs/uninstall.md`

The twelve items with the driver, the code and the assertion for each; the boundary that no suite runs
`install.ps1` and why; and five manual acceptance steps with expected output, including the read-only
check that the `ui-projects` block of `settings.yaml` survives.

### Also

`DSH_TEST_ONLY="<substring>" node scripts/verify.mjs` runs one test and prints how many it skipped, so a
single test's evidence does not have to be found inside a 762-assertion run.

---

## Round 38 — Step 6c: the uninstall audit, and the residue it found on a real machine

**Status: done. `install.ps1` extended in five places; parse-checked (1117 lines); `-Uninstall -DryRun`
run twice: exit 0 both times, byte-identical output, and ZERO writes across six fingerprints
(`settings.yaml` whole-file and `ui-projects` block, profile `package.json`, `pnpm-lock.yaml`, the
install record, the node_modules inventory). No suite change, so no suite run. The real uninstall was
NOT run: that is the user's to do.**

### What the audit found

The uninstall branch (originally lines 594-731) was already careful in the two places that matter most:
`Remove-DirectoryLink` deletes through the reparse point and refuses anything that is not a link, and
both source files are hashed before and after to prove the source tree was never reached. What it did
not do was look at anything it had not been told about:

| # | Gap | Impact |
| --- | --- | --- |
| 6 | nothing asserted that `settings.yaml` was left alone | Round 36's decision rested on "we never wrote it", which is a claim until something checks |
| 8 | `.ignored_*` tombstones were never looked for | disk residue whose name reads as "still installed" |
| 8 | the recorded node_modules inventory was never read back | an uninstall could take a neighbour's link and still exit 0 |
| 8 | a lockfile still naming the package was not noticed | a lock the manifest no longer agrees with |
| 12 | `-DryRun` printed a generic plan | no way to see what it would find without removing anything |

### The changes

- **A1** — `Get-SettingsBlock` extracts the `ui-projects:` block as text, and the uninstall hashes it
  before and after. A block, not a whole-file hash: Round 35 measured that dsh rewrites its own
  bookkeeping in that file even when the write is refused, so a whole-file hash reports changes this
  script did not make. Losing the block is reported more severely than changing it.
- **B** — tombstone scan for `.ignored_*` (and `node_modules/.ignored/<name>`): a tombstone that is a
  link is removed with the same guard as the leftover link; a real directory is reported, not deleted.
- **C** — the neighbours check, comparing the inventory before and after THIS run.
- **D** — lockfile residue: reported, NOT failed, until someone measures whether a `link:` dependency
  legitimately survives in the lockfile's importers section.
- **E** — `-DryRun` now reports what it FOUND (wired state, the node_modules entry and its type, a
  tombstone, the settings block) and prints four explicit "will not be touched" lines: the source tree,
  `settings.yaml`, every other node_modules entry, and the checklist record.
- **F** — the real-directory case keeps its Warn (not a failure) and now says what it is and how to
  delete it: a real copy of the package inside the profile, which the uninstall leaves alone.

### Two findings, both measured on the machine this ran on

**A tombstone was really there.** The first dry run reported
`pnpm tombstone present: …\node_modules\.ignored_dsh-ui-projects` — a REAL directory (not a link)
holding a stale copy of the package: 20 entries, 141,551 bytes, with its own `lib/`, `CHANGELOG.md` and
`cordis.patch.yml`. Two consequences, both intended: the listing never sees it (`profile-scan.js`
resolves BY NAME from `dependencies`, so pnpm's furniture can never be mistaken for an installed
package), and a real uninstall will now report it and count it as a failure — so that uninstall will
exit 1 with the `Remove-Item -Recurse` hint until somebody decides what that directory is.

**The install record's inventory is stale by construction.** It is captured BEFORE `dsh plugin add`
runs, so on this machine it holds 4 entries against 20 present today and does not contain the package
itself. The neighbours check as originally proposed would have compared against it and reported sixteen
"gained entries" on a healthy uninstall — a check that teaches its reader to ignore it. It now compares
this run's own before and after, and reports the record's drift as a note. Simulated both ways, read
only: old baseline `added=16 → FAILURE (false)`, new baseline `gone=[dsh-ui-projects], added=0 → OK`.

---

## Round 37 — Step 6b: the uninstall block, and an assertion that assumed an empty checklist

**Status: done. `suite` 729 assertions / 0 failing (701 → 729), `load` 64 / 0, `host` green,
`conformance` 49 / 0, `skeleton` 13 / 0, `derive-boot-css --check` unchanged, gate
(`--verify-refusal`) 11 / 0, `browser` 171 assertions / 0 failing under `--no-write`.**

### The block beside the removal command

Each row that offers a command now answers all three questions, in order: what the framework removes on
its own (six items), what the command removes (two), and what is deliberately left alone (four). The
third group is the load-bearing one — everything else can be worked out by trying it, while "your switch
survives, this package's settings survive, and your source tree is not touched" cannot, and those are the
facts somebody wants BEFORE pasting the command rather than after. It is also the only place inside the
interface where the two decisions about user data (Round 36) are visible to the person they affect.

Each group carries `data-uip-uninstall="automatic" | "command" | "kept"`, so both suites assert the
structure rather than the copy: the unit test renders all three from the real dictionaries in both
languages, and the browser test asserts that EVERY row offering a command has all three.

### `copy.uninstall` is read without a fallback, on purpose

A missing dictionary key should fail loudly rather than render three empty lists. It did, immediately:
the third hand-built copy fixture in `verify.mjs` — the one whose `kinds` line differed, so a
pattern-based edit missed it — came back as
`TypeError: Cannot read properties of undefined (reading 'automaticTitle')`, which names the group it
could not read. That is Round 35's lesson applied to a nested key before it could become one.

### The finding: an assertion that assumed an empty checklist

The full run failed on `the button refuses until every item is ticked` — `expected true, got false` —
and the cause is worth recording, because nothing in this round caused it. The boxes are the READING and
they are seeded from the record, so on a machine that holds a **current** confirmation the card opens
with every box already ticked, and the button is correctly enabled. The assertion had been passing only
because every record on this machine was `items: {}` until Round 35 fixed that — in other words, it broke
the moment the fix worked and a real confirmation existed.

It is now state-agnostic: the unticked state is CREATED (one box is clicked off), the refusal is waited
for, and the step below ticks everything again. Same assertion, no assumption about what the document
holds.

### Attachment paths

The specification's exact path was reported as its parent directory. It had genuinely been read — the
glob returned it and its content is what the Step 6 plan quotes — but the shortened path sent the reader
looking one level too high, so `CONTRIBUTING.md` now carries the rule for citing what a tool actually
returned.

---

## Round 36 — Step 6a: what an uninstall owns, and what the user owns

**Status: done. `suite` 701 assertions / 0 failing (695 → 701), `load` 64 / 0 (58 → 64), `host` green,
`conformance` 49 / 0, `skeleton` 13 / 0, `derive-boot-css --check` unchanged. No browser run: nothing
user-visible changed — this round is about the semantics of a package leaving, which the real-Cordis
check covers directly.**

### A decision that reverses the specification

The specification's uninstall flow says to clear `settings['<id>']`. That sentence predates the
checklist, when a project's settings entry held nothing but a package's cached state. It holds user
data now — a recorded verification, and any control the project offers — so it belongs to the user,
exactly like the id in `enabled`, and an uninstall keeps both. The two are one decision: a package
going away removes what the PACKAGE owns (its registration, its stylesheets, its markers, its CSS
variables) and nothing else. Reinstalling then restores the configuration the person had, instead of
the defaults.

The amended line, in the spec's own words: 「保留 settings['<id>']，与 enabled 同理」. It holds for the
`localStorage` fallback record too, which stores the same shape and therefore follows the same rule.

### What was actually missing: the proof, not the behaviour

`withdraw` (`service.js`) already retired before unregistering, and already wrote nothing to the
record. No test asserted any of it — which is how a future implementer following the old
specification would have deleted user data with the suite still green. That is the gap this round
closed, and it is the same shape as Round 35's: the behaviour was there, the assertion was not.

- `load-check.mjs`, on the real Cordis: the record is seeded the way a used installation looks — the id
  in `enabled`, a settings entry holding a recorded confirmation and an option, and a SECOND package's
  entry — and after the package's fiber is disposed the record is asserted **byte-identical**. The id
  is still in `enabled`, the confirmation is still readable, the other package's entry was never in
  question, and reinstalling the package applies the project again and finds its configuration.
- `verify.mjs`: the same rule in the fallback store — the departed id's entry survives in the
  `localStorage` blob, the installed package's entry is untouched — plus the inventory the cleanup half
  rests on: the plugin declares exactly four storage keys (one record, one debug flag, and the two
  leftovers that are swept on sight), and no storage call takes a key written inline, so a per-project
  key convention cannot appear without failing a test.

### Design note on the guard

The inventory guard's first form would have passed vacuously: every `localStorage` call site passes a
CONSTANT, so scanning for inline key literals finds nothing whether or not an undeclared key exists.
Both halves are therefore parsed out of the sources that declare them — the key constants from the
modules that define them, the sweep list out of `LEGACY_LOCAL_KEYS` — and asserted as an exact set, so
a fifth key fails the test and forces the cleanup question to be answered.

---

## Round 35 — a confirmation that recorded nothing, and the run that was not `--no-write`

**Status: done. `suite` 695 assertions / 0 failing (676 → 695), `host` green, `load` 58 / 0,
`conformance` 49 / 0, `skeleton` 13 / 0, `derive-boot-css --check` unchanged, gate
(`--verify-refusal`) 11 / 0, `browser` 168 assertions / 0 failing under `--no-write`, and
`browser (user)`: the three items ticked in the running instance, with all three keys on disk — the
first correct record since Round 29.**

### The bug: a record with a version and no items

What a person saw: tick all three items, press the button, reload — and the card reports the checklist
as INCOMPLETE, against the correct version. The record existed and contained nothing.

It was found by payload rather than by reading. The refusal gate prints what it refuses, and the
confirmation write a real click produced was

```
ops=[set:settings(58B)] … {"liquid-glass":{"checks":{"version":"3.0.0","items":{}}}}
```

58 bytes is exactly that object, so the loss was upstream of persistence: the page sent an empty set.
`store.confirmChecks` is where `items` is built —

```js
const items = {}
for (const itemId of itemIds) {
  if (project.testItems.some((item) => item.id === itemId)) items[itemId] = true
}
```

— and it was handed the string `'liquid-glass'`. The card passed `project.id` to a callback that
already closed over it (`onConfirm: (itemIds) => onConfirmChecks(project.id, itemIds)` calling into
`onConfirmChecks: (itemIds) => run(project.id, store.confirmChecks(project.id, itemIds))`), so the
array of ids bound to the second parameter and the id took the first. `for…of` over a string walks its
CHARACTERS, matched no declared item, and wrote nothing — silently, because iterating a string is
legal and the loop simply never matched. `onClear` on the next line never had the bug: it passes no
arguments at all.

### The chain, in one place

1. `panel.js` — `onConfirm: (itemIds) => onConfirmChecks(project.id, itemIds)`. The id is passed a
   SECOND time, to a callback that already closes over it.
2. The array of ids therefore binds to that callback's second parameter, and `'liquid-glass'` takes the
   first — the one named `itemIds`.
3. `store.confirmChecks(id, itemIds)` receives a STRING where the ids belong.
4. `for (const itemId of itemIds)` iterates the string's characters: `'l'`, `'i'`, `'q'`, `'u'`, …
5. `project.testItems.some((item) => item.id === 'l')` is false for every one of them.
6. `items` stays `{}` and the record is written as `{ version: '3.0.0', items: {} }` — 58 bytes, the
   payload the refusal gate printed. Nothing threw, nothing warned, and the card reported success.

### The fixes

- `panel.js` passes `onConfirm: (itemIds) => onConfirmChecks(itemIds)`. The id is closed over, not
  re-passed, and the two neighbouring callbacks now read the same way.
- `store.confirmChecks` throws a `TypeError` when its input is not a non-empty array, and when the
  record it computed would be empty. A loop that can match nothing must not be able to record a
  confirmation: both shapes used to write `{ version, items: {} }` and report success.
- The browser suite asserts the confirmation reads `current` at the point where the three boxes have
  just been ticked and the button pressed. It only checked that a record was PRESENT before, and an
  empty record satisfies presence — which is how two runs of this suite watched the bug happen.

### Why it survived five rounds, and the test that ends that

Five assertions in this file called `harness.store.confirmChecks('confirmable', ['one'])`: a
well-formed array, handed to the layer BELOW the bug. Every one of them passed — in every round since
the checklist was written — while the card in the browser recorded nothing at all. The assertions were
not weak; they were aimed one layer too low.

The new test renders the card through React and invokes the props the card hands its checklist, so the
assertion is on the CONNECTION between the component and the store, which is where the defect lived.
`CONTRIBUTING.md` now carries the rule this earned.

**Negative control.** The one line was put back and the suite was run against it: `FAIL the card hands
the item ids to the store, not the project id`, with the plugin's own action handler printing
`TypeError: confirmChecks expects a non-empty array of item ids, received "three-items"` — while the
store-boundary test beside it stayed green, which is precisely the gap this round closed. A regression
test that has never been seen to fail is not evidence; this one has been seen to.

### `browser (user)`: the first correct record since Round 29

The persistence path itself was never in question — the skin toggle's reload assertions cover it — but
no correct set of ids had ever reached it. After the fix, ticking the three items in the running
instance and pressing the button wrote, on disk:

```yaml
checks:
  version: 3.0.0
  items: { text-readable: true, settings-centred: true, no-first-frame-flash: true }
```

Every record before this one was `items: {}`, so every one of them read back as `incomplete` on the
next boot. That is the observation this round was about, confirmed by the person who made it rather
than by a harness — `browser (user)`, in this file's vocabulary, and the strongest evidence here
because it did not go through any code written in this round.

### Two lessons, stated so the next component inherits them

1. **`for…of` over a string is legal, silent and total.** It walks the characters, throws nothing and
   warns nothing, so a wrong argument produced a plausible-looking WRITE — `{ version, items: {} }` —
   instead of an error, and the record then survived a reload because the version it carried was
   correct. Where a loop's body can match nothing, that outcome has to be refused explicitly; the store
   does now, which is why the same mistake fails loudly today.
2. **An assertion tests the layer it calls.** Five assertions that handed the store a good array
   verified the callee's contract and said nothing about the caller's. A path carrying arguments from a
   component into a function needs an assertion made THROUGH the component.

### `waitFor` is not a boolean, and the diagnostic that could never run

Two browser-suite defects of one family — an assertion that could never pass, and a diagnostic that
could never be collected:

- `waitFor` THROWS on timeout and returns nothing on success. The group read
  `truthy(rendered === true, …)`, which is false either way, so two runs reported
  `expected truthy, got false` while the column was mounted the whole time. It now catches the
  timeout into a flag and asserts after the samples.
- The sampling diagnostic — six samples 500 ms apart, a refresh, four more, and two timed endpoint
  probes — was written AFTER that assertion, so the run that needed it never collected it. Assertions
  now come last and carry the sequence in their message.

Result: `["loading","ready","ready",…]`, endpoint 200 in 12–17 ms, and the group passes.

### Process: the run that was not `--no-write`

One full run was started without the flag; its log says `settings: writes allowed`, and its reset test
really did delete the profile's checklist record (`ui-projects.settings` → `{}`). Two corrections, and
one deliberate non-action:

- Restoring from `settings.yaml.bak3` was **not** done. The only record those backups hold is the same
  empty-items record this round fixed, so restoring it would restore the defect's output. The honest
  path is the one the fix enables: re-confirm in the UI.
- The flag's boundary is now written down, in `CONTRIBUTING.md` and in the suite header: `--no-write`
  refuses writes to the `settings` key only. Measured: 42 write attempts, 8 refused, 34 through — so a
  run moves the document's mtime while leaving the protected subtree alone. If a machine's
  `settings.yaml` must not be touched at all, do not run this suite on it.

---

## Round 34 — Settings › UI plugins: what is installed, read-only

**Status: done. `suite` 676 assertions / 0 failing (649 → 676), `host` green, `load` 58 / 0
(47 → 58), `conformance` 49 / 0, `skeleton` 13 / 0, `derive-boot-css --check` unchanged. No browser
run: this round registers a section, fetches one path and renders it, and the phase rule is that a
browser run passes the `--verify-refusal` gate first.**

A second settings section, `ui-plugins` (order 26, after the projects page), answers a different
question from the one above it: Settings › UI manages PROJECTS out of the registry, this manages
PACKAGES from a directory scan. Two pages because they have two sources of truth, and one page
answering both is where those get confused.

### The channel survey, and why the endpoint is where it is

| Route family | Authentication |
| --- | --- |
| `/plugins/**` (the client bundles) | **none.** `dsh-host-webserver` contains no address check, no origin check and no authorization code at all; `dsh-client-modules` registers `/plugins` as a bare `prefix` route. Right for a bundle, wrong for a listing that names every installed package and where it lives |
| `/api/**` | the Host/Origin fence, then persistent browser authentication — `dsh-client-connection` mounts it, and `API_PATH = "/api"` is documented as "the /api URL prefix — single source for both halves of the web transport" |

So the listing rides the **Connection service's fetch registry**:
`ctx.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', fetch })` — the
same call three shipped host halves make (`/api/file`, `/api/session/uploadFileBinary`,
`/api/present.host`), with registrations scoped to the caller's fiber so the route dies with the row.
**The payload is a projection**: identity, composition state and problems, and none of the absolute
directories the CLI prints for a human.

### The client binding was wrong, and this is what it was

The first version of the page side called `ctx.connection.fetch(new Request(path))`. **That method
does not exist there.** `connection.fetch.register` is the host-side registry, and `rpc.d.ts`'s
`fetch(request: Request)` belongs to the host HTTP bridge — the page's `connection` service exposes
`rpc.call(channel, endpoint, payload)` for RPC channels, which is a different mechanism, and the
shipped pages reach fetch routes the ordinary browser way:

```
dsh-session-log-export/lib/client.js   new URL("/api/session.export", hostBase()) → fetcher(url, …)
dsh-client-file-upload/lib/client.js   const FILE_UPLOAD_PATH = "/api/session/uploadFileBinary"
dsh-client-ui-deliverables/client.js   const PRESENT_OPEN_PATH = "/api/present.open"
```

A plain `fetch` to a full `/api/...` path, authenticated by the browser session cookie the fence
established. Two consequences, both now in the code: the route is registered **under `/api`**
(asserted, because a route outside it is served with no fence at all), and the page's request is a
plain `fetch(path, { credentials: 'same-origin' })`.

**What made this findable and what did not.** I checked the host side against three precedents and
got it right; I inferred the client side from a type file whose owner I never confirmed, and got it
wrong. The lesson is the one this project keeps relearning: a signature in a `.d.ts` is evidence
about *a* consumer of it, not about the one you are writing.

### What the column does

Three states, and the middle one is the point: `loading`, `ready` (with every package's problems
rendered on its own row), and `failed` — **with the reason**, because "cannot read the listing" and
"nothing is installed" look identical otherwise. Nothing is persisted, and that is asserted against
the store's own source: a stored listing is a claim about a profile at a moment that has passed.

Each row shows `name@version`, its kind, whether it is actually composed, the project it contributes
and the exact command that would remove it. The framework's own row is marked and carries no command
that would remove the thing rendering the list. Under every command sits the half that is easy to
forget, in both languages:

```
dsh plugin --profile web remove <name>
# The command alone does not take effect: the running dsh still holds the old composition.
# Stop dsh web (Ctrl+C), then start it again.
```

Nothing in this section writes. The commands are shown so a person can run them, because `$DSH_HOME`
is written by `install.ps1` and by nothing else in this project — a button that spawned
`dsh plugin` would be a write nobody reviewed, triggered by a click.

### The browser run, and what its first failure proved

The refusal gate passed (11 / 0), and the first full `--no-write` run came back **152 assertions with
4 failing** — all four in this round's new column, because **the endpoint was not there**: the running
dsh process had been started before this round, so it held the old composition and served the old
client code while the profile's `link:` dependency pointed at the working tree the entire time. That
is precisely the state the command block's own restart note describes — a profile can be perfectly
correct while the process serving it is not — and it arrived as a live demonstration of that note's
necessity, on the first attempt to use the thing it warns about.

**A restart did not clear it**, so the cause is narrower than a stale process, and this entry does not
guess at it: the page (authenticated) still receives the SPA fallback's `not found` for
`/api/ui-projects/installed.json`, so the endpoint is not registered on the running host. Two
candidates remain, and one line in that host's console separates them — either
`installed-package listing mounted at /api/ui-projects/installed.json` (registered: the fault is on
the client side) or `no connection service in this composition` (the row found no `connection`
service, in which case the fix is to declare the dependency so Cordis waits for it rather than
reading it optimistically inside an effect).

Two probes were run, and both are recorded as what they are, because either could be mistaken for
evidence:

- `GET /api/ui-projects/installed.json` unauthenticated answers **401** — and so does a path that
  certainly does not exist. The Host/Origin fence runs **before** routing, so an unauthenticated
  status cannot testify about whether a route exists; only the page's own authenticated request can.
- `GET /plugins/dsh-ui-projects/client.js` answers **404**, which is a false alarm: the shell fetches
  that route in its revisioned combo form. The skin's own assertions passed in the same run, and they
  cannot pass without the bundle — so the 404 says nothing about the bundle at all.

### The browser round found a namespace bug, and the crash was the lucky part

The listing column registered, the endpoint answered — and the column rendered a **blank page**. The
console said `Cannot read properties of undefined (reading 'bundle')`, and the diagnosis went the wrong
way at first for an instructive reason: `bundle` appears **nowhere** in this repository, because it is
not a property name. It is the VALUE of `dependency.kind`, read through a dynamic access —
`t.kinds[dependency.kind]` — on a `t.kinds` that was `undefined`. **Grepping for a literal cannot find a
dynamic property read.** The line the browser pointed at was the one that threw, and the property name
in the error came from the payload.

The real defect was wider than the crash. Sixteen keys were read one level too high: the dictionary
nests this page under `plugins`, exactly as it nests `storage`, `perf` and `tests`, which `panel.js`
reads as `t.storage[...]` and `t.perf[...]`. One of the sixteen was the dynamic read, so it threw; the
other fifteen rendered as **nothing at all**, silently. A green suite beside a blank column would have
been worse than the crash, and the fix is shaped around that.

**Why the suite did not catch it.** The tests built their own `t` fixture by hand — a dictionary that
does not exist — and handed it to a component whose copy lives under `plugins`. Both halves agreed with
each other and neither agreed with the shipped dictionary. Three assertions now make that impossible:
both REAL dictionaries are rendered (with a parity check that every key the component reads exists in
each, and a note listing keys nothing reads yet), a dictionary older than a project kind must show the
raw kind rather than a blank badge, and a source guard fails the suite if `t.<key>` is ever read
directly again — reading the code, not the comment that explains the bug.

**And one more thing the round proved by failing.** The endpoint was missing on the first two browser
attempts because the running host predated the code — the exact state the command block's own restart
note describes. A profile can be perfectly correct while the process serving it is not, and the note was
written before it was needed.
### A limitation, stated rather than hidden

A loader row cannot see, through any service this package can reach, the profile directory it was
composed from. The endpoint therefore scans what the CLI would scan by default — the profile named
`web`, otherwise the only one — and **puts the profile's name in the payload**, so a deployment with
several profiles shows which one is being described instead of guessing silently.

---



**Status: done. `suite` 649 assertions / 0 failing (613 → 649), `host` green, `load` 47 / 0 (40 → 47,
now against the real registry and the real runtime), `conformance` 49 / 0, `skeleton` 13 / 0,
`derive-boot-css --check` unchanged. No browser run: retirement happens only when a package is
unloaded, and no package can be unloaded yet.**

Step 4 of phase 2. Round 32 built a checker that can SEE a broken package; this round makes the
system able to survive one leaving.

### The three bugs, and the one root cause

`service.js` retired a project by re-registering an empty definition with `type: 'retired'`:

1. **`type: 'retired'` is not in the registry's vocabulary** (`PROJECT_TYPES` is
   `['skin','enhancement']`), so `normalize()` threw — inside a Cordis disposer, where `_unload`
   isolates every disposer's error into a `logger.error` line. **Retirement failed silently and
   completely.**
2. Even had it not thrown, `register()` only ever REPLACES: the definition stayed in `projects`, so
   `ids()` listed it, `store.snapshot()` rendered a phantom card for it, and the user saw a project
   whose package was gone.
3. **Nothing deactivated it.** The registry owns no DOM and no context, so an APPLIED project's
   stylesheets, `data-ui-project-*` marker and `data-ui-skin` attribute all outlived the package that
   created them.

**Root cause: a stub stood in for the class it was testing.** The step-2 `load-check` built the
service over a hand-written registry object that accepted anything it was handed — including
`type: 'retired'` — so the check passed while the production path threw. This is the same failure
shape as Round 30's refusal gate: a rule that refuses nothing looks exactly like a rule whose case
never came up. The fix is structural, not a patch: `load-check` now imports the real
`UiProjectRegistry` and constructs the real `UiProjectRuntime` from the built bundle, and asserts in
its own SOURCE that no stub registry has returned.

### The five additions

| Added | What it does |
|---|---|
| `registry.unregister(id)` | removes whatever is registered under an id; refuses an APPLIED id with a TypeError, because deleting the definition of an applied project leaks exactly what it owns. The disposer `register()` returns stays, and stays identity-guarded: a stale copy cannot remove a newer registration |
| `runtime.retire(id)` | `#disable(id, { persist: false })` + `#syncPerfAttribute`. NOT `disable(id)`: that path ends in `#remember()`, which rewrites `enabled` from the current active ids — i.e. it erases the user's choice. Retirement is a package's action, not the user's |
| `runtime.adopt(id)` | applies a project that registered AFTER `start()` restored the record. With projects arriving from separate packages, composition order is not ours to choose, so this is the normal case: without it an enabled project comes back off on every reload |
| `#remember(mutation)` | the record now holds INTENT, not observation. Deriving `enabled` from `activeIds()` dropped every id that is wanted but not currently applicable — a retired project, or one whose `apply` failed — the moment any other project was toggled. `resetOne()` always worked this way; `enable`/`disable` are now in line with it |
| `diagnostics().persistError` | a failed write is recorded, not only logged, and rendered as a banner at the top of the section. GLOBAL on purpose: the record is one document, so blaming a project for a write failure would be a lie about what broke |

### Three problems found in the process, recorded because each was invisible

- **`instanceof` across a realm.** The registry runs inside the suite's vm sandbox, so its
  `TypeError` is the sandbox's constructor and `refused instanceof TypeError` is false. The assertion
  now reads `refused?.name`, which is a string and survives the boundary.
- **A fixture used the wrong context.** A project's `apply` receives the PROJECT context
  (`insertCss(css)`, one argument), and the load-check fixture closed over Cordis's plugin context
  instead — so `insertCss` resolved against Cordis's inject rules and threw. The runtime was right;
  the fixture was wrong. Worth recording because the symptom ("cleanup never ran") pointed at
  retirement, which was innocent.
- **A string replacement is silent when it matches nothing.** The load-check import patch was a
  chained two-step replacement whose second step ran before the first had applied, matched zero
  times, and changed nothing. Every patch after that asserts an exact match count and refuses to
  write otherwise.

### Sabotage

`#remember()` restored to `activeIds()` fails exactly the two intent assertions and nothing else —
643 of 645 still pass, so the check is surgical rather than merely sensitive:

```
FAIL the record is intent, so an id that is wanted but absent survives other toggles
     expected ["gone-package", "other"], got ["other"]
FAIL a project whose apply fails stays in the record, and says so on its card
     expected ["broken"], got []
```

---



**Status: done. `suite` 613 assertions / 0 failing, `host` green, `load` 40 / 0 (now also proving
which Cordis it drove), `conformance` 49 / 0, `check:installed` run against the real profile —
read-only, with the profile directory and `node_modules` byte-identical before and after. No browser
run: nothing in this round is visible in a page.**

Step 3 of phase 2. The loader itself is dsh's; what this round adds is the ability to look at a
profile and say what is in it, whether it is composed, and whether we could run it — before anything
is installed, and without the possibility of writing anything.

### What was added

| File | What it is |
|---|---|
| `src/host/manifest-schema.js` | the one field table for `dsh.uiProject`, its enumerations, and `validateManifest` |
| `src/host/conformance.js` | pure checks: seven problem codes, each naming a field, a value and a fix |
| `src/host/profile-scan.js` | read-only profile scan: dependencies, bundles, in-box bundles, orphans, and the command preview |
| `scripts/check-installed.mjs` | the CLI, including `--candidate` previews and `--json` |
| `scripts/check-installed.test.mjs` | 49 assertions over fixtures, plus two structural guards |

### `patch-file-missing`: we are stricter than the loader, on purpose

The loader's admission predicate checks only that the property exists —
`readProfileManifest(dir).dsh?.bundle?.patch !== void 0`. A package that names a patch file it does
not ship therefore joins the layer stack and fails when the stack is built, which is a boot failure
rather than a package problem. We require the file to exist and to be readable under the package
root. This is contract validation, not sandboxing: a bundle's patch and its `lib/` are executed by
dsh at composition time, and nothing here changes that — what it changes is that "installed and
dead" is reported as such instead of arriving as a GUI that will not start.

### Two facts kept apart, because conflating them is the mistake this exists to avoid

`installed` (in `dependencies`, resolvable under `node_modules`) and `composed` (in
`dsh.profile.bundles` **and** declaring `dsh.bundle.patch`) are different sets, and neither contains
the other: `dsh.profile.bundles` also lists the profile template's in-box bundles, which are not
dependencies — the loader's own words are "in-box bundles from the profile template are not
dependencies and are never touched". The real profile shows both: two in-box bundles, two
dependency bundles.

`orphanedBindings` therefore means something narrower than "in `dependencies` but not in the stack":
it means a dependency that **declares a bundle** and is missing from the stack. A plain library is
not an orphan — the loader itself notes that "a plain library is fine" — and `zod` in a real profile
is the case that would have made the wider definition cry wolf.

### Negative results, recorded

- **A test helper hid nine failures behind one bug.** `uiProjectDsh({ uiProject: { id: 'Bad_Id!' } })`
  spread its overrides LAST, so each "one field is wrong" fixture was really "eight fields are
  missing" — nine assertions failed, all for the same reason, and none of them for the field under
  test. The helper now merges into the well-formed project instead of replacing it.
- **`--list-profiles` listed `profiles/node_modules` as a profile.** Found by running the CLI against
  the real profile, not by any fixture: the predicate was "a directory that is not hidden". It is now
  "a directory with a package.json", which is the definition the rest of the scanner already used.
- **`schemaVersion` was called advisory in step 1, and that was wrong.** `dshVersionHint` is a claim
  about dsh and can be advisory; `schemaVersion` is our own contract version, and a version we do not
  implement means we cannot read the document — including the fields we would drop silently. It is an
  error, and `conformance.js` says why in the code.

### Recorded, not to be forgotten: before step 5

```
步骤 5 前必须核实（否则栏目无法读取宿主清单）
1. @deepseek-ai/dsh-host-webserver 是否给行提供"注册只读路由"的 API
2. 若否：核实 @deepseek-ai/dsh-client-connection 的 `connection` 服务接口面（能否通用请求）
不阻塞步骤 3；两条都未核实前不得开始步骤 5 的栏目 UI。
```

### Verified against the real profile

```
DEPENDENCIES (2)   dsh-cost-meter 1.7.23 bundle composed store
                   dsh-ui-projects 0.1.0 bundle composed link → E:\dsh\plugins\dsh-ui-projects
BUNDLES (4)        @deepseek-ai/dsh-base [in-box] · @deepseek-ai/dsh-web-app [in-box]
                   dsh-cost-meter [dependency] · dsh-ui-projects [dependency]
UI PROJECT PACKAGES (0)   (none — the framework does not declare one yet)
PROBLEMS (0)
PREVIEW            dsh-cost-meter  → remove / update / rollback dsh-cost-meter@1.7.23
                   dsh-ui-projects → remove / update / n/a (a link: dependency has no published version)
```

---



**Status: done. `suite` 613 assertions / 0 failing, `host` green, `load` 32 assertions / 0 failing
against the deployment's own Cordis 4.0.2, `skeleton` check 13 / 0, `derive-boot-css --check` and
the manifest checks green. NOT verified in a browser this round, and deliberately so: the profile
still serves the previous package code, and every browser-visible consequence of this round (one
extra presence row in the served index) appears only after a reinstall, which is the user's to run.**

This is step 2 of phase 2: the structure that lets a UI project live in its own package, plus the
minimal package that proves it. The framework keeps its own project for now; it stops being the
only possible one.

### What was added

| File | What it is |
|---|---|
| `src/host/service.js` | the host-plane service `uiProjectsHost`, and the first-paint contract it owns: the presence announcement, the marker attribute and script, the fragment tag, and "read the settings document at emit time" |
| `src/client/service.js` | the client-plane service `uiProjects`: `register` / `list` / `refusals` / `revision` / `diagnostics` |
| `src/client/boot-presence.js` | what the host plane told this page, and what actually reached it |
| `scripts/bundle-client.mjs` | the client-bundle builder, extracted so a second package can use the same ESM→CJS rules |
| `scripts/derive-manifest.mjs` | `package.json` → `dsh.uiProject` → `src/client/manifest.generated.js`, with `--check` |
| `scripts/load-check.mjs` | both halves mounted on real Cordis roots, with real fibers disposed |
| `../dsh-ui-project-skeleton/` | the smallest complete UI project package — reference and fixture |

### Four findings that changed the design, each from source rather than from reasoning

**1. Caller identity stops at the fiber.** A service method can see who called it — but only its
fiber, whose name is inherited and may be `'root'` — so it carries no package identity and no
version. Hence `register(manifest, definition)`: the manifest is explicit because it is the only
authority there is, and the caller's context is used for lifetime and as a diagnostic.

**2. A plain object provided as a service is NOT wrapped with the caller's context.** The earlier
sketch assumed Cordis wraps every service. It does not: `getTraceable` (utils.ts) returns the value
untouched unless the value itself carries `Symbol.for('cordis.tracker')`, which only `Service`
subclasses and Cordis's own services define. Without that marker `this.ctx` is `undefined`, and the
first `load` run failed exactly there.

**3. The tracker symbol is global by design, so the marker can be declared without importing
Cordis.** `symbols.tracker` is `Symbol.for('cordis.tracker')` — a global-registry symbol, chosen so
that code which cannot import Cordis can still take part. The client service therefore declares
`{ property: 'ctx', noShadow: true }` under that symbol, copied from Cordis's own reflect service,
and `load` proves the effect: disposing the package's fiber withdraws its registration.

**4. Two services, not one, and no precedent to copy.** A full scan of the shipped packages found
**no** service name used in both planes, and the shipped convention for a mirrored concept is two
names (`settings` host / `settingsScope` client). So: `uiProjects` in the browser, `uiProjectsHost`
in Node. The mechanism would have allowed the same name (the isolation key is a symbol minted on
`ctx.root`, so two roots cannot collide) — the convention, the error messages and the future of
same-root tests are what decided it.

### Negative results, recorded

- **A loose assertion passed for the wrong reason.** `load` first selected rows by "mentions
  skeleton" and matched the framework's own first-paint stylesheet, because `tokens.css` binds
  `--dsw-alias-bg-skeleton`. Two of the three initial failures were that, not a real defect. The
  filter now matches the presence row's own shape.
- **`ctx.provide` on a stub context is not optional.** The first `host` run after this change died
  with `ctx.provide is not a function`, because the host row now provides a service. Both stubs
  (and the suite's minimal probe context) had to model it; a context that models less than the row
  touches fails as a boot failure rather than as a test failure.
- **The extraction of `scripts/build.mjs` was verified byte-for-byte before it was trusted.** The
  rebuilt bundle was compared against the previous artefact: identical header, identical loader
  tail, `lib/boot-css.js` hash unchanged, and exactly the two new modules added to the graph.

---



**Status: done. `suite` 609 assertions / 0 failing, `host` green, `browser` 147 assertions / 0
failing — with the refusal gate proved first, and the closing guard confirming the record this run
found was unchanged. Snapshot 45.** Closes the known issue recorded in Round 29.

Two things, both about a claim being broader than the thing that backed it.

## The gate: prove the rule before letting it run

Three runs of this suite deleted a confirmation from a real settings document, because a rule that
refuses nothing looks exactly like a rule whose case never came up — and each fix was "read the source
more carefully, then run again", which meant the next run paid for the mistake. The rule has now been
wrong four times:

| attempt | shape it believed in | what the client sends |
|---|---|---|
| 1 | `{namespace, ops}` at the top level of the body | `{type, rpcId, method, payload}` |
| 2 | `payload.namespace` | `payload.args.…` |
| 3 | `payload.args.namespace` | **`payload.args.ns`** |
| 4 | **`payload.args.ns`** | same — agreed, and the gate said so |

The fourth row is the difference. `--no-write` no longer starts with the rule: it starts with a GATE
that refuses every write to the settings API **without consulting the rule at all** (`blanket` mode is
the default, so a path that forgets to switch is safe rather than dangerous), keeps the bodies it
refused, and only then asks the rule to classify those REAL payloads. A rule that disagrees with what
the client actually sends fails there — with the document untouched, the log showing every body, and
the run stopping before anything that could write:

```
  ok   the refusal rule is proved against real payloads first
         gate  null        carriesProtectedKey=false  ops=[set:enabled(16B)]
         gate  null        carriesProtectedKey=false  ops=[set:initialized(4B)]
         gate  "settings"  carriesProtectedKey=true   ops=[set:settings(58B)]
         gate  null        carriesProtectedKey=false  ops=[set:touched(4B)]
         gate  null        carriesProtectedKey=false  ops=[set:v(1B)]
         note  the gate passed; the refusal rule is now in charge
```

Two triggers, not one (a confirmation writes the `settings` key carrying a record; a withdrawal writes
it without one), because one capture proves one shape. The gate also waits for the write it is about
rather than judging whatever has arrived — its first version reported a rule failure that was really a
timing failure.

`node scripts/browser-verify.mjs <url> --verify-refusal` runs the gate and nothing else, for exactly the
situation this round was written in: a document worth protecting and a rule not yet trusted.

**Residual risk of the gate, stated for whoever reads this next.** A write can only reach the document
if `Fetch.enable` fails to install AND the page happens to write a protected key. The mitigations:
`Fetch.enable`'s failure throws before any navigation, `blanket` is the default mode, and the gate
re-reads the document's `settings` BLOCK afterwards and reports a difference. That last check reads the
block, not one line — `settings: {}` and a populated `settings:` are different numbers of lines, and a
one-line read cannot tell them apart. The gate never writes to the document.

**One self-inflicted change, recorded:** the gate-only run switched the skin off on an instance that
had it on. `--verify-refusal` ends before the phase that reads the starting skin state, so the closing
restore acted on `startedWithSkinOn`'s initial `false` and "put back" a state it had never found. The
restore is now skipped in that mode, and the gate reads the state it is in. Both edits are provably
outside the full suite's path: the added condition is `&& !verifyRefusalOnly`, which is true there, and
the gate's read is overwritten by the phase that owns it.

**What the verification runs found, and why they were stopped.** Both runs were the deliberate
sabotage of the new listener (the listener removed, expecting the calibration to fail — it did, in
both). They disagreed on how many assertions ran: 144 with TWO failures, then 143 with one. Only one
conditional assertion can explain that difference — the one that runs only when the instance already
had a checklist record, and which asserts that the run refused to delete it. So the first run found a
record, tried to assert it had been protected, and FAILED: the removal protection added in Round 28
still does not engage, and the record that was there is gone from `settings.yaml`. The document was
also left with `enabled: []` — the skin switched off — which the suite is supposed to leave as it
found it.

**That was fixed in the same round, and the fix was wrong twice more before it was right.** The rule
was rewritten against the shape read out of the client's own source, checked by a self-check that used
those payloads — and refused nothing again, because the self-check's payloads were written by hand from
a type declaration rather than from a request. Two more runs and the answer came from the one instrument
that could settle it: the run now logs EVERY write it sees, verbatim, and the log said
`namespace=undefined ops=[]` for a body whose envelope was `method=settings/mutate`. The host gateway
requires the payload to be exactly `{args: <object>}` — "Remote payload must contain exactly one
plain-object args field" (`dsh-api-gateway/lib/index.js`) — so the arguments are one level deeper than
the type declarations suggested. Both wrong shapes are now regression cases in the self-check.

The rule now runs offline (`node scripts/browser-verify.mjs --self-check`), refuses every write to
`ui-projects`'s `settings` key and to `ui-theme` wholesale, logs each write it sees in the real shape,
sets a non-zero exit code if a protected write is ever let through, and verifies at the end of a run —
before the page is closed — that the checklist record it found is still there. **The clean browser run
has not happened yet**, and this round must not be snapshotted as done until it does.

Two things, both about a claim being broader than the thing that backed it.

**A project could declare the same test item twice.** The id shape and the label were validated;
uniqueness was not. The consequences were quiet in the way this package spends its time removing: the
card rendered two identical rows, and every part of the system keys a checklist by that id — the tick
map, the stored record, the currency rule — so the two rows shared one tick and the record could not
tell them apart. "Each declared item was read" stopped being a claim anybody could verify. The
uniqueness check is now part of the same loop, refusing with the id and BOTH labels, because a
duplicate is the one mistake an author cannot see from the card.

**The asymmetry with project ids is deliberate and now written down.** A project id that arrives twice
means REPLACE — that is how hot reload works, and `register` is documented that way — so it is
accepted. A test item id that arrives twice inside one definition means the definition contradicts
itself, so it is refused. Refused rather than warned about, and not de-duplicated at render time
either: hiding the second row leaves the definition just as contradictory while making it invisible,
and a render-time fix would not reach the store, which is where the collision actually happens.

**"The skin raises no console or page errors" was listening to two channels out of three.** The suite
collected `Runtime.exceptionThrown` and `Log.entryAdded`, so a page's own `console.error` — how React
reports duplicate list keys, among much else — never reached it. The claim named "console" and the
instrument did not. `Runtime.consoleAPICalled` is now collected too (errors only; the shell logs
informational lines through the same event by design), and that gap is exactly what the uniqueness
rule above removes one source of.

**The collector is calibrated, and the ordering contract is asserted.** A listener that silently
stopped working would leave every run green while proving nothing, so a test at the END of the run
emits `console.error('dsh-ui-projects calibration')` and asserts it arrives. It runs last because
calibrating dirties the channel the console assertion reads — a property that is now a failing
assertion (`consoleAssertionsDone`) rather than a comment, because a comment cannot fail when somebody
adds an assertion below it.

**Doc corrections that came with it.** `checksStateOf`'s comment cited the duplicate-id allowance as
part of its reason for checking per item; that reason is gone, and the per-item test is simply the
correct one. And the checklist test's header still said the version stamp was "the part with teeth",
which Round 29 made incomplete: the claim is about a pair.

**Verification:** `suite` 609 / 0 (+4), `host` green, `derive --check` unchanged, and the browser suite
**147 / 0** with the gate first and the closing guard reporting `the record this run found is unchanged
after it (incomplete)`. The document's `settings` block was byte-for-byte identical before and after
(`settings: { liquid-glass: { checks: { version: 3.0.0, items: {} } } }`); the file's size changed by the
`enabled` line alone, which this flag is designed to let through. Two sabotage runs: the uniqueness
check commented out (the duplicate assertion fails), and the `Runtime.consoleAPICalled` listener
commented out (the calibration fails — seen, in a browser). The README's item rules are now written out
in full rather than implied — the three refusals and why the uniqueness one is stricter than the
project-id rule beside it.

---

## Round 29 — a confirmation is worth what its version AND its checklist are worth

**Status: done. `suite` 605 assertions / 0 failing, `host` green. Snapshot 44.** The browser suite was
not re-run, by agreement: nothing here is reachable through the interface, and its assertions read the
checklist hook as an opaque value they compare start-to-end.

The currency rule compared the version and stopped. Three things went unnoticed, and one of them was
not theoretical — a real settings document was found holding:

```yaml
settings: { liquid-glass: { checks: { version: 3.0.0, items: {} } } }
```

a confirmation with nothing ticked in it, which the card reported as "confirmed for 3.0.0". The other
two: an item added to a checklist without a version bump (the claim silently covers a list it never
saw), and an item removed (which was already handled — see below).

**Changed**

- **The record is a claim about a PAIR.** `checksStateOf` answers `current` only when the version
  matches AND every declared item is ticked; `stale` when the version differs; `incomplete` when the
  checklist does. The old boolean could not express the difference, and a message that names the wrong
  cause is worse than no message.
- **`checksCurrent: boolean` is replaced by `checksState`** rather than joined by it. Two fields
  describing one thing are two fields that can disagree, and the suite asserts the old name is gone.
- **A third sentence**, in both languages: "confirmed for v3.0.0, but the checklist changed since;
  confirm it again." — because the existing sentence asserts a version change that did not happen.
- **The subset test IS the equality test**, and that is why nothing counts. `storedChecks` keeps only
  items that are declared now and were ticked, so the kept set is a subset of the declared set by
  construction; requiring every declared item makes it equal. A count-based check would be weaker: a
  project may declare the same item id twice, and `[a, a]` against `{a: true}` is one tick standing
  for two declarations.

**AN ITEM REMOVED DOES NOT INVALIDATE THE CONFIRMATION, and that is the interesting half.** Everything
still declared was read and holds, so the claim is intact. What makes that true is `storedChecks`'s
filter, so the test asserts both directions: the state stays `current`, AND the removed key never
reaches the snapshot's items. A future "optimisation" that kept every key would fail there rather than
quietly changing what a confirmation means.

**Behaviour change, recorded for readers rather than only for the reviewer who approved it:** the
checklist's tick boxes are now seeded from the record **whenever one exists**, not only while it is
current. The boxes are the reading and the record is the claim; a new version or a changed checklist
invalidates the claim, not the fact that somebody read these items. The visible consequences are that
an out-of-date record shows what was read before, and that the confirm button can already be enabled
when the panel opens — the same reading, one click from being re-recorded.

**Known issue, CLOSED in Round 30.** `registry.js` validated a test item's id shape and its label, but
not that ids were UNIQUE, so a project could declare the same item twice: the card rendered two
identical rows sharing one tick. It was recorded here rather than fixed in this round because it
belongs to registry validation, and it was the reason the currency rule was written per-item rather
than count-based — an argument that has since been replaced by a better one (see `checksStateOf`).

**Verification:** `suite` 605 / 0 (+21), `host` green, `derive --check` unchanged. A sabotage run that
reverted the rule to "version only" failed the added-item assertion and the seeded-document assertion,
and was then restored. **Stated exactly:** the `items: {}` and partially-ticked cases live in the same
test after the added-item one, and this suite's `equal` throws, so they did not individually report a
failure — they exercise the same expression the sabotage broke, and the observed-record case (assertion
7) did fire, which is the shape found on a real machine.

**Three harness traps this round cost time on, recorded so they cost less next time.** A second
`boot()` inside a test moves the module-level registry handle, after which the older harness's
`enable` and `isEnabled` disagree — the seeded-document case is its own test because of it. The harness
mounts no locale service, so every harness renders ENGLISH; copy assertions must read the translate
table for the other language rather than the render. And `render()` draws every registered project, so
any assertion about a card has to be scoped to that card's markup.

---

## Round 28 — every translucent surface, in every mode that removes transparency

**Status: done. `suite` 584 assertions / 0 failing, `host` green, `browser` 142 assertions / 0
failing. Snapshot 42.**

Two branches raised four fills to opaque and stopped, and the fills that matter most were missing: the
floating tier (`--dsw-alias-bg-layer-3`, which ten packages use for menus and dialogs through
`--dsw-specific-menu`), the overlay fill, the module-platform panels twelve packages put text on, and
tooltips. A third branch had the floating tier but not the module platform. The reader who had asked
for less transparency kept seeing it.

**The root cause was not the token list. It was that nothing could have caught it.** `@supports not`
asserted only that `bg-base` went opaque, `prefers-reduced-transparency` had no assertion at all, and
the browser suite emulated neither query. Written first this round, and it failed first:

```
13 surface(s) are still translucent under a mode that removes transparency:
  @supports not ((backdrop-filter: blur(1px)) → --dsw-alias-bg-layer-3, --dsw-alias-bg-overlay,
                                                  --dsw-alias-bg-module-platform, --dsw-alias-tooltip-bg, --lg-glass-bg
  @media (prefers-reduced-transparency: reduce) → the same five
  @media (prefers-contrast: more) → --dsw-alias-bg-module-platform, --dsw-alias-tooltip-bg, --lg-glass-bg
```

**Changed**

- **A structural guard** (`suite`): the expected set is COMPUTED from the skin's own palette — every
  token it declares with an alpha — and the only hand-written parts are two lists with reasons
  attached: surfaces (must be opaque in all four modes) and tints (exempt, because a tint's alpha *is*
  its colour, e.g. `rgb(15 23 42 / 6%)` over a white panel). A new translucent token now forces a
  decision instead of slipping through. It checks both themes per branch, and asserts that the two
  no-transparency branches cover the same tokens — their bodies were byte-identical, which is how one
  omission came to exist twice.
- **Eight surfaces taken opaque** in `@supports not` and `prefers-reduced-transparency`, three in
  `prefers-contrast: more`, and the same eight in `forced-colors` (below). Every value is derived
  rather than invented: `layer-3`/`overlay` re-use the contrast branch's own pair, `module-platform`
  shares layer-2's translucency so it takes layer-2's opaque form, `tooltip-bg` is its own colour with
  the alpha removed.
- **The material fill moved from a component rule to the token.** `--lg-glass-bg` is taken opaque in
  all four branches and the four `[data-composer-card] { background: … }` patches are deleted: they
  were a component rule standing in for a token the token layer had not handled, and raising it means
  `.lg-glass` and anything else reading the material follows too.
- A `tokens.css` comment describing the retired opacity slider and its `--lg-material-swap`
  multiplication is gone. That token appeared nowhere else in the source: the prose outlived the
  mechanism and described it as though it were live.

**The forced-colors correction, and the measurement that forced it.** The plan said this mode needs no
token work because the platform replaces author background colours — which it does. The browser suite
now measures that instead of assuming it, and the measurement said something else as well:

```
probe: { background: "rgb(0, 0, 0)", color: "rgb(255, 255, 255)" }   ← author colours replaced
probe at rgba(1, 2, 3, 0.52): "rgba(0, 0, 0, 0.52)"                  ← author ALPHA kept
settings panel: "rgba(0, 0, 0, 0.52)"    composer card: "rgba(0, 0, 0, 0.52)"
```

The platform replaces the colour and keeps the alpha, so a translucent fill stays translucent here
too — the card was reporting its own 52%. The fills are therefore taken opaque in this branch as well
and the guard's branch list grew from three to four. Two earlier attempts at this measurement were
spent on a wrong element: the first `[role="dialog"]` in the document is not the settings panel, and
the failure message named no element. Every message now carries the raw readings and a calibration.

**A run deleted a confirmation, and the rule meant to prevent it was silently wrong.** `--no-write`
refused writes whose payload text contained `checks`. The card's reset writes the record with the
project's settings deleted — no `checks` anywhere — and the removal protection added to catch that
looked for a `settings` property on the request body. The real operation is `settings/mutate` with
`[namespace, ops]` arguments and each op shaped `{op: 'set', path: […], value: …}`, so the rule matched
nothing and the run removed an existing record. The decision is now a pure function keyed on the path,
checked against payloads in the real shape without a browser, and the checklist assertion compares the
post-reload state with the state the run INHERITED rather than with `false` — on an instance that had a
record, the old form read that record as proof this run had written one.

**Also fixed in passing:** the withdrawal check clicked the card's reset while the previous action's
write was still pending, and a disabled button drops a click without a trace — the same lesson as the
switch, missed in code written after it was learned.

**Verification:** `suite` 584 / 0, `host` green, `browser` 142 / 0 with the composer, the settings
panel and the calibration measured in a real Chrome under both queries, `derive --check` agreeing with
the file on disk. **Cost, recorded rather than discovered:** the first-paint sheet grew from 8216 B to
10484 B (+2268 B, 11 → 13 blocks) and every byte is inlined into every page load, for tokens no
first-frame element consumes. That is what a structural derive tool costs; a necessity-based one
("only the tokens a first-frame element reads") would be a different change.

---

## Round 27 — the composer gets the frame material

**Status: done. `suite` 558 assertions / 0 failing, `host` green, `browser` 122 assertions / 0
failing. `settings.yaml`'s `ui-projects` record byte-identical after the run. Snapshot 41.**

The composer was the last opaque surface in the application. This is a specification gap rather than
a defect — the specification names floating surfaces (dialog, menu, listbox, tooltip) and the
composer is none of those — but it left the one element the reader types into painting `#fff` /
`#2c2c2e` on top of the frame's frost.

**Changed**

- `[data-composer-card]` takes the material: `--lg-glass-bg`, `--lg-glass-radius` (22px, exactly the
  radius the shipped card already used), and `box-shadow: var(--dsw-elevation-stroke),
  var(--lg-glass-shadow), var(--lg-glass-inner-highlight)` — the shipped ring kept, the shipped glow
  replaced rather than stacked.
- Its frost lives on `[data-composer-card]::before` with `z-index: -1`, and the card carries
  `isolation: isolate` to give that layer a stacking context to land in.
- The composer's frost is added to **every** degradation list: medium tier, low tier, the mobile
  query, and all four suppression branches (`@supports not`, `prefers-reduced-transparency`,
  `forced-colors`, `prefers-contrast: more`). Under the four suppression branches the card's fill
  goes opaque with every other one.

**Three decisions worth recording**

1. **The blur is on a pseudo-element, not on the card.** The card is already `position: relative`, so
   it is already the containing block for its positioned descendants, and it has no `fixed`
   descendant — every popover in its neighbourhood is portalled to `document.body` (verified in the
   deployed bundles: the model menu, four stat dialogs, the attachment overlay and lightbox). So the
   containing-block rule would have nothing to act on *today*; the pseudo-element is there for
   tomorrow, so that a future client rendering a popover inside the composer cannot be captured by
   it. `suite` asserts the absence of `backdrop-filter` on the card, and a sabotage run that moved it
   there failed exactly that assertion.
2. **The shared fill token is not rebound.** `--dsw-specific-input-major` paints approval cards, the
   question card, four attachment surfaces and a chat element as well as the composer. Rebinding it is
   the obvious way to make the composer translucent and the wrong one. `suite` asserts the skin never
   declares it, and a sabotage run that did failed that assertion.
3. **The seat's fade is left alone — after trying the opposite.** The shipped rule ramps to
   `var(--dsw-alias-bg-base)` over 36px and then HOLDS that colour for the rest of the seat, which is
   invisible only while the token matches the page around it; this skin makes it transparent, so the
   ramp is inert. Restating it with the glass fill was written, built, and **seen in a screenshot of
   the running application**: a glass-tinted rectangle spanning the column below the card, with a hard
   edge where the seat ends (and in the hero phase the seat does not reach the bottom of the viewport,
   so that edge is in the middle of the page). It was reverted, and `suite` now asserts that the skin
   declares nothing at all about the seat, with the reason attached. A fade that dissolves content
   rather than painting a fill is a `mask-image` on the scroller — a different change, not this one.

**Also fixed, found by the run crashing.** `--no-write`'s Fetch handler answered paused requests with
fire-and-forget sends. CDP discards a paused request when the page navigates away from it, answering
one then fails with `Invalid InterceptionId`, and an unhandled rejection does not fail an assertion —
it aborts the whole run. The first full run of this round was green through the mobile check and then
died with no verdict at all. Now the race is caught and ignored, and anything else is recorded in the
console assertions instead of vanishing.

**Found by reading the emitted sheet rather than from memory, twice.** The mobile block
(`max-width: 768px`) was not in the plan — it was noticed while inspecting the built CSS, and it
would have left the composer at the desktop radius on a phone. And `forced-colors` made the four
suppression branches, not three.

**Negative results.** The seat fade (above). And a stale build: the first run of the new assertions
failed on the mobile clause because the bundle had not been rebuilt — which is also the proof that
the clause bites.

**Verification:** `suite` 558 / 0, `host` green, `browser` 122 / 0 with the composer measured in a
real Chrome — the fill changes and is translucent, the blur is on the pseudo-element at 20px, the card
carries no `backdrop-filter`, and the frost steps down to 16px on a phone and 12px on a two-core
device. Two sabotage runs, each failing exactly its own assertion. The material was also judged by
eye: `E:\dsh\.shots\glass-closed.png` (light, dialog closed) shows the card reading as glass over the
page background, with the band from the reverted seat rule visibly gone.
**Not measured end to end:** the composer's fill in dark mode. It is covered by construction — the
card's rule is asserted, the dark token rebinding is asserted, and the dark branch is asserted to be
in force — but no assertion reads the card's computed fill with `data-ds-dark-theme` set, so that
combination rests on the pieces rather than on a measurement of its own.

**One observation, not attributable.** `ui-theme.preference` changed from `dark` to `light` during
this round. The successful run's first screenshot (22:28:33) is already light and the settings write
is at 22:28:40, so the change happened before that run's theme phases — it was not the dark phase of
that run. The suite does drive the same attribute the shipped theme plugin persists, so a run remains
a plausible cause in general; it is recorded rather than explained away, and the timing here does not
implicate this run.

---

## Round 26 — withdrawing a recorded verification

**Status: done. `suite` 517 assertions / 0 failing, `host` green, `browser` 108 assertions / 0
failing. `settings.yaml` byte-identical after the run. Snapshot 40.**

A confirmation could be made and never taken back. The only way to remove one was to reset the whole
project, which also discarded its settings — a destructive action to undo a small mistake, and the
last behavioural item left on step 1's specification.

**Changed**

- **The card's reset clears the project's stored options**, not just its enabled state. "Reset Liquid
  Glass to its default" that leaves "confirmed for 3.0.0" on the card is a partial reset wearing the
  name of a complete one.
- **`Restore default UI` clears every project's options.** Its docstring has always said it forgets
  every user choice while the code kept `settings`; the discrepancy was invisible only because
  `settings` held nothing but confirmations.
- **A `Withdraw confirmation` button** in the checklist, shown only when there is a record to
  withdraw. Separate from the reset on purpose: retracting a claim should not also cost a
  configuration.
- Copy in both languages, and the checklist's ticks clear with the record.

**Three decisions worth recording**

1. **Withdrawal is owned by the RUNTIME, not by the project context.** `confirmChecks` writes through
   the project's context, which exists only while the project is applied — and `settingsFor` reads a
   confirmation with the project switched off, by design, so a card can say "confirmed for 3.0.0"
   while the skin is off. Reading it there and being unable to withdraw it there is an asymmetry that
   would have shown up as a button doing nothing in exactly the state where a stale confirmation is
   most likely to be sitting there. `clearChecks` is a runtime method for that reason, and a sabotage
   run that routed it back through the context failed the assertion written for it.
2. **The key is deleted, not emptied.** An empty object survives every `=== undefined` check in the
   codebase, so "cleared" and "never confirmed" would have become two states that read the same in
   some places and differently in others. `#applySettings` now drops a project's entry when the last
   key leaves it, which also makes `settingsFor(id)` mean the same thing as "no settings".
3. **The ticks go with the record.** They are seeded from the stored confirmation, so withdrawing it
   would otherwise leave a fully ticked checklist beside no record at all — indistinguishable from
   the reading that was just retracted, one click from being recorded again.

**Also asserted, because nothing did.** Both languages now have to carry exactly the same copy, key
by key, including the nested groups. Nothing checked this before, and the failure mode is one-sided
and silent: a key missing from `zh` renders English inside a Chinese interface while every assertion
written against the English copy keeps passing. A sabotage run that deleted `zh.tests.withdraw` failed
the check with the exact path.

**Verification:** `suite` 517 / 0 (+18: withdrawal, the off-state path, `resetAll`, the parity table,
and the button's presence-when-present), `host` green, `browser` 108 / 0 with a new check that ticks,
confirms, presses the card's reset, and asserts the record, the withdrawal offer and the ticks are all
gone — and that the skin went back to its shipped default, which for this skin is OFF. Three sabotage
runs: clearing routed through the context, `resetAll` keeping settings, and the missing `zh` key. Each
failed exactly the assertion written for it and nothing else. `settings.yaml` unchanged byte for byte.

---

## Round 25 — the browser suite runs green, and what it had really been measuring

**Status: done. `suite` 499 assertions / 0 failing, `host` green, `browser` 99 assertions / 0
failing — the first fully green run of the browser suite. `settings.yaml` byte-identical before and
after. Snapshot 38.**

The browser suite had never once been run to completion. Running it turned up a real bug in the skin,
a real bug in the build tooling, and six assertions that were describing the harness rather than the
product. The distinction is the point of this round: a failing check is not evidence about the skin
until that check is known to be able to pass, and three of these could not.

**A real skin bug, in three branches at once.** The gradient suppressions were written as
`body { background-image: none }`, while the gradient itself is painted by
`body[data-ds-dark-theme] { background-image: … }` — one attribute more specific. A media query adds
no specificity of its own, so the suppression won in light mode (where the gradient rule is a plain
`body` that comes earlier) and lost in dark mode, silently. `prefers-contrast: more`,
`forced-colors: active` and `prefers-reduced-transparency: reduce` were all affected: the readers who
had asked for the decoration to stop were the only ones still getting it. Fixed by naming both
selectors in all three branches — no `!important`, no specificity fight, just the selector the themed
rule actually uses.

It was found only because the contrast check now measures BOTH themes. It used to measure whichever
theme the machine happened to be in, which is how a dark-mode-only failure survives a light-mode run.

**A real bug in the tooling, and the reason nothing caught it.** `tools/derive-boot-css.mjs` skipped
any prelude containing a comma, so writing the suppression as `body, body[data-ds-dark-theme]` — the
only form that works — removed all three rules from the first-paint sheet (11 blocks → 8) with
nothing failing: the build's subset check cannot see a rule that is missing, and its completeness
check used a *second copy* of the same predicate, blind in the same place. Two copies of a rule catch
only the mistakes one of them does not make.

Two more defects were in that predicate and are now impossible: the remainder after the marker was
trimmed before its first character was inspected, so `body[marker] [role='menu']` — a descendant, the
space being the combinator — was accepted as a body-level rule; and `:where(a, b, c)` is ONE selector
containing commas, which a naive split tears into fragments that classify as anything.

The predicate now lives in one place, `scripts/boot-css-rules.mjs`, imported by both the build and
the tool. It answers `body` / `other` / `mixed`, and `mixed` throws at both call sites rather than
being mistaken for `other`: a sheet that quietly omits half a rule looks complete and is not.

**Six assertions that were measuring the harness.**

1. **The command line.** The page URL was `argv[2]`, so `--no-write` alone became the "page URL",
   Chrome launched, every navigation failed, and the suite reported **fifteen skin failures** that
   were one bad argument. The URL is now identified by its shape (`http(s)://`), and a missing one
   exits 2 with usage *before* Chrome starts.
2. **The first frame.** The proof was "the shell's boot page is still in place". The served HTML is
   `<div id="root"></div>` with nothing inside it, and the boot element is created by the RENDERER's
   bundle — a different request, untouched by the block — so the assertion was false on every run,
   including the runs where the skin assertions behind it never executed. It now asserts what the
   block can actually establish: zero `style[id^="dsh-ui-projects"]` and zero `[data-ui-skin-column]`,
   which this client bundle and nothing else creates.
3. **The tier.** `equal(tier, 'high')` was written into the check, so a four-core machine would have
   failed a correct page. The expectation is now derived from the reported core count, and the frost
   is asserted against the radius of whichever tier was resolved — which also means the attribute and
   the stylesheet cannot drift apart.
4. **The checklist.** The confirm button was found by its English label on a Chinese interface: the
   button was absent, the assertion read `null`, and it looked like the checklist refusing to render.
   The component now publishes `data-uip-action="confirm-checks"` and
   `data-uip-checks[-version]`, the browser assertions read state instead of copy, and `suite` asserts
   the hooks exist so a rename cannot silently unhook every browser assertion at once.
5. **The contrast branch.** Two problems. The expected fill was the light one while the page was
   dark. And the branch assertion searched the whole sheet, so breaking one branch left the other two
   answering for it — found by sabotaging one branch on purpose and watching nothing happen. It now
   runs both themes, checks the theme held before trusting any number, searches each branch's own
   block, and allows a stated tolerance for the instrument's own resolution (the single darkest and
   lightest pixel of an 8-bit PNG, whose extremes are antialiased glyph edges).
6. **The accent.** `equal(--lg-accent, '#4d6bfe')` — but `#4d6bfe` is the SHELL's brand colour
   (`--dsw-alias-brand-primary`, confirmed in the deployed bundle) while `--lg-accent` is the skin's
   own, `#007aff`. The check measured one token and expected another. Both halves are now asserted:
   the skin's token reaches the page, and the shipped brand colour is unchanged — a skin is a
   material, not a re-brand.

**The toggle cascade, explained.** `setSkin` clicked a switch that was still `disabled` from the
previous write — the marker clears as soon as the change is applied, while the settings write is
still in flight — and a click on a disabled button is dropped without a trace. The first diagnostic
read the switch's state thirty seconds later, by which time it looked perfectly healthy, which is how
a run was spent on an explanation the instrument could not have confirmed either way. The click now
waits for the control to accept input and reports how long it waited. **This was never a product
bug**: a panel that refuses input while it persists the previous one is behaving correctly.

**Negative results, kept because they eliminate hypotheses.** "The pending flag is stuck" — disproven:
the switch was disabled at click time and enabled 150 ms later. "Blocking the combo URL kills the
application" — disproven: this plugin's bundle is its own request, `/plugins/??dsh-ui-projects/client.js`.
"`#staleBootPage()` is dead code" — disproven: the renderer bundle does contain `dsh-boot`.

**One side effect that cannot be attributed.** `ui-theme.preference` is `dark`; earlier in the session
it was `light`. The dark phase drives the same `data-ds-dark-theme` attribute the shipped theme plugin
persists, so a suite run is a plausible cause — but the interface was also in use by hand, and the
change cannot be traced to either. Recorded rather than explained away. Related: `mtime` on
`settings.yaml` is not evidence of anything, because the host rewrites the file with identical
content; only the hash distinguishes a rewrite from a change.

**Verification:** `suite` 499 / 0 (+21 assertions: the predicate table, the per-branch sheet shape,
the checklist hooks), `host` green, `browser` 99 / 0 in a real Chrome over CDP, `derive --check`
agreeing with the file on disk. Two sabotages were run to prove the new assertions bite: removing the
descendant check from the predicate, and rewriting one suppression branch back to a bare `body`. Both
failed the intended assertion and nothing else — and the first attempt at the second one proved the
opposite, because the sheet-wide search was still satisfied by the two branches left intact.
`settings.yaml` was byte-identical after the run (same sha256), with `--no-write` holding the
checklist confirmation out of it.

---

## Round 24 — a write the browser suite can refuse, and a notification that was missing

**Status: done. `suite` 478 assertions / 0 failing, `host` green. Both browser checks still await a
debug port.**

**A real bug, found by writing a check rather than by reading code.** The browser check for Round 23
waits for the card to say "Confirmed for v…" after the button is clicked. Reasoning about whether
that text would ever appear turned up the answer: it would not.

`writeSetting` updates the runtime's settings map and then persists — but it never told the registry,
and the panel renders from a snapshot taken when the registry last changed. A setting is not a
registry change, so the card kept whatever it had when it was last drawn. Nothing caught this because
the only control that writes a setting was the retired opacity slider, whose value the browser's own
input element keeps in step; a confirmation has nothing to keep it in step, so it would simply never
appear. Fixed with one line (`registry.notify()`), and the fix notifies even when persistence FAILS,
because the in-memory value is what the panel draws and it has already changed by then.

The regression test asserts the notification on the subscription rather than on a render, and that
distinction is the whole point: `render()` takes a fresh snapshot and would pass either way, which is
precisely how the gap survived Round 23. Verified by sabotage — removing the line makes the new
assertion fail, restoring it makes the suite green with the file byte-identical.

**`--no-write`.** Round 23's browser check records a real confirmation in the settings document of
whatever instance it is pointed at, overwriting a hand-made one and accumulating on every re-run. The
flag refuses that write in flight.

The approach worth recording is what made it possible: the write path is **HTTP**, not a websocket —
every api call is `POST /api/<service>/<operation>`, so the operation is in the URL and the payload is
in the body, and CDP's `Fetch` domain can pause and refuse exactly one of them. Two consequences
follow from that. The refusal is narrowed to mutations whose payload carries `checks`, because the
rest of the suite depends on real persistence — a skin toggle that did not survive a reload would fail
the test that checks it. And the run asserts that something WAS refused: a URL pattern that matched
nothing would leave the test passing while quietly writing.

Both modes now assert the confirmation appears (the in-memory half), and they differ in what the
reload shows — which is a stronger pair of checks than either mode alone: one proves the durable path
works, the other proves the flag works.

**Verification:** `suite` (+1 assertion, the notification, with a sabotage run proving it bites),
`host` unchanged, `browser-verify.mjs` syntax-checked. Neither browser check has been run.

---

## Round 23 — step 6, unit D: the verification checklist

**Status: done. `suite` 477 assertions / 0 failing, `host` green. The browser check is written and
**not yet run**; it is on the suspended list. Step 6 is complete with this round.**

**Changed**

- `testItems: [{ id, label }]` on a project definition, validated like every other list: an item
  without an id cannot be stored, an item without a label is a checkbox nobody can read, and both
  would have surfaced as a control that silently does nothing.
- The panel renders it as a native `<details>` with the boxes inside and a **Mark as passed** button
  that refuses until every box is ticked.
- Confirming writes `{ version, items }` into the project's own settings record, through the same
  per-project storage every other option uses — no new namespace, no schema change.
- The shipped skin declares three items, drawn from the failures it actually had reported back:
  readable text, a centred settings dialog, and no first-frame flash.

**Three decisions worth recording**

1. **The version travels INSIDE the confirmation record**, rather than as a second key beside it.
   The shape the plan sketched (`checks = {itemId: true}` plus a `checksVersion`) would take two
   writes, leaving a window where a reader sees a new version's stamp over an old version's ticks.
   One key cannot disagree with itself, and there is one thing to keep in step instead of two.
2. **An invalidated confirmation is reported, not deleted.** Shipping a new version means the thing
   the checklist verified has changed, so the old confirmation is a claim about code that no longer
   exists — but "confirmed for 1.0.0, needs confirming again" tells a reader something an empty
   checkbox cannot.
3. **Confirming requires the project to be applied.** `contextFor` hands out a read/write context
   only for an active project, and that is not a limitation here but the point: a checklist is
   confirmed by looking at the running thing. Reading a confirmation is different from making one,
   so `runtime.settingsFor(id)` was added: a card can say "confirmed for 3.0.0" while the project is
   switched off.

**A test that had to be fixed rather than a feature.** The negative assertion — that a project with
no items renders no disclosure — was written against the shipped skin, and stopped being true the
moment the skin declared its own checklist. The assertion was right about the rule and wrong about
its subject, so the test now registers a project with no items and keeps both halves.

**Verification:** `suite` (+20 assertions: validation of three malformed item shapes, the rendered
disclosure and its copy, the absent disclosure for a project without items, the recorded
`{version, items}` shape, invalidation across a version change with the old record still reported,
and that an undeclared item id cannot be smuggled into the record). `host` unchanged. The new
browser check drives the checklist as a person does — open it, tick every box, watch the button
become available, click it, reload, and find the confirmation still there — and it is executable
because the shipped skin now has a checklist to drive. **It writes to the durable settings
document**, so a run leaves a confirmation recorded against the current version; that is honest (a
test did look at it) but it is a real change to the profile the suite points at.

---

## Round 22 — step 6, unit C: more contrast, and a two-way first-paint guard

**Status: done. `suite` 457 assertions / 0 failing, `host` green. The browser check is written and
**not yet run**; it is on the suspended list.**

**Changed**

- `tokens.css` gains `@media (prefers-contrast: more)`: every page fill goes opaque, the floating
  tier follows, and the hairlines get real weight (light `12% → 34%`, dark `12% → 38%`).
- `glass.css` answers the same query: the ambient gradient goes, and so does the blur.
- `boot.css` re-derived — 9 blocks → 11, 7039 B → 8033 B. The new branch is body-level, so the
  first frame has to carry it too.
- **`build.mjs` now checks the first-paint sheet in BOTH directions.**

**Three things worth recording**

1. **`prefers-contrast` is not `forced-colors`, and not `reduced-transparency`.** Forced-colors
   hands the palette to the platform and the skin steps back entirely. Reduced-transparency is
   about seeing through things. This one keeps the palette and asks for more separation *within*
   it — which for a glass surface means removing the two things that eat contrast: a translucent
   fill, and a hairline too faint to say where one surface ends and the next begins. The text
   colours are not touched, and cannot be: this project never redefines a label token, because the
   design system validated every pair it ships. Raising the background is the only lever that
   raises the ratio without inventing a new colour relationship.
2. **The blur is dropped here, and the reason is not punishment.** With opaque fills there is
   nothing behind the glass left to refract, so keeping a full-viewport `backdrop-filter` would cost
   the GPU for no visible effect. The layer becomes redundant, not forbidden.
3. **THE GUARD WAS ONE-DIRECTIONAL, AND NOW IS NOT.** Round 17's check proved `boot.css` ⊆ the
   skin's emitted CSS. It could not see the failure that matters most in practice: add a body-level
   rule to the skin, forget to re-derive, and the build passes while the first frame silently lacks
   it. Verified by doing exactly that — the new contrast branch made the build fail with *"missing
   3 body-level rule(s) the skin declares"* before `boot.css` was re-derived, and pass after. Subset
   says "boot.css claims nothing the skin does not"; completeness says "boot.css claims everything
   the skin has". Together they make it exactly the skin's body-level rules, which is what the
   file's header has claimed since it was written.

**Verification:** `suite` (+9 assertions: both sheets answering the query — asserted as a COUNT of
two, because `background-image: none` and `backdrop-filter: none` already appear in the other
branches and would have made a bare `contains` pass whether or not this branch existed — plus the
values unique to it, the label tokens still untouched, and the branch present in the first-paint
sheet). `host` unchanged. The new browser check presents `prefers-contrast: more` through
`Emulation.setEmulatedMedia` and asserts both halves: the deterministic one (fill opaque, gradient
gone, hairline heavier, skin still applied) and the measured one (the painted text spread did not
narrow). It restores the emulation in a `finally`, which is load-bearing rather than tidy: under
this query the skin drops its frost, so leaving it on would make the tier check that follows
measure a blur that is deliberately absent.

---

## Round 21 — step 6, unit B/2: regions, conflicts and blur nesting

**Status: done. `suite` 440 assertions / 0 failing, `host` green. No browser check: the two-project
case needs a second shipped project, and inventing one to satisfy a test would be inventing data.**

**Changed**

- `PROJECT_REGIONS`: eight names — `sidebar`, `center`, `rightbar`, `overlay`, `composer`, `dialogs`,
  `tokens`, `background` — each documented with the DOM hook it refers to. A vocabulary rather than
  free text, because it is only useful if two projects can be compared: `['composer']` and
  `['input area']` describe one thing and would never collide.
- `modifies` on a project definition, validated against the vocabulary. A misspelling would
  otherwise silently never conflict with anything, so the project would look checked when it was not.
- `registry.regionConflicts()`: pairs of active enhancements whose regions overlap.
- `runtime` retains the scoped CSS each project inserted, and answers `declaresFilter(id)`.
- `src/client/css-filter.js`: pure string analysis — `declaresBackdropFilter`, `filteredSelectors`.
  Its own module because two places need the answer (the settings page escalates a conflict to a
  nesting warning; the diagnostics overlay looks for a real chain of layers) and the settings page
  must not depend on a debug instrument.
- `diagnostics.js` gains a bounded DOM scan behind the debug switch: the candidate set is the
  layout frame, its columns, the right column, the overlay layer, the composer card and the
  ARIA-role surfaces; each is read for a `backdrop-filter` on itself **and on its `::before`**, then
  walked up twelve levels to find a filtered ancestor. Cached by the registry's revision, because the
  overlay repaints four times a second and the scan is the most expensive thing in the file.

**THREE DECISIONS WORTH RECORDING**

1. **Skins do not participate in conflict warnings.** The specification asks for the warning
   between enhancements; a skin is alone by policy. The shipped skin declares a broad footprint, so
   including it would make every enhancement conflict with it — and a warning that is always present
   is wallpaper. Its declaration still feeds the nesting analysis.
2. **A nesting takes BOTH projects to blur**, not "at least one" as the plan said. A nesting means a
   filtered element inside another filtered element; one filter alone has nothing to nest in. The
   approved wording would have reported a risk that cannot exist, so it is corrected here.
3. **The blur is read from CSS text, not from the DOM.** The skin's frost lives on a `::before`
   pseudo-element: `querySelectorAll` cannot return it and an ancestor walk cannot pass through it,
   so a DOM-only answer would miss the one layer this package knows most about. The DOM scan
   confirms what the text predicts; the two are reported side by side.

**Verification:** `suite` (+28 assertions: detection between enhancements, the skin exclusion, the
advisory-only guarantee, region validation, `declaresBackdropFilter` against real stylesheet text
including `none`, a commented-out rule and a conditional, the two-blur escalation and its
one-blur negative, and both panel surfaces rendering the region names in the reader's language).
`host` unchanged.

---

## Round 20 — step 6, unit B/1: execution order

**Status: done. `suite` 412 assertions / 0 failing, `host` green. No browser check: this is
invisible to a browser suite (see below).**

Split out of the planned unit B because ordering is a *timing* problem and region conflicts are a
*metadata* problem; the two share only `normalize()`. This half fixes an existing defect.

**Changed**

- `priority` on a project definition: integer, default `100`, **lower runs first**, validated the way
  `perfLevel` is — a non-integer throws at registration, because the sort is the contract and a
  fractional priority would make two projects' relative order depend on float comparison.
- `registry.canonicalOrder(ids)`: sort by `(priority, registration index)`, stable.
- `runtime.start()` and `resetAll()` apply the canonical order. **This is the defect:** the restore
  path used to iterate `record.enabled`, which `#remember()` writes as `activeIds()` — a sorted
  array — so the real order was alphabetical by id. Renaming a project silently changed when it ran.
- `requires` still wins over `priority`: a dependency is applied before its dependent regardless of
  the numbers. Ordering is a request; dependency order is correctness.
- `runtime.appliedOrder` records what was actually applied, and `outOfOrderId()` names the first
  project running earlier than priority says it should. A click deliberately does not re-order — it
  would flicker — so without this the promise "the order is restored on the next load" would be
  unverifiable. The card for that project says so instead.
- **Deleted `snapshot.conflicts`.** It held the active skin ids, nothing read it (the panel derives
  its "will replace X" line from the project list it already has), and a second silently unread
  notion of "conflict" is what makes the real one hard to trust.

**THE FINDING: an assertion that had been passing vacuously.** Writing the ordering test needed a
seeded `localStorage` record, so it copied the key from the sweep test next door —
`dsh.ui.projects.v1`. It read nothing. The real key is `dsh.ui-projects.v1`: **one character, a
hyphen against a dot**, and the two literals are indistinguishable at a glance. That revealed the
original: the sweep test asserts "while the key this plugin does use is untouched" against the same
wrong literal, so for as long as it has existed it has proved that the plugin does not touch a key
the plugin has never read. The assertion was not wrong about the sweep — the legacy-key half is
real — it was wrong about what it was checking, under a label that said otherwise.

Fixed structurally rather than by correcting the typo: `plugin.__internals.persistKeys` now exposes
`localKey` and `settingsNamespace` from the module that owns them, and both tests read the real
value. The next rename cannot silently orphan them.

**Found by a failing test, not by review** — and only because the new test's own premise was
checked rather than assumed. The debugging path is worth recording: the storage object was verified
to be the right one, the key was verified present at adapter creation, and `getItem` still returned
`null`; only comparing the literals byte by byte showed why.

**Verification:** `suite` (+18 assertions). The ordering tests register projects in a deliberately
scrambled order with priorities `10/100/200`, seed the record in yet another order, and compare the
**recorded apply sequence** against the canonical one; ties are pinned against alphabetical order
(`zulu` before `alpha`); `requires` is pinned against a `priority: 1` dependent. `host` unchanged.

---

## Round 19 — step 6, unit A: the effect tier

**Status: done. `suite` 394 assertions / 0 failing, `host` green. The browser check is written but
not yet run.**

Specification §7.1 asks every project to declare a performance level, and §7.2 asks for a low-end
device to get a cheaper treatment. Those two connect only through something a stylesheet can read,
so the work was: a declared tier, a device estimate, and one attribute between them.

**Changed**

- `perfLevel: 'low'|'medium'|'high'` on a project definition, defaulting to `medium` and **validated
  the way `type` is** — an unknown tier throws at registration. Deliberately not the way `scope` is:
  `scope` is accepted as-is, so a typo there is invisible, and a `perfLevel` typo would be worse than
  invisible, because the ranking treats unknown tiers as `medium`. A project asking for `low` and
  spelling it `Low` would silently be given a heavier treatment than it declared.
- `src/client/perf.js`, the device half: `saveData` (a statement of intent, and the strongest signal
  available), core count as a weak demoter, and an optional frame-time probe. `deviceMemory` is
  deliberately NOT consulted — Chromium-only and capped, so using it would classify Firefox and
  Safari by the absence of an API rather than by their hardware.
- `data-ui-perf` carrying the heaviest declared demand among active projects, capped by the device
  class, and removed when the last project goes off.
- `glass.css` gains `--lg-glass-blur-medium: 16px` / `--lg-glass-blur-low: 12px` and the two blocks
  that read the attribute. `boot.css` was re-derived: the new tokens are body-level declarations,
  and a first frame has to agree with every later frame.

**THE ATTRIBUTE GOES ON THE BODY, NOT ON `<html>` — a correction to the plan, and the mechanism
behind it.** The plan said `html[data-ui-perf]`. The scoper REPLACES a leading `html`/`:root` with
the project marker (`scope-css.js`, `scopeCompound`), and the marker is
`body[data-ui-project-…="on"]`. So a degradation rule authored as `html[data-ui-perf='low'] …`
compiles to `body[data-ui-project-…="on"][data-ui-perf='low'] …` — and matches only if the runtime
wrote the attribute on the body. On `<html>`, every such rule would have matched nothing, silently:
the failure this package has now paid for three times (the dead dark branch, the dead
`overflow: clip`, the dead ambient seat). The rules are authored as `body[data-ui-perf='…']` so the
selector states where the attribute actually lives.

**Tooling:** `tools/derive-boot-css.mjs` is now a permanent tool rather than the throwaway Round 17
used and deleted — it derives `src/host/boot.css` from the scoped skin CSS, with a `--check` mode.
Round 17 needed it once; every body-level change needs it again, which is what makes it a tool.

**A guard gap noticed here and fixed in unit C.** The build proves `boot.css` is a SUBSET of the
skin's emitted CSS — one direction only. Adding a body-level rule to `tokens.css` and forgetting to
re-derive would pass the build while the first frame silently lacked the rule. Unit C turns that
check into equality.

**Verification:** `suite` (+30 assertions: the pure policy functions with their boundaries, the
attribute appearing on the body and leaving with the last project, the demotion reaching the card,
and a mis-cased tier failing registration), `host` unchanged and green. The new
`browser-verify.mjs` check forces `hardwareConcurrency` to 2 with
`Emulation.setHardwareConcurrencyOverride` before load, then asserts the attribute AND the resolved
`backdrop-filter` (12px, and 20px once the override is lifted) — **not yet run.**

---

## Round 18 — two absolute claims that were not true, and how they were found

**Status: documentation and one comment only. Nothing executable moved, so `suite` and `host` were
not re-run.**

Both claims were pre-existing — neither came from rounds 16 or 17 — and both were found while doing
something else, which is the part worth keeping.

1. **`persist.js` claimed to be the only module touching `localStorage`.** The sentence "this
   module is the ONLY place in the plugin that touches `localStorage`" had been there for rounds.
   `diagnostics.js:25` reads `window.localStorage?.getItem('dsh.ui.projects.debug')`, and that
   module's own header documents the key. The architecture was never wrong — a debug toggle is not
   state, and the two keys never interact — but the sentence was, and it was exactly the kind of
   sentence a reader cites instead of checking. Rewritten to say what is true: the only place that
   touches the plugin's own STATE record.
2. **The README's file listing had no `diagnostics.js` entry at all.** Noticed because round 17's
   new line for `runtime.js` names that file — a reference to something the reader cannot find in
   the list beside it. Added.

**Checked and deliberately left alone:** `runtime.js`'s header calls itself "the only place that
touches the DOM, storage and the theme service on behalf of a project". That holds: the host half
contributes HTML text and never touches the DOM API, and `diagnostics.js` builds an overlay but
never a project's DOM. The README line that stated the stronger, false version of it was corrected
in the same pass.

**The method lesson — the reason this round exists.** The first claim had already been audited and
passed. It was read, its intent agreed with, and confirmed, without the tree ever being searched
for the keyword. An absolute claim — *only*, *never*, *always*, *the sole* — cannot be verified by
reading it; it is verified by grepping what it generalises over and looking at every hit. The
intent behind a false absolute is usually true, and that is precisely what lets it survive review.
Both items above came out of keyword searches run for unrelated reasons; re-reading would not have
found either.

**A second method failure, caught the same way — and it happened twice.** Writing this entry
consumed the heading of the round it was inserted before: the replacement text started at a `---`
separator and ended at another, and the heading that sat between them was never re-emitted. The
same mistake happened once before, with Round 15, six rounds earlier — and both times the edit
looked clean when it was made. Both were caught by grepping `^## Round` and reading the numbers,
not by re-reading the prose. Same rule as above: verify the artefact rather than the intention, and
make the check mechanical enough that it cannot be skimmed. `node tools/snapshot.mjs --diff` is the
other mechanical check that would have caught it, one command later.

---

## Round 17 — step 5: the first frame is already the skin

**Status: done. `suite` 346 assertions / 0 failing, `host` green. The browser check is written but
not yet run — it needs a live `dsh web` and a Chrome with a debug port.**

Step 5 asks for the last state to be on screen from the first frame. Until now the skin was applied
from the client bundle, which by definition loads *after* the shell has painted, so step 5 was one
of the two steps still unimplemented (step 6 is the other).

**Changed:** the host half now answers `webserver/index-inject` with two rows.

1. `{ kind: 'style' }` carrying `src/host/boot.css` — the body-level subset of the skin, already
   written in the scoper's marker form, inlined immediately after `<head>`. Emitted
   **unconditionally**: every selector carries the project marker, so with the skin off the sheet
   is inert and the host needs no branch to get wrong.
2. `{ kind: 'script', placement: 'body' }`, emitted **only** when the settings document says the
   skin is on, setting `data-ui-project-liquid-glass="on"` on the body and `data-ui-skin` on the
   root, immediately after `<body>` opens — before the application mounts and before anything
   paints.

**The specification's own mechanism could not be used.** It asks for a blocking head script that
reads `localStorage` synchronously. Round 16 made the settings document authoritative and removes
the `localStorage` copy after the first successful write, so that script would find nothing on
exactly the loads that matter. The host reads the same document the client writes, at render time.

**How the CSS reaches the host:** the host half ships as plain ESM with no transformation and
cannot import a stylesheet, so `lib/boot-css.js` is generated from `src/host/boot.css` — after the
build **proves the source is a subset of the CSS the skin emits**, leaf rule by leaf rule, each
with its at-rule context, compared whitespace-insensitively. Drift fails the build and names the
rule. Verified by sabotage rather than by reading: `--lg-glass-blur: 20px` → `21px` turned the
build red with "1 rule(s) drifted"; restoring it went green with the file byte-identical.

**Two things this found on the way.** The check's first run accused its own documentation — the
source file's header comment was parsed as a rule, so comments are now stripped before comparison
(and before the payload is inlined, which also keeps ~1.4 KB of prose out of every page). And
`host-check.mjs`'s fake context had neither `on` nor `get`, so the moment the row grew a listener
the check would have reported `apply threw`: a context missing a method does not fail partially,
it refuses the loader entry.

**Not in this round:** step 6 — a performance level per project, enhancement priority and conflict
warnings, blur-nesting detection, `prefers-contrast`, and the test checklist.

**Verification:** `suite` (+20 assertions, including the *absence* of `::before` in the first-paint
sheet: the blur cannot exist before the runtime stamps `data-ui-skin-column`, so pinning its
absence keeps that a stated boundary instead of a surprise), `host` (+11 assertions: row shapes,
`placement: 'body'`, the enabled / disabled / no-settings branches, and that neither payload
contains `<` — both are inlined verbatim into HTML). **Not yet observed in a browser**: the new
`browser-verify.mjs` check blocks `dsh-ui-projects/client.js` with `Network.setBlockedURLs` and then
asserts the first frame is already skinned while the application never mounts.

---

## Round 16 — three dead things removed, and two forever-polls bounded

**Status: done. `suite` 319 assertions / 0 failing, `host` loads. Not yet observed in a browser.**

Three leftovers from earlier rounds, taken one at a time with a snapshot between each
(`20-runtime-poll-cleanup`, `21-core-css-deadcode-cleanup`, `22-diagnostics-cleanup`).

1. **Both retry loops ran forever.** `markColumns` polled every 250ms and `watchBootPage` every
   500ms for the life of the session, for every active project, whether or not there was anything
   left to find — and in the boot page's case the callback had already become a no-op, so it was a
   no-op twice a second indefinitely. Neither loop had ever been tested: they are driven by
   wall-clock time, and every existing test reaches the DOM path through `FakeMutationObserver`
   instead. Both intervals now stop, on success and unconditionally `RETRY_BUDGET_MS` (5s) after
   activation, while both observers stay connected — a re-render that replaces the marked columns
   is a DOM mutation, and only the observer can see it.
   The deadline deliberately does **not** call `ctx.fail()`: that routes to `registry.markError()`,
   which calls `#clearActive(id)` and would present the project as off while its stylesheet stayed
   inserted. A give-up is recorded in `markingState.timedOut` instead, and the project stays
   enabled.
2. **`html[data-ui-projects='on'] .ui-ambient-layer`** — the seat for a full-screen backdrop, whose
   only consumer was the pre-v3 Liquid Glass DOM layer. Its rule is deleted, as is the empty
   `html[data-ui-projects='on'] { }` marker rule beneath it, with the record of both moved into
   `core.css`'s header. The verify harness's `.ds-ambient` probe and its eight `=== 0` assertions
   are deliberately KEPT: they are the guard that no project mounts that layer again.
3. **Three diagnostics fields** — `ambientCount` / `ambientParent` / `ambientGrandparent`, the
   `.ds-ambient` query that fed them, and `describeNode()` which became unreachable once they went.
   All had reported constants since the ambient layer was deleted, and nothing outside the debug
   overlay consumed them. `run` was bumped to `r12-poll-cleanup` and the stale `clip` dropped from
   `build`, since a staleness marker that no longer changes is worse than none.

**Verification:** `suite` and `host`. The suite gained a `FakeTimers` and two tests — the first
tests that drive these loops at all — and one of them **failed on its first run and found a real
defect in this round's own work**: the observer path marked the columns without clearing the
interval, because only the interval's own callback had been wired to stop it. In the field the
observer is the path that usually marks first, so the poll would have kept ticking behind a
correctly marked page.

**Negative result worth keeping:** "clear the retry when the attempt succeeds" was implemented in
one place and read as correct. It was wrong in the only path that matters, and only a test that
drives both ways in separately could say so.

---

## Round 15 — RESOLVED: one centring mechanism, not two

**Status: CLOSED. Confirmed by the user in their browser.** The settings dialog is centred and the
close button is reachable.

**Changed, and it is small:** the overlay carries all the centring; the panel carries none.

```css
body .VOzbGW_overlay {
  position: fixed !important;
  inset: 0 !important;
  top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
  width: 100vw !important; height: 100vh !important;
  max-width: none !important; max-height: none !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  z-index: 2147483000 !important;
}

body .VOzbGW_panel {
  /* clean slate: nothing that positions this element for itself */
  position: static !important;
  inset: auto !important;
  top: auto !important; left: auto !important; right: auto !important; bottom: auto !important;
  transform: none !important;
  margin: 0 !important;
  flex: none !important;
  width: min(800px, calc(100vw - 60px)) !important;
  height: min(800px, calc(100vh - 60px)) !important;
  max-width: none !important; max-height: none !important;
}
```

**Why the nine rounds before it failed — the actual finding.** Two centring mechanisms were live at
once, and Round 14 added the second without removing the first:

| who centres | how |
|---|---|
| the overlay | `display: flex; justify-content: center; align-items: center` |
| the panel | `position: fixed; inset: 0; margin: auto` |

`margin: auto` on a box that a flex container is *also* placing does not agree with the flex
alignment — it produces a **double offset**. That is the whole bug, and it was introduced by a fix.
The user diagnosed it directly: *"旧代码里有 left: 50% + translateX(-50%) 等残留，与现在的 flex
居中打架，产生了双重偏移"*, and then observed the symptom that confirmed it — adding flex centring
moved the dialog **further left** instead of centring it.

Round 14 made this worse while reporting it as progress, and the reason is visible in its own entry:
it asserted `position: fixed`, `inset: 0` and `margin: auto` on the panel as *the* requirements,
without ever asking whether the overlay was also positioning it. A test can only be as good as the
set of alternatives it considers.

**The rule this round leaves behind, now enforced by the suite:** a rule that *half* positions an
element is the bug, not the fix. The assertions come in pairs — the overlay must carry nine
centring properties, and the panel must carry **none** of `position: fixed`, `position: absolute`,
`inset: 0`, `margin: auto`, `translate`, `left: 50%`, `top: 50%` — so no future round can reintroduce
a second mechanism without failing a test.

**Also learned:** `transform` on the panel had to be cancelled explicitly. A transform creates a
containing block, which changes what `position: fixed` resolves against, *and* applies after layout,
moving the painted box and leaving the layout box behind. Both effects move a dialog, and both are
invisible when reading the stylesheet.

**Dropped on purpose:** the 18px float above the composer. Expressing it needs a `margin-bottom`, and
a margin is exactly what conflicted with the flex centring. Centring was the nine-round problem;
the float is a one-line refinement that can return once centring is settled.

**Verified:** suite (410 assertions) — the paired assertions above, plus an explicit
`transform: none` and `margin: 0`.
**Browser (user): CONFIRMED.**

---

## Round 14 — the panel is centred by its own geometry

**Superseded by Round 15.** Kept because its failure is the useful part.

**Changed:** the panel was given `position: fixed; inset: 0; margin: auto` and the lift as a
`margin-bottom` instead of a `transform`; the overlay was reduced to a `z-index`, because its
geometry "was measured correct". All dialog rules were merged so each selector appears once.

**Why it was wrong:** it added a second centring mechanism on top of the overlay's flex centring
rather than replacing it. The merged-rules part was correct and stands — the suite's own assertion
for `position: fixed` had been matching the *first* `body .VOzbGW_panel` rule, which did not mention
position at all, and failing against correct CSS.

**Why the reading that motivated it was wrong:**

```
.VOzbGW_mask: 1440 x 880          DevTools, hover   the mask fills the viewport
.VOzbGW_overlay: no inline style  DevTools          nothing overrides the skin
overlayRect: { x: -260, w: 280 }  an earlier probe
panelRect:   { x: -521, w: 800 }  the same earlier probe
```

The mask is `position: absolute; inset: 0`, so a mask 1440 wide proves its containing block is the
full viewport — which **contradicts** the overlay being 280 wide. Both readings cannot be true.

The last two rows agree with each other arithmetically — an 800px child centred in a 280px box lands
at −521 — and that agreement is why they were believed. **The lesson is narrower than "measure
twice": two readings that agree with each other are not thereby correct.** Those two agreed because
they described the same wrong moment, not because they described the page.

---

## Round 13 — the column marking is repaired after a re-render

**Changed:** `markColumns` no longer stops after its first success. Both the `MutationObserver` and
the 250 ms interval now keep running for the life of the project, and each attempt recomputes the
column set and writes the attribute only when that set has actually changed.
**Why:** a contradiction noticed while writing this file, which the two readings below cannot both
be true of:

```
an early probe:  columnClasses: ["pI_x6G_sidebarCol", "pI_x6G_centerCol"]   marking landed
a later reading: columnsMarked: 0, sidebarColumnWidth: null                 marking gone
```

The skin's CSS was measured working on `pI_x6G_centerCol` in between, and no toggle happened. The
shell re-renders — opening the right panel, collapsing the sidebar, switching session — and a
re-render can replace the frame's children with **new elements carrying no attribute**. A marking
that stops after its first success is not a marking; it is a marking that is correct until the next
render.
**Also:** the previous attempt set the attribute unconditionally on every tick, which would have
meant touching the DOM four times a second forever. A repeated attempt on an unchanged frame now
costs a grid lookup and nothing else.
**Verified:** suite (389 assertions) — a dedicated test replaces the frame's children behind the
runtime's back and asserts the attributes come back, that the overlay container is still left
unmarked, and that the diagnostic says `re-marked after a re-render`. Also covered: the full
disable → re-enable cycle, and the diagnostic agreeing with the DOM count by construction.
**Browser (user): CONFIRMED.** The reading after the fix:

```
"widths":      { "window": 1440, "frame": 1440, "sidebar": 280 }
"marking":     { "attempts": 175, "columns": 2, "marked": 2, "note": "marked" }
"columnsMarked": 2
"columnClasses": [ "pI_x6G_sidebarCol", … ]
"errored": []
```

`attempts: 175` is the evidence that matters: the retry loop is still running long after its first
success, and `marked: 2` says the attributes are in place *now* rather than having been placed once.
Before this round the loop stopped at the first success, which is why an early probe saw
`columnClasses: ["pI_x6G_sidebarCol", "pI_x6G_centerCol"]` and a later one saw `columnsMarked: 0`.

`sidebarColumnWidth: null` — the contradiction this entry opened with — is therefore **resolved**:
it was never a diagnostic bug. The marking really was being lost, and it is now repaired.

**Diagnostic overlay, twice fixed in one round.** It was moved to the top-left in Round 11 because a
long report ran off the right edge and a screenshot then cropped exactly the fields being asked
about. That fixed the horizontal problem and created a vertical one: the report is taller than the
window, `overflow: auto` cannot help because the panel is `pointer-events: none`, and the last
fields were unreachable — reported by the user as "the rest is cut off". It is now a two-column
layout at 9px, so neither edge loses fields. The `run` id is hoisted onto its own line, because that
is the field that decides whether anything else in the report means anything.

---

## Closed issue: the settings dialog — the full list of what was tried

Kept because it is the clearest measure of how much time the third column saves. Closed by Round 15.

| round | change | verification | outcome |
|---|---|---|---|
| 4–7 | panel width, `flex-shrink: 0`, `min-width` on nav / content | suite only | **no effect** |
| 7 | `isolation: isolate` removed from the columns | suite only | no effect (it was a real bug, just not this one) |
| 8–9 | `position: fixed; inset: 0; z-index` on the **overlay** | suite only | no effect — it was already correct |
| 10–13 | `width: min(800px, …)`, `max-width: none` on the panel | **browser (user)**: computed 800×800 | **the panel size — this part worked** |
| 14 | `position: fixed; inset: 0; margin: auto` **on the panel** | suite only | **made it worse — a second centring mechanism** |
| 15 | overlay centres; panel positions nothing | suite + **browser (user)** | **fixed** |

Every row marked `suite only` is a row that failed. That is the whole argument for the verification
column.

### Facts established by measurement, not inference

- The sidebar is **not** collapsed: `cols.sidebar = 280`, `frameWidth = 1440`, no
  `data-sidebar-collapsed`. **Three rounds were spent on a symptom that did not exist.**
- The panel is **not** compressed: measured `800×800` in DevTools. Two more rounds went to that one.
- `.VOzbGW_panel` **does** exist in the DOM when Settings is open. An earlier probe reported
  `overlay NOT in this document`; that reading was taken with the dialog **closed**, and was wrongly
  read as "the element does not exist". Two reasons a query returns nothing — absent, or not there
  *yet* — were treated as one.
- `.VOzbGW_*` has **two** forms: a 36×36 `rail` / `trigger` settings button in the sidebar footer, and
  the full `overlay` / `panel` dialog. The narrow vertical-text strip was the **dialog**, not the
  rail — despite the rail being named in the guesses.
- `.VOzbGW_overlay` has exactly **one** rule in the entire install, and it already declares
  `position: fixed; inset: 0`. Nothing was overriding it in any way readable from source.

---

## Round 12 — container query for the project card

**Changed:** `.uip-card` gets `container-type: inline-size`, plus an
`@container (max-width: 420px)` rule that stacks the card into one column.
**Why:** the card's preview is a fixed `116px` grid track beside `minmax(0, 1fr)`, so a narrow
container squeezes the text column to a few dozen pixels and every word wraps onto its own line —
text running vertically. The existing `@media` breakpoints fire on the *window* width and cannot
see that the card is narrow inside a wide window.
**Verified:** suite (373 assertions).
**Browser:** **unverified.**

## Round 11 — diagnostics instrument fixed, twice

**Changed:** the overlay moved from bottom-right to top-left and shrank to 10px; field order put
`run` and `dialog` first; a `widths` block reports the numbers that decide sidebar collapse.
**Why:** the report ran off the right edge of the window, so screenshots cut off exactly the fields
being asked about — and that was read as "nothing to see" rather than "the instrument is out of
frame". A separate field had been querying `.uip-panel` (the *skin's own* page) and so reported
"settings panel not open" for a dialog that was open the whole time.
**Verified:** suite.
**Lesson:** an instrument that reports nothing is not evidence of nothing. Both bugs here produced
plausible-looking output from a broken question.

## Round 10 — `dismissBootPage`

**Changed:** new runtime capability, plus `watchBootPage()` in the composition root.
**Why:** the shipped frontend ends with `new Boot(document.getElementById("root")).run()`, which
mounts the application but **never removes the boot page it built**. Both are `height: 100%`
children of `#root`, so the container's content is about twice the viewport: the page scrolls to a
second screen, and the application's own layout is measured against a box twice the size of the
window.
**Removal is conditional** — only when the container is genuinely oversized and the application is
present beside the page — so a slow boot is never touched.
**Verified:** suite (`browser` — the user confirmed the second screen is gone).

## Round 9 — remove the opacity slider

**Changed:** the whole control removed, not disabled: `setMaterialOpacity`, `#opacityApplier`,
`opacityDisposers`, the scale constants, and the `controls` declaration. Transparency is now fixed
at the most transparent setting the design holds together at.
**Why:** the slider mapped 0–100 onto a multiplier with a floor of `0.45`, which put a surface at
roughly **15% alpha** — technically present, invisible in practice. The user found the bottom of the
slider and reasonably concluded the skin had stopped working. That one number caused a full round of
misdiagnosis.
**Verified:** suite, `browser (user)`.
**Kept:** a leftover `{opacity: 0}` record is asserted to change nothing.

## Round 8 — `:where()` vs. specificity, and the dialog class

**Changed:**
- hiding rules for the stats rows are no longer wrapped in `:where()`;
- the settings dialog is targeted through its shipped class `.VOzbGW_panel` and its mask
  `.VOzbGW_mask`.
**Why:**
1. `:where()` has zero specificity. `:where(.cm-root){display:none}` at (0,0,0) loses to the
   cost-meter plugin's `.cm-root{display:block}` at (0,1,0) — so the rule was silently dead and the
   rows could never be hidden, while reading as perfectly reasonable CSS.
2. Every attempt to avoid the shipped class names failed *silently*: `[data-rightbar-col] > *`
   matched a 0×0 slot wrapper, `> :last-child` matched the overlay container, and `.uip-panel` was
   the skin's own page. Naming the class is a deliberate trade, made safe by a guard test that
   fails loudly if a frontend rebuild rehashes it.
**Verified:** suite, `browser (user)` — the stats rows disappeared.

## Round 7 — the scoper, three real bugs

**Changed:**
- a functional pseudo-class takes a **selector list**: `:where(a, b)` had only its first branch
  scoped, so `[role='menu']` leaked to the whole document;
- `:where(html)` / `:where(body)` hid the compound from the binding decision and produced
  `body[marker] :where(body)` — a body inside a body, matching nothing. `overflow: clip` was
  written that way and never applied;
- a **doubled marker** is now refused with a thrown error. A selector spelling the marker out by
  hand in a slightly different form (`'on'` vs `"on"`) was scoped a second time into
  `body[marker][marker] …`, which matches nothing on any page.
**Verified:** suite, plus `emitted` — the emitted selectors are now asserted to *match* the elements
they target, by executing them against a realistic DOM, rather than by checking the source text.
**Lesson:** "the stylesheet contains the rule" and "the rule hits the element" are different claims,
and only the second one matters.

## Round 6 — the ambient field

**Changed:** the layer is mounted inside `[data-shell-overlay]` and re-homed until it lands there.
**Why:** hanging it off `<body>` distorted the measurement the shell uses to decide the sidebar's
width. Separately, on a fresh page load the shell has not rendered its floating layer yet, so the
field landed in a fallback and the glass had nothing behind it — the reported symptom was "the
background colour disappeared after restarting, and only toggling the switch brings it back".
**Verified:** suite, `browser (user)`.

## Round 5 — the column seam

**Changed:** `markColumns()` marks the application's real layout columns with
`data-ui-skin-column`, with a retry driven by a `MutationObserver` plus an interval.
**Why:** the shipped layout paints its columns from CSS-module class names and exposes no attribute
on them, and two structural guesses had already failed *silently*. The retry exists because a
project is applied while the shell is still booting — the frame does not exist yet, or exists with
zero-area children.
**Verified:** suite; `browser (user)` — the frost was later confirmed on `pI_x6G_centerCol` as
`backdrop-filter: blur(22px) saturate(1.8)`.

## Round 4 — the token/marker placement bug

**Changed:** token overrides and the project marker moved from `html` to
`body[data-ui-project-<id>="on"]`, and the scoper learned to append the marker to a leading
`body` / `html` compound instead of prefixing it.
**Why:** the shipped client declares its palette on `body`. A skin scope of `html` silently lost
every token; and `body[marker] body[data-ds-dark-theme]` asks for a body **inside** a body, which
is how the dark branch was dead.
**This is the most likely regression point for the settings-dialog problem.** Before this round the
skin effectively did not apply at all, so the dialog was untouched; this is the round where the
skin first really took effect.
**Verified:** suite, `browser`.

## Superseded: the media-query-era card layout

**Changed:** `@media (max-width: 720px)` / `(max-width: 560px)` for `.uip-card`.
**Superseded by:** Round 12's container query. These remain as a fallback but cannot express "this
card is narrow", which is the condition that actually matters.

---

## Tooling added along the way

| script | purpose |
|---|---|
| `verify.mjs` | behavioural suite; asserts properties, not source text |
| `host-check.mjs` | the host half loads, `apply` runs, and the first-paint rows are shaped right — the failure that looks like "stuck on Loading plugins…" |
| `build.mjs` | zero-dependency ESM→CJS bundler with a strict host-import check |
| `balance-check.mjs` | bracket balance that skips comments, strings, templates and regexes |
| `scope-peek.mjs` | the scoper's real output for a given selector |
| `emitted-css.mjs` | the CSS a project actually contributes, as the browser receives it |
| `revision.mjs` | the built bundle's hash and which fixes are present — separates "did not work" from "not loaded" |
| `console-probe.mjs` | a copy-paste probe for the running page, deliberately naming no class |
| `capture-skin.mjs` | screenshots and measurements from a real Chrome over CDP |
| `css-peek.mjs` | one selector's declarations at a time, so the arithmetic is visible |
| `dialog-geometry.mjs` | scans installed client bundles for a given element's rules |

**`emitted-css.mjs`, `scope-peek.mjs` and `css-peek.mjs` were each what actually found a bug.**
Reading the source did not: a doubled marker, a `:where()` that conceded a specificity fight, and a
`116px` fixed grid track all look correct in the file they are written in.

## Open questions

1. **The settings dialog's float above the composer.** Round 15 centred the dialog and deliberately
   dropped the 18px lift, because expressing it needs a `margin-bottom` and a margin is what
   conflicted with flex centring. It can return as padding on the overlay's content box, or as a
   translated wrapper that is not the centred element itself — but not as a margin on the panel.
2. The `rail` / `trigger` form of the settings entry is 36×36 **by design**, and `TriggerContent`
   renders no label at all when narrow (`{wide && <span/>}`). An earlier note here claimed its
   Chinese labels were being clipped; that was wrong — there are no labels to clip.

---

## What this file is for

Round 15 is the entry that justifies the format. Nine rounds of CSS were applied to the settings
dialog, six of them reported to the user as fixes, and **every one of them was wrong**. The record
that would have shortened it is four lines long:

| round | what was changed | what was verified | outcome |
|---|---|---|---|
| 4–7 | panel width, `flex-shrink`, `min-width` | suite only | no effect |
| 8–9 | `isolation` removed; `position: fixed` on the overlay | suite only | no effect |
| 10–13 | `width: min()`, `max-width: none`, `z-index` | suite only | no effect |
| 14 | `position: fixed; inset: 0; margin: auto` on the panel | **suite only** | **made it worse** |
| 15 | overlay centres; panel positions nothing | suite + **browser** | **fixed** |

Two things stand out. Round 14 *caused* a regression while being reported as progress — the entry
says so, which is the only reason it is still useful. And the column that separates the useful
rounds from the wasted ones is the third one: **`suite only` means unverified**, and every unverified
round failed.

Hence the rule stated at the top of this file, and the reason it is worth keeping: **record negative
results, and mark `unverified` as `unverified`.**


---

## Resolved contradictions

Kept because each one was, for a while, a reason to distrust the instruments rather than the code.

| contradiction | resolution |
|---|---|
| `columnsMarked: 0` while `pI_x6G_centerCol` was measured carrying `blur(22px) saturate(1.8)` | Not a contradiction at all — the marking was placed once and then lost to a re-render. Round 13. |
| `overlay NOT in this document` while `div.VOzbGW_panel` was listed by a `querySelectorAll` on the same screen | The first reading was taken with the dialog closed. Two probes, two different moments, read as one disagreement. |
| The sidebar "collapsed to a rail" | `cols.sidebar = 280`, `frameWidth = 1440`, no `data-sidebar-collapsed`. The symptom never existed; three rounds were spent on it. |
| The settings panel "was squeezed by flex" | Measured `800×800` in DevTools. The panel was never compressed. |

