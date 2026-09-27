# Updating and rolling back a UI project package

Three commands with three different promises: one records a restorable version, one records what is
installed now, and one — the only mode in this project allowed to write inside the source tree — puts an
older version back. This is the workflow, the on-disk layout, the rules each command refuses to break, and
the manual steps that verify it. Written because the commands are easy to run in the wrong ORDER, and
because two of the three write nothing at all: a reader deserves to know which one changed their machine.

## The boundary: no suite runs `install.ps1`

`install.ps1` writes `$DSH_HOME`. Automation does not run it in this project, and neither does any suite:
it is the user's to run, deliberately, after a dry run. The interface only **prints** the commands — a card
or a column never executes one — so nothing in this system starts a maintenance command on its own.

What IS automatic is five source guards in `scripts/verify.mjs`, which read the script's text and assert
that each mode still writes only what it promises:

| Guard | What it holds |
| --- | --- |
| `the update mode is a read-only plan, and refuses to pretend otherwise` | the only write verbs in the UPDATE branch aim at `$StateNew` / `$StatePath` |
| `the snapshot mode writes only inside the version store, and verifies what it wrote` | a snapshot never reaches into the source tree |
| `the rollback mode writes only the two source files it promises to, in the order it promises` | backup before write, and no third file |
| `the rollback listing half is read-only` | `-Rollback -List` opens and verifies, and writes nothing |
| `the uninstall script still contains every check it promises, where it promises it` | each promise and the dry run's position |

They catch a check being **deleted, renamed or moved**. They cannot catch one being **weakened** — a
comparison replaced by something that always passes reads the same to a source scan. The real verification
is a real run, which is why this document ends in an acceptance list rather than in a test.

## The three commands, and the order they go in

| Command | Writes | Never writes | Run it when |
| --- | --- | --- | --- |
| `install.ps1 -Snapshot` | a new snapshot directory under the profile's versions dir | the source tree, `settings.yaml`, the install record, the profile | before bringing in a new version, so there is something to come back to |
| `install.ps1 -Update` | one field of the install record: `lastVerified` | the source tree, `settings.yaml`, any snapshot | after the new version is in place, to record it as the new baseline |
| `install.ps1 -Rollback -To <name>` | `package.json` and `lib/**` in the source tree, plus a backup of what was there | `cordis.patch.yml`, `CHANGELOG.md`, `settings.yaml`, the snapshots | to go back to a recorded version, with `dsh web` stopped |

The order is the part that is easy to get wrong, so the script states it where the modes are implemented
(`install.ps1:1138`):

```text
    install.ps1 -Snapshot           record a restorable version
    git pull  &&  npm run build     the user brings the new version
    install.ps1 -Update             verify what is there, and record it as the new baseline
```

**`-Update` records; it does not restore, and it does not install.** It reads the recorded state and the
current build, reports the difference (package.json and `lib/client.js` hashes, the lib tree), and writes
`lastVerified` beside the record's own `before` — a new field, because overwriting that baseline would
destroy what `-Uninstall` compares against. If `lib/client.js` is missing it says so and names the fix
(`node scripts/build.mjs`) rather than comparing against nothing.

`-Snapshot` needs the build too: with no `lib/client.js` there is nothing to record, and it stops
(exit 1) instead of writing a partial version.

## The layout on disk

```text
<profile>/
  .dsh-ui-projects-install.json            the install record: before, lastVerified, lastRollback
  .dsh-ui-projects-versions/
    dsh-ui-projects/
      0.1.0-20260927T044712Z/              one snapshot
        manifest.json
        payload/
          package.json
          cordis.patch.yml
          CHANGELOG.md
          lib/**
    .rollback-backup/
      0.1.0-20260927T044712Z-20260927T051653Z/    one rollback backup
        manifest.json
        payload/{package.json, lib/**}
```

