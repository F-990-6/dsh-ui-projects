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
| `host` | `node scripts/host-check.mjs` — the host half loads and `apply` runs |
| `browser` | measured in a real Chrome over CDP, with screenshots |
| `browser (user)` | confirmed by the user looking at their own running instance |
| `emitted` | `node scripts/emitted-css.mjs` / `scope-peek.mjs` — the CSS the browser actually receives |
| **unverified** | written from reasoning about the source; never observed running |

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
| `host-check.mjs` | the host half loads and `apply` runs — the failure that looks like "stuck on Loading plugins…" |
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

