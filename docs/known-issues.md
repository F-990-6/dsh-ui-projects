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
