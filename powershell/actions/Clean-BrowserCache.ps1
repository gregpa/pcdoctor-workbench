<#
.SYNOPSIS
    Closes browsers and clears their caches (Chrome, Edge, Firefox, Brave).
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
$browsers = @(
    @{ name = 'chrome'; cache = "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Cache" }
    @{ name = 'msedge'; cache = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Cache" }
    @{ name = 'firefox'; cache = "$env:LOCALAPPDATA\Mozilla\Firefox\Profiles" }
    @{ name = 'brave'; cache = "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data\Default\Cache" }
)
$freed = 0
$perBrowser = @{}
foreach ($b in $browsers) {
    Get-Process -Name $b.name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    if (Test-Path $b.cache) {
        $size = (Get-ChildItem -Path $b.cache -Recurse -Force -ErrorAction SilentlyContinue -File | Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
        if ($null -ne $size) {
            Remove-Item -Path "$($b.cache)\*" -Recurse -Force -ErrorAction SilentlyContinue
            $freed += $size
            $perBrowser[$b.name] = [math]::Round($size/1MB, 1)
        }
    }
}
$result = @{ success = $true; duration_ms = $sw.ElapsedMilliseconds; bytes_freed = $freed; per_browser_mb = $perBrowser; message = "Cleared browser caches ($([math]::Round($freed/1MB,1)) MB)" }

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
