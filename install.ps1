<#
.SYNOPSIS
    Install (or remove) dsh-ui-projects in a dsh profile, using dsh's own plugin
    command rather than hand-editing YAML.

.DESCRIPTION
    WHY THIS SHAPE
    --------------
    An earlier install.ps1 wired the plugin by rewriting the profile's
    `cordis.patch.yml` by hand. That is the fragile path: the profile patch file
    is a top-level YAML sequence whose empty state is literally `[]`, so wiring
    by hand means replacing `[]` with an insert block and restoring it later.
    The restore is what failed: the surviving backup
    (`cordis.patch.yml.bak-dsh-ui-projects`) is still present, while
    `cordis.patch.yml` itself is gone -- the rollback deleted the file instead of
    writing the backup back over it.

    dsh already provides the supported mechanism, and this script uses it:

        dsh plugin --profile <name> add <path>

    is a thin pnpm forwarder. It initialises the profile if needed, runs
    `pnpm add`, then reconciles `dsh.profile.bundles` against the installed state
    -- any dependency whose package.json declares `dsh.bundle.patch` is appended
    to the bundle layer list, and removed again when it stops being one. So:

      * no YAML is ever edited by this script;
      * the profile's own patch layer is left untouched and its entry count is
        asserted unchanged, which is how we prove we did not touch it;
      * installing the package IS the wiring, because this package carries
        `dsh.bundle.patch` and `dsh.client.platform: web`.

    Verified behaviour, not assumed: pnpm records a LOCAL DIRECTORY DEPENDENCY as
    `link:` -- a directory symlink, not a copy:

        "dsh-ui-projects": "link:E:/dsh/plugins/dsh-ui-projects"

    Two consequences shape the checks below. First, the profile reads `lib/`
    through the link, so rebuilding in the source tree needs no reinstall. Second,
    and far more important: because the profile contains only a link, a careless
    removal could in principle reach the real source tree. Every path here
    therefore asserts, after the fact, that the source tree's manifest and built
    bundle are byte-unchanged. Given that this project has already lost its source
    tree twice, that assertion is the point of the script as much as installing is.

    WHAT IT NEVER DOES
    ------------------
    It never edits `cordis.patch.yml`, never deletes anything under the source
    tree, never runs `pnpm install` by hand, and never touches a dsh installation
    directory. `-Uninstall` leaves backups in place and reports where they are.

    The symbolic-link probe writes one temporary directory under $env:TEMP and
    removes it. It runs in `-DryRun` too, on purpose: link creation on Windows
    needs Developer Mode or elevation, and that is exactly the fact worth knowing
    before a real install starts. Pass -SkipLinkProbe to suppress it.

.PARAMETER DryRun
    Print the plan and every check, and change nothing.

.PARAMETER Uninstall
    Remove the plugin from the profile and verify the removal.

.PARAMETER Profile
    Profile name. Defaults to "web".

.PARAMETER ProfileDir
    Absolute path to the profile directory. Overrides -Profile.

.PARAMETER SourceDir
    Absolute path to the dsh-ui-projects package. Defaults to the directory this
    script lives in.

.PARAMETER SkipLinkProbe
    Skip the temporary symbolic-link capability probe.

.EXAMPLE
    powershell -File install.ps1 -DryRun
    Show exactly what would happen, then stop.

.EXAMPLE
    powershell -File install.ps1
    Install into the web profile.

.EXAMPLE
    powershell -File install.ps1 -Uninstall
    Remove it again.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Uninstall,
    [switch]$Update,
    [switch]$Snapshot,
    [switch]$ListVersions,
    [string]$Name = '',
    [string]$Revision = '',
    [int]$Keep = 3,
    [int]$Changes = 1,
    [switch]$SkipLinkProbe,
    [string]$Profile = 'web',
    [string]$ProfileDir,
    [string]$SourceDir,
    [string]$DshCommand = ''
)

Set-StrictMode -Version 2.0

$ErrorActionPreference = 'Stop'

$PackageName = 'dsh-ui-projects'
$StateFileName = '.dsh-ui-projects-install.json'
$LockFileName = 'pnpm-lock.yaml'
$PatchFileName = 'cordis.patch.yml'

# ------------------------------------------------------------------- encoding
#
# Windows PowerShell 5.1's Get-Content defaults to the system ANSI code page, so
# any UTF-8 file holding non-ASCII text comes back as mojibake and the
# ConvertFrom-Json after it fails with a syntax error that never mentions
# encoding. dsh-cost-meter's package.json is exactly such a file. Every read and
# write here goes through these helpers, pinning UTF-8 on both sides; writes emit
# no BOM, because a BOM would prepend U+FEFF to the first line of a YAML file or
# of the state JSON read back later.

# $false = do not emit a byte-order mark.
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-TextFile([string]$Path) {
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Read-JsonFile([string]$Path) {
    return (Read-TextFile $Path) | ConvertFrom-Json
}

function Read-TextLines([string]$Path) {
    return [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)
}

function Write-TextFile([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# ------------------------------------------------- StrictMode-safe JSON access
#
# Set-StrictMode -Version 2.0 turns two ordinary PowerShell idioms into runtime
# throws, and both sit right on the path this script depends on:
#
#   * `$obj.PSObject.Properties.Name` -- the obvious way to list an object's keys
#     -- THROWS when the object has no properties at all. That is not an edge
#     case: it is the state of every profile with no dependencies yet, i.e. the
#     normal first install.
#   * reading a property that does not exist throws, so even `$m.dsh.bundle.patch`
#     as a presence test explodes when it is absent -- the exact case it is meant
#     to detect.
#
# Every read of a JSON document therefore goes through these helpers, and nothing
# else touches .PSObject directly.

# Whether a JSON object carries a named property. Tolerates $null.
function Test-JsonProperty($Object, [string]$Name) {
    if ($null -eq $Object) { return $false }
    return $null -ne $Object.PSObject.Properties[$Name]
}

# One property's value, or $Default when the object is null or lacks the key.
function Get-JsonProperty($Object, [string]$Name, $Default) {
    if (-not (Test-JsonProperty $Object $Name)) { return $Default }
    return $Object.PSObject.Properties[$Name].Value
}

# A JSON ARRAY field, always as an array. Two traps are handled here: a missing
# or null field must not become `@($null)` (whose Count is 1), and the collection
# must not be unrolled on the way out -- hence `-NoEnumerate`. Callers must NOT
# wrap the call in @(). Only for fields that are JSON arrays; an object-shaped
# field comes back as a one-element array, which is why `dependencies` is read
# with Test-JsonProperty instead.
function Get-JsonArray($Object, [string]$Name) {
    $value = Get-JsonProperty $Object $Name $null
    if ($null -eq $value) { Write-Output -NoEnumerate ([object[]]@()); return }
    Write-Output -NoEnumerate ([object[]]@($value))
}

# An object's property names, as an array. A JSON object with no properties has no
# names, and `$obj.PSObject.Properties.Name` THROWS in that case under StrictMode --
# so the members are enumerated explicitly instead. -NoEnumerate for the same
# reason Get-JsonArray uses it: callers must NOT wrap the call in @().
function Get-JsonNames($Object) {
    if ($null -eq $Object) { Write-Output -NoEnumerate ([object[]]@()); return }
    $names = @($Object.PSObject.Properties | ForEach-Object { $_.Name })
    Write-Output -NoEnumerate ([object[]]$names)
}

# The profile's bundle layer list, with every link of the path guarded.
function Get-ProfileBundles($Manifest) {
    $dsh = Get-JsonProperty $Manifest 'dsh' $null
    $profile = Get-JsonProperty $dsh 'profile' $null
    return Get-JsonArray $profile 'bundles'
}

# Whether the manifest declares a dependency by name.
function Test-ProfileDependency($Manifest, [string]$Name) {
    return Test-JsonProperty (Get-JsonProperty $Manifest 'dependencies' $null) $Name
}

# ------------------------------------------------------------------- reporting

function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Write-Plan([string]$Text) {
    Write-Host "   PLAN   $Text" -ForegroundColor Yellow
}

function Write-Skip([string]$Text) {
    Write-Host "   SKIP   $Text" -ForegroundColor DarkGray
}

function Write-Ok([string]$Text) {
    Write-Host "   OK     $Text" -ForegroundColor Green
}

function Write-Note([string]$Text) {
    Write-Host "   NOTE   $Text" -ForegroundColor DarkCyan
}

function Write-Warn([string]$Text) {
    Write-Host "   WARN   $Text" -ForegroundColor Magenta
}

# --------------------------------------------------------------- small helpers

# Count the loader patch entries in a profile patch file (0 when absent).
function Get-PatchEntryCount([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
    $entries = @(Read-TextLines $Path | Where-Object { $_ -match '^\s*-\s' })
    return $entries.Count
}

# The `ui-projects:` block of the settings document, as text, or $null when absent.
#
# Read as a BLOCK rather than hashed whole. dsh rewrites its own bookkeeping in that
# file while it runs -- measured in Round 35: with `--no-write` in force, the mtime
# and the revision keys still moved -- so a whole-file hash reports changes this
# script did not make, and a check that cries wolf is a check that gets ignored.
# What must not move is the SUBTREE, which is where the user's choices live: the
# switch list and the per-project settings (a recorded verification among them).
#
# The extraction is deliberately line-based: a YAML parser is not available in
# Windows PowerShell 5.1, and this file's shape is one top-level key per column 0.
function Get-SettingsBlock([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $lines = @(Read-TextLines $Path)
    $start = -1
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match '^ui-projects:') { $start = $index; break }
    }
    if ($start -lt 0) { return $null }
    $end = $lines.Count
    for ($index = $start + 1; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match '^\S') { $end = $index; break }
    }
    return (($lines[$start..($end - 1)]) -join "`n")
}

# Resolve a directory symlink's absolute target, or $null when the path is not a
# link. A relative target resolves against the link's own directory, not the
# process working directory.
function Get-LinkTarget([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.LinkType) { return $null }
    $target = @($item.Target) | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($target)) { return $null }
    if (-not [System.IO.Path]::IsPathRooted($target)) {
        $target = Join-Path (Split-Path -Parent $Path) $target
    }
    return [System.IO.Path]::GetFullPath($target)
}

# Top-level package directory names inside a node_modules folder.
function Get-NodeModulesInventory([string]$NodeModulesDir) {
    if (-not (Test-Path -LiteralPath $NodeModulesDir -PathType Container)) { return @() }
    $names = New-Object System.Collections.ArrayList
    foreach ($entry in Get-ChildItem -LiteralPath $NodeModulesDir -Directory -Force -ErrorAction SilentlyContinue) {
        if ($entry.Name -eq '.bin') { continue }
        if ($entry.Name.StartsWith('@')) {
            foreach ($scoped in Get-ChildItem -LiteralPath $entry.FullName -Directory -Force -ErrorAction SilentlyContinue) {
                [void]$names.Add("$($entry.Name)/$($scoped.Name)")
            }
            continue
        }
        [void]$names.Add($entry.Name)
    }
    return @($names | Sort-Object)
}

# One sha256 over every file under a root, excluding named directories.
#
# Relative paths are normalized to `/` and sorted before hashing, so the value does not depend on the
# order the filesystem happens to return directory entries in. The sort is PowerShell's default string
# sort -- the same one the manual fingerprint command in `docs/` uses, which is what makes the two
# agree. This is a SELF-CONSISTENT fingerprint for comparing one machine against itself, not a
# canonical cross-tool hash.
function Get-TreeFingerprint([string]$Root, [string[]]$Exclude) {
    $summary = [pscustomobject]@{ files = 0; bytes = 0; sha256 = 'n/a' }
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $summary }
    $lines = New-Object System.Collections.ArrayList
    $files = 0
    $bytes = 0
    $stack = New-Object System.Collections.Stack
    $stack.Push($Root)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        foreach ($entry in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
            if ($entry.PSIsContainer) {
                if ($Exclude -contains $entry.Name) { continue }
                $stack.Push($entry.FullName)
                continue
            }
            $files += 1
            $bytes += $entry.Length
            $rel = $entry.FullName.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
            [void]$lines.Add("$rel $(Get-Sha256 $entry.FullName)")
        }
    }
    $joined = (@($lines | Sort-Object) -join "`n")
    $sha = [System.BitConverter]::ToString(
        (New-Object System.Security.Cryptography.SHA256Managed).ComputeHash([System.Text.Encoding]::UTF8.GetBytes($joined))
    ).Replace('-', '').ToLowerInvariant()
    return [pscustomobject]@{ files = $files; bytes = $bytes; sha256 = $sha }
}

