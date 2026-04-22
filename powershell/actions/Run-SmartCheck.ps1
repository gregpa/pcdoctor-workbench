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

# v2.4.19 (rewritten v2.4.21): smartctl third-tier fallback for drives
# where the primary Windows APIs (Get-StorageReliabilityCounter +
# MSFT_PhysicalDisk) come up empty. Samsung + Intel NVMe routinely
# return Temperature=1 C (filtered out) and Wear=0 (suspicious) from
# the Windows Storage stack. smartctl reads the NVMe SMART log directly
# via the Windows NVMe driver.
#
# v2.4.21 fix: smartctl 7.5+ on Windows uses Linux-style /dev/sdX
# device paths for its unified driver abstraction, NOT \\.\PhysicalDriveN.
# Calls using the Windows-style path return "Invalid argument" or
# "Unable to detect device type". We now:
#   1. Invoke `smartctl --scan` ONCE to get the real device list with
#      the correct `-d <type>` flag per device (e.g. `-d ata`, `-d sat`,
#      `-d nvme`, `-d scsi`).
#   2. Run `-i -j` on each scan entry to learn its model + capacity
#      + serial (cheap query, no SMART pass-through needed).
#   3. Match each Get-PhysicalDisk row to a scan entry by capacity
#      (exact bytes) and use that entry's dev path + type for the
#      full `-a -j` query.
# This correctly handles Intel RST, USB-SATA bridges, and direct NVMe
# without needing to know the vendor-specific naming conventions.
function Get-SmartctlPath {
    $candidates = @(
        'C:\Program Files\smartmontools\bin\smartctl.exe',
        'C:\Program Files (x86)\smartmontools\bin\smartctl.exe'
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    $cmd = Get-Command smartctl -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-SmartctlInventory {
    param([string]$SmartctlPath)
    if (-not $SmartctlPath) { return @() }
    $inventory = @()
    try {
        $scanOut = & $SmartctlPath --scan 2>&1 | Out-String
        foreach ($line in ($scanOut -split "`r?`n")) {
            # Match the scan format:
            #   "/dev/sda -d ata # /dev/sda, ATA device"
            #   "\\.\PhysicalDrive0 -d nvme # (older builds / WinNT API)"
            if ($line -match '^\s*(\S+)\s+-d\s+(\S+)') {
                $dev = $Matches[1]
                $type = $Matches[2]
                try {
                    $infoJson = & $SmartctlPath -j -i -d $type $dev 2>&1 | Out-String
                    $info = $infoJson | ConvertFrom-Json -ErrorAction SilentlyContinue
                    if ($info) {
                        $inventory += @{
                            dev        = $dev
                            type       = $type
                            model      = "$($info.model_name)"
                            size_bytes = if ($info.user_capacity.bytes) { [long]$info.user_capacity.bytes } else { 0 }
                            serial     = "$($info.serial_number)"
                        }
                    }
                } catch { }
            }
        }
    } catch { }
    return $inventory
}

function Find-SmartctlMatchForDisk {
    param(
        [Parameter(Mandatory=$true)] $PhysicalDisk,
        [Parameter(Mandatory=$true)] [array] $Inventory
    )
    if (-not $PhysicalDisk.Size -or $Inventory.Count -eq 0) { return $null }
    $targetBytes = [long]$PhysicalDisk.Size
    # Exact capacity match first - bytes-level match guarantees this is
    # the same drive. Two drives with the exact same byte count is
    # essentially never a real-world occurrence (even two drives of the
    # "same" marketed size have tiny spare-area differences).
    foreach ($inv in $Inventory) {
        if ($inv.size_bytes -eq $targetBytes) { return $inv }
    }
    # Fallback: within 1 GB tolerance, in case the Windows Storage stack
    # reports a slightly different capacity than smartctl does.
    foreach ($inv in $Inventory) {
        if ([math]::Abs($inv.size_bytes - $targetBytes) -lt 1GB) { return $inv }
    }
    return $null
}

function Get-SmartctlDriveData {
    param(
        [Parameter(Mandatory=$true)][string]$SmartctlPath,
        [Parameter(Mandatory=$true)][string]$DevPath,
        [Parameter(Mandatory=$true)][string]$DevType
    )
    try {
        $json = & $SmartctlPath -j -d $DevType -a $DevPath 2>&1 | Out-String
        if (-not $json) { return $null }
        $parsed = $json | ConvertFrom-Json -ErrorAction SilentlyContinue
        if (-not $parsed) { return $null }
        $temp = $null; $wearPct = $null
        if ($parsed.nvme_smart_health_information_log) {
            $nvme = $parsed.nvme_smart_health_information_log
            if ($nvme.temperature) { $temp = [int]$nvme.temperature }
            # percentage_used is the manufacturer's wear indicator,
            # 0 = new, 100 = EOL. Matches our wear_pct semantics.
            if ($null -ne $nvme.percentage_used) { $wearPct = [int]$nvme.percentage_used }
        } elseif ($parsed.ata_smart_attributes -and $parsed.ata_smart_attributes.table) {
            foreach ($attr in $parsed.ata_smart_attributes.table) {
                if ($attr.name -in @('Wear_Leveling_Count','SSD_Life_Left','Media_Wearout_Indicator')) {
                    # ATA attr.value is normalized current health (100 = new,
                    # 0 = worn). Invert to wear percentage.
                    $wearPct = 100 - [int]$attr.value
                }
                if ($attr.name -in @('Temperature_Celsius','Airflow_Temperature_Cel')) {
                    if ($attr.raw -and $null -ne $attr.raw.value) {
                        $temp = [int]$attr.raw.value
                    }
                }
            }
        }
        return @{ temp_c = $temp; wear_pct = $wearPct }
    } catch { return $null }
}

$smartctlPath = Get-SmartctlPath
$smartctlInventory = if ($smartctlPath) { Get-SmartctlInventory -SmartctlPath $smartctlPath } else { @() }

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

    # Wear: raw counter value. Get-StorageReliabilityCounter returns 0 on
    # many SSDs where the Windows Storage stack can't translate the
    # manufacturer's wear indicator. smartctl picks those up reliably.
    $wearPct = if ($rel) { $rel.Wear } else { $null }

    # v2.4.19: smartctl third-tier fallback. Triggered when primary path
    # returned null/zero for temp or wear - skips the subprocess cost for
    # drives that already have real values. Typically fires on Samsung /
    # Intel NVMe internals (temp missing) and sometimes on SATA SSDs
    # (wear reported as 0 by the counter).
    $needsSmartctl = ($null -eq $temp) -or ($null -eq $wearPct) -or ($wearPct -eq 0)
    if ($needsSmartctl -and $smartctlPath -and $smartctlInventory.Count -gt 0) {
        try {
            # v2.4.21: match by capacity against the scan-derived inventory
            # so we use smartctl's own device path + detected type. Avoids
            # the prior hardcoded \\.\PhysicalDriveN path which smartctl
            # 7.5+ on Windows rejects with "Invalid argument" on non-SAT
            # USB and NVMe-on-RST drives.
            $inv = Find-SmartctlMatchForDisk -PhysicalDisk $p -Inventory $smartctlInventory
            if ($inv) {
                $sc = Get-SmartctlDriveData -SmartctlPath $smartctlPath -DevPath $inv.dev -DevType $inv.type
                if ($sc) {
                    if ($null -eq $temp -and $null -ne $sc.temp_c -and $sc.temp_c -ge 15 -and $sc.temp_c -le 120) {
                        $temp = $sc.temp_c
                    }
                    # Override wear only when smartctl gives a non-zero
                    # reading and the primary path was null or zero. Protects
                    # against downgrading a valid non-zero wear to a
                    # potentially worse value from a flaky smartctl parse.
                    if ($null -ne $sc.wear_pct -and $sc.wear_pct -gt 0 -and (($null -eq $wearPct) -or ($wearPct -eq 0))) {
                        $wearPct = $sc.wear_pct
                    }
                }
            }
        } catch {
            # smartctl call failed; leave existing values. Don't warn
            # unless the user set $VerbosePreference.
        }
    }

    if ($temp -and $temp -gt 65) { $warns += "Temp=${temp}C (>65C)" }

    if ($rel -and $rel.ReadErrorsUncorrected -gt 0)   { $warns += "Uncorrected read errors: $($rel.ReadErrorsUncorrected)" }
    if ($rel -and $rel.WriteErrorsUncorrected -gt 0)  { $warns += "Uncorrected write errors: $($rel.WriteErrorsUncorrected)" }
    if ($wearPct -and $wearPct -ge 80)                { $warns += "Wear level: $wearPct%" }

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
        wear_pct            = $wearPct
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
