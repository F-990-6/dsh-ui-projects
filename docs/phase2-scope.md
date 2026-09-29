# Phase 2: what shipped, what was descoped on purpose, and what is still open

This file closes phase 2 (`UI第二阶段.txt`, the plugin system). It exists because a phase that reports only
what it built is a phase whose gaps are rediscovered later as bugs: every item below is either **delivered
with evidence**, **descoped with a reason and a re-entry condition**, or **open and itemised somewhere a
reader can find it**. The audit that produced it is Round 52 of `CHANGELOG.md`, run over the spec's own text
rather than over the plan's summary of it.

Two facts about the spec are worth stating before the lists, because they shape every "descoped" entry
below: its package-norm section (§三) and its install-flow section (§四) were **proposals written before the
loader's mechanism had been measured**, and the spec itself opens with the rule that code wins over prose.
Where the implementation differs, the difference is listed here with the measurement that decided it —
silently "improving" on a written requirement is how a project loses the thread of what it promised.

## What shipped — the six core goals, 6/6

The spec's §二 lists six core goals for this phase. All six are delivered, and each row below carries the
evidence rather than the intention:

| spec §二 goal | delivered | evidence |
| --- | --- | --- |
| 1. A plugins column in Settings | a registered settings **section** beside "UI" (`src/client/panel-plugins.js`), fed by the read-only endpoint `/api/ui-projects/installed.json` (`src/host/installed-endpoint.js`). The spec suggests a route `/settings/plugins`; a section is the phase-1 architecture's route, and the spec's own wording is "建议" | browser tests: the column opens, fetches and settles; the framework row carries no removal command |
| 2. UI column manages on/off, plugins column manages source, version, update, uninstall | UI page = cards with switch, checklist, maintenance block, version state; plugins column = name@version, kind, composed, framework, contract badge, project id, problems, and the maintenance/uninstall commands | `suite` 844/0; browser 239/0 |
| 3. Split into framework + skin package with `peerDependencies` | `dsh-ui-projects` (unscoped, local `link:`) and `@xjl-resources/dsh-plugin-liquid-glass` (scoped, `peerDependencies: dsh-ui-projects`). The framework ships **no** project of its own | skin `check` 26/0, `suite` 237/0; framework round 8c's "ships no project" assertions |
| 4. Install, enable, disable, update, uninstall, rollback | install = `dsh plugin --profile web add <path>`; enable/disable = the UI switch; update/rollback = `install.ps1 -Snapshot/-Update/-Rollback -To` | self-test: `-Uninstall -DryRun` exit 0 with six fingerprints unchanged; `-Update -DryRun` exit 0; `-Snapshot`/`-Rollback` acceptance lists in `docs/update-and-rollback.md` |
| 5. No change to business logic, routes, API, state management, permissions | phase 2 added one settings section, one host service (`uiProjectsHost`), one client service (`uiProjects`) and one read-only endpoint | `load` 85/0, `host` 41/0 |
| 6. **The key constraint**: a skin must cover contract-compliant third-party plugins automatically; violators are detected, shown and **not** blocked; coverage is a semantic contract, not a whitelist | Liquid Glass's frosted surfaces are selected by WAI-ARIA role and `--dsw-alias-*` tokens; no package name appears in any selector; contract findings are `severity: 'warning'` and nothing refuses a package | browser test A: a surface the skin has never heard of is frosted because it carries `role="dialog"`; B: the same surface with `role="custom-dialog"` is not; D/E: the warn badge with findings, and the framework's own two accepted findings |

## Step by step (spec 第四步–第十一步)