# A hash's first 16 characters, or whatever there is when it is not a hash at all.
#
# `'n/a'.Substring(0, 16)` throws, and the places that print a short hash are exactly the places that
# can be handed a placeholder: a tree that is not there, a file that was never hashed. Under StrictMode
# that throw is the end of the whole run, which is how a missing build becomes a stack trace instead of
# a diagnosis. Every short hash in this script goes through here.
function Get-ShortSha([string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) { return '(none)' }
    if ($Value.Length -le 16) { return $Value }
    return $Value.Substring(0, 16)
}

# The sha256 of a string, lowercase, the same construction the manual fingerprint command uses.
#
# Needed because `Get-Sha256` hashes a FILE, and one of the things recorded here is a value rather than a
# path: the settings block's hash, which is evidence that the user's record was left alone.
function Get-TextSha([string]$Text) {
    return [System.BitConverter]::ToString(
        (New-Object System.Security.Cryptography.SHA256Managed).ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
    ).Replace('-', '').ToLowerInvariant()
}

# Every version snapshot under a package's versions directory, newest first.
#
# A snapshot is a directory holding `manifest.json` and a `payload` directory. Anything else found there
# is returned too, with `ours = $false`: the pruning step deletes only what this tool wrote, and the only
# way to know that is to read the manifest back rather than to trust a directory name.
function Get-VersionSnapshots([string]$PackageVersionsDir) {
    $found = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $PackageVersionsDir -PathType Container)) { return @() }
    foreach ($entry in @(Get-ChildItem -LiteralPath $PackageVersionsDir -Directory -Force -ErrorAction SilentlyContinue)) {
        $manifestPath = Join-Path $entry.FullName 'manifest.json'
        $manifest = $null
        if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
            try { $manifest = Read-JsonFile $manifestPath } catch { $manifest = $null }
        }
        [void]$found.Add([pscustomobject]@{
            name = $entry.Name
            dir = $entry.FullName
            manifest = $manifest
            ours = ([string](Get-JsonProperty $manifest 'tool' '') -eq 'install.ps1 -Snapshot')
            schemaVersion = Get-JsonProperty $manifest 'schemaVersion' 0
            version = [string](Get-JsonProperty $manifest 'version' '')
            createdAt = [string](Get-JsonProperty $manifest 'createdAt' '')
        })
    }
    return @($found | Sort-Object -Property createdAt, name -Descending)
}

# Verify one snapshot against its own manifest: every recorded file present and byte-identical.
#
# The same comparison runs in three places -- after writing, when listing, and (in 7c) before restoring --
# because a copy nobody re-read is a copy nobody has checked. A truncated or edited file is therefore a
# REPORTED failure rather than a surprise during a rollback.
function Test-VersionSnapshot([string]$SnapshotDir) {
    $manifestPath = Join-Path $SnapshotDir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        return [pscustomobject]@{ ok = $false; checked = 0; total = 0; problems = @(); reason = 'no manifest.json' }
    }
    $manifest = $null
    try { $manifest = Read-JsonFile $manifestPath }
    catch { return [pscustomobject]@{ ok = $false; checked = 0; total = 0; problems = @(); reason = 'manifest.json is not readable JSON' } }
    $files = @(Get-JsonProperty $manifest 'files' @())
    if ($files.Count -eq 0) {
        return [pscustomobject]@{ ok = $false; checked = 0; total = 0; problems = @(); reason = 'the manifest lists no files' }
    }
    $problems = New-Object System.Collections.ArrayList
    $checked = 0
    foreach ($record in $files) {
        $rel = [string](Get-JsonProperty $record 'rel' '')
        $expected = [string](Get-JsonProperty $record 'sha256' '')
        if ($rel -eq '') { [void]$problems.Add('<a manifest entry with no rel>'); continue }
        $abs = Join-Path (Join-Path $SnapshotDir 'payload') $rel.Replace('/', '\')
        if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { [void]$problems.Add("missing: $rel"); continue }
        if ((Get-Sha256 $abs) -ne $expected) { [void]$problems.Add("changed: $rel"); continue }
        $checked += 1
    }
    # And the other direction: a payload holding files the manifest never listed is not what was recorded.
    $payloadRoot = Join-Path $SnapshotDir 'payload'
    if (Test-Path -LiteralPath $payloadRoot -PathType Container) {
        $listed = @($files | ForEach-Object { ([string](Get-JsonProperty $_ 'rel' '')).Replace('\', '/') })
        $present = @(Get-ChildItem -LiteralPath $payloadRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
            ForEach-Object { $_.FullName.Substring($payloadRoot.Length).TrimStart('\', '/').Replace('\', '/') })
        foreach ($rel in $present) { if ($listed -notcontains $rel) { [void]$problems.Add("unrecorded: $rel") } }
    }
    return [pscustomobject]@{ ok = ($problems.Count -eq 0); checked = $checked; total = $files.Count; problems = @($problems); reason = '' }
}

# Remove a directory LINK, never its target.
#
# `pnpm remove` has been observed deleting the dependency and the bundle layer
# while leaving the node_modules link itself in place. Removing that leftover is
# only safe because it is a link: the deletion must reach the reparse point and
# stop. So it goes through Directory.Delete(path, recursive:false), which is
# documented to remove the link and nothing else -- deliberately NOT
# `Remove-Item -Recurse`, whose behaviour on a directory link has varied across
# PowerShell versions and which, on a package linked straight at its source tree,
# is one bug away from deleting the source. The refusal below is the guard: if the
# path is not a link, this throws rather than deletes.
function Remove-DirectoryLink([string]$Path) {
    if ((Get-LinkTarget $Path) -eq $null) {
        throw "refusing to delete $Path because it is not a link; deleting it could destroy real data"
    }
    [System.IO.Directory]::Delete($Path, $false)
}

# Fail loudly with a message the user can act on.
function Stop-With([string]$Text) {
    Write-Host ''
    Write-Host "   ABORT  $Text" -ForegroundColor Red
    Write-Host ''
    exit 1
}

# ---------------------------------------------------------------- resolve paths

$dshHome = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($dshHome)) {
    $dshHome = Join-Path $HOME '.dsh'
}

if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
    $ProfileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
}
$ProfileDir = [System.IO.Path]::GetFullPath($ProfileDir)

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        Stop-With 'cannot infer the source directory; pass -SourceDir explicitly'
    }
    $SourceDir = $PSScriptRoot
}
$SourceDir = [System.IO.Path]::GetFullPath($SourceDir)

$ManifestPath = Join-Path $ProfileDir 'package.json'
$PatchPath = Join-Path $ProfileDir $PatchFileName
$LockPath = Join-Path $ProfileDir $LockFileName
$NodeModulesDir = Join-Path $ProfileDir 'node_modules'
$LinkPath = Join-Path $NodeModulesDir $PackageName
$StatePath = Join-Path $ProfileDir $StateFileName
# The version store, defined HERE rather than inside the mode that uses it.
#
# Round 40's crash came from one branch assuming a variable another branch had defined, and the fix was
# a comment saying a branch must define what it reads. A path that several modes need belongs in this
# list instead, where every mode can see it and none has to guess.
$VersionsDir = Join-Path $ProfileDir '.dsh-ui-projects-versions'
$PackageVersionsDir = Join-Path $VersionsDir $PackageName

# `dsh plugin --profile <name>` resolves the profile from DSH_HOME itself and is
# never told about -ProfileDir. If the two disagree, this script would verify one
# directory while dsh edited another -- two half-configured profiles and a
# verification report about neither. Refuse the mismatch instead.
$profileDirFromHome = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $dshHome 'profiles') $Profile))
if ($ProfileDir -ne $profileDirFromHome) {
    Stop-With @"
-ProfileDir and DSH_HOME disagree:
           -ProfileDir          $ProfileDir
           DSH_HOME\profiles\...  $profileDirFromHome
         'dsh plugin' resolves the profile from DSH_HOME and cannot be pointed
         elsewhere, so point DSH_HOME at the home you mean instead of passing
         -ProfileDir to a different profile.
"@
}

