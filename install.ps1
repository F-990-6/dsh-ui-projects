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

$mode = if ($Uninstall) { 'UNINSTALL' } else { 'INSTALL' }
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

    if ($DryRun) {
        Write-Plan "run: $(Format-Dsh @('plugin', '--profile', $Profile, 'remove', $PackageName))"
        Write-Plan 'then assert: dependency gone, bundle layer gone, patch entries unchanged'
        Write-Plan 'then assert: the source tree is byte-unchanged'
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
        Write-Warn "a real directory (not a link) remains at $LinkPath; left in place, remove it yourself if it is stale"
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
