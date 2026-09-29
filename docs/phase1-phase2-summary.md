# Phase 1 and phase 2: the map, the tags, and what is still open

## What this document is, and what it is not

**This document is a MAP, not a record.** Two things it deliberately does not replace:

- **`CHANGELOG.md`** is the record: every round, what it changed, how it was verified, and what the negative
  results were. This file names rounds; it never restates their contents.
- **`docs/phase2-scope.md`** is the phase-2 audit: the six core goals, the step-by-step table, the three
  descoped groups with their re-entry conditions, and the items implemented differently than proposed. This
  file points at it; where the two could disagree, that one wins.

What is here is only what neither of them states in one place: **which phase a piece of work belongs to**,
**which tags mark the boundaries**, **when each band happened**, **what is still open**, and **the index**
that makes the other two documents navigable.

Written at the close of round 56i (2026-09-29). Today's state, not a forecast.

---

## Phase 1 — the built-in UI project system

**The spec:** `UI第一阶段.txt` (7,762 bytes, written **2026-09-24 19:12**). It lives in the DSH attachment
store, outside this workspace and outside every repository: `%USERPROFILE%\.dsh\attachments\v1\files\` +
`6e\6e9cea2396f5…871d\`. Its opening line fixes the phase boundary more sharply than any later summary:

> build dsh Web UI's built-in UI project system, and implement the first UI project, Liquid Glass. **This
> phase does not build a plugin system, does not do npm install, and does not do runtime loading.** Every UI
> project is built in.

**Goal, in the spec's own seven points (§二):** a `UI` section in Settings; cards rendered from a registry
(name, description, version, preview, switch, state, reset); Liquid Glass as the first project; on = the iOS
27 glass material, off = fully restored with no residue; a new project needs only a registration, never a
change to the page; the shipped UI stays clean and Liquid Glass starts **off**; and no change to business
logic, routes, API, state management or permissions.

**The six steps the spec prescribes (§八.2), and what they became:**

| step | the spec's wording | what it produced |
| --- | --- | --- |
| 第一步 | read the Cordis loader rules and confirm whether `renderBootScript` is required, **before** writing the entry file | the entry plugin (`src/host/index.js`, `src/client/index.js`) and the answer that the host half answers `webserver/index-inject` instead |
| 第二步 | the UI project registry | `src/client/registry.js` — id, name, description, version, `type` (`skin`/`enhancement`), `defaultEnabled`, `scope`, `supports`, `apply()`, `cleanup()`, `preview`; skins mutually exclusive, enhancements stacked by a priority number |
| 第三步 | the Settings › UI section | `src/client/panel.js` + `store.js` + `locale.js`, rendered from the registry alone |
| 第四步 | the Liquid Glass skin (CSS + `apply`/`cleanup`) | `projects/liquid-glass/` (tokens, glass, the ambient gradient) and the runtime that installs and removes it — `runtime.js` is the only DOM-touching module |
| 第五步 | first frame with no flash (inline `<head>` script + data attribute + inlined critical CSS) | the first-paint mechanism (`uiProjectsHost.bootRows`, marker written at emit time, the derived `boot.css` subset) |
| 第六步 | performance budget, test checklist, accessibility | `perf.js` (tiers, the frame probe, mobile demotion), `css-filter.js` (which selectors carry a blur), the checklist, and the degradation branches (`prefers-reduced-transparency`, `prefers-contrast`, `forced-colors`) |

**What phase 1 left behind** — the architecture phase 2 built on rather than replaced: the **scoper**
(`src/client/scope-css.js`), which rewrites a project's CSS so it can only apply while that project is on;
the **marker** convention `data-ui-project-<id>` (the spec proposed `data-ui-skin-<id>`; the shipped name is
the one the scoper emits — see the README's recorded deviations); **persistence** through the settings
document with a `localStorage` fallback; the **settings-slot** registration; the frost/surfaces split; and
the rule that a project's own CSS and behaviour ship inside that project's package.

**Its precondition, which is not a round:** snapshot `01-step0-restored-and-buildable` (2026-09-24 19:19) —
the source tree was recovered from the recycle bin, the unrelated reminders feature excised, and `build` +
`host-check` made to pass. The earliest `## Round` in the CHANGELOG is Round 4, so **the recovery and the
first spec are phase 1's actual beginning, and the workspace's git history starts after them**: the
framework repository's first commit is `577fc7b` ("step1: built-in UI project system + Liquid Glass
v3.0.0"), which is also where `step1-complete` points. For the first day, the only history that exists is
the snapshot series.