# The modes are mutually exclusive on purpose: each has a different promise about what it writes, and a
# command that could be read as two of them at once would have no honest promise at all.
#
# `-Snapshot -ListVersions` is refused at the top of the SNAPSHOT section instead of here, so that the
# refusal sits with the two names it is about -- and so that this check does not make that one dead code.
$modeSwitches = @()
if ($Uninstall) { $modeSwitches += '-Uninstall' }
if ($Update) { $modeSwitches += '-Update' }
if ($Snapshot) { $modeSwitches += '-Snapshot' }
if ($ListVersions) { $modeSwitches += '-ListVersions' }
$pairHandledBelow = ($modeSwitches.Count -eq 2 -and $Snapshot -and $ListVersions)
if ($modeSwitches.Count -gt 1 -and -not $pairHandledBelow) {
    Write-Host ''
    Write-Host "   REFUSED  $($modeSwitches -join ' and ') are different modes; pass one of them."
    Write-Host '            Nothing was run and nothing was written.'
    Write-Host ''
    exit 2
}

$mode = if ($Uninstall) { 'UNINSTALL' } elseif ($Update) { 'UPDATE' } elseif ($Snapshot) { 'SNAPSHOT' } elseif ($ListVersions) { 'LIST-VERSIONS' } else { 'INSTALL' }
if ($DryRun) { $mode = "$mode (dry run)" }

Write-Head 'Target'
Write-Host "   DSH_HOME    $dshHome"
Write-Host "   profile dir $ProfileDir"
Write-Host "   source dir  $SourceDir"
Write-Host "   mode        $mode"

# ------------------------------------------------------------- dsh invocation
#
# This script drives `dsh` to do the wiring, but `dsh` is NOT necessarily on
# PATH. Launching the harness as `npx @deepseek-ai/dsh web` never installs a
# global `dsh` binary, so a bare `Get-Command dsh` preflight aborts on a setup
# that works perfectly well. The launcher is therefore resolved once, here, and
# every call goes through Invoke-Dsh.
#
# Resolution order:
#   1. -DshCommand, when given, wins outright. The value is split on whitespace
#      into a command plus simple flags; quoting inside it is NOT parsed, so a
#      launcher whose own path contains spaces needs the command and the flag
#      passed as separate words that this split keeps together -- or just a
#      PATH entry that resolves it.
#   2. an actual `dsh` on PATH.
#   3. `npx --yes @deepseek-ai/dsh`, once a version probe confirms it runs.
#      `--yes` is explicit so npx never stops to ask whether to install the
#      package, and no version is pinned so npx resolves it itself.
#   4. otherwise abort, reporting what the probe actually said.

$script:DshExe = $null
$script:DshArgs = @()
$script:DshPath = ''
$script:DshProbe = ''
$script:DshHow = ''

# Whitespace split: a command plus simple flags. Deliberately does not attempt
# to honour quotes -- see the note above.
function Split-CommandLine([string]$CommandLine) {
    return @($CommandLine -split '\s+' | Where-Object { $_ -ne '' })
}

function Resolve-DshLauncher([string]$Explicit) {
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        # @() around the call is load-bearing. A function returning a one-element
        # array unrolls to the bare element, so a single-word -DshCommand arrives
        # here as a plain string -- and under Set-StrictMode -Version 2.0 a
        # string has no .Count, which throws. (A multi-word value stays an array
        # and hides the bug, which is exactly how this got caught twice.)
        $parts = @(Split-CommandLine $Explicit)
        $script:DshExe = $parts[0]
        # Assigned in two steps on purpose: `$x = if (...) { @() } else { @() }`
        # can collapse an empty array to $null, and @($null) is a ONE-element
        # array, which would then be splatted as a stray empty argument.
        $script:DshArgs = @()
        if ($parts.Count -gt 1) { $script:DshArgs = @($parts[1..($parts.Count - 1)]) }
        $script:DshPath = [string](Get-Command $script:DshExe -ErrorAction SilentlyContinue).Source
        $script:DshHow = 'from -DshCommand'
        return $true
    }

    $onPath = Get-Command 'dsh' -ErrorAction SilentlyContinue
    if ($onPath) {
        $script:DshExe = 'dsh'
        $script:DshArgs = @()
        $script:DshPath = [string]$onPath.Source
        $script:DshHow = 'found on PATH'
        return $true
    }

    $npx = Get-Command 'npx' -ErrorAction SilentlyContinue
    if ($npx) {
        # The probe is the authority on whether `npx --yes @deepseek-ai/dsh` runs
        # here. It can fail for reasons unrelated to dsh -- an unwritable npm
        # cache, a proxy, no network on a cold cache -- so its output is reported
        # verbatim rather than summarised away.
        # The probe runs through `cmd /c ... 2>&1` on purpose.
        #
        # This script sets $ErrorActionPreference = 'Stop'. Under it, PowerShell
        # converts a native command's stderr into ErrorRecords, and a redirected
        # `2>&1` then raises a TERMINATING NativeCommandError -- so the script dies
        # inside the probe, before it can print the abort message that explains
        # what went wrong. npm writes all of its diagnostics to stderr, so an
        # unreachable registry or an unwritable cache would otherwise abort the
        # preflight silently. Merging the two streams inside cmd leaves PowerShell
        # reading stdout text only, which is what we actually want here.
        $probeOutput = & cmd /c 'npx --yes @deepseek-ai/dsh --version 2>&1'
        $probeCode = $LASTEXITCODE
        $flat = (@($probeOutput) | Where-Object { $_ -ne '' } | Select-Object -First 2) -join ' / '
        $script:DshProbe = "npx --yes @deepseek-ai/dsh --version -> exit $probeCode" +
            $(if ($flat -ne '') { ": $flat" } else { '' })
        if ($probeCode -eq 0) {
            $script:DshExe = 'npx'
            $script:DshArgs = @('--yes', '@deepseek-ai/dsh')
            $script:DshPath = [string]$npx.Source
            $script:DshHow = 'via npx'
            return $true
        }
    }
    return $false
}

# Run the resolved launcher with extra arguments.
#
# The arguments MUST be splatted through a variable. `& $exe @('a','b')` is an
# array SUBEXPRESSION, not splatting: it hands the callee a single space-joined
# argument, which makes dsh fail with "--profile <name> is required" because it
# never sees `plugin` as the command. Splatting is `@name`, so the arrays are
# concatenated into one variable first.
#
# The exit status is recorded in a script-scoped variable rather than returned.
# A function's return value IS its output stream, so `return $LASTEXITCODE` next
# to a native command's stdout yields an ARRAY of the command's output plus the
# status -- and `$status -ne 0` is then true even on success, producing a bogus
# abort that quotes pnpm's own progress lines as the "exit code". Recording the
# status instead keeps stdout flowing to the console, where the user wants it.
$script:DshExitCode = 0

function Invoke-Dsh([string[]]$Arguments) {
    $all = @($script:DshArgs) + @($Arguments)
    if ($all.Count -eq 0) {
        & $script:DshExe
    }
    else {
        & $script:DshExe @all
    }
    $script:DshExitCode = $LASTEXITCODE
}

# The launcher plus arguments as one printable line, for plans and logs.
function Format-Dsh([string[]]$Arguments) {
    return (@($script:DshExe) + @($script:DshArgs) + @($Arguments)) -join ' '
}

# ================================================================ PREFLIGHT ===

Write-Head 'Preflight'

if (Resolve-DshLauncher $DshCommand) {
    Write-Ok "dsh command : $(Format-Dsh @())"
    if ($script:DshPath -ne '') { Write-Note "resolved at : $($script:DshPath)  ($($script:DshHow))" }
    else { Write-Note "resolved    : $($script:DshHow)" }
    if ($script:DshProbe -ne '') { Write-Note "probe       : $($script:DshProbe)" }
}
else {
    $probeLine = if ($script:DshProbe -ne '') { "`n         probe  : $($script:DshProbe)" } else { '' }
    Stop-With @"
no way to run dsh was found.
         Tried, in order: -DshCommand (not given), a 'dsh' on PATH, and
         'npx --yes @deepseek-ai/dsh'.$probeLine
         Pass the launcher explicitly, for example:
           -DshCommand "npx --yes @deepseek-ai/dsh"
"@
}

$pnpm = Get-Command 'pnpm' -ErrorAction SilentlyContinue
if ($pnpm) { Write-Ok "pnpm on PATH  : $($pnpm.Source)" }
else { Stop-With 'pnpm is not on PATH; `dsh plugin` forwards to it, and this script will not fall back to editing YAML by hand' }

