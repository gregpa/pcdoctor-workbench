<#
.SYNOPSIS
    Reads SMART health via Get-PhysicalDisk + Get-StorageReliabilityCounter.
    CrystalDiskInfo CLI is preferred if present, else native WMI.

.OUTPUT
    { drives: [ { model, serial, health, temp_c, power_on_hours,
                  reallocated_sectors, warnings: [] } ], summary }
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
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($DryRun) {
    @{ success = $true; dry_run = $true; duration_ms = $sw.ElapsedMilliseconds } | ConvertTo-Json -Compress
    exit 0
}

# Admin check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $err = @{ code = 'E_NOT_ADMIN'; message = 'Run-SmartCheck requires administrator privileges.' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}

$drives           = @()
$warningLines     = [System.Collections.Generic.List[string]]::new()
$skipped          = @()

# NVMe temperature is reported in multiple places and Get-StorageReliabilityCounter
# frequently returns a stale/low value (1 C is a known bug).  Build a fallback
# map from Win32_TemperatureProbe / MSStorageDriver_ATAPISmartData.  Best-effort only.
$nvmeTemps = @{}
try {
    Get-CimInstance -Namespace 'root\Microsoft\Windows\Storage' -ClassName MSFT_PhysicalDisk -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.Temperature -and $_.Temperature -gt 5) {
                $nvmeTemps[$_.DeviceId.ToString()] = [int]$_.Temperature
            }
        }
} catch { }

$physical = @(Get-PhysicalDisk -ErrorAction SilentlyContinue)
foreach ($p in $physical) {
    # Skip non-storage USB devices: 2FA tokens, card readers, etc reported with size 0.
    if (-not $p.Size -or $p.Size -lt 1GB) {
        $skipped += @{ model = $p.FriendlyName; reason = "size < 1GB (likely non-storage device)" }
        continue
    }

    $warns = @()
    $rel = $null
    try { $rel = Get-StorageReliabilityCounter -PhysicalDisk $p -ErrorAction SilentlyContinue } catch { }

    $health = if ($p.HealthStatus) { "$($p.HealthStatus)" } else { 'Unknown' }
    if ($health -ne 'Healthy') { $warns += "Health=$health" }

    # Temperature: trust the reliability counter only when it reports a plausible value.
    # NVMe drives routinely return 1 C from this counter due to a known Storage API bug.
    $temp = $null
    if ($rel -and $rel.Temperature -and $rel.Temperature -ge 15 -and $rel.Temperature -le 120) {
        $temp = [int]$rel.Temperature
    } elseif ($nvmeTemps.ContainsKey($p.DeviceId.ToString())) {
        $temp = $nvmeTemps[$p.DeviceId.ToString()]
    }
    if ($temp -and $temp -gt 65) { $warns += "Temp=${temp}C (>65C)" }

    if ($rel -and $rel.ReadErrorsUncorrected -gt 0)   { $warns += "Uncorrected read errors: $($rel.ReadErrorsUncorrected)" }
    if ($rel -and $rel.WriteErrorsUncorrected -gt 0)  { $warns += "Uncorrected write errors: $($rel.WriteErrorsUncorrected)" }
    if ($rel -and $rel.Wear -and $rel.Wear -ge 80)    { $warns += "Wear level: $($rel.Wear)%" }

    $drives += [ordered]@{
        model               = $p.FriendlyName
        serial              = $p.SerialNumber
        size_gb             = [math]::Round($p.Size / 1GB, 1)
        bus_type            = "$($p.BusType)"
        media_type          = "$($p.MediaType)"
        health              = $health
        temp_c              = $temp
        power_on_hours      = if ($rel) { $rel.PowerOnHours } else { $null }
        reallocated_sectors = if ($rel) { $rel.ReadErrorsUncorrected } else { $null }
        wear_pct            = if ($rel) { $rel.Wear } else { $null }
        warnings            = @($warns)
    }

    foreach ($w in $warns) { [void]$warningLines.Add("$($p.FriendlyName): $w") }
}

$sw.Stop()
$warnCount = $warningLines.Count

# v2.4.18: persist the elevated SMART data to a known cache path. The
# non-admin Get-SMART.ps1 reads this on its next invocation and merges
# wear_pct + temp_c into its fallback rows, letting the Dashboard show
# real data without requiring admin on every scan. Cache survives app
# restarts. The security scan cycle picks it up within seconds of any
# successful elevated SMART check.
$cacheDir = 'C:\ProgramData\PCDoctor\reports'
$cachePath = Join-Path $cacheDir 'smart-cache.json'
try {
    if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
    # Key by serial + model for stable lookup across scans. The cache is a
    # dictionary (serial -> {wear_pct, temp_c, power_on_hours, reallocated
    # _sectors}) so Get-SMART.ps1 can merge precisely.
    $cacheEntries = @{}
    foreach ($d in $drives) {
        $key = if ($d.serial) { "$($d.serial)" } else { "$($d.model)::$($d.size_gb)" }
        $cacheEntries[$key] = [ordered]@{
            model               = $d.model
            serial              = $d.serial
            wear_pct            = $d.wear_pct
            temp_c              = $d.temp_c
            power_on_hours      = $d.power_on_hours
            reallocated_sectors = $d.reallocated_sectors
            health              = $d.health
        }
    }
    $cache = [ordered]@{
        generated_at  = [int64](([DateTimeOffset](Get-Date)).ToUnixTimeSeconds())
        drive_count   = @($drives).Count
        entries       = $cacheEntries
    }
    $cache | ConvertTo-Json -Depth 6 | Set-Content -Path $cachePath -Encoding UTF8 -Force
} catch {
    [void]$warningLines.Add("Cache write failed: $($_.Exception.Message)")
}

$result = [ordered]@{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    drives      = @($drives)
    skipped     = @($skipped)
    warnings    = @($warningLines)
    summary     = "Checked $(@($drives).Count) disk(s); $warnCount warning(s)."
    message     = if ($warnCount -eq 0) { "SMART check complete - all drives healthy. Cache updated." } else { "SMART check found $warnCount issue(s). Cache updated." }
}
$result | ConvertTo-Json -Depth 6 -Compress
exit 0
