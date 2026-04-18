param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

# Read installed version
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA|GeForce|RTX|GTX' } | Select-Object -First 1
$installedVersion = if ($gpu) { "$($gpu.DriverVersion)" } else { $null }

# The Nvidia feed URLs change; we'll use a well-known one if reachable, else report unknown
$latestVersion = $null
$feedOk = $false
try {
    $resp = Invoke-RestMethod -Uri 'https://api.nvidia.com/services/com.nvidia.services.Drivers.json/services/com.nvidia.services.Drivers/1' -TimeoutSec 10 -ErrorAction SilentlyContinue
    if ($resp) { $feedOk = $true }
} catch {}

# Simpler approach: scrape GeForce driver page for "Game Ready" version text
if (-not $feedOk) {
    try {
        $resp = Invoke-WebRequest -Uri 'https://www.nvidia.com/en-us/geforce/drivers/' -UseBasicParsing -TimeoutSec 10
        if ($resp.Content -match 'Game Ready Driver.*?(\d{3}\.\d{2})') {
            $latestVersion = $Matches[1]
            $feedOk = $true
        }
    } catch {}
}

@{
    success = $feedOk
    duration_ms = $sw.ElapsedMilliseconds
    installed_version = $installedVersion
    latest_version = $latestVersion
    feed_available = $feedOk
    message = if ($feedOk) { "Installed: $installedVersion; Latest Game Ready: $latestVersion" } else { "Could not reach Nvidia feed; check manually" }
} | ConvertTo-Json -Compress
exit 0
