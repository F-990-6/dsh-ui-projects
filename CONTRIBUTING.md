# Contributing to dsh-ui-projects

## Never use `instanceof` across a Cordis or vm boundary

**Any error or type check that can receive a value from the other side of a Cordis/vm boundary must
not use `instanceof`.** The vm has its own intrinsics: a `TypeError` constructed inside the sandbox
does not share a prototype with the host's, so `err instanceof Error` and `err instanceof TypeError`
are both **false** for an error that crossed the boundary — while every other property of the error
is perfectly intact. Read `.name` and `.message` instead; both are strings and survive any boundary.

```js
// wrong — silently false across a boundary
if (refused instanceof TypeError) { … }
message: err instanceof Error ? err.message : String(err)

// right
if (refused?.name === 'TypeError') { … }
message: typeof err?.message === 'string' && err.message.length > 0 ? err.message : String(err)
```

This is not a style preference. It has cost this project three separate incidents, and the third one
reached the user's screen. All three are in the tree; the line numbers are as of `43913b5` and are
meant to be traced, not trusted.

| Where | What happened |
| --- | --- |
| `src/client/registry.js:167` | `unregister(id)` refuses an applied id with a `TypeError`. The registry runs inside the suite's vm sandbox, so the assertion `refused instanceof TypeError` was false and a correct refusal read as a failed check. The assertion at `scripts/verify.mjs:3746` now reads `refused?.name`. |
| `scripts/load-check.mjs:323` | A fixture's `apply(ctx)` used the **Cordis plugin** context instead of the **project** context the runtime hands it. `insertCss` resolved against Cordis's inject rules and threw `cannot get property "insertCss" without inject`, so the project never applied — and the "cleanup never ran" symptom pointed at retirement, which was innocent. The boundary hands you a different object than the one you think you have; name it after what it is. |
| `src/client/runtime.js:902` | `#write` recorded `err instanceof Error ? err.message : String(err)`. A write can be called across the boundary (the suite's sandbox, a Cordis plugin boundary), where that test fails and `String(err)` prepends `"Error: "` — so the settings panel displayed **"Error: quota exceeded"** to the user. The recorded message is now read from `err?.message`. |

Two consequences worth carrying into new code:

- **A harness is a boundary.** The suite loads the bundle inside `vm`, so anything it hands the code
  under test — and anything the code under test throws back — has crossed one.
- **A wrong `instanceof` fails quietly**, which is the worst property a check can have. Prefer a
  comparison that cannot be false for a correct value.

## Where things live

| Path | What it is |
| --- | --- |
| `src/client/` | the browser half: the registry, the runtime, the settings section. CJS-dialect sources, bundled by `scripts/build.mjs` and never loaded by Node directly |
| `src/host/` | the host half: the loader row, the `uiProjectsHost` service, the conformance checker. Plain ESM, copied verbatim into `lib/` |
| `scripts/` | builds, suites and tools. `bundle-client.mjs` and `fake-dom.mjs` are shared with sibling UI project packages |
| `docs/` | `uninstall.md` (the twelve things a removal consists of, which driver holds each one) and `update-and-rollback.md` (the snapshot → update → rollback workflow, its on-disk layout, and what each mode refuses to do). Both end in manual acceptance steps, because the host half can only be verified by a real run |

## The verification set

```powershell
npm run build            # src/** → lib/**
npm test                 # behavioural assertions against the built bundle
npm run test:host        # the host half loads, applies, and answers the index injection
npm run test:load        # both halves on the real Cordis from the deployment
npm run test:conformance # the installed-package checker, over fixtures
npm run check:installed  # read-only against a real profile
```

`npm test` is the count that moves; the number is recorded per round in `CHANGELOG.md` rather than here,
so that this file states what to run and the changelog states what it found.

### What `--no-write` protects

The browser suite's `--no-write` flag has a narrow promise, and it is worth stating because it reads
broader than it is:

> `--no-write` refuses writes to the `settings` key only. It does not refuse
> `enabled`/`initialized`/`touched`/`v`: the suite's own reload assertions require the enabled set to
> persist, and refusing it would remove the guard the flag exists to protect. Consequence: file mtime
> changes; the `settings` subtree does not.

Counted from a full run rather than assumed: 42 write attempts, 8 refused (the ones carrying
`settings`), 34 through. If a run must not touch a machine's `settings.yaml` at all, do not run the
browser suite on it — that is not what this flag buys.

`CHANGELOG.md` records what each round changed **and how it was verified**, including the negative
results — a change that did not fix the problem is worth more than one that was never tried, because
it eliminates a hypothesis. Keep that up: state the command, state the count, and say plainly when
something was not verified.

## Verification discipline

Five rules, each one learned by getting it wrong. They live here because every reader of this file touches
one of them; the incidents that produced them, with their numbers, are in `CHANGELOG.md`.

1. **Changing `src/**` means rebuilding before verifying.** The suite and the browser both load `lib/`, so a
   stale build makes correct code fail and a broken bundle pass. `npm run build` first, always.
   — Round 43, lesson 1.
2. **An assertion added inside an existing `test()` prints nothing of its own.** The count moving is the
   only evidence it ran, and nobody reads a count that did not change. A new claim gets its own `test()`
   with its own name. — Round 43, lesson 2.
3. **Verify the artifact the source becomes, not the file you remember.** `lib/index.js` is the host
   ENTRY only; the host half is copied file by file, so a constant added to `profile-scan.js` lives in
   `lib/profile-scan.js` and nowhere else. Grep the file the source becomes. — Round 43, "And one about
   verifying a build".
4. **Never round-trip a file through PowerShell text cmdlets.** `Get-Content -Raw` with `Set-Content`
   decodes and re-encodes through the ANSI code page on the Windows PowerShell available here, which
   destroys every non-ASCII character in the file and reports nothing. Edit through the file tools or
   Node; if a shell round-trip is unavoidable, move bytes and compare hashes. — Round 43, lesson 5.
5. **A guard reads CODE, not the prose around it.** Comments, and the guard's own explanation of why it
   exists, are matched by a text scan exactly like the code is — so a guard that scans raw text can fail
   on its own documentation (and pass on a comment that looks like the code it is looking for). Strip
   comments first, or scan code lines only, and prove the guard is sensitive by removing the thing it
   guards rather than by rewording a message near it. — Round 43, lesson 2 (the column's copy guard) and
   Round 45/46 (the `-Update` ordering guard and the skin's DOM-free guard, each of which failed on its own
   documentation before it ever ran clean).
6. **Every first-class package is in git AND in `tools/snapshot.mjs`'s `ROOTS`.** Two histories, because
   they fail differently: git records why a change happened, a snapshot survives the repository itself. A
   package with neither is one bad edit from being rewritten from memory, and this project has lost a
   source tree twice. Adding a package is therefore three edits — the package, the roster here, and the
   snapshot roots — and `scripts/verify.mjs` asserts the third against the directory on disk, so a package
   added tomorrow cannot be forgotten. — Round 46 (the skeleton had been uncovered since it was created,
   and `dsh-plugin-liquid-glass` joined the workspace uncovered).

Rule 4 is the same discipline as `## Tool discipline` below, applied to bytes rather than to anchors:
mutate with the file tools, or in memory, and never leave the tree in a state only a test could have
caught. Rule 5 is the same discipline applied to what a guard is allowed to look at. Rule 6 is the same
discipline applied to the tree itself: what is not under a version control system is not recoverable, and
"it is in the repository" is a claim about exactly one directory.

## Test the path, not the function

**Any path that carries arguments from a component into a function must be tested THROUGH the
component. Calling the target function directly does not test the path, and a suite full of such calls
stays green through a defect that makes the feature do nothing.**

That is not a style preference, it is measured. A checklist confirmation was broken for five rounds by
one re-passed argument — the card passed `project.id` to a callback that already closed over it, so the
store received a string where a list of item ids belonged, `for…of` walked its characters, matched
nothing, and wrote `{ version, items: {} }`. Five assertions on `confirmChecks` passed the entire time:
each handed the store a well-formed array, which is the layer BELOW the defect. The regression test
that ends it renders the card through React and invokes the props the card hands its checklist; Round
35 of `CHANGELOG.md` records the failing control that proves it can fail.

## Cite the path you read, not its parent

**When you report where something came from, give the path the tool returned. A parent directory plus a
filename is not a path, and it costs the reader a search.**

A specification file was reported as living in `C:\Users\19103\.dsh\attachments\`. It was really read —
the name came back from a glob and the file was read in full, and its content is what the Step 6 plan
quoted — but the path quoted was the directory the glob SEARCHED, not the file it found. The reader
looked there, saw only `v1`, and had to ask whether the citation had been invented. The real location is
content-addressed and three levels deeper:

```text
…\attachments\v1\files\b1\b113ae0c…ad871d\UI第二阶段.txt
```

The lesson is not "do not infer paths" — nothing was inferred here. It is that to the person who goes
looking, a shortened path and an invented one are indistinguishable, so the full path (or none) is the
only citation worth giving. The same holds for anything else quoted from a tool: cite the line you read,
the count you saw, the command you ran.

## Tool discipline: never build a multi-line anchor inside a template literal

**A patch script must not hold a multi-line code anchor inside a template literal.** Escaping,
line-chomping and quoting fight each other there, and the failures are silent or bizarre: in one
round this project produced an anchor that matched two places, a regular expression that arrived at
the file with its backslashes eaten, a script that did not parse at all, and a replacement line that
reached the file as the literal text `.join(' + NL + ')`. Four attempts, four different symptoms,
one cause.

Two shapes work, and both have been used since:

```js
// 1. line-level edits, matched on a prefix or an exact trimmed line — no pattern contains a newline
//    or a backslash, and every operation asserts how many lines it expects to touch
const hits = lines.map((line, i) => (line.trim() === target ? i : -1)).filter((i) => i >= 0)
if (hits.length !== 1) throw new Error(`found ${hits.length}`)

// 2. the read + edit tools, whose anchors are plain strings and never pass through JS parsing
```

Two further properties are worth copying, because they are what kept these failures cheap: a patch
script **writes only after every anchor has matched**, so a mistake changes nothing; and it **prints
what each operation touched**, so the report carries the same evidence the tool used.

And one companion rule, learned the same way: **never do line surgery** (splicing a block by computed
indices) in a file where the same line occurs more than once. Three attempts at moving one block put
it in the `finally` block, then after the `catch`, and finally destroyed the file — all because
`} catch (err) {` appears several times in it. Restore from git and use an anchored edit.
