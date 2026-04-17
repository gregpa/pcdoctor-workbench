<#
.SYNOPSIS
    Reclaims Docker disk space via system prune and builder prune.
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

$dockerExe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
if (-not (Test-Path $dockerExe)) { $dockerExe = 'docker' }

$out1 = & $dockerExe system prune -af 2>&1 | Out-String
$out2 = & $dockerExe builder prune -af 2>&1 | Out-String
$combined = "$out1`n$out2"
$reclaimMatch = [regex]::Match($combined, 'Total reclaimed space: ([\d\.]+)([KMGT]?B)')
$reclaimed = if ($reclaimMatch.Success) { "$($reclaimMatch.Groups[1].Value) $($reclaimMatch.Groups[2].Value)" } else { 'unknown' }

$sw.Stop()
$result = @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    reclaimed   = $reclaimed
    output      = ($out1 + $out2).Trim()
    message     = "Docker compacted: $reclaimed reclaimed"
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