| step | deliverable | evidence | status |
| --- | --- | --- | --- |
| 第四步 — contract detection, method researched not assumed | `src/host/contract-scan.js`: a text scanner (no parser is resolvable here — measured), three decidable rules plus rule 3's criterion written down, five false-positive classes each pinned by an A-layer case | `conformance` 122/0; the CLI report's `UI CONTRACT` section over the real profile | done |
| 第五步 — plugins column + install flow + validation + contract badge | column, badge (four states, findings panel, framework row) and activation-time validation (`conformance.js`, `manifest-schema.js`). The **install flow** is descoped — A1 | browser D/E; `PROBLEMS (0)` in the CLI report | column/badge/validation done; install flow descoped |
| 第六步 — uninstall and complete cleanup | client-side reclamation of registry, stylesheets, markers, variables, listeners and timers (`runtime.js`), plus `install.ps1 -Uninstall`; `docs/uninstall.md` lists the twelve items and a five-step manual acceptance | `-Uninstall -DryRun` exit 0, zero writes; the uninstall source guards in `scripts/verify.mjs` | done, with two deliberate deviations (below) |
| 第七步 — update, rollback, state snapshots | `-Snapshot` (payload + per-file sha256 manifest, read back), `-Update` (read-only plan, records `lastVerified`), `-Rollback -To` (the only mode that writes the source tree: `package.json` + `lib/**`, with a backup of what was there), `-ListVersions`; `docs/update-and-rollback.md` | `-Update -DryRun` exit 0; five source guards; the version store's assertions in `load-check.mjs` | done, in the snapshot form rather than the registry form (below) |
| 第八步 — extract Liquid Glass | its own package with host half, client half, first-paint fragment and its own maintenance wrapper | skin `check` 26/0 and `suite` 237/0 | done |
| 第九步 — the two example packages | `@xjl-resources/dsh-plugin-example` (compliant minimum: 0 findings) and `@xjl-resources/dsh-plugin-example-dialog` (compliant + violating overlays: exactly 1 finding) | their `check.mjs` at 16/0 and 14/0, the second importing the framework's **real** scanner | done |
| 第十步 — `docs/plugin-development.md` | the author-facing guide, including the four contract rules in full | `docs/plugin-development.md` | done |
| 第十一步 — self-test | ten offline suites plus four manual runs; the spec's four 【测试】 lines map to browser tests A/B/C/D/E | Round 52: 1,399 offline assertions, 0 failing; gate 11/0; full browser 239/0 | done |

## Descoped on purpose (group A)

**Descoped is not refused.** Each entry states the re-entry condition that would bring it back.

### A1 — the registry/tarball install flow (§四 install flow, items 1–10, and item 14's `ui-projects.installed` field)

**Not built:** package-name validation, scope trust prompts, `registry` queries, tarball download with
sha512 `dist.integrity` verification, `dsh`-field validation **before** install, refusal of incompatible
`pluginApiVersion`, of unmet `requires`, of runtime dependencies and of `preinstall`/`postinstall`/`prepare`
scripts, and the `ui-projects.installed` list in `settings.yaml`.

**Why it is out of phase 2's scope:** every package in this workspace is installed as a local `link:`
dependency, and a local directory has no registry entry, no tarball and no `dist.integrity` — the update
plan says so in its own output (`link:*` / "no registry version to query"). For registry packages the
mechanism the loader already uses, `dsh plugin add <spec>`, is a **pnpm forwarder**: pnpm performs the
registry fetch, the tarball download and the integrity check against `pnpm-lock.yaml`, and blocks `prepare`
builds until they are explicitly allowed. Re-implementing that in `install.ps1` would be a second, weaker
copy of a solved problem.

**Alternative mechanisms that cover the same ground today:**
`dsh plugin` (pnpm) for fetch + integrity; `conformance.js` and `manifest-schema.js` at **activation** —
a package this build cannot run says so, with a problem code and an action, before it does anything;
`check-installed.mjs` for the human-readable verdict over a real profile; and the profile's own
`dependencies` as the installed record.

**Why there is no `ui-projects.installed` field:** the profile already *is* the installed record — the
scanner reads it, the column renders it, and `dsh plugin add/remove` maintains it. A copy inside
`settings.yaml` would be a second source that can drift from the first, which is the failure family this
project has paid for repeatedly.

**Re-entry condition:** a package must arrive from a registry *without* pnpm doing the work — for example a
tarball a person hands over directly, or a future marketplace inside dsh. Until then the flow would have no
input that is not already validated by the tool that fetched it.

### A2 — display items the spec asks the plugins column for (§五)

**Not shown anywhere:** the package **author** (no manifest in this workspace declares one), the
**CHANGELOG** inside the interface (`install.ps1 -Update -DryRun` prints the newest section; the file itself
is the record), and a **"copy diagnostics" button** (the data exists — `src/client/diagnostics.js` collects
`persistKind`, `persistReady`, `persistDiverged`, `persistError`, `regionConflicts`, `layers`, fills and the
build label — but nothing copies it; the out-of-order signal appears as a sentence on the project card).

