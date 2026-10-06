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

**A test that names a project must name one this repository is entitled to name** — the fixture
(`scripts/test-skin.mjs`, id `test-skin`) or the built-in this package ships (`glass`), never a package's
own project. The framework owns the registry, the runtime, the settings page, the persistence and the
first-paint CONTRACT (`src/host/service.js`); a look or an enhancement owns its stylesheet, its
first-paint rows and its markers, and lives in its own repository —
`@fn-x/dsh-plugin-liquid-glass` and `dsh-ui-project-skeleton` are the two that exist. Three
consequences for anything added here:

- Fixtures use `scripts/test-skin.mjs`, whose id is `test-skin`. `src/**` used to contain one real
  project; since step 8c it contains none, and `scripts/verify.mjs` asserts that both ways round
  (a `boot()` harness holds exactly the fixture, and a package-less composition holds nothing).
- A suite may still name an INSTALLED package by its directory — `load-check.mjs` mounts the skin's
  real `lib/client.js`, and `browser-verify.mjs` drives it in a real browser. Those are tests of the
  framework driving a package, not the framework depending on one; the rule is about `src/**` CODE,
  which must name no project at all. Two things keep a name in `src/**` on purpose: a comment that
  records an incident keeps the name it happened under, because a neutralised comment loses the trace,
  and `persist.js`'s `LEGACY_LOCAL_KEYS` is a migration constant that has to keep the old spelling.
- The snapshot roots in `tools/snapshot.mjs` are where "every first-class package" is enumerated. A
  new package is a new root.

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

Nine rules, each one learned by getting it wrong — and three more added in phase 3, learned the same way.
They live here because every reader of this file touches one of them; the incidents that produced them,
with their numbers, are in `CHANGELOG.md`.

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
   added tomorrow cannot be forgotten. **`E:\dsh\tools` counts.** It is a `ROOTS` entry, and it holds the
   only copy of `snapshot.mjs` — a tree the snapshot protected while nothing protected the snapshot, until
   step 8e put it under git. (It held `derive-boot-css.mjs` too until step 56h-5 moved that tool into the
   package whose CSS it derives.) — Round 46 (the skeleton had been uncovered since it was created, and
   `dsh-plugin-liquid-glass` joined the workspace uncovered).
7. **A typed parameter creates a lifelong type constraint on its variable.** `param([string]$Framework)`
   means every later assignment to `$Framework` is silently coerced to a string — so
   `$framework = Get-ParameterSurface $Framework` leaves the variable a String, and the failure surfaces
   on the NEXT line pointing at the wrong place: `The property 'surface' cannot be found on this object`,
   about a property that is demonstrably there. Use a different name for the derived value
   (`$frameworkInfo = Get-ParameterSurface $Framework`), never the parameter's own name. — Round 49, 8e-1
   (`tools`-side `plugins/dsh-ui-projects/scripts/param-surface.ps1`; it cost that tool its first two runs,
   and the error named the wrong line both times).
8. **Assert the property, not the spelling that currently carries it.** An assertion has to name the thing
   it is about, and that thing is almost never the string, number or element that happens to encode it
   today. Five times an assertion here was written against the spelling instead, and every one of them
   either passed for the wrong reason or failed against correct code. **A proxy value:**
   `plugins/dsh-ui-projects/scripts/verify.mjs` asserted that the framework's card is not "presented as
   maintaining the framework" with `excludes(markup, 'dsh-ui-projects')` — a literal that ANY other mention
   of that name trips, including the one the maintenance hint legitimately carries; it now asserts the
   property, the card's own sentence read out of the dictionary. **A hand-built fixture:** two fixtures in
   that same file were hand-written dictionaries holding the keys the page happened to read at the time, so
   the day the page read an eighth key both threw `copy.contractNotScannedWhy is not a function` while the
   shipped dictionaries were fine — a fixture is a dictionary that does not exist, and `columnCopy()` is now
   the real dictionary with short stand-ins on top, so a key added to the page cannot leave it behind. **A
   count that belongs to somebody else:** the 18 findings of `dsh-cost-meter` are a fact about that
   package's current bundle, not about this suite's behaviour, so
   `plugins/dsh-ui-projects/scripts/browser-verify.mjs` asks for `>= 1` and for the badge's number to equal
   the number of findings the panel lists. What this project does pin — the SHA of a build artifact, the
   framework's own two accepted findings — is a snapshot, and says so where it is pinned, so a red result
   there means the input moved and never that the assertion was right. **The wrong element's text:** the
   framework's contract summary was checked by parsing the first number out of the row's whole
   `textContent`, which begins with `dsh-ui-projects@0.1.0` — the number was the version's `0`, and a
   correct panel failed with `expected 2, got 0`; twice in that group the answer was to publish a state hook
   and read it (`data-uip-contract-summary`, `data-uip-contract-limits`), and its sibling was a selector for
   a hook the component had never published at all. **A mechanism, and an invented policy:** two more
   assertions demanded that the skin's `box-shadow` WIN over a component's own stylesheet, and that
   enabling a second project leave the first one alone; both failed against correct code, because a project
   rule written as `:where(...)` is scoped with the marker INSIDE the `:where()` and therefore carries zero
   specificity on purpose, and because the framework allows one global look at a time by policy. "What I
   believe the implementation does" is a spelling too. — Round 48 (the proxy assertion), Round 49 and Round
   50/9b (the fixtures, the counts, and the four browser assertions).
