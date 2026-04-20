<#
.SYNOPSIS
    Run System File Checker (sfc /scannow) to repair system files.
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'

trap {
    $errRecord = @{
        code    = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' }
        message = $_.Exception.Message
        script  = $MyInvocation.MyCommand.Name
        line    = $_.InvocationInfo.ScriptLineNumber
        stack   = $_.ScriptStackTrace
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($DryRun) {
    $result = @{ success = $true; dry_run = $true; duration_ms = $sw.ElapsedMilliseconds; message = 'DryRun' }
    $result | ConvertTo-Json -Depth 3 -Compress
    exit 0
}

# v2.3.15: SFC silently fake-succeeds in 5s when run non-elevated (it prints
# "You must be an administrator..." to stdout and exits 0). Pre-check so we
# emit a clear E_NOT_ADMIN rather than reporting a bogus success.
$currentId = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentId)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $err = @{ code='E_NOT_ADMIN'; message='sfc /scannow requires administrator privileges' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}

# sfc.exe writes to the console in UTF-16 LE; PowerShell's default output
# encoding is UTF-8, so piping raw to Out-String preserves the UTF-16 bytes
# and downstream tools see \u0000V\u0000e\u0000r... instead of "Ver...".
# Force the output encoding to Unicode (UTF-16 LE) for this child, then
# convert back to UTF-8 for JSON serialization.
$prevOutputEncoding = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::Unicode
    $output = & sfc /scannow 2>&1 | Out-String
} finally {
    [Console]::OutputEncoding = $prevOutputEncoding
}
# Strip any stray nulls that still bleed through, then collapse the scattered
# progress lines (sfc emits "Verification X% complete." repeatedly).
$output = $output -replace '\x00', ''
$exit = $LASTEXITCODE

# Verify SFC actually ran a scan. If stdout has neither the start banner nor
# any outcome keywords, it was blocked (another instance, no console session).
$didScan = $output -match 'Beginning system scan|Verification \d+%|Windows Resource Protection'
$foundViolations = $output -match 'found (integrity violations|corrupt files)'
$repaired = $output -match 'successfully repaired'
$unrepaired = $output -match 'unable to fix some of them'

$result = @{
    success = ($exit -eq 0 -and $didScan)
    duration_ms = $sw.ElapsedMilliseconds
    exit_code = $exit
    did_scan = [bool]$didScan
    found_violations = [bool]$foundViolations
    repaired = [bool]$repaired
    unrepaired = [bool]$unrepaired
    output = ($output.Trim() -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^\s*$' } | Select-Object -Last 10) -join "`n"
    message = if (-not $didScan) { 'SFC did not actually run - check output (another instance? no console session?)' }
              elseif ($repaired) { 'SFC found + repaired corrupt files; reboot to verify' }
              elseif ($unrepaired) { 'SFC found corrupt files but could not repair - run DISM /RestoreHealth next' }
              elseif ($foundViolations) { 'SFC found violations - see output' }
              else { 'SFC clean: no integrity violations' }
}

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