if (-not (Test-Path -LiteralPath $ProfileDir -PathType Container)) {
    Stop-With "profile directory does not exist: $ProfileDir"
}
Write-Ok 'profile directory exists'

# The damaged-profile guard. Without a manifest, `dsh plugin` silently
# re-initialises the profile from the shipped template, which resets
# dsh.profile.bundles and drops any third-party bundle already registered.
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    Stop-With @"
the profile has no package.json at $ManifestPath
         Installing now would make dsh re-initialise the profile from the shipped
         template and silently drop every third-party bundle already registered.
         Repair the profile first:  powershell -File tools\repair-profile.ps1 -DryRun
"@
}
Write-Ok 'profile manifest exists'

$sourceManifest = Join-Path $SourceDir 'package.json'
if (-not (Test-Path -LiteralPath $sourceManifest -PathType Leaf)) {
    Stop-With "no package.json in the source directory: $SourceDir"
}
$sourcePkg = Read-JsonFile $sourceManifest
$sourceName = Get-JsonProperty $sourcePkg 'name' ''
if ($sourceName -ne $PackageName) {
    Stop-With "source package is named $sourceName, expected $PackageName"
}

# Read through the guarded accessors rather than as `$sourcePkg.dsh.bundle.patch`:
# under StrictMode that expression throws when the declaration is ABSENT, which is
# precisely the condition this check exists to detect.
$sourceDsh = Get-JsonProperty $sourcePkg 'dsh' $null
$sourcePatch = Get-JsonProperty (Get-JsonProperty $sourceDsh 'bundle' $null) 'patch' $null
if ([string]::IsNullOrWhiteSpace($sourcePatch)) {
    Stop-With 'source package declares no dsh.bundle.patch, so installing it would not wire a loader row'
}

$sourcePlatform = Get-JsonProperty (Get-JsonProperty $sourceDsh 'client' $null) 'platform' $null
if ($sourcePlatform -ne 'web') {
    Stop-With "source package declares dsh.client.platform = $sourcePlatform, expected web"
}

$sourceVersion = Get-JsonProperty $sourcePkg 'version' '?'
Write-Ok "source package is $PackageName v$sourceVersion with a bundle patch and a web client half"

foreach ($artifact in 'lib/index.js', 'lib/client.js') {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDir $artifact) -PathType Leaf)) {
        Stop-With "missing build artifact $artifact; run: node scripts/build.mjs"
    }
}
Write-Ok 'build artifacts present (lib/index.js, lib/client.js)'

