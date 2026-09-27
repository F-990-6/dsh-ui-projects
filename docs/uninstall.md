# Uninstalling a UI project package

What a removal consists of, which half performs each part, and where the assertion that holds it lives.
Written because the twelve items span three drivers — the client runtime, the `dsh plugin` command, and
`install.ps1` — and a reader with a bug in front of them should not have to work out which one owns it.

## The boundary: no suite runs `install.ps1`

`install.ps1` writes `$DSH_HOME`. Automation does not run it in this project, and neither does any
suite: it is the user's to run, deliberately, after a dry run. That has one consequence worth stating
plainly rather than papering over — **the host-side items below can only be verified by a real
uninstall**, which is why they end in the manual acceptance list rather than in a test.

What IS automatic is a source guard (`scripts/verify.mjs`, `the uninstall script still contains every
check it promises`). It reads the script's text and asserts that each check, each "will not be touched"
promise, and the dry run's position are still there. It catches a check being **deleted, renamed or
moved**. It cannot catch one being **weakened** — a comparison replaced by something that always passes
reads the same to a source scan. The real verification is a real uninstall.

## The twelve items

| # | Item | Who does it | Where | The assertion that holds it |
| --- | --- | --- | --- | --- |
| 1 | the project's own `cleanup()` runs | client runtime | `service.js` `withdraw` → `runtime.retire` → `#release` | `load-check.mjs` (counted), `verify.mjs` `retire deactivates a project…` |
| 2 | the registry entry goes | client registry + service | `registry.unregister`, `withdraw` | `load-check.mjs`: `service.list()` empty, `registry.get()` undefined |
| 3 | its stylesheets and `<style>` | client runtime | `insertCss` ledger, `#release` | `load-check.mjs` (`insertedCss` empty), `verify.mjs` retire test |
| 4 | the `data-ui-project-<id>` attribute | client runtime | `#unmarkProject` | `verify.mjs` retire test (`body marker` is `null`) |
| 5 | the CSS variables it declared | client runtime | they live inside the scoped sheet, so 3 covers them | same as 3 — no offline test reads a *resolved* value; the browser suite does that for the toggle path |
| 6 | `settings['<id>']` — **kept on purpose** | nobody: it is the user's data | Round 36 decision | `load-check.mjs` (record byte-identical), `verify.mjs` (fallback blob), `install.ps1` (manual) |
| 7 | `localStorage` | the fallback record keeps the entry; no package owns a key | `persist.js` | `verify.mjs`: the departed entry survives, and the key inventory is exactly four declared keys |
| 8 | the package directory on disk | `dsh plugin remove`, then `install.ps1` | leftover-link guard, tombstone scan, neighbours check | **manual** (items 1–3 of the acceptance list) |
| 9 | listeners, timers, observers | the project's `cleanup()`, plus the runtime's own disposers | `ctx.markColumns()` and friends push into the runtime's owned list | `verify.mjs` `a project's timer and the runtime's own observer are gone…` |
| 10 | the profile's `dsh.profile.bundles` row | `dsh plugin remove`, asserted by `install.ps1` | `install.ps1` verify block | **manual** |
| 11 | the shipped interface comes back | client runtime | `retire` drops the body marker, the tier and the sheet | `verify.mjs` `retiring the active skin returns the shipped interface…` |
| 12 | the settings panel is told | client service | `deps.notify()` in `withdraw` (`service.js:195`) | `load-check.mjs`: exactly one notification per withdrawal |

Two items are not performed by this project's code at all — 2's registry entry is the registry's and the
service's, 10's bundle row is the command's — so for those, "coverage" can only ever be an assertion.

**The root marker is not on this list.** `data-ui-projects` is set in `start()` and cleared in
`dispose()` (`runtime.js:233`, `:457`): it means "this plugin is mounted", not "a project is applied",
and retiring the last project leaves it in place on purpose. Its removal is asserted where it belongs,
in `dispose() removes every effect it owns`.

## The client half

`registry.unregister(id)` removes the definition and refuses an applied id rather than leaking its
stylesheets; `runtime.retire(id)` deactivates it first, which runs the project's `cleanup()` and every
disposer the runtime owns for it, drops `data-ui-perf` with the last project, and **writes nothing** —
both halves of the user's record survive (the id in `enabled`, and its entry in `settings`). Reinstalling
finds the configuration the user had. See Round 36 in `CHANGELOG.md` for why that is the decision.

## The host half

`install.ps1 -Uninstall`: reads the install record, backs up the "before" hashes, runs
`dsh plugin --profile <p> remove <pkg>` (skipped when the profile no longer declares it, so the script is
re-runnable), then asserts — dependency gone, bundle row gone, patch entries unchanged, no leftover link,
no pnpm tombstone, no other `node_modules` entry changed, the source tree byte-unchanged, and the
`ui-projects` block of `settings.yaml` byte-unchanged. Failures keep the install record and exit 1.

## Manual acceptance

Run these in order; each command is read-only up to the second one, which is the removal itself.

1. **The plan, and what it promises.**
   `powershell -File install.ps1 -Uninstall -DryRun`
   Expect: exit 0; a `What this run found` section describing THIS profile (wired state, the
   node_modules entry and its type, any tombstone); a `Will not be touched` section naming the source
   tree, `settings.yaml`, other packages, and the checklist record; and no writes at all — the six
   fingerprints (`settings.yaml` whole file and `ui-projects` block, profile `package.json`,
   `pnpm-lock.yaml`, the install record, the node_modules inventory) are identical afterwards.

2. **The removal.** `powershell -File install.ps1 -Uninstall`
   Expect: exit 0 and `Done`. An exit of 1 names the check that failed and keeps the install record; on
   this machine that is how a stale pnpm tombstone (`node_modules\.ignored_<name>`) is reported, and it
   is not deleted for you when it is a real directory.

3. **The listing.** `node scripts/check-installed.mjs`
   Expect: the package is not listed as a dependency, and no row names it.

4. **The interface, after a restart.** Stop `dsh web` and start it again, then open Settings › UI.
   Expect: no card for the package; the shipped interface is what is left; no `data-ui-project-<id>`
   attribute on `<body>` and no `data-ui-perf`.

5. **The user's data, which the removal must not touch.**
   `Get-Content C:\Users\19103\.dsh\settings.yaml | Select-String -Pattern 'ui-projects' -Context 0,10`
   Expect: the `ui-projects` block is still there, and a `checks` record — if the user had recorded one —
   is still in it.

## Where the coverage lives

| Driver | Covers | How to run |
| --- | --- | --- |
| `scripts/verify.mjs` (offline) | items 1, 3, 4, 5, 6, 7, 9, 11, 12 from the client's side, plus the `install.ps1` source guard | `node scripts/verify.mjs`, or one test: `DSH_TEST_ONLY="…" node scripts/verify.mjs` (the skip count is printed) |
| `scripts/load-check.mjs` (real Cordis) | items 1, 2, 3, 6, 12 against the real registry and real fibers | `node scripts/load-check.mjs` |
| `scripts/browser-verify.mjs` (real Chrome) | the toggle path end to end, including resolved token values; the uninstall path itself cannot be driven here because it ends in a restart | gate first: `--verify-refusal`, then `--no-write` |
| `install.ps1` + `check-installed.mjs` (manual) | items 8 and 10, and the host half of 6 | the acceptance list above |
