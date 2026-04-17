<#
.SYNOPSIS
    Creates a Windows System Restore point.
#>
param(
    [string]$Description = 'PCDoctor: manual restore point',
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

$before = (Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Select-Object -Last 1).SequenceNumber
try {
    Checkpoint-Computer -Description $Description -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop
} catch {
    # Windows throttles to 1 per 24h; fallback: try APPLICATION_INSTALL type
    Checkpoint-Computer -Description $Description -RestorePointType 'APPLICATION_INSTALL' -ErrorAction Stop
}
Start-Sleep -Seconds 2
$after = (Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Select-Object -Last 1).SequenceNumber

$sw.Stop()
$result = @{
    success         = $true
    duration_ms     = $sw.ElapsedMilliseconds
    sequence_number = $after
    description     = $Description
    message         = "Created restore point #$after"
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