**Shown, but on the other surface:** `modifies`, `perfLevel`, `priority` (enhancements only), `requires`,
the description and the preview belong to a *project*, and they are rendered on the UI page's cards, not in
the plugins column. That split is the spec's own §二.2 division of labour: the UI page manages appearance,
the plugins column manages packages.

**Why:** a package's author and changelog are publishing metadata, and this phase installs from local
directories that have neither; the diagnostics overlay already answers the question the copy button would
serve, for a reader who turns it on.

**Re-entry condition:** publishing metadata becomes real when packages are published (A3), and the copy
button becomes worth its code the first time a user has to report a state we cannot reproduce.

### A3 — the publish flow in the development guide (§六.2's "发布流程")

**Not written:** `npm publish`, the `files` allowlist's effect on a published tarball, versioning and tags
for packages.

**Why:** all six packages here are `private: true` and installed by `link:`, so the publish path is not
exercised by anything and a document describing it would be unverified prose — the one thing this
project's docs are not allowed to be.

**Re-entry condition:** the same as A1 — a registry-facing package.

## Implemented differently than proposed (worth knowing, not gaps)

| spec proposal | what shipped | what decided it |
| --- | --- | --- |
| §三 package fields (`dsh.type`, `dsh.id`, `dsh.modifies`, `dsh.perfLevel`, `dsh.priority`, `dsh.requires`, `dsh.runtimeDependencies`, `dsh.provides`, `dshVersionHint`) | `dsh.bundle.patch` + `dsh.client.platform` + `dsh.compatibility.dsh` + `dsh.uiProject.*` (`manifest-schema.js` accepts `priority`, `modifies`, `requires`, `perfLevel`, `preview`, `previewLabel`, `testItems`, …) | the loader admits a package by `dsh.bundle.patch` and reconciles `dsh.profile.bundles` — measured, not assumed |
| §三 the skin's `main` is `lib/client.js`, "first-paint injection is the framework's job" | each package has a host half; the framework owns the **mechanism** (`uiProjectsHost.bootRows`) and each package owns its **fragment** (`scripts/derive-boot-css.mjs --package <dir>`, in the skin package since 56h-5) | round 8c's rule that the framework contains no skin's CSS; the phase-2 architecture question the user answered before step 1 |
| §三 `preview.png` | a CSS gradient string plus `previewLabel` | no binary to package or maintain; the card renders it with an accessible name |
| §三 `register(registry)` | `ctx.uiProjects.register(manifest, definition)` on the framework's service, lifetime bound to the caller's fiber | withdrawal on unload, and the manifest passed explicitly because Cordis caller identity stops at the fiber |
| §四.3 refuse to load a skin when the framework is missing, and prompt "install dsh-ui-projects first" | `inject: ['uiProjects']` — Cordis parks the plugin until the service exists | with the framework absent there is no surface on which to print a prompt; parking is the honest form of "does not run", and it self-heals when the framework arrives |
| §四.4/§七 detect once at install time and cache the verdict in package metadata | scan on demand per listing (`contractFor`), cached with the response | there is no metadata store to write; a stored verdict goes stale, and the scan was measured at 14.5 ms for 296,614 characters |
| §四 uninstall item 6 — clear `settings['<id>']` | the entry is **kept** | it is the user's data (a recorded verification, their options), which is why `docs/uninstall.md` lists it under "not touched on purpose" |
| §四 update flow (query the registry, uninstall the old version, install the new one, auto-rollback) | `-Snapshot` records a restorable version, the user brings the new version, `-Update` records the baseline, `-Rollback -To` restores `package.json` + `lib/**` | local `link:` packages have no registry version; uninstall-and-reinstall would destroy the link; the snapshot form covers the same failures and every mode's writes are guarded by five source scans |

## Recorded, not blocking (group B)

1. **The CLI report's column width.** A scoped package name longer than the 34-character column runs into
   the next field: `@xjl-resources/dsh-plugin-example-dialog1 finding(s)`,
   `@xjl-resources/dsh-plugin-liquid-glassno findings`. Cosmetic; found during the step-11 self-test.
   **Closed in 56h-1**: the report's name column is now derived per section from the names in it, so a
   40-character name cannot reach the next field and a section of short names keeps the layout it had.
2. **`README.md`'s `--shot` sentence** names two files; the flag writes three (`<name>.png`,
   `<name>-closed.png`, `<name>-dark.png`). The plugins column is captured by none of them, which is why the
   visual evidence for the two-command check is a person's screenshot.
   **Closed in 56h-2**: `README.md` now names all three files and the moment each one is written (dialog
   open, dialog closed by Escape, dark mode); the plugins column is still captured by none of them.