9. **An insertion is proven by what it did not delete.** Every documentation edit here replaces a range of
   text, and the range is chosen by an anchor — so the anchor is the boundary you are inserting at
   **together with the whole line that follows it**, and that line comes back verbatim inside the
   replacement. Two habits make the result checkable rather than hopeful: a pure insertion is one whose
   `git diff --numstat` deletion column is `0`, and the count of `## Round` headings taken before and after
   an added round entry moves by exactly `+1`. The mistake this rule exists for is an insertion that
   consumed the heading of the round it was placed before, and it has happened three times: Round 50 ate
   Round 49's heading, Round 55's heading went the same way, and Round 56a's heading was eaten by the entry
   inserted above it. — Round 50, Round 55, Round 56a.

10. **A requirement added MID-ROUND gets its red first.** When the scope grows — a clause discovered while
    writing the green, a field a panel will need, a "while we are here" — the new claim is written as a
    failing assertion **before** the code that satisfies it, exactly as it would have been had it been in
    the plan. The alternative is not a shortcut: it is a suite that is fully green **and does not test the
    thing at all**, so "0 failing" stops meaning "done" and starts meaning "nobody has looked". Measured
    twice in phase 3: the `updateFailures` row landed with no assertion and 1432/0 was reported as a
    finish, and the `onUpdateFailure` signature landed while the call that uses it did not — a signature is
    not behaviour, and a `contains(source, 'name')` check matches the parameter list. **Ask what could make
    this assertion pass while the feature is broken** (rule 8), and if the answer is "the line I have
    already written", it is not an assertion about the feature.
11. **A commit message states what LANDED, never what was planned.** Two phase-3 commits described work
    that had not been done: one claimed the `request` injector had gained an optional second argument when
    only the intention existed, and one claimed a step was complete when only its signature was in the
    tree. The message is the only part of a commit that survives a squash, a rebase and a reader's
    patience — and a message that describes a plan makes the log actively misleading about what the code
    does. Before writing one, read `git diff --stat` and describe THAT. If part of the work is missing, the
    message says which part, or the commit waits.
12. **A progress report has three states, and "partly" is one of them.** Every hand-off says which of
    three things is true, by name: **landed** (with the files and lines), **not landed**, or **partly
    landed** (with the part that is). "Done" and "not done" are not a complete vocabulary: the phase-3
    segments repeatedly ended with a signature in the tree and its caller missing, or a module in place and
    its import not — states that a two-valued report rounds to "done" and a reader then trusts. The report
    is what the next action is planned from, so rounding up here costs the next round, not this one.

Rule 4 is the same discipline as `## Tool discipline` below, applied to bytes rather than to anchors:
mutate with the file tools, or in memory, and never leave the tree in a state only a test could have
caught. Rule 5 is the same discipline applied to what a guard is allowed to look at. Rule 6 is the same
discipline applied to the tree itself: what is not under a version control system is not recoverable, and
"it is in the repository" is a claim about exactly one directory. Rule 7 is the same discipline applied to
a PowerShell parameter: the type you declared is a constraint you keep, and its consequences appear one
statement later than the mistake. Rule 8 is the same discipline applied to the assertion itself: name the
property, not the string, count or element that currently spells it — and ask what could make this
assertion pass while the feature is broken, then assert that instead. Rule 9 is the same discipline applied
to the edit itself: the text on either side of an insertion is part of the insertion, and a heading that
disappears is a deletion nobody asked for.

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

A specification file was reported as living in `$env:USERPROFILE\.dsh\attachments\`. It was really read —
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
