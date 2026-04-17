<#
.SYNOPSIS
    Runs DISM component cleanup with ResetBase on WinSxS store.
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

# --- ACTION BODY ---
$output = & dism.exe /Online /Cleanup-Image /StartComponentCleanup /ResetBase 2>&1 | Out-String
$success = $LASTEXITCODE -eq 0
$result = @{ success = $success; duration_ms = $sw.ElapsedMilliseconds; exit_code = $LASTEXITCODE; message = if ($success) { 'WinSxS cleanup completed' } else { 'WinSxS cleanup had errors' }; dism_output = $output.Trim() }

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