3. **`.snapshots/README.md` is under no version control at all** — `E:\dsh` is not a repository and
   `.snapshots` is an `EXCLUDE` entry in `tools/snapshot.mjs`, so the file that explains the snapshots is
   itself protected by nothing. Deciding which repository should hold it is open.
4. **`docs/`-adjacent wording:** the snapshot index's heading says "20 – 38" while its prose says "20 through
   37"; the rows for 20–37 are deliberately **not** backfilled (the file states why), and 46–47 now carry a
   pointer to Rounds 45–46.
   **Closed in 56h-3**: the heading now reads 20–37 and agrees with the prose. The rows for 20–37 are still
   deliberately not backfilled, and 46–47 still carry the pointer to Rounds 45–46.
5. **The framework's row has no removal block** — by design and asserted; recorded so that a future reader
   does not "fix" it.

## Already itemised, deliberately not in this round (group C)

| item | where it is recorded | what it is |
| --- | --- | --- |
| **B.2** | Round 52 | the gate drives a fixed project id and does not check that the project is active; a state that makes the click a no-op reads exactly like a broken refusal rule |
| **`Ctrl+Shift+R` can come back with the skin off** | Round 52 | the client's settings read has a two-second budget; when it times out the runtime proceeds with the empty record while the host's first paint still marks the body |
| **the record can name two skins** | Round 50 (9b-5), linked from Round 52 | `#remember` computes the enabled list from the record, not from the runtime's active set; the same family as B.2 |
| **deferred items (b)–(e)** | Round 51 | move `derive-boot-css.mjs` into the skin package (next round); `.snapshots` index rows 20–37 (pointer added, no backfill); the dead `matchesWithAncestors` in `scripts/fake-dom.mjs` (next round, bundled); `install.ps1`'s decision-tree comment (deferred until that file is touched for another reason). **`matchesWithAncestors` is deleted (56h-4) and the derivation tool has moved into the skin package (56h-5); the other two still stand.** |

## Phase 3, and phase 4

The spec names both, in §七's closing note and §八.3:

- **Phase 3 = a compatibility matrix, with UI Contract compliance as one of its columns, plus automatic
  CHANGELOG generation.** The contract scanner (`src/host/contract-scan.js`) is already the column's
  data source: it reports per-package findings, the rules it cannot decide, and the sizes it read.
- **Phase 4 = conflict detection, with contract violations as a class of warning.** The pieces that already
  exist are the region vocabulary, `regionConflicts()` and the run-time `layers` measurement in
  `src/client/diagnostics.js`.

Suggested order before starting either: fix the two items that change what a user sees (B.2 and the
`Ctrl+Shift+R` timeout, which share the "the client's record was empty" root), then the display round
(group A2's copy button plus group B's cosmetics), then phase 3.

## Closing this phase

Six repositories, all clean at the time of writing, each with its own history:

| repository | HEAD |
| --- | --- |
| `E:\dsh\plugins\dsh-ui-projects` | `8d06f34 Step 11 docs: Round 52 closes the self-test, and the gate's precondition is written down` |
| `E:\dsh\plugins\dsh-plugin-liquid-glass` | `a19e82b Step 8e-1: forward named parameters, not a positional remainder` |
| `E:\dsh\plugins\dsh-plugin-example` | `6c78817 Step 9b: the smallest compliant UI skin (example package)` |
| `E:\dsh\plugins\dsh-plugin-example-dialog` | `2201f8b Step 9b: a third-party client plugin with one compliant and one non-compliant overlay` |
| `E:\dsh\plugins\dsh-ui-project-skeleton` | `42bc7ea initial: minimal UI project package (reference + loader fixture)` |
| `E:\dsh\tools` | `a607110 Step 9b: snapshot covers the two example packages` |

Phase 1 ended with tags (`step1-complete`, `step1-cleanup-complete`, `step1-persist-complete`,
`step5-first-paint`, `step1-final` in the framework repository; `step7c-complete` on the skin). **Phase 2
should end the same way: tag `step2-complete`** — in the framework and tools repositories at least, and in
the three package repositories if the tag is meant to describe the whole workspace. Tagging is the user's
step, like every other write to their environment.