**Rounds:** 4–29 (26 rounds), from the token/marker placement bug and the scoper's three real bugs through
the v3 skin, the ambient field, the first-paint predicate, the perf tier, the region vocabulary, the browser
suite going green (Round 25) and the composer material (Round 27).

**Tags — six, all on 2026-09-25 except the last:**

| tag | target | subject |
| --- | --- | --- |
| `step1-complete` | `577fc7b` | step1: built-in UI project system + Liquid Glass v3.0.0 |
| `step1-cleanup-complete` | `d26a77e` | step1-cleanup: bounded runtime retries, dead CSS/diagnostics removed, v3 docs |
| `step1-persist-complete` | `5673e90` | step1-persist: fix settingsScope inject, add ready() gate, diagnostics |
| `step5-first-paint` | `ab492d0` | step5: first paint served by the host |
| `step1-final` | `93eaea2` | step6: composer glass + dark-mode fix + boot-css predicate unified |
| `step7c-complete` | `4f55f6d` (2026-09-27) | Step 7c fix: the backup copy and its manifest agree on one name |

Two notes on that table, because both are easy to misread. The tag **names** are the phase-1 vocabulary even
where the target's subject names a later step (`step1-final` points at step-6 work). And `step7c-complete`
lives in the **framework** repository even though it is a tag about the skin's material: the skin package
did not exist as its own repository until step 8b, so every phase-1-era tag about it is in the framework's
history. `docs/phase2-scope.md` says that tag is "on the skin"; it is not, and it never could have been.

**Phase 1 ended** when the built-in system was complete and phase 2's spec was written — see the timeline
below for the two dates that bracket it.

---

## Phase 2 — the plugin system