# ---- link capability (informational) --------------------------------------
#
# pnpm records this dependency as a directory link. Creating one on Windows can
# need Developer Mode or elevation, so it is worth knowing about early -- but this
# probe is ADVISORY and never gates the install. Measured on the machine this was
# written on: `New-Item -ItemType SymbolicLink` fails with "Administrator
# privilege required" while pnpm's own link creation succeeds in the very same
# session. Treating the PowerShell result as authoritative would therefore abort
# installs that work perfectly well. The real `dsh plugin add` below is the
# arbiter; if it fails, it fails loudly with the backups left in place.
if ($SkipLinkProbe) {
    Write-Skip 'link capability probe skipped (-SkipLinkProbe)'
}
else {
    $probeRoot = Join-Path $env:TEMP ("dsh-linkprobe-" + [System.Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null

        # A junction needs no privilege, so if a symlink is refused a junction is
        # the link type pnpm can still fall back to.
        $junctionOk = $false
        try {
            New-Item -ItemType Junction -Path (Join-Path $probeRoot 'junction') -Target $SourceDir -ErrorAction Stop | Out-Null
            $junctionOk = $true
        }
        catch { }

        try {
            New-Item -ItemType SymbolicLink -Path (Join-Path $probeRoot 'link') -Target $SourceDir -ErrorAction Stop | Out-Null
            Write-Ok 'directory symlinks are creatable (probe removed)'
        }
        catch {
            Write-Note "PowerShell could not create a directory symlink: $($_.Exception.Message)"
            if ($junctionOk) { Write-Note 'A directory junction IS creatable, which is the link type pnpm can use instead.' }
            Write-Note 'This does NOT block the install on its own: pnpm creates the link itself.'
        }
    }
    finally {
        if (Test-Path -LiteralPath $probeRoot) { Remove-Item -Recurse -Force $probeRoot -ErrorAction SilentlyContinue }
    }
}

# ================================================================ UNINSTALL ===

if ($Uninstall) {
    Write-Head 'Uninstall plan'

    $state = $null
    if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
        $state = Read-JsonFile $StatePath
        $installedAt = Get-JsonProperty $state 'installedAt' 'an unknown time'
        Write-Ok "found install record (installed $installedAt)"
    }
    else {
        Write-Warn "no install record ($StateFileName); proceeding on the live state alone"
    }

    $patchBefore = Get-PatchEntryCount $PatchPath
    $sourceManifestSha = Get-Sha256 $sourceManifest
    $sourceBundle = Join-Path $SourceDir 'lib/client.js'
    $sourceBundleSha = if (Test-Path -LiteralPath $sourceBundle -PathType Leaf) { Get-Sha256 $sourceBundle } else { $null }
    # The user's data in the settings document, captured before anything runs. See
    # Get-SettingsBlock for why this is a block and not a whole-file hash.
    $settingsPath = Join-Path $dshHome 'settings.yaml'
    $settingsBlockBefore = Get-SettingsBlock $settingsPath
    # The inventory as it stands NOW, for the neighbours check below.
    #
    # Not the one in the install record: that one is a snapshot taken BEFORE the install
    # ran, so it is stale by construction. Measured on the machine this was written on:
    # 4 entries recorded, 20 present, and the package itself missing from its own record.
    # Comparing against it would report sixteen "gained entries" on a healthy uninstall.
    $inventoryBefore = @(Get-NodeModulesInventory $NodeModulesDir)

    if ($DryRun) {
        Write-Plan "run: $(Format-Dsh @('plugin', '--profile', $Profile, 'remove', $PackageName))"
        Write-Plan 'then assert: dependency gone, bundle layer gone, patch entries unchanged'
        Write-Plan 'then assert: the source tree is byte-unchanged'
        Write-Plan 'then assert: the ui-projects block of settings.yaml unchanged, no pnpm tombstone left, no other node_modules entry changed'

        <#
          The plan above is generic; this section is about THIS profile. A dry run that
          only prints what it would do leaves the reader to find out what it would find
          -- and the questions that matter are answerable by reading, which is free.
        #>
        Write-Head 'What this run found'
        $dryManifest = Read-JsonFile $ManifestPath
        $dryDeclared = Test-ProfileDependency $dryManifest $PackageName
        $dryBundled = (Get-ProfileBundles $dryManifest) -contains $PackageName
        if ($dryDeclared -or $dryBundled) {
            Write-Note "wired already: dependency=$dryDeclared, bundle layer=$dryBundled -- the command above is what removes it"
        }
        else {
            Write-Note 'the profile does not declare it any more; the run would skip the command and go straight to the checks'
        }
        if (-not (Test-Path -LiteralPath $LinkPath)) {
            Write-Note 'node_modules entry: absent'
        }
        else {
            $dryLink = Get-LinkTarget $LinkPath
            if ($dryLink -eq $null) { Write-Warn "node_modules entry: a REAL DIRECTORY (not a link) at $LinkPath" }
            else { Write-Note "node_modules entry: a link to $dryLink" }
        }
        $dryTombstones = @(Get-ChildItem -LiteralPath $NodeModulesDir -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like '.ignored_*' -and $_.Name -like "*$PackageName*" })
        if ($dryTombstones.Count -eq 0) { Write-Note 'pnpm tombstone (.ignored_*): none' }
        else { Write-Warn "pnpm tombstone present: $(($dryTombstones | ForEach-Object { $_.FullName }) -join ', ')" }
        if ($settingsBlockBefore -eq $null) {
            Write-Note 'settings.yaml: no ui-projects block (nothing to preserve)'
        }
        else {
            Write-Note 'settings.yaml: a ui-projects block is present and will be compared before and after'
        }

        <#
          The five things a person about to paste a removal command most needs to read
          before they paste it. Four of them are user data (the switch list, the
          per-project settings including a recorded verification, the source tree they
          built this package in, and the version snapshots taken of it); the fifth is
          every other package in the profile.
        #>
        Write-Head 'Will not be touched'
        Write-Note "the source tree          $SourceDir"
        Write-Note "settings.yaml            $settingsPath"
        Write-Note "other packages           every other entry under $NodeModulesDir, compared before and after this run"
        Write-Note 'the checklist record     ui-projects.settings in settings.yaml (user data; see Round 36)'
        Write-Note "version snapshots        $PackageVersionsDir   (a package going away is not a reason to forget a version)"

        Write-Head 'Dry run'
        Write-Host '   Nothing was run. Re-run without -DryRun to apply.'
        exit 0
    }

    Write-Head 'Removing'

    # Re-runnable on purpose. pnpm refuses to remove a dependency that is already
    # gone (ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS), and a second run is precisely
    # what the leftover-link case below needs -- so an already-absent dependency is
    # a skip, not a failure.
    $manifestBeforeRemove = Read-JsonFile $ManifestPath
    $stillDeclared = (Test-ProfileDependency $manifestBeforeRemove $PackageName) -or
        ((Get-ProfileBundles $manifestBeforeRemove) -contains $PackageName)

    if ($stillDeclared) {
        Invoke-Dsh @('plugin', '--profile', $Profile, 'remove', $PackageName)
        if ($script:DshExitCode -ne 0) {
            Stop-With "dsh plugin remove exited $($script:DshExitCode); the profile was left as it was so you can inspect it"
        }
        Write-Ok 'dsh plugin remove exited 0'
    }
    else {
        Write-Skip "$PackageName is not a profile dependency; skipping dsh plugin remove"
    }

    # ---- assertions --------------------------------------------------------
    Write-Head 'Verify'

    $failed = 0
    $manifest = Read-JsonFile $ManifestPath

    if (Test-ProfileDependency $manifest $PackageName) {
        Write-Warn "$PackageName is still a profile dependency"
        $failed++
    }
    else { Write-Ok 'no longer a profile dependency' }

    $bundles = Get-ProfileBundles $manifest
    if ($bundles -contains $PackageName) {
        Write-Warn "$PackageName is still in dsh.profile.bundles (remaining: $($bundles -join ', '))"
        $failed++
    }
    else { Write-Ok "removed from dsh.profile.bundles (remaining: $($bundles -join ', '))" }

    $patchAfter = Get-PatchEntryCount $PatchPath
    if ($patchAfter -eq $patchBefore) { Write-Ok "profile patch layer untouched ($patchAfter entries)" }
    else {
        Write-Warn "patch entries changed: $patchBefore -> $patchAfter"
        $failed++
    }

    # Clear the leftover link BEFORE the source-integrity checks below, so those
    # checks also cover this deletion. That ordering is the whole point: the one
    # operation in this script that could conceivably reach the source tree is
    # removing this link, and these two assertions are what prove it did not.
    if (-not (Test-Path -LiteralPath $LinkPath)) {
        Write-Ok 'the profile node_modules entry is gone'
    }
    elseif ((Get-LinkTarget $LinkPath) -eq $null) {
        Write-Warn "a real directory (not a link) remains at $LinkPath"
        Write-Host '         this is a real COPY of the package inside the profile, not a symlink. The uninstall does not touch it.'
        Write-Host "         to delete it:  Remove-Item -Recurse `"$LinkPath`"   (confirm first that you did not put it there)"
    }
    else {
        $leftoverTarget = Get-LinkTarget $LinkPath
        Write-Note "pnpm left the node_modules link behind: $LinkPath -> $leftoverTarget"
        try {
            Remove-DirectoryLink $LinkPath
            Write-Ok "leftover link removed ($(if (Test-Path -LiteralPath $LinkPath) { 'still present!' } else { 'link gone, target untouched' }))"
        }
        catch {
            Write-Warn "could not remove the leftover link: $($_.Exception.Message)"
            $failed++
        }
    }

    # pnpm's tombstone: instead of deleting a package directory it cannot release, pnpm
    # renames it to `.ignored_<name>` (and can also park it under `node_modules/.ignored`).
    #
    # The listing never consults one -- `src/host/profile-scan.js` resolves BY NAME from
    # the profile's `dependencies` and never walks node_modules, so a tombstone can never
    # be mistaken for an installed package, and that is documented there as deliberate.
    # What is left is disk residue whose NAME reads as "still installed" to a person
    # looking at the folder, which is exactly the kind of thing an uninstall should not
    # leave unexplained. A tombstone that is a link is removed with the same guard as the
    # leftover link above; a real directory is reported and left alone, like the case above.
    $tombstones = New-Object System.Collections.ArrayList
    foreach ($entry in @(Get-ChildItem -LiteralPath $NodeModulesDir -Force -ErrorAction SilentlyContinue)) {
        if ($entry.Name -like '.ignored_*' -and $entry.Name -like "*$PackageName*") { [void]$tombstones.Add($entry.FullName) }
    }
    $ignoredParked = Join-Path (Join-Path $NodeModulesDir '.ignored') $PackageName
    if (Test-Path -LiteralPath $ignoredParked) { [void]$tombstones.Add($ignoredParked) }

    if ($tombstones.Count -eq 0) {
        Write-Ok 'no pnpm tombstone (.ignored_*) left for this package'
    }
    else {
        foreach ($tombstone in @($tombstones)) {
            if ((Get-LinkTarget $tombstone) -eq $null) {
                Write-Warn "a pnpm tombstone is a REAL DIRECTORY, left in place: $tombstone"
                Write-Host "         remove it yourself if it is stale:  Remove-Item -Recurse `"$tombstone`""
                $failed++
            }
            else {
                try {
                    Remove-DirectoryLink $tombstone
                    Write-Ok "tombstone link removed (its target was not touched): $tombstone"
                }
                catch {
                    Write-Warn "could not remove the tombstone link $tombstone : $($_.Exception.Message)"
                    $failed++
                }
            }
        }
    }

    # The important ones: removing a link dependency must never touch its target.
    # Run after the link removal above, and note that a non-zero result here is the
    # single most serious thing this script can report.
    if ((Get-Sha256 $sourceManifest) -eq $sourceManifestSha) { Write-Ok 'source package.json byte-unchanged' }
    else {
        Write-Warn "the source package.json CHANGED during uninstall: $SourceDir"
        $failed++
    }
    if ($sourceBundleSha -ne $null) {
        if ((Get-Sha256 $sourceBundle) -eq $sourceBundleSha) { Write-Ok 'source lib/client.js byte-unchanged' }
        else {
            Write-Warn "the source lib/client.js CHANGED during uninstall: $sourceBundle"
            $failed++
        }
    }

    # The user's data, which an uninstall must not touch (Round 36): the switch list in
    # `ui-projects.enabled` and the per-project settings, a recorded verification among
    # them. Nothing in this script edits that file, and this is the assertion that says
    # so -- "we did not write it" is a claim until something checks.
    $settingsBlockAfter = Get-SettingsBlock $settingsPath
    if ($settingsBlockBefore -eq $null -and $settingsBlockAfter -eq $null) {
        Write-Skip 'settings.yaml has no ui-projects block (nothing to preserve)'
    }
    elseif ($settingsBlockBefore -eq $null) {
        Write-Note 'settings.yaml gained a ui-projects block during the uninstall (that is dsh writing, not this script)'
    }
    elseif ($settingsBlockAfter -eq $null) {
        Write-Warn "settings.yaml LOST its ui-projects block during the uninstall: switches and recorded verifications are user data"
        $failed++
    }
    elseif ($settingsBlockBefore -eq $settingsBlockAfter) {
        Write-Ok 'settings.yaml: the ui-projects block is byte-unchanged (switches and recorded verifications survive)'
    }
    else {
        Write-Warn 'settings.yaml: the ui-projects block CHANGED during the uninstall'
        Write-Host '         expected it to be identical; compare the file against your own copy before trusting the result'
        $failed++
    }

    if ($state -ne $null) {
        $lockRecord = Get-JsonProperty $state 'before' $null
        $lockRecord = Get-JsonProperty $lockRecord 'lockFile' $null
        $lockBackup = Get-JsonProperty $lockRecord 'backup' $null
        if (-not [string]::IsNullOrWhiteSpace($lockBackup)) {
            $backupPath = Join-Path $ProfileDir $lockBackup
            if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
                Write-Note "lockfile backup kept (NOT restored): $lockBackup"
                Write-Note 'restore it yourself only if you know the current lockfile is wrong'
            }
        }
    }

    # Did the removal take anything else with it, or bring something new in?
    #
    # The baseline is this run's OWN before-snapshot, not the install record. The record's
    # inventory is taken before the install runs, so it goes stale the moment anything else
    # is installed -- on the machine this was written on it holds 4 entries against 20
    # present today, and does not even contain this package. A check built on it would
    # report sixteen "gained entries" on a healthy uninstall, which is how a check teaches
    # its reader to ignore it.
    #
    # Run after the link and tombstone handling above, because both of those are supposed
    # to change the inventory.
    $nowInventory = @(Get-NodeModulesInventory $NodeModulesDir)
    $gone = @($inventoryBefore | Where-Object { $nowInventory -notcontains $_ })
    $added = @($nowInventory | Where-Object { $inventoryBefore -notcontains $_ })
    $unexpectedGone = @($gone | Where-Object { $_ -ne $PackageName })
    if ($unexpectedGone.Count -eq 0 -and $added.Count -eq 0) {
        $removed = if ($gone.Count -eq 0) { 'nothing' } else { $gone -join ', ' }
        Write-Ok "no other node_modules entry changed (this run removed: $removed)"
    }
    else {
        if ($unexpectedGone.Count -gt 0) {
            Write-Warn "node_modules lost entries that are NOT $PackageName : $($unexpectedGone -join ', ')"
        }
        if ($added.Count -gt 0) {
            Write-Warn "node_modules gained entries during an uninstall: $($added -join ', ')"
        }
        $failed++
    }

    # The install record's own inventory, reported for context and never as a verdict: it
    # is the pre-install snapshot described above, so drift is expected rather than wrong.
    if ($state -ne $null) {
        $beforeRecord = Get-JsonProperty $state 'before' $null
        $recordedInventory = Get-JsonProperty $beforeRecord 'nodeModules' $null
        if ($recordedInventory -ne $null) {
            $recordedDrift = @(@($recordedInventory) | Where-Object { $nowInventory -notcontains $_ })
            Write-Note "install record lists $(@($recordedInventory).Count) node_modules entries (taken before the install); $($recordedDrift.Count) of them are gone now"
        }
    }

    # A lockfile that still names the package would mean pnpm removed the dependency from
    # the manifest without rewriting its lock. Reported, NOT failed: whether a `link:`
    # dependency legitimately survives in the lockfile's importers section has not been
    # measured here, and asserting an unmeasured rule is how a check starts lying (see the
    # refusal self-check that once validated an invented payload).
    if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
        $lockHits = @(Select-String -LiteralPath $LockPath -SimpleMatch -Pattern $PackageName -ErrorAction SilentlyContinue)
        if ($lockHits.Count -eq 0) { Write-Ok "$LockFileName no longer names $PackageName" }
        else {
            Write-Warn "$LockFileName still names $PackageName on $($lockHits.Count) line(s)"
            Write-Note 'check by hand whether that is legitimate for a link dependency before treating it as a failure'
        }
    }

    if ($failed -eq 0) {
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        Write-Head 'Done'
        Write-Host '   Plugin removed and verified. The source tree is untouched.'
    }
    else {
        Write-Host ''
        Write-Warn "$failed check(s) did not pass. The install record was kept at $StateFileName"
        Write-Warn 'so a later run can still see what this install changed.'
    }
    exit $(if ($failed -eq 0) { 0 } else { 1 })
}

