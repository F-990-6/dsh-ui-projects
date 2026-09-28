<#
.SYNOPSIS
    Print the parameter surface of two scripts, read from the PARSER rather than from their text.

.DESCRIPTION
    The framework's install.ps1 and a UI project package's wrapper install.ps1 have to agree about one
    thing: which parameters exist, and what TYPE each one is. The wrapper declares them so that it can
    forward them by name, and a wrapper that has fallen behind either drops a command the framework would
    have honoured, or -- worse -- mis-binds it by position. Both are silent, which is why the surface is
    compared mechanically instead of being reviewed by eye.

    WHY THE PARSER AND NOT A REGULAR EXPRESSION. Three shapes that a text scan gets wrong, and all three
    are present in these two files:

      * `[switch]$Snapshot` and `[string]$Snapshot` are the same words to a regular expression, and the
        difference is whether the framework script accepts `-Snapshot $false` or refuses it. The type is
        half of the contract.
      * A parameter's own attributes may sit on a line of their own (`[Parameter(Mandatory = $true)]`), so
        "the line that declares it" is not one line.
      * A `param(` block nests parentheses (`[int]$Keep = 3`), so slicing it out by lines needs a real
        tokenizer to know where the block ends.

    The AST answers all three by construction: `Parameters[i].StaticType.Name` IS the type, and
    `ParamBlock.Extent.Text` IS the block. Note that `[CmdletBinding()]` is an ATTRIBUTE of the param
    block and is NOT inside that extent, so the block is emitted with its attributes in front of it.

    READ-ONLY. This parses two files and executes nothing it reads. It writes only the file named by -Out.

.PARAMETER Framework
    Path to the framework's install.ps1.

.PARAMETER Wrapper
    Path to a package's wrapper install.ps1.

.PARAMETER Out
    Where to write the JSON. Omitted, it goes to stdout, so a person can read a surface by hand.

.EXAMPLE
    powershell -File scripts/param-surface.ps1 -Framework install.ps1 -Wrapper ..\dsh-plugin-liquid-glass\install.ps1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Framework,
    [Parameter(Mandatory = $true)][string]$Wrapper,
    [string]$Out = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-ParameterSurface([string]$Path) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($resolved, [ref]$tokens, [ref]$errors)
    if (@($errors).Count -gt 0) {
        throw "$Path does not parse: $($errors[0].Message)"
    }
    if ($null -eq $ast.ParamBlock) {
        throw "$Path declares no param block, so it has no surface to compare"
    }
    $surface = [ordered]@{}
    foreach ($parameter in $ast.ParamBlock.Parameters) {
        $surface[$parameter.Name.VariablePath.UserPath] = $parameter.StaticType.Name
    }
    $block = @($ast.ParamBlock.Attributes | ForEach-Object { $_.Extent.Text }) + @($ast.ParamBlock.Extent.Text)
    return [pscustomobject]@{ surface = $surface; block = ($block -join "`n") }
}

<#
    The locals are NOT called `$framework` and `$wrapper`. `[string]$Framework` is a TYPE-CONSTRAINED
    variable for the whole life of the script, so assigning a [pscustomobject] to a local spelled the same
    way coerces it to a string -- silently -- and the failure then appears on the next line as "The
    property 'surface' cannot be found on this object", which points at the wrong place.
#>
$frameworkInfo = Get-ParameterSurface $Framework
$wrapperInfo = Get-ParameterSurface $Wrapper
$result = [ordered]@{
    framework = $frameworkInfo.surface
    wrapper = $wrapperInfo.surface
    frameworkParamBlock = $frameworkInfo.block
}
$text = $result | ConvertTo-Json -Depth 6 -Compress
if ([string]::IsNullOrWhiteSpace($Out)) {
    $text
} else {
    [System.IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding($false)))
}