**The spec:** `UI第二阶段.txt` (18,215 bytes, written **2026-09-26 22:32**), in the same attachment store,
`b1\b113ae0cd4ef…ebbe\`. Its steps run 第一步…第十一步 and stop there: **the spec ends at 第十一步**, which is
why phase 3 needs a new one (see "Still open").

**The six core goals: 6/6, each with evidence rather than intention** — the table is `docs/phase2-scope.md`'s
opening section and is not reproduced here. In one line each: the plugins column is a settings **section**
beside "UI" fed by a read-only endpoint; appearance lives on the UI page and packages live in the plugins
column; the framework ships **no** project while `@xjl-resources/dsh-plugin-liquid-glass` is a package with
`peerDependencies: dsh-ui-projects`; install is `dsh plugin add`, enable/disable is the switch, and
update/rollback are the installer's `-Snapshot`/`-Update`/`-Rollback -To`; phase 2 added exactly one settings
section, one host service, one client service and one read-only endpoint; and the key constraint holds — a
skin covers contract-compliant third-party plugins **by role and token, never by package name**, violators
are shown as warnings and **never blocked**.

**Step by step (spec 第四步–第十一步):** the table, the evidence and the status are `docs/phase2-scope.md`'s
second section. The one descope inside it: **第五步's install flow** (group A1 below); the column, the badge
and the activation-time validation of that step all shipped.

**Descoped on purpose (group A), each with a re-entry condition:** **A1** the registry/tarball install flow,
including the `ui-projects.installed` field — every package here is a local `link:`, and `dsh plugin` is a
pnpm forwarder that already does fetch, integrity and `prepare` gating; **A2** the display items (package
author, in-interface CHANGELOG, "copy diagnostics" button) — two are publishing metadata and the third is
already answered by the diagnostics overlay; **A3** the publish flow in the development guide — all packages
are `private: true`. `docs/phase2-scope.md` carries the reasons and the re-entry conditions in full.

**Implemented differently than proposed:** eight rows, all in `docs/phase2-scope.md` — the `dsh.*` field set,
the skin's `main`, `preview.png` as a CSS gradient, `register(registry)` as
`ctx.uiProjects.register(manifest, definition)`, parking instead of a prompt when the framework is absent,
scan-on-demand instead of a cached verdict, the kept `settings['<id>']` entry on uninstall, and the snapshot
form of the update flow.

**Rounds 30–53.** Rounds **30, 31, 32 and 33 have no headings of their own** — the CHANGELOG references them
from inside other entries (Round 32 built the checker that can see a broken package; Round 30's refusal gate
is the shape a later rule is compared to). Their work is phase 2's, and the audit's own step table is the
record. The same caution applies to the labels: "step 6" in phase 1 means the performance budget and the
checklist, while 第六步 in phase 2 means uninstall — the two phases reuse step numbers, so a label is never
sufficient evidence of a phase.

**The seven repositories, at the close of 56i:**

| repository | commits | `step2-complete` | HEAD now | commits after the tag |
| --- | --- | --- | --- | --- |
| `plugins\dsh-ui-projects` | 75 | `9223d1b` (09-29) | `5f6d0a2` Step 56i docs | **18** |
| `plugins\dsh-plugin-liquid-glass` | 6 | `a19e82b` (09-28) | `074e4b8` Step 56h docs | 3 |
| `plugins\dsh-plugin-example` | 2 | `6c78817` (09-28) | `f475fe3` Step 56h-5e | 1 |
| `plugins\dsh-plugin-example-dialog` | 1 | `2201f8b` (09-28) | same commit | 0 |
| `plugins\dsh-ui-project-skeleton` | 1 | `42bc7ea` (09-26) | same commit | 0 |
| `tools` | 4 | `a607110` (09-28) | `63a5c79` Step 56i-0 | 2 |
| `.snapshots` | 1 | *(no tags)* | `248079b` (09-29) | — |

So **`step2-complete` marks phase 2's close, not today's state**: 24 commits landed after it in the four
repositories that have moved, and `.snapshots` did not exist when it was applied.

**Maintenance rounds after phase 2 (all 2026-09-29):**

| round | newest commit | what it closed |
| --- | --- | --- |
| 54 | `2b9198c` | group C's "the gate drives a fixed project id" — the gate resolves the project it drives and fails by name |
| 55 | `860ceb0` | T3: an unknown record is not an empty one; the first frame answers while the record is still unknown |
| 56a | `266a823` | the installed-package row reads its own facts; the preview rule gets one home |
| 56b–56d | `36a5ca7` (+ docs `f84c57b`) | the per-package CHANGELOG arrives on demand; the row folds down; `CommandRow` becomes a component |
| 56h | `44a77c7` | six small items: the CLI's name column, the `--shot` sentence, the dead matcher, the ninth contributing rule, the derivation tool's move into the skin package |
| 56i | `5f6d0a2` | `.snapshots` comes under version control; the snapshot listing learns to skip dot-directories |

Cross-repository commits from those rounds: skin `074e4b8` (56h docs), `tools` `63a5c79` (56i-0), example
`f475fe3` (56h-5e), `.snapshots` `248079b` (its root commit).

**Final state of the offline suites** (agent-run, all exit 0, after round 56i):

| suite | result |
| --- | --- |
| `dsh-ui-projects` `scripts/verify.mjs` | **1134 passed, 0 failing** |
| `dsh-ui-projects` `scripts/check-installed.test.mjs` (`conformance`) | **130 passed, 0 failing** |
| `dsh-ui-projects` `scripts/load-check.mjs` | **91 passed, 0 failing** |
| `dsh-ui-projects` `scripts/host-check.mjs` | host half is loadable |
| `browser-verify.mjs --self-check` | the refusal rule covers every protected write |

**The browser numbers are Round 56d's: 239 / 0.** No browser run happened in 56h or 56i, and that was a
decision rather than an omission — both rounds changed `scripts/**`, documentation, or files outside every
repository, and `lib/client.js` was `a524d5921ef0` throughout, so a running interface had nothing new to
show. The last round that could have changed what a person sees was 56d.

---

## Timeline, and how the times were obtained

**Three sources, and they do not always agree.** This document treats the **commit date as primary**
(`git log --date=short`, which exists for 75 framework commits and 15 more across the other repositories),
uses the **snapshot mtimes** as the chronology for the first day — when there were no commits at all — and
uses the **spec timestamps** as the intent boundary. Where they disagree, the disagreement is stated rather
than averaged: a snapshot taken at 09-26 22:21 and a spec written at 09-26 22:32 are two different events,
and the twelve minutes between them are the point.

**Line 1 — the specs (what was asked, and when):**

| | file | size | written |
| --- | --- | --- | --- |
| phase 1 | `UI第一阶段.txt` | 7,762 B | **2026-09-24 19:12** |
| phase 2 | `UI第二阶段.txt` | 18,215 B | **2026-09-26 22:32** |

**Line 2 — the snapshots (what was copied, and when):** 47 snapshot directories plus `pre-build`, from
`01-step0-restored-and-buildable` (**09-24 19:19**, seven minutes after the phase-1 spec) through
`45-step7-no-write-gated` (**09-26 22:21**), then `46-step8a` (**09-28 12:14**) and `47-step8b`
(**09-28 13:12**). The first day is dense — 19 snapshots on 09-24/09-25 — and the last four days hold none.

**Line 3 — the commits and tags (what was recorded in git):** the framework's history runs **09-25 … 09-29**
(75 commits). The six phase-1 tags are 09-25 (five of them) and 09-27 (`step7c-complete`).
`step2-complete` is 09-29 in the framework, 09-28 in the skin, the two example packages and `tools`, and
09-26 in the skeleton. The maintenance rounds are all 09-29.

**Two gaps, both visible in line 2:**

- **`44` → `45` (09-25 23:09 → 09-26 22:21, ~23 hours).** The composer/translucency work stopped and the
  no-write gate was snapshotted the next evening.
- **`45` → `46` (09-26 22:21 → 09-28 12:14, ~38 hours).** This is the phase boundary. The phase-2 spec was
  written **inside** it (09-26 22:32, eleven minutes after the last phase-1 snapshot), and the first phase-2
  snapshot — step 8a's — followed on 09-28. The commits agree: every step-8 and step-9 commit is 09-28/09-29.

**How the phase boundary was established** (three independent statements, none of them a summary's claim):
Round 32 describes its own work as **Step 3 of phase 2** — that text survives as a sub-entry inside Round 34's
entry, which is where the unheaded rounds 30–33 are recorded — and Round 34 opens with **Step 4 of phase 2**;
and `46-step8a`, the first snapshot after the gap, was created on 09-28 12:14, after a phase-2 spec written
09-26 22:32. So phase 2 begins at **Round 30**, and phase 1 is Rounds 4–29.

---

## Still open

Grouped by where the record lives, not by importance — except the first item, which is a protection gap of
the same kind round 56i just closed.

1. **The two specs are under no version control at all — and they are the only statement of what the phases
   promised.** `UI第一阶段.txt` and `UI第二阶段.txt` live in
   `%USERPROFILE%\.dsh\attachments\v1\files\<sha256>\`, outside this workspace, outside every repository, and
   outside `tools/snapshot.mjs`'s `ROOTS` (which covers the five packages and `tools`). This is exactly the
   B.3 gap that 56i closed for `.snapshots/README.md`, with a worse object: not the index of the snapshots
   but the goals themselves. See "Suggested next steps" 1.
2. **Group A — descoped with a re-entry condition.** A1 the registry/tarball install flow (re-entry: a
   package arriving from a registry *without* pnpm doing the work); A2 the author/CHANGELOG/copy-diagnostics
   display items (re-entry: publishing metadata becomes real, or a user has to report a state we cannot
   reproduce); A3 the publish flow (re-entry: a registry-facing package). `docs/phase2-scope.md` holds the
   full reasoning.
3. **The two items still standing in the deferred list** (group C's `deferred items (b)–(e)` row, where
   `matchesWithAncestors` was deleted in 56h-4 and the derivation tool moved in 56h-5): the `.snapshots`
   index rows for 20–37 are **pointer-only, deliberately not backfilled**, and **`install.ps1`'s decision-tree
   comment** is deferred until that file is touched for another reason.
4. **Group C's three individually-recorded items**, all still open: the gate drives a fixed project id and
   does not check that the project is active (B.2); `Ctrl+Shift+R` can come back with the skin off, because
   the client's settings read has a two-second budget and proceeds with the empty record when it times out;
   and the record can name two skins, because `#remember` computes the enabled list from the record rather
   than from the runtime's active set. The last two share the "the client's record was empty" root.
5. **Phase 3 and phase 4 have not started**, and phase 3 needs a new spec: `UI第二阶段.txt` ends at 第十一步.
   What already exists for them: the contract scanner as phase 3's data source, and the region vocabulary,
   `regionConflicts()` and the runtime `layers` measurement for phase 4.
6. **`.snapshots` has no tag**, while the other six repositories do. Its single commit (`248079b`, 09-29) is
   the repository's whole history so far.
7. **`step2-complete` no longer describes the current state** (18 / 3 / 2 / 1 commits behind, per the table
   above). Anyone reading the tag as "this is what ships" would be reading a 24-commit-old workspace.

---

## Suggested next steps

**Every item in this section is a suggestion. None of it has been done, and nothing here is a commitment.**

1. **Bring the two specs under protection** — the same treatment `.snapshots/README.md` just received, and
   for the same reason (they are the phase goals and they have exactly one copy). Two ways, and they are not
   exclusive: copy them into `docs/` (e.g. `docs/specs/`) so they are version-controlled with the record they
   produced, or add the attachment directory as a `ROOTS` entry in `tools/snapshot.mjs` — the first is better
   for a reader, the second for a machine, and the current arrangement is neither.
2. **Then the two user-visible items rather than the cosmetics**: the `Ctrl+Shift+R` timeout and the
   "record can name two skins" bug share one root — the client proceeded with an empty record — and
   `docs/phase2-scope.md` already suggests fixing them before the rest of group C.
3. **Tag `.snapshots`** (its root commit is a natural `step2-complete`-era marker) so that all seven
   repositories have a boundary, and decide whether the six existing `step2-complete` tags should be
   accompanied by a marker for the maintenance rounds — right now 24 commits are untagged everywhere.
4. **Do not start phase 3 from this document.** It needs a spec of its own: the compatibility matrix column
   set, the CHANGELOG generation rules, and what "automatic" means for a package that has no CHANGELOG are
   all decisions, and `docs/phase2-scope.md`'s last section lists only what already exists to build on.

---

## Index: repositories, tags, and rounds

**Repositories and their boundaries** — see the phase-2 table above for `step2-complete` and HEAD. Phase 1's
tags are in the framework repository only; the skin repository's history begins at step 8b, so its phase-1
work is recorded in the framework's history and in the snapshots.

**Rounds → phase.** Phase 1: 4–29. Phase 2: 30–53 (30–33 without headings). Maintenance: 54, 55, 56a, 56b,
56c, 56d, 56h, 56i.

**Rounds with a date that a commit can prove** — only where a commit's subject names that step, which is why
this table is short and why the phase bands above are the reliable unit:

| round | step label in git | date(s) |
| --- | --- | --- |
| 39 | `Step 6d` | 09-27 |
| 40 | `Step 7a` | 09-27 |
| 41 | `Step 7b` | 09-27 |
| 42 | `Step 7c` | 09-27 |
| 43 | `Step 7d` | 09-27 |
| 44 | `Step 7e` | 09-28 |
| 45 | `Step 8a` | 09-28 |
| 46 | `Step 8b` | 09-28 |
| 47 | `Step 8c` | 09-28 |
| 48 | `Step 48` (8d review) | 09-28 |
| 49, 51 | `Step 8e` | 09-28 … 09-29 |
| 50 | `Step 9b` | 09-28 … 09-29 |
| 52 | `Step 11` | 09-29 |
| 54–56i | the round's own number | 09-29 |

Rounds 4–38 and 53 are **not** in that table: no commit subject names them, so their dates are only
bounded by the phase bands (4–29: 09-24 … 09-26; 30–53: 09-26 … 09-29). Inventing a date for them would be
inventing a record.

---

## Appendix A — the 52 round headings

Read from `CHANGELOG.md`, newest first as they appear there. Titles are verbatim; **no line numbers**, because
that file grows at the top and any number would rot.

**Maintenance (6 headings):** 56i — the snapshot index comes under version control, and the listing learns to skip
dot-directories · 56h — six small items, one tool moved out of the workspace's `tools/`, and the rule that
keeps a heading from being eaten · 56b–56d — the CHANGELOG arrives on demand, and the row folds down to what
a reader needs · 56a — the installed-package row reads its own facts, and the preview rule gets one home ·
55 — T3: an unknown record is not an empty one, and the first frame answers while it lasts · 54 — B.2 fixed:
the gate resolves the project it drives, and fails by name when it cannot.

**Phase 2 (20 headings, rounds 34–53; rounds 30–33 are unheaded):** 53 — Phase 2 closes: the scope document, and three items descoped
on purpose · 52 — Step 11: the self-test closes, and the gate fails on a state nobody had told it about ·
51 — Step 8e closed: the wrapper's whole surface is driven, and two of the three sub-rounds were already
recorded · 50 — Step 9b: the contract scanner, the badge, the two-sided example, and four assertions that
measured the wrong thing · 49 — Step 8e: the wrapper forwards what it was given, and the wait stops
reporting a verdict · 48 — Step 8d review: the copied block repeats the row's own command · 47 — Step 8c:
the framework ships no project · 46 — Step 8b: the framework gets a skin of its own, and the material moves
out · 45 — Step 8a: the installer learns which package it is maintaining · 44 — Step 7e: the maintenance
workflow is written down, and a stamp a person can read · 43 — Step 7d: the interface offers the commands,
and says only what it knows · 42 — Step 7c: recording a state, and the one command allowed to write the
source tree · 41 — Step 7b: version snapshots, and the check that makes a truncated copy visible · 40 —
Step 7a: `-Update` as a read-only plan · 39 — Step 6d: the uninstall list, its proof, and its limits ·
38 — Step 6c: the uninstall audit, and the residue it found on a real machine · 37 — Step 6b: the uninstall
block, and an assertion that assumed an empty checklist · 36 — Step 6a: what an uninstall owns, and what the
user owns · 35 — a confirmation that recorded nothing, and the run that was not `--no-write` · 34 —
Settings › UI plugins: what is installed, read-only.

> **Rounds 30, 31, 32 and 33 have no headings.** Their work is phase 2's and it is recorded inside other
> entries' prose — the CHANGELOG refers to Round 30's refusal gate, to Round 32 as the round that built a
> checker able to see a broken package, and to a known issue "CLOSED in Round 30". A reader looking for a
> `## Round 30` will not find one; a reader looking for what Round 30 did will find it under Rounds 29 and 34.

**Phase 1 (26 headings, rounds 4–29):** 29 — a confirmation is worth what its version AND its checklist are
worth · 28 — every translucent surface, in every mode that removes transparency · 27 — the composer gets the
frame material · 26 — withdrawing a recorded verification · 25 — the browser suite runs green, and what it
had really been measuring · 24 — a write the browser suite can refuse, and a notification that was missing ·
23 — step 6, unit D: the verification checklist · 22 — step 6, unit C: more contrast, and a two-way
first-paint guard · 21 — step 6, unit B/2: regions, conflicts and blur nesting · 20 — step 6, unit B/1:
execution order · 19 — step 6, unit A: the effect tier · 18 — two absolute claims that were not true, and
how they were found · 17 — step 5: the first frame is already the skin · 16 — three dead things removed, and
two forever-polls bounded · 15 — RESOLVED: one centring mechanism, not two · 14 — the panel is centred by its
own geometry · 13 — the column marking is repaired after a re-render · 12 — container query for the project
card · 11 — diagnostics instrument fixed, twice · 10 — `dismissBootPage` · 9 — remove the opacity slider ·
8 — `:where()` vs. specificity, and the dialog class · 7 — the scoper, three real bugs · 6 — the ambient
field · 5 — the column seam · 4 — the token/marker placement bug.

**Total: 52 headings** — 26 in phase 1, 20 in phase 2 (with four of phase 2's rounds unheaded), 6 in the
maintenance band.
