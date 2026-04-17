<#
.SYNOPSIS
    Flushes the Windows DNS resolver cache.

.DESCRIPTION
    Runs ipconfig /flushdns. Emits { success, duration_ms, entries_cleared_estimate } on success.

.PARAMETER DryRun
    Show what would happen without actually flushing.

.PARAMETER JsonOutput
    (Always emitted - kept for uniform parameter shape across all action scripts.)
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
    $result = @{
        success    = $true
        dry_run    = $true
        duration_ms = $sw.ElapsedMilliseconds
        message    = 'DryRun: would run ipconfig /flushdns'
    }
    $result | ConvertTo-Json -Depth 3 -Compress
    exit 0
}

# Capture count of entries before/after is not possible via ipconfig;
# we surface a success record with duration only.
$output = & ipconfig /flushdns 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "ipconfig /flushdns exited with code $LASTEXITCODE : $output"
}

$sw.Stop()

$result = @{
    success     = $true
    dry_run     = $false
    duration_ms = $sw.ElapsedMilliseconds
    message     = 'DNS resolver cache flushed'
    native_output = ($output | Out-String).Trim()
}

$result | ConvertTo-Json -Depth 3 -Compress
exit 0
