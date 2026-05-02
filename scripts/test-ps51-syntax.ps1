<#
.SYNOPSIS
    Pre-ship gate: parse every bundled .ps1 file under Windows PowerShell 5.1
    rules so PS7-only syntax (??, ?., ?:, ternary) doesn't ship.

.DESCRIPTION
    v2.5.26 (post-mortem): Greg's second-PC install (2026-05-01) shipped with
    Get-Temperatures.ps1 line 249 using the null-coalescing operator
    `$entry.serial ?? $prop.Name`. That syntax requires PowerShell 7+.
    Greg's main box has pwsh 7 installed; the second PC didn't.
    `resolvePwshPath()` in scriptRunner.ts falls back to Windows PowerShell
    5.1 (`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`) when
    pwsh 7 is absent — and 5.1 couldn't even PARSE the script. The temp
    pipeline silently died and the dashboard never got CPU/GPU temps.

    PCDoctor's IPC handler explicitly supports the 5.1 fallback path, so
    every .ps1 file we ship MUST parse cleanly on 5.1. This gate parses
    each script's AST without executing it, using the 5.1 PSParser API
    (System.Management.Automation.PSParser) so the check is portable to
    machines that only have 5.1.

.NOTES
    Walks both `powershell/` (the bundled tree, what gets copied to
    ProgramData) and any standalone .ps1 files under `scripts/`. Skips
    `node_modules/` and `release/` to avoid third-party noise.
#>

[CmdletBinding()]
param(
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

# Resolve the script's own directory robustly. Using $MyInvocation
# instead of $PSScriptRoot because the latter can be empty in some
# CmdletBinding/-File invocation paths.
if ([string]::IsNullOrEmpty($Root)) {
    $Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
}

# Resolve the repo root (one level up from scripts/).
$repoRoot = (Resolve-Path (Join-Path $Root '..')).Path
$targets = @(
    Get-ChildItem -Path (Join-Path $repoRoot 'powershell') -Recurse -Filter '*.ps1' -File -ErrorAction SilentlyContinue
    Get-ChildItem -Path (Join-Path $repoRoot 'scripts') -Filter '*.ps1' -File -ErrorAction SilentlyContinue
) | Sort-Object FullName -Unique

if (-not $targets) {
    Write-Host '[ps51-syntax] No .ps1 files found under powershell/ or scripts/.'
    exit 0
}

$failures = @()
foreach ($file in $targets) {
    try {
        $tokens = $null
        $errors = $null
        # PSParser.Tokenize returns the lexer errors. Anything in $errors is
        # a syntax-level fault that 5.1 cannot parse. We do NOT execute the
        # script; this is a static check.
        $null = [System.Management.Automation.PSParser]::Tokenize(
            (Get-Content -Raw -Path $file.FullName),
            [ref]$errors
        )
        if ($errors -and $errors.Count -gt 0) {
            $first = $errors[0]
            $failures += [ordered]@{
                file    = $file.FullName.Substring($repoRoot.Path.Length + 1)
                line    = $first.Token.StartLine
                column  = $first.Token.StartColumn
                message = $first.Message
            }
        }
    } catch {
        $failures += [ordered]@{
            file    = $file.FullName.Substring($repoRoot.Path.Length + 1)
            line    = 0
            column  = 0
            message = "Tokenize threw: $($_.Exception.Message)"
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Host '[ps51-syntax] FAIL — the following scripts have PS5.1-incompatible syntax:'
    foreach ($f in $failures) {
        Write-Host ('  {0}:{1}:{2}  {3}' -f $f.file, $f.line, $f.column, $f.message)
    }
    Write-Host ''
    Write-Host 'Common culprits: ?? (null-coalesce), ?. (null-conditional), ternary (cond ? a : b).'
    Write-Host 'Replace with `if`/`else` expressions or PS5.1-safe equivalents.'
    exit 1
}

Write-Host ('[ps51-syntax] PASS — all {0} .ps1 files parse cleanly on PowerShell 5.1.' -f $targets.Count)
exit 0
