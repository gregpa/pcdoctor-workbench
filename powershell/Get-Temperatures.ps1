<#
.SYNOPSIS
    Aggregate per-component temperature readings: GPU via nvidia-smi,
    NVMe / SSD via the SMART cache (populated by Run-SmartCheck), CPU
    via WMI (admin only).

.DESCRIPTION
    v2.4.28: powers the Dashboard TemperaturePanel tile. Reader-friendly
    JSON shape:

      {
        success, duration_ms, generated_at,
        cpu:  { zones: [{name, temp_c}...], needs_admin },
        gpu:  [{ vendor, name, temp_c, memory_temp_c, fan_pct, utilization_pct }],
        disks:[{ drive, model, temp_c, kind, source, needs_admin }],
        message
      }

    CPU reading uses MSAcpi_ThermalZoneTemperature which requires admin
    on most Windows builds. When running non-admin we silently mark
    needs_admin=true and return an empty zones list. A separate admin-
    elevated action writes a cache file so the non-admin path can still
    show the last known value.

    GPU reading via nvidia-smi works non-admin. AMD/Intel equivalents
    not attempted yet (vendor-specific CLIs needed). Panel renders
    "no GPU data" for those systems until we add more probes.

    NVMe / SSD temps are sourced from the SMART cache populated by
    Run-SmartCheck.ps1 (see v2.4.18-v2.4.21). No duplicate SMART query
    here - we just join to avoid double work.
#>
param([switch]$JsonOutput)

$ErrorActionPreference = 'Continue'

