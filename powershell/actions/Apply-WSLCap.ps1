<#
.SYNOPSIS
    Applies a memory/swap/CPU cap to WSL2 via .wslconfig and issues wsl --shutdown.
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

$wslConfigPath = "$env:USERPROFILE\.wslconfig"
$content = @"
[wsl2]
memory=8GB
swap=4GB
processors=8
"@
Set-Content -Path $wslConfigPath -Value $content -Encoding UTF8
& wsl --shutdown 2>&1 | Out-Null

$sw.Stop()
$result = @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    path        = $wslConfigPath
    message     = "WSL memory cap applied (8GB memory + 4GB swap). wsl --shutdown issued."
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