# =================================================================== UPDATE ===

if ($Update) {
    Write-Head 'Update plan'
    Write-Plan 'read the recorded state and the current build; write nothing in the source tree'
    Write-Plan 'then assert: the profile still links this source, the record is unchanged, no other package moved'
    Write-Plan 'then report the diff; nothing is written in this mode (7c implements recording)'
    Write-Plan 'this mode never runs dsh, never edits YAML, never copies or deletes a file'

    <#
      `-Update` VERIFIES AND REPORTS. It writes nothing at all -- not the source tree, not the install
      record, not the profile. Three duties live in three commands on purpose, because the ORDER is the
      part that is easy to get wrong:

          install.ps1 -Snapshot           record the version that is running now
          git pull  &&  npm run build     the user brings the new version
          install.ps1 -Update             verify what is there, and report the difference

      This round implements the PLAN only. Without -DryRun the mode refuses rather than half-working, so
      no path inside this branch can write anything at all; `scripts/verify.mjs` asserts exactly that,
      and 7c will add the recording step together with the guard that permits it.
    #>
    if (-not $DryRun) {
        Write-Host ''
        Write-Host '   REFUSED  -Update without -DryRun is not implemented yet (7c implements it).'
        Write-Host '            This round implements the plan only: re-run with -DryRun.'
        Write-Host '            Nothing was run and nothing was written.'
        Write-Host ''
        exit 2
    }

    $settingsPath = Join-Path $dshHome 'settings.yaml'
    $settingsBlock = Get-SettingsBlock $settingsPath

    # The baseline chain, stated because a file-level diff can only be as precise as what was written
    # down: the newest version snapshot when one exists (7b writes those), otherwise the install record,
    # which carries two hashes and nothing more.
    $recorded = $null
    if (Test-Path -LiteralPath $StatePath -PathType Leaf) { $recorded = Read-JsonFile $StatePath }
    $recordedBefore = Get-JsonProperty $recorded 'before' $null
    $recordedSource = Get-JsonProperty $recordedBefore 'source' $null
    $recordedManifestSha = Get-JsonProperty $recordedSource 'manifestSha256' $null
    $recordedBundleSha = Get-JsonProperty $recordedSource 'clientBundleSha256' $null
    $recordedAt = Get-JsonProperty $recorded 'installedAt' ''

    $currentManifest = Read-JsonFile $sourceManifest
    $currentVersion = Get-JsonProperty $currentManifest 'version' '?'

    # Both paths are resolved HERE, in this branch, and that is not decoration.
    #
    # `Set-StrictMode -Version 2.0` turns a reference to an undefined variable into a thrown
    # VariableIsUndefined, which is how the FIRST manual dry run of this mode ended: `$sourceBundle` was
    # defined in the UNINSTALL branch and assumed here, and the run died on it before printing anything.
    # A branch that reads a name must define it, even when the same name exists further up the file --
    # and only a real run could have found this: the source guards were green throughout.
    $nowManifestSha = Get-Sha256 $sourceManifest
    $sourceBundle = Join-Path $SourceDir 'lib/client.js'
    $nowBundleSha = $null
    if (Test-Path -LiteralPath $sourceBundle -PathType Leaf) {
        $nowBundleSha = Get-Sha256 $sourceBundle
    }
    else {
        Write-Warn "lib/client.js is missing at $sourceBundle; run: node scripts/build.mjs"
    }

    Write-Head 'What this run found'
    if ($recorded -eq $null) {
        Write-Warn "no install record ($StateFileName); the comparison below has no baseline"
    }
    else {
        Write-Note "recorded at install : $recordedAt"
    }
    Write-Note "current version     : $currentVersion"
    if ($recordedManifestSha -eq $null) {
        Write-Skip 'package.json        : no recorded hash to compare against'
    }
    elseif ($recordedManifestSha -eq $nowManifestSha) {
        Write-Ok "package.json        : unchanged since the record ($(Get-ShortSha $nowManifestSha))"
    }
    else {
        Write-Warn "package.json        : CHANGED since the record (was $(Get-ShortSha $recordedManifestSha), now $(Get-ShortSha $nowManifestSha))"
    }
    if ($nowBundleSha -eq $null) {
        Write-Skip 'lib/client.js       : not built, so there is nothing to compare (see the warning above)'
    }
    elseif ($recordedBundleSha -eq $null) {
        Write-Skip 'lib/client.js       : no recorded hash to compare against'
    }
    elseif ($recordedBundleSha -eq $nowBundleSha) {
        Write-Ok "lib/client.js       : unchanged since the record ($(Get-ShortSha $nowBundleSha))"
    }
    else {
        Write-Warn "lib/client.js       : CHANGED since the record (was $(Get-ShortSha $recordedBundleSha), now $(Get-ShortSha $nowBundleSha))"
    }

    $libTree = Get-TreeFingerprint (Join-Path $SourceDir 'lib') @()
    Write-Note "lib/**              : $($libTree.files) files, $($libTree.bytes) bytes, sha $(Get-ShortSha $libTree.sha256)"
    $sourceTree = Get-TreeFingerprint $SourceDir @('.git', 'node_modules', 'lib')
    Write-Note "source tree         : $($sourceTree.files) files, $($sourceTree.bytes) bytes, sha $(Get-ShortSha $sourceTree.sha256)   (excludes .git, node_modules, lib)"
    if ($recorded -ne $null -and $nowBundleSha -ne $null -and $recordedManifestSha -eq $nowManifestSha -and $recordedBundleSha -eq $nowBundleSha) {
        Write-Note 'verdict             : NOTHING TO UPDATE -- the build matches what the record was taken against'
    }
    elseif ($recorded -ne $null) {
        Write-Note 'verdict             : this build DIFFERS from the recorded one; 7c would record the new state'
    }

    # Registry capability, not a registry query: the query itself lands after the packages are published
    # (step 8). What is worth saying today is which case this profile is in.
    $profileManifest = Read-JsonFile $ManifestPath
    $spec = Get-JsonProperty (Get-JsonProperty $profileManifest 'dependencies' $null) $PackageName ''
    if ($spec -like 'link:*') {
        Write-Note "registry            : skipped -- the dependency spec is $spec, so there is no registry version to query"
    }
    elseif ([string]::IsNullOrWhiteSpace($spec)) {
        Write-Skip "registry            : the profile does not declare $PackageName"
    }
    else {
        Write-Note "registry            : the dependency spec is $spec; the query lands once the packages are published (step 8)"
    }
    if (-not [string]::IsNullOrWhiteSpace($Revision)) {
        Write-Note "revision            : $Revision (recorded only -- this mode never calls git)"
    }

    $changelogPath = Join-Path $SourceDir 'CHANGELOG.md'
    $wanted = [Math]::Max($Changes, 1)
    Write-Head "CHANGELOG (newest $wanted section(s) of the candidate)"
    if (-not (Test-Path -LiteralPath $changelogPath -PathType Leaf)) {
        Write-Skip 'the candidate ships no CHANGELOG.md'
    }
    else {
        $changelogLines = @(Read-TextLines $changelogPath)
        $headings = New-Object System.Collections.ArrayList
        for ($index = 0; $index -lt $changelogLines.Count; $index++) {
            if ($changelogLines[$index] -match '^##\s') { [void]$headings.Add($index) }
        }
        if ($headings.Count -eq 0) {
            Write-Skip 'the changelog has no "## " sections to show'
        }
        else {
            $take = [Math]::Min($wanted, $headings.Count)
            for ($section = 0; $section -lt $take; $section++) {
                $from = $headings[$section]
                $to = if ($section + 1 -lt $headings.Count) { $headings[$section + 1] } else { $changelogLines.Count }
                $body = @($changelogLines[$from..($to - 1)])
                $cap = 40
                if ($body.Count -gt $cap) {
                    $body = @($body[0..($cap - 1)]) + @("   ... $($body.Count - $cap) more line(s); see CHANGELOG.md")
                }
                foreach ($line in $body) { Write-Host "   $line" }
            }
            Write-Note 'the changelog is round-based, not version-based: these are the newest sections, and the install record time is the reference point'
        }
    }

    Write-Head 'Recorded state (evidence only; this mode never writes it)'
    if ($settingsBlock -eq $null) {
        Write-Note 'no ui-projects block in settings.yaml'
    }
    else {
        $blockLines = @($settingsBlock -split "`n")
        Write-Note "the ui-projects block is $($blockLines.Count) line(s); it is compared byte-for-byte by -Update, never rewritten here"
        $enabledIds = @()
        foreach ($line in $blockLines) {
            if ($line -match '^\s{4}-\s+(.+)$') { $enabledIds += $Matches[1].Trim() }
        }
        if ($enabledIds.Count -eq 0) { Write-Note '  enabled : (nothing recorded)' }
        else { Write-Note "  enabled : $($enabledIds -join ', ')" }
        $settingsLine = @($blockLines | Where-Object { $_ -match '^\s{2}settings:' })
        # The line already carries its own label, so it is printed as it is: prefixing it printed
        # `settings: settings: {}` on the first manual run of this mode.
        if ($settingsLine.Count -gt 0) { Write-Note "  $($settingsLine[0].Trim())" }
    }

    Write-Head 'Will not be touched'
    Write-Note "the source tree          $SourceDir"
    Write-Note "settings.yaml            $settingsPath"
    Write-Note "other packages           every other entry under $NodeModulesDir"
    Write-Note 'the checklist record     ui-projects.settings in settings.yaml (user data; see Round 36)'

    Write-Head 'Dry run'
    Write-Host '   Nothing was run. -Update without -DryRun is not implemented yet (7c implements it).'
    exit 0
}

