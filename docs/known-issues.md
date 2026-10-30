# Known issues — dsh-ui-projects

Structural problems this package knows about: each one is either not ours to fix, or deliberately not
fixed yet. The rule for an entry is the same as the CHANGELOG's — it states what was MEASURED, names the
file and line the measurement came from, and says who owns the fix.

---

## 1 · The first frame flashes dark before the reader's light theme

**Observed** (2026-10-06, on a real restart, with the built-in `glass` enabled): *the first frame already
carries the skin — and it is the DARK skin, which then switches to light.*

**The half that is ours works.** The skin is in the first frame because `src/host/index.js` subscribes to
`webserver/index-inject` and pushes `uiProjectsHost.bootRows('glass', BOOT_CSS)`, and `service.js:140` only
pushes the marker row when the durable record says the project is ON. So the payload arrived and the marker
was set. That part is not in question.

**The flash is NOT this package's, and the measurement is the point.** It is the shell's own theme
bootstrap, and the code is in `@deepseek-ai/dsh-client-ui-theme`:

- `lib/index.js:39-45` — the head CSS colours the document canvas BEFORE any script runs, and for the
  `system` preference it emits light plus `@media(prefers-color-scheme: dark)`.
- `lib/index.js:47-57` — a **body script** then computes
  `dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)`
  and calls `document.body.toggleAttribute('data-ds-dark-theme', dark)` **before the loading page and the
  application scripts**. `lib/index.js:17` says the default preference is `system`.
- Its README states the intent: *"A body script then sets `body[data-ds-dark-theme]` … before the loading
  page and application scripts, so the first paint uses the selected palette."*

**This package is a FOLLOWER of that attribute, on purpose.** Every dark block in `src/host/skins/glass/boot.css`
(13 of them, from `:56`) is written `body[data-ui-project-glass="on"][data-ds-dark-theme]`, and the same
gating runs through `tokens.css` and `glass.css`. Nothing in `src/**` writes or removes the attribute —
a `grep` for it returns CSS gates, comments and tests, and no writer. So the skin paints dark exactly when
the shell has already said dark.

**The consequence to expect**: with the skin OFF the same flash should still happen, because the attribute
and the shell's own dark palette are there either way — the skin makes the flashed frame look like a
finished dark skin rather than like a dark shell, which is why it is more noticeable now.

**Why the skin must NOT compensate.** Painting light during the first frame regardless of the attribute
would invert the bug for every dark-mode reader — they would get a light flash instead. The skin has no
independent way to know the reader's durable preference: `bootRows(projectId, cssText)` carries CSS and
nothing else, and inventing a second channel for it would duplicate a decision the shell already owns.

**Who owns the fix**: the shell. The candidate is the disagreement between the preference the bootstrap
embeds (the durable setting, or the `system` default) and the palette the client's theme presenter finally
resolves — the flash IS that disagreement, and only the shell can see both sides of it. Diagnostics that
pin it down, from the browser console: `document.documentElement.dataset.dsThemeSource` (what the bootstrap
used), `matchMedia('(prefers-color-scheme: dark)').matches`, and `document.body.hasAttribute('data-ds-dark-theme')`
once the app has settled.

**Status: recorded, not fixed. Not ours.**

---

## 2 · Cross-workspace file edits and encodings (a trap this repository has already fallen into)

A read–replace–write round trip through PowerShell 5.1 (`Get-Content -Raw` → `WriteAllText`) decodes a
BOM-less UTF-8 file as ANSI and writes the mangling back, and it lost a byte outright at four places — so
decoding it back is not a repair. It silently corrupted three files during the built-in round, in commits
that were already written, and the round's own equivalence check is what caught it.

Use Node (`readFileSync(…, 'utf8')` / `writeFileSync(…, 'utf8')`) or PowerShell 7's
`Set-Content -Encoding utf8NoBOM`, never PS 5.1's `WriteAllText` and never a shell redirect into a source
file. Then count the mojibake characters; zero is the only acceptable number. The full account lives in the
skin monorepo's `docs/known-issues.md` (section 8), where it happened.

