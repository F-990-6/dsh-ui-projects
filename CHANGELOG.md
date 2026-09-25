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
| `emitted` | `node scripts/emitted-css.mjs` / `scope-peek.mjs` — the CSS the browser actually receives |
| **unverified** | written from reasoning about the source; never observed running |

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

