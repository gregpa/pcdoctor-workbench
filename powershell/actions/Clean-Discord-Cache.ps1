<#
.SYNOPSIS
    Closes Discord and clears its cache directories.
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
Get-Process -Name Discord -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
$targets = @("$env:APPDATA\discord\Cache", "$env:APPDATA\discord\Code Cache", "$env:APPDATA\discord\GPUCache")
$freed = 0
foreach ($t in $targets) {
    if (-not (Test-Path $t)) { continue }
    $size = (Get-ChildItem -Path $t -Recurse -Force -ErrorAction SilentlyContinue -File | Measure-Object -Property Length -Sum).Sum
    if ($null -ne $size) { $freed += $size }
    Remove-Item -Path "$t\*" -Recurse -Force -ErrorAction SilentlyContinue
}
$result = @{ success = $true; duration_ms = $sw.ElapsedMilliseconds; bytes_freed = $freed; message = "Cleared Discord cache ($([math]::Round($freed/1MB,1)) MB)" }

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