# =================================================================== SNAPSHOT ===

# Refused with both names in play, before either of them opens the directory they share: one of these
# modes writes there and the other only reads, and a combined invocation is the one a person reaches for
# by accident. The general mode matrix above deliberately leaves this pair to this check, so that the
# refusal sits with the two names it is about instead of making this branch dead code.
if ($Snapshot -and $ListVersions) {
    Write-Host ''
    Write-Host '   REFUSED  -Snapshot and -ListVersions are different modes; pass one of them.'
    Write-Host '            Nothing was run and nothing was written.'
    Write-Host ''
    exit 2
}

if ($Snapshot) {
    Write-Head 'Snapshot plan'
    Write-Plan 'record the version that is running now: package.json, cordis.patch.yml, CHANGELOG.md and lib/**'
    Write-Plan 'write them under the profile''s versions directory, plus a manifest with a sha256 per file'
    Write-Plan 'read every written file back and compare it against that manifest'
    Write-Plan "keep the newest $([Math]::Max($Keep, 1)); the oldest are named before they go"
    Write-Plan 'this mode never writes inside the source tree, never runs dsh, never touches settings.yaml'

    # A snapshot name becomes a directory name, so it is validated as one: no separators, no `..`, nothing
    # that could leave the versions directory even if a caller passes it by accident.
    if (-not [string]::IsNullOrWhiteSpace($Name)) {
        if ($Name -notmatch '^[A-Za-z0-9._-]+$') {
            Write-Host ''
            Write-Host "   REFUSED  -Name must match ^[A-Za-z0-9._-]+$ (got: $Name)."
            Write-Host '            Nothing was run and nothing was written.'
            Write-Host ''
            exit 2
        }
    }

    $sourceClientBundle = Join-Path $SourceDir 'lib/client.js'
    if (-not (Test-Path -LiteralPath $sourceClientBundle -PathType Leaf)) {
        Write-Warn "nothing to record: $sourceClientBundle does not exist; run: node scripts/build.mjs"
        exit 1
    }

    $sourceManifestNow = Read-JsonFile $sourceManifest
    $SnapshotVersion = [string](Get-JsonProperty $sourceManifestNow 'version' '0.0.0')
    $SnapshotStamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $SnapshotName = if (-not [string]::IsNullOrWhiteSpace($Name)) { $Name } else { "$SnapshotVersion-$SnapshotStamp" }

    # What a package IS, not what somebody's working directory contains: the manifest, the loader patch,
    # the changelog, and the build output under `lib/**. An untracked notes file is not part of a version.
    $payloadFiles = New-Object System.Collections.ArrayList
    foreach ($rel in @('package.json', 'cordis.patch.yml', 'CHANGELOG.md')) {
        $abs = Join-Path $SourceDir $rel
        if (Test-Path -LiteralPath $abs -PathType Leaf) {
            [void]$payloadFiles.Add([pscustomobject]@{ rel = $rel; abs = $abs })
        }
        else {
            Write-Skip "not present, so not recorded: $rel"
        }
    }
    $libRoot = Join-Path $SourceDir 'lib'
    foreach ($entry in @(Get-ChildItem -LiteralPath $libRoot -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object FullName)) {
        $rel = 'lib/' + $entry.FullName.Substring($libRoot.Length).TrimStart('\', '/').Replace('\', '/')
        [void]$payloadFiles.Add([pscustomobject]@{ rel = $rel; abs = $entry.FullName })
    }

    $libTree = Get-TreeFingerprint $libRoot @()
    $sourceTree = Get-TreeFingerprint $SourceDir @('.git', 'node_modules', 'lib')
    $settingsBlockNow = Get-SettingsBlock (Join-Path $dshHome 'settings.yaml')
    $settingsBlockSha = if ($settingsBlockNow -eq $null) { '' } else { Get-TextSha $settingsBlockNow }

    $manifestFiles = @()
    foreach ($file in $payloadFiles) {
        $manifestFiles += [pscustomobject]@{
            rel = $file.rel
            bytes = (Get-Item -LiteralPath $file.abs).Length
            sha256 = Get-Sha256 $file.abs
        }
    }
    $manifest = [pscustomobject]@{
        schemaVersion = 1
        tool = 'install.ps1 -Snapshot'
        name = $SnapshotName
        package = $PackageName
        version = $SnapshotVersion
        revision = $Revision
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        sourceDir = $SourceDir
        payload = [pscustomobject]@{
            files = $payloadFiles.Count
            bytes = [int](@($manifestFiles | Measure-Object -Property bytes -Sum).Sum)
            sha256 = $libTree.sha256
        }
        sourceTree = [pscustomobject]@{ files = $sourceTree.files; bytes = $sourceTree.bytes; sha256 = $sourceTree.sha256 }
        settingsBlockSha256 = $settingsBlockSha
        files = $manifestFiles
    }
    $SnapshotDir = Join-Path $PackageVersionsDir $SnapshotName
    $SnapshotPayload = Join-Path $SnapshotDir 'payload'

    Write-Head 'What this run found'
    Write-Note "version            : $SnapshotVersion"
    if ([string]::IsNullOrWhiteSpace($Revision)) { Write-Note 'revision           : (none given; recorded as empty)' }
    else { Write-Note "revision           : $Revision (recorded only -- this mode never calls git)" }
    Write-Note "payload            : $($payloadFiles.Count) files, $([int](@($manifestFiles | Measure-Object -Property bytes -Sum).Sum)) bytes   (lib/** tree sha $(Get-ShortSha $libTree.sha256))"
    Write-Note "source tree        : $($sourceTree.files) files, $($sourceTree.bytes) bytes, sha $(Get-ShortSha $sourceTree.sha256)   (excludes .git, node_modules, lib)"
    if ($settingsBlockSha -eq '') { Write-Note 'settings block     : none in settings.yaml (nothing to record a hash of)' }
    else { Write-Note "settings block sha : $(Get-ShortSha $settingsBlockSha)   (evidence only; the block itself is never copied)" }
    Write-Note "name this run will create : $SnapshotName"
    if (Test-Path -LiteralPath $SnapshotDir) {
        Write-Warn "a snapshot named $SnapshotName already exists; pick another -Name (nothing was written)"
        exit 1
    }

    Write-Head 'Retention'
    $keepCount = [Math]::Max($Keep, 1)
    $existingSnapshots = @(Get-VersionSnapshots $PackageVersionsDir)
    $wouldPrune = @($existingSnapshots | Select-Object -Skip $keepCount)
    if ($wouldPrune.Count -eq 0) { Write-Note "keeping the newest $keepCount; nothing would be pruned" }
    else { Write-Note "keeping the newest $keepCount; would prune: $(($wouldPrune | ForEach-Object { $_.name }) -join ', ')" }

    if ($DryRun) {
        Write-Head 'Dry run'
        Write-Host '   Nothing was run. Re-run without -DryRun to apply.'
        exit 0
    }

    Write-Head 'Writing'
    New-Item -ItemType Directory -Force -Path $SnapshotPayload | Out-Null
    foreach ($file in $payloadFiles) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent (Join-Path $SnapshotPayload $file.rel.Replace('/', '\'))) | Out-Null
        Copy-Item -LiteralPath $file.abs -Destination (Join-Path $SnapshotPayload $file.rel.Replace('/', '\')) -Force
    }
    Write-TextFile (Join-Path $SnapshotDir 'manifest.json') (($manifest | ConvertTo-Json -Depth 6) + "`n")
    Write-Ok "copied $($payloadFiles.Count) file(s) into $SnapshotDir"

    # READ-BACK: the copy is verified, not assumed, and the verification is honest about its reach. The
    # source side of this comparison is read in the SAME process at the SAME moment, so it proves the copy
    # matched the source as it was then. It cannot see a concurrent writer changing the source tree after
    # this moment -- nothing in this script can, and pretending otherwise would be the more dangerous lie.
    Write-Head 'Read-back'
    Write-Note 'read-back: comparing every written file against the manifest'
    $verification = Test-VersionSnapshot $SnapshotDir
    if (-not $verification.ok) {
        Write-Warn "the copy does NOT match its manifest: $(($verification.problems | Select-Object -First 5) -join '; ')"
        Remove-Item -LiteralPath $SnapshotDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Warn 'the incomplete snapshot was removed; older snapshots were not touched'
        exit 1
    }
    Write-Ok "snapshot $SnapshotName verified ($($verification.checked)/$($verification.total) files)"

    Write-Head 'Retention'
    $allSnapshots = @(Get-VersionSnapshots $PackageVersionsDir)
    $pruneList = @($allSnapshots | Select-Object -Skip $keepCount)
    Write-Note "keeping the newest $keepCount : $(($allSnapshots | Select-Object -First $keepCount | ForEach-Object { $_.name }) -join ', ')"
    if ($pruneList.Count -eq 0) { Write-Note 'nothing to prune' }
    foreach ($entry in $pruneList) {
        if (-not $entry.ours) {
            Write-Warn "not written by this tool, so left alone: $($entry.name)"
            continue
        }
        $OldSnapshotDir = $entry.dir
        Remove-Item -LiteralPath $OldSnapshotDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Note "pruned: $($entry.name)"
    }

    Write-Head 'Done'
    Write-Host "   Snapshot $SnapshotName recorded and verified."
    Write-Host '   Next: git pull && npm run build brings the new version, then -Update reports the difference.'
    Write-Host '   Restoring one is -Rollback -To <name> (7c).'
    exit 0
}

if ($ListVersions) {
    # READ-ONLY, and the guard asserts it: everything below opens files, and nothing here writes.
    $keepCount = [Math]::Max($Keep, 1)
    Write-Head "Versions (newest first; keeping $keepCount)"
    $entries = @(Get-VersionSnapshots $PackageVersionsDir)
    if ($entries.Count -eq 0) {
        Write-Skip "no version snapshots yet under $PackageVersionsDir"
        exit 0
    }
    foreach ($entry in $entries) {
        if ($entry.manifest -eq $null) {
            Write-Warn "$($entry.name): no readable manifest.json, so only its name is shown"
            continue
        }
        if ($entry.schemaVersion -ne 1) {
            # Reported, never fatal: a manifest from a future format should still be listed with whatever
            # fields this script can read, and the reader decides what to do about it.
            Write-Warn "$($entry.name): schemaVersion $($entry.schemaVersion) is not one this script knows; showing the fields it can read"
        }
        $payload = Get-JsonProperty $entry.manifest 'payload' $null
        Write-Note ("{0}   v{1}   {2}   {3} files   {4} bytes   sha {5}" -f $entry.name, $entry.version, $entry.createdAt, (Get-JsonProperty $payload 'files' 0), (Get-JsonProperty $payload 'bytes' 0), (Get-ShortSha ([string](Get-JsonProperty $payload 'sha256' ''))))
    }

    Write-Head 'Verification'
    $bad = 0
    foreach ($entry in $entries) {
        $verification = Test-VersionSnapshot $entry.dir
        if ($verification.ok) {
            Write-Ok "$($entry.name): $($verification.checked)/$($verification.total) files match the manifest"
        }
        else {
            $bad += 1
            $detail = if ($verification.reason -ne '') { $verification.reason } else { ($verification.problems | Select-Object -First 5) -join ', ' }
            Write-Warn "$($entry.name): does NOT match its manifest -- $detail"
        }
    }

    Write-Head 'Summary'
    Write-Note "$($entries.Count - $bad) of $($entries.Count) snapshot(s) verify"
    Write-Note '-Rollback refuses a snapshot that does not (7c)'
    exit $(if ($bad -eq 0) { 0 } else { 1 })
}

# =================================================================== INSTALL ===

Write-Head 'Install plan'

$patchBefore = Get-PatchEntryCount $PatchPath
$alreadyDep = $false
$alreadyBundle = $false
if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
    $manifestNow = Read-JsonFile $ManifestPath
    $alreadyDep = Test-ProfileDependency $manifestNow $PackageName
    $alreadyBundle = (Get-ProfileBundles $manifestNow) -contains $PackageName
}

if ($alreadyDep -and $alreadyBundle) {
    Write-Note "$PackageName is already wired; the install is idempotent and will simply re-verify"
}
$existingLink = Get-LinkTarget $LinkPath
if ($existingLink -ne $null) {
    if ($existingLink -eq $SourceDir) { Write-Note "node_modules entry already links to this source: $existingLink" }
    else { Write-Warn "node_modules entry currently links elsewhere: $existingLink" }
}
elseif (Test-Path -LiteralPath $LinkPath) {
    Write-Warn "a real directory (not a link) already exists at $LinkPath; pnpm will replace it with a link"
}

Write-Plan "run: $(Format-Dsh @('plugin', '--profile', $Profile, 'add', $SourceDir))"
Write-Plan 'this declares the dependency AND appends the bundle layer (no YAML is edited)'
Write-Plan "back up $LockFileName and the node_modules inventory first"
Write-Plan 'then assert: dependency present, bundle present, patch entries unchanged, source tree unchanged'

if ($DryRun) {
    Write-Head 'Dry run'
    Write-Host '   Nothing was run and nothing was written. Re-run without -DryRun to apply.'
    exit 0
}

# ---- backups ---------------------------------------------------------------

Write-Head 'Backup'

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$lockBackupName = "$LockFileName.dsh-ui-projects-$stamp.bak"
$lockBackupPath = Join-Path $ProfileDir $lockBackupName

$before = [pscustomobject]@{
    manifestSha256 = Get-Sha256 $ManifestPath
    patchEntries = $patchBefore
    patchSha256 = if (Test-Path -LiteralPath $PatchPath -PathType Leaf) { Get-Sha256 $PatchPath } else { $null }
    lockFile = [pscustomobject]@{
        name = $LockFileName
        present = (Test-Path -LiteralPath $LockPath -PathType Leaf)
        sha256 = if (Test-Path -LiteralPath $LockPath -PathType Leaf) { Get-Sha256 $LockPath } else { $null }
        backup = if (Test-Path -LiteralPath $LockPath -PathType Leaf) { $lockBackupName } else { $null }
    }
    nodeModules = Get-NodeModulesInventory $NodeModulesDir
    uiProjectsEntry = if (Test-Path -LiteralPath $LinkPath) { 'present' } else { 'absent' }
    # Captured now so the post-install check compares against a genuine earlier
    # state. Hashing the same file twice at verify time would prove nothing.
    source = [pscustomobject]@{
        manifestSha256 = Get-Sha256 (Join-Path $SourceDir 'package.json')
        clientBundleSha256 = Get-Sha256 (Join-Path $SourceDir 'lib/client.js')
    }
}

if ($before.lockFile.present) {
    Copy-Item -LiteralPath $LockPath -Destination $lockBackupPath -Force
    Write-Ok "lockfile backed up -> $lockBackupName"
}
else {
    Write-Skip "no $LockFileName to back up"
}
Write-Ok "node_modules inventory recorded ($(@($before.nodeModules).Count) top-level entries)"

$state = [pscustomobject]@{
    tool = 'install.ps1'
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    profileDir = $ProfileDir
    sourceDir = $SourceDir
    packageName = $PackageName
    before = $before
}
Write-TextFile $StatePath (($state | ConvertTo-Json -Depth 8) + "`n")
Write-Ok "install record written -> $StateFileName"

# ---- run dsh ---------------------------------------------------------------

Write-Head 'Installing'
Invoke-Dsh @('plugin', '--profile', $Profile, 'add', $SourceDir)
if ($script:DshExitCode -ne 0) {
    Stop-With "dsh plugin add exited $($script:DshExitCode). The install record and lockfile backup were kept at $ProfileDir so you can inspect what changed."
}
Write-Ok 'dsh plugin add exited 0'

# ---- assertions ------------------------------------------------------------

Write-Head 'Verify'

$failed = 0

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    Stop-With "the profile manifest disappeared during the install: $ManifestPath"
}
$manifest = Read-JsonFile $ManifestPath

$dependencies = Get-JsonProperty $manifest 'dependencies' $null
if (Test-JsonProperty $dependencies $PackageName) {
    $spec = Get-JsonProperty $dependencies $PackageName ''
    Write-Ok "dependency declared: $spec"
}
else {
    $depNames = Get-JsonNames $dependencies
    Write-Warn "$PackageName was not added to dependencies (declared: $($depNames -join ', '))"
    $failed++
}

$bundles = Get-ProfileBundles $manifest
if ($bundles -contains $PackageName) {
    Write-Ok "bundle layer registered (bundles: $($bundles -join ', '))"
}
else {
    Write-Warn "$PackageName is NOT in dsh.profile.bundles, so its loader row will not apply"
    $failed++
}

$patchAfter = Get-PatchEntryCount $PatchPath
if ($patchAfter -eq $patchBefore) { Write-Ok "profile patch layer untouched ($patchAfter entries, as before)" }
else {
    Write-Warn "patch entries changed: $patchBefore -> $patchAfter; this script never edits it"
    $failed++
}

$target = Get-LinkTarget $LinkPath
if ($target -eq $null) {
    if (Test-Path -LiteralPath $LinkPath) {
        Write-Warn "$LinkPath is not a link; the profile may now hold a COPY rather than a link"
    }
    else {
        Write-Warn "no node_modules entry at $LinkPath"
    }
    $failed++
}
elseif ($target -eq $SourceDir) {
    Write-Ok "node_modules entry links to the source tree ($target)"
}
else {
    Write-Warn "node_modules entry links to $target, expected $SourceDir"
    $failed++
}

# The guard that matters most: installing must never modify what it links to.
# Both hashes were captured before `dsh plugin add` ran.
if ((Get-Sha256 (Join-Path $SourceDir 'package.json')) -eq $before.source.manifestSha256) {
    Write-Ok 'source package.json byte-unchanged'
}
else {
    Write-Warn "the source package.json CHANGED during install: $SourceDir"
    $failed++
}
if ((Get-Sha256 (Join-Path $SourceDir 'lib/client.js')) -eq $before.source.clientBundleSha256) {
    Write-Ok 'source lib/client.js byte-unchanged'
}
else {
    Write-Warn "the source lib/client.js CHANGED during install: $SourceDir"
    $failed++
}

if ($failed -eq 0) { Write-Head 'Done' } else { Write-Head 'Incomplete' }
if ($failed -eq 0) {
    Write-Host '   Installed and verified. Nothing was written outside the profile directory'
    Write-Host '   except one temporary directory under $env:TEMP, already removed.'
    Write-Host ''
    Write-Host '   Next: restart dsh web, then open Settings and confirm a "UI" section appears.'
    Write-Host "   Undo with:  powershell -File install.ps1 -Uninstall -DryRun"
}
else {
    Write-Host "   $failed check(s) did not pass. The install record is at $StateFileName"
    Write-Host '   and the lockfile backup is beside it; nothing was rolled back automatically.'
}
Write-Host ''
exit $(if ($failed -eq 0) { 0 } else { 1 })