trap {
    $errRecord = @{
        code    = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' }
        message = $_.Exception.Message
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# ---- CPU via MSAcpi_ThermalZoneTemperature (admin-gated on most builds) ----
$cpuZones     = @()
$cpuNeedsAdmin = $false
try {
    $zones = Get-CimInstance -Namespace 'root\wmi' -ClassName 'MSAcpi_ThermalZoneTemperature' -ErrorAction Stop
    foreach ($z in $zones) {
        # CurrentTemperature is in tenths of Kelvin. 3000 -> 27 C, 3500 -> 77 C.
        # Skip zones that report <0 or >150 C - those are sensor-read
        # errors, not real temps.
        if ($null -ne $z.CurrentTemperature -and $z.CurrentTemperature -gt 0) {
            $tempC = [math]::Round(($z.CurrentTemperature / 10) - 273.15, 1)
            if ($tempC -ge 0 -and $tempC -le 150) {
                $cpuZones += [ordered]@{
                    name   = "$($z.InstanceName)"
                    temp_c = $tempC
                }
            }
        }
    }
} catch {
    $msg = "$($_.Exception.Message)"
    if ($msg -match 'Access denied' -or $msg -match 'privilege' -or $msg -match '0x80041003') {
        $cpuNeedsAdmin = $true
    }
}

# v2.4.28: fall back to the cached CPU reading when the live WMI query
# fails. Cache is written by the admin-elevated run (future v2.4.29
# refresh_temperatures action) at C:\ProgramData\PCDoctor\reports\
# temperature-cache.json. Cache > 6 h old is ignored as stale.
$cpuCacheUsed = $false
if ($cpuZones.Count -eq 0) {
    $cachePath = 'C:\ProgramData\PCDoctor\reports\temperature-cache.json'
    if (Test-Path $cachePath) {
        try {
            $cache = Get-Content $cachePath -Raw -ErrorAction Stop | ConvertFrom-Json
            $nowUnix = [int64](([DateTimeOffset](Get-Date)).ToUnixTimeSeconds())
            $ageH = ($nowUnix - [int64]$cache.generated_at) / 3600.0
            if ($ageH -le 6 -and $cache.cpu -and $cache.cpu.zones) {
                foreach ($z in $cache.cpu.zones) {
                    $cpuZones += [ordered]@{
                        name   = "$($z.name)"
                        temp_c = [double]$z.temp_c
                    }
                }
                $cpuCacheUsed = $true
                $cpuNeedsAdmin = $false
            }
        } catch { }
    }
}

# ---- GPU via nvidia-smi (non-admin) ----
$gpuList = @()
$nvsmi = 'C:\Windows\System32\nvidia-smi.exe'
if (-not (Test-Path $nvsmi)) {
    $cmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($cmd) { $nvsmi = $cmd.Source } else { $nvsmi = $null }
}
if ($nvsmi) {
    try {
        $csv = & $nvsmi --query-gpu=name,temperature.gpu,temperature.memory,fan.speed,utilization.gpu --format=csv,noheader,nounits 2>&1 | Out-String
        foreach ($line in ($csv -split "`r?`n")) {
            $line = $line.Trim()
            if (-not $line) { continue }
            $parts = $line -split ',\s*'
            if ($parts.Length -ge 5) {
                $tempGpu = $null
                $tempMem = $null
                $fanPct  = $null
                $utilPct = $null
                try { if ($parts[1] -and $parts[1] -ne 'N/A') { $tempGpu = [int]$parts[1] } } catch { }
                try { if ($parts[2] -and $parts[2] -ne 'N/A') { $tempMem = [int]$parts[2] } } catch { }
                try { if ($parts[3] -and $parts[3] -ne 'N/A') { $fanPct  = [int]$parts[3] } } catch { }
                try { if ($parts[4] -and $parts[4] -ne 'N/A') { $utilPct = [int]$parts[4] } } catch { }
                $gpuList += [ordered]@{
                    vendor           = 'NVIDIA'
                    name             = $parts[0]
                    temp_c           = $tempGpu
                    memory_temp_c    = $tempMem
                    fan_pct          = $fanPct
                    utilization_pct  = $utilPct
                }
            }
        }
    } catch { }
}

# ---- NVMe / SSD temps from the SMART cache ----
$diskList = @()
$smartCachePath = 'C:\ProgramData\PCDoctor\reports\smart-cache.json'
if (Test-Path $smartCachePath) {
    try {
        $smart = Get-Content $smartCachePath -Raw -ErrorAction Stop | ConvertFrom-Json
        foreach ($prop in $smart.entries.PSObject.Properties) {
            $entry = $prop.Value
            if ($null -ne $entry.temp_c) {
                $diskList += [ordered]@{
                    drive   = $entry.serial ?? $prop.Name
                    model   = "$($entry.model)"
                    temp_c  = [int]$entry.temp_c
                    kind    = 'nvme'
                    source  = 'smart-cache'
                    needs_admin = $false
                }
            }
        }
    } catch { }
}

# v2.4.28: if the SMART cache didn't yield temps, enumerate the drives
# so the UI can at least list them with needs_admin=true instead of
# hiding them entirely. Mirrors Get-SMART.ps1's Add-NonAdminFallback.
if ($diskList.Count -eq 0) {
    try {
        $phys = Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.Size -and $_.Size -ge 1GB }
        foreach ($p in $phys) {
            $diskList += [ordered]@{
                drive   = "$($p.FriendlyName)"
                model   = "$($p.FriendlyName)"
                temp_c  = $null
                kind    = "$($p.MediaType)"
                source  = 'physicaldisk-only'
                needs_admin = $true
            }
        }
    } catch { }
}

$sw.Stop()

# Build a short summary message used by the Dashboard panel header.
$msgParts = @()
# PowerShell Sort-Object doesn't always follow -Property on hashtable
# entries reliably; use the scriptblock form so we're sorting on the
# actual numeric value, not alphabetically on the string form.
if ($cpuZones.Count -gt 0) {
    $hot = ($cpuZones | Sort-Object -Descending { [double]$_.temp_c } | Select-Object -First 1).temp_c
    $msgParts += "CPU $hot C$(if ($cpuCacheUsed) { ' (cached)' } else { '' })"
} elseif ($cpuNeedsAdmin) {
    $msgParts += 'CPU needs admin'
}
if ($gpuList.Count -gt 0 -and $null -ne $gpuList[0].temp_c) {
    $msgParts += "GPU $($gpuList[0].temp_c) C"
}
$diskWithTemp = @($diskList | Where-Object { $null -ne $_.temp_c })
if ($diskWithTemp.Count -gt 0) {
    $hot = ($diskWithTemp | Sort-Object -Descending { [double]$_.temp_c } | Select-Object -First 1).temp_c
    $msgParts += "hottest drive $hot C"
}
$summary = if ($msgParts.Count -gt 0) { ($msgParts -join ', ') } else { 'no sensor data' }

$payload = [ordered]@{
    success      = $true
    duration_ms  = $sw.ElapsedMilliseconds
    generated_at = [int64](([DateTimeOffset](Get-Date)).ToUnixTimeSeconds())
    cpu          = [ordered]@{
        zones       = $cpuZones
        needs_admin = $cpuNeedsAdmin
        from_cache  = $cpuCacheUsed
    }
    gpu          = $gpuList
    disks        = $diskList
    message      = $summary
}

if ($JsonOutput) {
    $payload | ConvertTo-Json -Depth 6 -Compress
} else {
    $payload | ConvertTo-Json -Depth 6
}
exit 0
