<#
.SYNOPSIS
    Reset and rebuild the Windows Search index.
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

Stop-Service WSearch -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$indexPath = 'C:\ProgramData\Microsoft\Search\Data\Applications\Windows'
$beforeSize = 0
if (Test-Path $indexPath) {
    $beforeSize = (Get-ChildItem -Path $indexPath -Recurse -Force -ErrorAction SilentlyContinue -File | Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
    Get-ChildItem -Path $indexPath -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
}
Start-Service WSearch -ErrorAction SilentlyContinue
$result = @{ success = $true; duration_ms = $sw.ElapsedMilliseconds; bytes_freed = $beforeSize; message = 'WSearch index reset; rebuild will run in background (30-60 min)' }

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