**And PS 5.1 is not hypothetical here**: on 2026-10-30 this machine's shell was Windows PowerShell 5.1, and
`Set-Content -Encoding utf8NoBOM` failed outright ("cannot convert the value "utf8NoBOM"") on the release
bump. It failed SAFELY — the file was neither changed nor corrupted — but the lesson stands: in this
environment, file edits go through an editor/tool, not through the shell.

---

## 3 · The window washes out, and only a client-plugin restart brings it back

**Observed** (reported 2026-10-30, screenshot): *the interface "disappears" often — the whole window washes
out to near-white and the text behind it is barely visible; restarting the PLUGIN brings it back, restarting
dsh makes it go away again.* Asked which plugin, the reader answered plainly: **this one.** The wallpaper
engine is installed on that machine but switched off, so it is not in the picture.

**A correction worth keeping, because the first version of this entry got it wrong.** It blamed
`dsh-plugin-wallpaper-engine` for writing the same shell tokens. That diagnosis was reasoned from the two
plugins' code and was never measured, and the reader's next message falsified it in one line. The lesson is
not "be careful"; it is that *ordering* was inferred from a symptom and then attached to a convenient suspect
— the symptom is real, the suspect was not.

**What the symptom does establish.** A plugin restart fixes it and a dsh restart breaks it. Nothing static
can behave that way: a media query or a bad declaration would be constant. So something about this skin is
injected, or measured, in a different ORDER on the two paths. This package has exactly two injection
channels, and both are plausible carriers:

1. **`src/host/skins/glass/boot.css`** — pushed by the host into `<head>` at page load, first paint, already
   scoped (`body[data-ui-project-glass="on"]`), and carrying the token block.
2. **The client half** — `glass.css` + `tokens.css` scoped by `scopeCss` when the project is enabled, plus
   the four overlay sheets inserted RAW into `<head>` (never scoped, by design).

**The three questions that would settle it, and none of them needs a restart to answer.** They are listed in
this order because each one shrinks the space by half:

- **When the window is washed out, does the skin's settings card still show its material version?** A version
  means the client half ran and its sheet is applied, so the wash is a VALUE problem inside our own sheet. No
  version means the client half did not run, and what the reader sees is the boot sheet or the plain shell.
- **Is the wash light or dark?** A near-white wash under a DARK theme is the light token block winning, which
  points at the order of the scoped sheets. A wash in light mode is more likely the opaque branch (see
  below) rather than a wrong palette.
- **Does it happen on a fresh page load, or only after opening a dialog/menu?** The overlay is the only sheet
  that runs on dialogs and portals, and it is the only one inserted raw rather than scoped — a bug there
  appears exactly when a dialog opens and would look like "the background vanished behind the dialog".

**The candidate that needs no ordering at all, and should be checked before any of the above**: the four
degradation branches — `@supports not ((backdrop-filter: blur(1px)) …)`, `prefers-reduced-transparency`,
`forced-colors` and `prefers-contrast` — all raise every fill to OPAQUE (`#fff` / `#1c1c1e`). If any of them
is active on this machine, the whole app is drawn with opaque fills and reads as a flat wash, and a plugin
restart would change nothing (so this candidate is falsified only by the restart fixing it — which the reader
reports it does).

**Status: OPEN, and ours.** Not diagnosed, not fixed. The next step is measurement, not more reasoning: the
three questions above, plus — if a browser with an authenticated tab can be attached — a capture of
`document.body.getAttributeNames()` and the computed `--dsw-alias-bg-layer-1` while the window is washed out.

## 4 · Two plugins on one surface (kept as a shape, not as a diagnosis)

The concern that produced the first version of section 3 is still real in general: custom properties have one
value per element and no arbitration, so any two plugins that both paint the shell's token layer will fight,
and the last writer wins. It is recorded here only as a shape to check when the composition actually contains
two such plugins — **not** as the cause of section 3. And the guidance stands: the answer to that shape is one
owner per surface, never an `!important` sweep or an observer that re-stamps after a foreign write.