`$VersionsDir` is `<profile>/.dsh-ui-projects-versions` and `$PackageVersionsDir` is
`<VersionsDir>/dsh-ui-projects` (`install.ps1:489`). A **snapshot name becomes a directory name**, so
`-Name` is validated against `^[A-Za-z0-9._-]+$` and a name that does not match is refused with exit 2
before anything is read (`install.ps1:1395`). The default name is `<version>-<stamp>`, the stamp being UTC
`yyyyMMddTHHmmssZ` — which is why `0.1.0-20260927T044712Z` is one name and not three fields.

**What a snapshot records is what a package IS**: `package.json`, `cordis.patch.yml`, `CHANGELOG.md` (each
only if present) and every file under `lib/**`. An untracked notes file in the working directory is not
part of a version and is not copied (`install.ps1:1416`). `manifest.json` carries:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`; a manifest from a future format is still listed, with a warning |
| `tool` | `install.ps1 -Snapshot` — the marker that makes a directory *ours* |
| `name`, `package`, `version`, `revision` | what was recorded, and the `-Revision` note (never read from git) |
| `createdAt` | UTC round-trip time; this is what the interface formats for display |
| `sourceDir` | where it came from; a rollback refuses a snapshot taken from another tree |
| `payload` | file count, byte count, and the sha256 of the whole `lib/**` tree |
| `sourceTree` | the same for the source tree, excluding `.git`, `node_modules`, `lib` — evidence, not a payload |
| `settingsBlockSha256` | the hash of the `ui-projects` block of `settings.yaml`; evidence only, the block is never copied |
| `files[]` | one `{ rel, bytes, sha256 }` per recorded file |

Everything after the write is read back: every recorded file is re-hashed against the manifest, and a
snapshot that does not match is **removed** and reported (exit 1) rather than left to be discovered during
a rollback. Older snapshots are untouched by that (`install.ps1:1508`).

**A directory is only ever pruned if its own manifest says this tool wrote it.** Anything else found in
the versions directory is listed with what it is and left alone — the tool reads the manifest rather than
trusting a directory name (`install.ps1:384`, `:1525`).

## Retention: three of each, and the two counts sort differently

Both kinds are pruned to `-Keep`, default **3** (`install.ps1:101`), floored at 1 so `-Keep 0` cannot mean
"delete everything". The two are ordered differently, and the difference is deliberate:

- **Snapshots** are ordered newest-first by `createdAt`, then by `name` as a tiebreak
  (`install.ps1:390`). The list a reader sees — in `-ListVersions`, `-Rollback -List`, and the plugins
  column — is that same order.
- **Backups** are ordered by directory **name**, descending (`install.ps1:1786`). A backup name is
  `<snapshot>-<stamp>`, and the stamp is UTC `yyyyMMddTHHmmssZ`, so name order *is* time order — and it is
  the only ordering available for a directory whose manifest might be unreadable.

`-Snapshot -DryRun` prints the snapshot names that would be pruned **before** anything is written
(`install.ps1:1482`), and the real run prints them again as it prunes. Pruning happens only after the new
snapshot has verified, so a failed snapshot never evicts a good one.

## Restoring: exactly two things, and six refusals before anything is written

A rollback restores `package.json` and `lib/**`. That is the whole list
(`install.ps1:1586`). `cordis.patch.yml` and `CHANGELOG.md` are **in** the snapshot and are deliberately
**not** restored: making the running version correct does not require them, and every extra write is a risk
this project has already paid for.

**The loader patch is the interesting case.** If the `cordis.patch.yml` in the snapshot differs from the
one in the tree — present/absent, or a different hash — the rollback **refuses** (exit 1) and prints both
hashes, because that file decides how the plugin composes and this command does not write it:

```text
   REFUSED  the cordis.patch.yml in the snapshot differs from the one in the tree.
            This command does not restore that file. Pass -Force to roll back anyway,
            or align the patch by hand first.
```

`-Force` proceeds — and says what it is doing — while still not writing that file. When the two are
identical it reports that nothing is at stake.

Every refusal below happens **before the mode has written anything at all**, including before the backup:

| Refusal | Exit |
| --- | --- |
| `-To` does not match `^[A-Za-z0-9._-]+$` | 2 |
| no snapshot directory with that name | 1 |
| the directory was not written by this tool (`ours` is false) | 1 |
| the snapshot does not verify against its own manifest | 1 |
| the snapshot's `sourceDir` is not this source tree | 1 |
| the snapshot records no `package.json` and no `lib/**`, so there is nothing to restore | 1 |
| `cordis.patch.yml` differs and `-Force` was not passed | 1 |

Then, and only then, in this order: **backup → read the backup back → restore → re-verify**.

1. **Backup.** The current `package.json` and `lib/**` are copied to
   `<VersionsDir>\.rollback-backup\<To>-<stamp>\`, in the same snapshot format with the same manifest
   (tool: `install.ps1 -Rollback backup`), and that copy is verified by reading it back. A backup that does
   not verify stops the run with the source tree still untouched — and the message prints the number of
   problems as well as the first eight, because a total layout failure once read as a partial copy.
2. **Restore.** `package.json` and every `lib/**` file recorded in the snapshot are copied in.
3. **Re-verify.** Every restored file is re-hashed against the snapshot's manifest. If any file does not
   match, the tree is **put back from the backup taken moments ago**, both paths are printed, and the run
   exits 1 — with both copies still on disk for a person to inspect. `Done` is never printed for a rollback
   that did not verify.

## The rollback's rollback

The backup directory above is the answer to "and if the rollback was the mistake". It is a complete,
self-verifying copy of the two things a rollback touches, and the procedure is by hand:

```powershell
# the path is printed by the rollback itself, under "Done"
$backup = 'C:\Users\<you>\.dsh\profiles\web\.dsh-ui-projects-versions\.rollback-backup\<name>-<stamp>'
Copy-Item "$backup\payload\package.json" 'E:\dsh\plugins\dsh-ui-projects\package.json' -Force
Copy-Item "$backup\payload\lib\*" 'E:\dsh\plugins\dsh-ui-projects\lib\' -Recurse -Force
```

The newest **three** backups are kept, pruned by name after a successful rollback
(`install.ps1:1784`). Older ones are deleted; if a specific one matters, copy it out of the versions
directory before running another rollback.

Two fields in the install record are worth knowing, because they are the only trace a rollback leaves:

```jsonc
"lastVerified": { "at": "…", "by": "install.ps1 -Update", "version": "0.1.0",
                  "baseline": "…", "payload": { "sha256": "…" }, "source": { … } },
"lastRollback": { "at": "…", "by": "install.ps1 -Rollback",
                  "from": { "version": "0.1.0", "libTreeSha256": "…" },
                  "to":   { "name": "0.1.0-20260927T044712Z", "version": "0.1.0", "libTreeSha256": "…" },
                  "backupPath": "…", "forced": false }
```

Both are written the same way: a new file beside the record, read back while the original is still in
place, and only then moved over it. On a bad read-back the original is left untouched and the partial file
is named in the message (`install.ps1:1343`, `:1811`).

## Read-only modes, exit codes, and one preflight trap

| Mode | Reads | Exit |
| --- | --- | --- |
| `-ListVersions` | every snapshot, verifying each against its manifest | 0; 1 if any snapshot fails to verify |
| `-Rollback -List` | the same, and says per snapshot whether it is `restorable` | 0; 1 if any snapshot is `NOT restorable` |
| `-Snapshot -DryRun`, `-Update -DryRun`, `-Rollback … -DryRun`, `-Uninstall -DryRun` | the plan, the findings, and what would be written | 0 |

Otherwise: **0** succeeded, **1** a check failed or a refusal fired (the record is kept), **2** the command
line itself was wrong — two modes at once, `-Rollback` without `-To` or `-List`, a name or `-To` value that
is not a valid directory name. A usage error says `Nothing was run and nothing was written.`

**The trap:** preflight runs before the mode branches and it is unconditional
(`install.ps1:683`). Even `-ListVersions`, which writes nothing and never calls `dsh`, requires a resolvable
`dsh` launcher **and** `pnpm` on PATH, and aborts with exit 1 if either is missing. That is deliberate —
the script refuses to edit YAML by hand as a fallback — but it means "I only wanted to list the versions"
can end at `ABORT` on a machine whose PATH is not set up for plugin work.

## Manual acceptance

Run these in order. Steps 1–3 are read-only or additive; step 4 is destructive by design and step 5 is the
one that moves the source tree. Stop `dsh web` before step 5 — the command cannot tell whether it is
running and will not pretend to (`install.ps1:1597`).

1. **The plan, and what it would record.**
   `powershell -File install.ps1 -Snapshot -DryRun`
   Expect: exit 0; `Snapshot plan` (`keep the newest 3; the oldest are named before they go`),
   `What this run found` (version, payload count and bytes, lib tree sha, source tree sha), and a
   `Retention` section naming what would be pruned. Nothing is written.

2. **A real snapshot, and its read-back.**
   `powershell -File install.ps1 -Snapshot`
   Expect: exit 0; `<n>/<n> files` verified, `Retention` naming what is kept and what was pruned, and
   `Done`. Then `powershell -File install.ps1 -ListVersions` lists it first and verifies it
   (`restorable`). Re-running with the same name must refuse (`a snapshot named … already exists`) rather
   than overwrite.

3. **Recording the baseline after a change.**
   `powershell -File install.ps1 -Update`
   Expect: exit 0; `What this run found` comparing package.json and `lib/client.js` against the recorded
   hashes, then `Recorded` with `lastVerified written`, and the closing note that the source tree,
   `settings.yaml` and the snapshots were not touched.

4. **The truncation negative case: a damaged snapshot is refused, not restored.**
   Take a scratch snapshot you do not need — `install.ps1 -Snapshot -Name l2-negative` — then truncate one
   file inside it, for example:

   ```powershell
   $snap = 'C:\Users\<you>\.dsh\profiles\web\.dsh-ui-projects-versions\dsh-ui-projects\l2-negative\payload\lib\client.js'
   $bytes = [System.IO.File]::ReadAllBytes($snap)
   [System.IO.File]::WriteAllBytes($snap, $bytes[0..([int]($bytes.Length / 2))])
   ```

   Expect, in this order:
   - `-ListVersions` reports `l2-negative: does NOT match its manifest` and **exits 1** for the whole run;
   - `-Rollback -List` prints `NOT restorable` for it and **also exits 1** — neither listing is a write;
   - `-Rollback -To l2-negative` prints `REFUSED  l2-negative does not verify, so it will not be restored`,
     exits 1, and has written **nothing** — no backup directory is created, and the source tree's
     fingerprint is unchanged;
   - cleanup is by hand: the tool never deletes a damaged snapshot on its own. Delete that one directory.

5. **The rollback, and the rollback's rollback.**
   With `dsh web` stopped:
   `powershell -File install.ps1 -Rollback -To <good name> -DryRun` → expect the plan, `What this run found`
   (`will change : package.json <sha> -> <sha>`, `will change : lib/** n file(s)`), the patch verdict, and
   `Will not be touched`.
   Then `powershell -File install.ps1 -Rollback -To <good name>` → expect `Backup verified`, `Restoring`,
   `Re-verify OK (n file(s) match the snapshot)`, `lastRollback written to …`, and `Done` naming the backup
   path. Start `dsh web` again and confirm the restored version is what loads (Settings › UI prints the
   package version on the card).
   Finally, if the rollback itself was the mistake, copy the two paths back from the backup printed in
   `Done` — the procedure in "The rollback's rollback" above.

## Where the coverage lives

| Driver | Covers | How to run |
| --- | --- | --- |
| `scripts/verify.mjs` (offline) | the five source guards above, the client-side copy that prints the commands, and the four states of the version sentence a card shows | `node scripts/verify.mjs`, or one test: `DSH_TEST_ONLY="…" node scripts/verify.mjs` |
| `scripts/browser-verify.mjs` (real Chrome) | that the commands are rendered on the cards and in the column, and that opening the projects page alone asks the host for the version store | gate first: `--verify-refusal`, then `--no-write` |
| `install.ps1` itself (manual) | every behaviour in this document: retention, refusal, restore, re-verify, the record's two fields | the acceptance list above |

Nothing in this project runs `install.ps1` for you, and no test claims to have verified a write that only a
real run can perform.
