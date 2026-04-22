param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

# ---- Admin check ----
# smartctl -a needs SAT pass-through which requires admin. When run as user,
# the probe returns exit_status:1 + no model/capacity -> the Dashboard used to
# render "(0 GB) UNKNOWN" rows. Now: detect non-admin up front, skip smartctl,
# and fall back to Get-PhysicalDisk which works as user for model + size +
# HealthStatus. Wear / temp / media-errors require admin - we null them and
# surface 'needs_admin' so the UI can show a clear message.
$currentId = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentId)
$isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

$drives = @()

# v2.4.18: read the cache written by Run-SmartCheck.ps1 when it ran
# elevated. Cache is a { serial -> {wear_pct, temp_c, ...} } dict. We
# look up each physical disk by serial number first, then fall back to
# model::size_gb. When a match is found we merge wear + temp into the
# non-admin row AND flip needs_admin to false, because the real values
# are now in hand. Cache > 30 days old is ignored (stale).
function Read-SmartCache {
    $cachePath = 'C:\ProgramData\PCDoctor\reports\smart-cache.json'
    if (-not (Test-Path $cachePath)) { return $null }
    try {
        $raw = Get-Content -Path $cachePath -Raw -ErrorAction Stop | ConvertFrom-Json
        if (-not $raw.generated_at) { return $null }
        $nowUnix = [int64](([DateTimeOffset](Get-Date)).ToUnixTimeSeconds())
        $ageHours = ($nowUnix - [int64]$raw.generated_at) / 3600.0
        if ($ageHours -gt (30 * 24)) { return $null }  # expire after 30d
        # Return the entries object as a plain hashtable for fast lookup
        $dict = @{}
        foreach ($prop in $raw.entries.PSObject.Properties) {
            $dict[$prop.Name] = $prop.Value
        }
        return @{ entries = $dict; age_hours = $ageHours; generated_at = $raw.generated_at }
    } catch { return $null }
}

function Add-NonAdminFallback {
    param([object]$Cache = $null)
    $out = @()
    try {
        $phys = Get-PhysicalDisk -ErrorAction SilentlyContinue
        foreach ($p in $phys) {
            # v2.4.19: skip non-storage devices that PhysicalDisk enumerates
            # (2FA tokens like GoldKey, smart card readers, tiny removable
            # drives). They never carry SMART data and confuse the UI with
            # perpetual "admin admin" placeholders. Run-SmartCheck.ps1
            # applies the same filter, so their absence from the cache is
            # not evidence of needing elevation - just skip them here too.
            if (-not $p.Size -or $p.Size -lt 1GB) { continue }

            $sizeGB = if ($p.Size) { [math]::Round($p.Size / 1GB, 1) } else { 0 }
            $health = switch ("$($p.HealthStatus)") {
                'Healthy'   { 'PASSED' }
                'Warning'   { 'WARN' }
                'Unhealthy' { 'FAILED' }
                default     { 'UNKNOWN' }
            }
            $model = "$($p.FriendlyName)"
            if (-not $model) { $model = "$($p.Model)" }

            # Cache lookup: prefer serial, fall back to model::size.
            $wearPct = $null; $tempC = $null; $poh = $null; $mediaErrors = $null
            $needsAdmin = $true
            if ($Cache -and $Cache.entries) {
                $key = if ($p.SerialNumber) { "$($p.SerialNumber)".Trim() } else { "$model::$sizeGB" }
                $cachedEntry = $Cache.entries[$key]
                if (-not $cachedEntry -and $p.SerialNumber) {
                    # Also try the model::size fallback if serial lookup missed
                    $cachedEntry = $Cache.entries["$model::$sizeGB"]
                }
                if ($cachedEntry) {
                    $wearPct = $cachedEntry.wear_pct
                    $tempC   = $cachedEntry.temp_c
                    $poh     = $cachedEntry.power_on_hours
                    $mediaErrors = $cachedEntry.reallocated_sectors
                    # With real values merged in, we can drop the "admin
                    # required" banner. The elevate button still shows up
                    # if ANY other row lacks a cache match.
                    $needsAdmin = $false
                }
            }

            # Severity reconsidered with cache data: high wear or temp
            # escalates to warn/crit even if Windows' HealthStatus is "Healthy".
            $severity = if ($health -eq 'FAILED') { 'crit' }
                        elseif ($health -eq 'WARN') { 'warn' }
                        elseif ($wearPct -ne $null -and $wearPct -gt 90) { 'crit' }
                        elseif ($wearPct -ne $null -and $wearPct -gt 75) { 'warn' }
                        elseif ($tempC -ne $null -and $tempC -gt 70) { 'warn' }
                        else { 'good' }

            $out += @{
                drive          = "$model ($sizeGB GB)"
                model          = $model
                device         = "PhysicalDisk$($p.DeviceId)"
                health         = $health
                wear_pct       = $wearPct
                temp_c         = $tempC
                media_errors   = $mediaErrors
                power_on_hours = $poh
                status_severity = $severity
                needs_admin    = $needsAdmin
            }
        }
    } catch {}
    return ,$out
}

if (-not $isAdmin) {
    # v2.4.18: load the cache (if fresh) so wear/temp can be merged into
    # the non-admin rows. When the cache hits on every drive, needs_admin
    # flips to false per-row and the UI stops nagging for elevation.
    $cache = Read-SmartCache
    $drives = Add-NonAdminFallback -Cache $cache
    $sw.Stop()
    $anyNeedsAdmin = @($drives | Where-Object { $_.needs_admin }).Count -gt 0
    $cacheAgeHours = if ($cache) { [math]::Round($cache.age_hours, 1) } else { $null }
    $cacheMsg = if ($cache) { "cache from $cacheAgeHours h ago" } else { "no cache yet" }
    $hintMsg = if ($anyNeedsAdmin) { " - run SMART Health Check to refresh" } else { "" }
    @{
        success = $true
        duration_ms = $sw.ElapsedMilliseconds
        drives = $drives
        count = $drives.Count
        needs_admin = $anyNeedsAdmin
        cache_age_hours = $cacheAgeHours
        message = "SMART: $($drives.Count) drive(s) ($cacheMsg)$hintMsg"
    } | ConvertTo-Json -Depth 6 -Compress
    exit 0
}

# ---- Admin path: smartctl for full SMART ----
$smartctl = 'C:\Program Files\smartmontools\bin\smartctl.exe'
if (-not (Test-Path $smartctl)) {
    $smartctl = (Get-Command smartctl -ErrorAction SilentlyContinue).Source
    if (-not $smartctl) {
        # smartctl missing but we ARE admin - fall back to Get-PhysicalDisk
        # with a note so the UI can prompt the install.
        $drives = Add-NonAdminFallback
        $sw.Stop()
        @{ success=$true; duration_ms=$sw.ElapsedMilliseconds; drives=$drives; count=$drives.Count;
           message="smartctl not installed - run 'winget install smartmontools.smartmontools'" } | ConvertTo-Json -Depth 6 -Compress
        exit 0
    }
}

$scanOut = & $smartctl --scan 2>&1 | Out-String
foreach ($line in ($scanOut -split "`r?`n")) {
    if ($line -match '^(/dev/\S+|\\\\\.\\PhysicalDrive\d+)') {
        $dev = $Matches[1]
        try {
            $json = & $smartctl -a -j $dev 2>&1 | Out-String
            $d = $json | ConvertFrom-Json
            # Skip drives where the probe clearly failed (no capacity + no model).
            # These manifest as "(0 GB) UNKNOWN" rows in the UI; filtering them
            # here gives a cleaner table instead of garbage entries.
            $capBytes = if ($d.user_capacity.bytes) { [long]$d.user_capacity.bytes } else { 0 }
            $modelStr = "$($d.model_name)"
            if ($capBytes -eq 0 -and [string]::IsNullOrWhiteSpace($modelStr)) { continue }

            $size = if ($capBytes -gt 0) { [math]::Round($capBytes / 1GB, 1) } else { 0 }
            $health = if ($d.smart_status.passed) { 'PASSED' } elseif ($d.smart_status.failed) { 'FAILED' } else { 'UNKNOWN' }
            $wearPct = $null
            $tempC = $null
            $mediaErrors = $null
            $powerOnHours = $null
            if ($d.nvme_smart_health_information_log) {
                $wearPct = $d.nvme_smart_health_information_log.percentage_used
                $tempC = $d.nvme_smart_health_information_log.temperature
                $mediaErrors = $d.nvme_smart_health_information_log.media_errors
                $powerOnHours = $d.nvme_smart_health_information_log.power_on_hours
            } elseif ($d.ata_smart_attributes) {
                foreach ($attr in $d.ata_smart_attributes.table) {
                    if ($attr.name -eq 'Wear_Leveling_Count' -or $attr.name -eq 'SSD_Life_Left' -or $attr.name -eq 'Media_Wearout_Indicator') {
                        $wearPct = 100 - [int]$attr.value
                    }
                    if ($attr.name -eq 'Temperature_Celsius' -or $attr.name -eq 'Airflow_Temperature_Cel') {
                        $tempC = [int]$attr.raw.value
                    }
                    if ($attr.name -eq 'Power_On_Hours') {
                        $powerOnHours = [int]$attr.raw.value
                    }
                }
            }
            $severity = if ($health -eq 'FAILED') { 'crit' }
                        elseif ($health -eq 'UNKNOWN') { 'warn' }
                        elseif ($wearPct -ne $null -and $wearPct -gt 90) { 'crit' }
                        elseif ($wearPct -ne $null -and $wearPct -gt 75) { 'warn' }
                        elseif ($tempC -ne $null -and $tempC -gt 70) { 'warn' }
                        else { 'good' }
            $drives += @{
                drive = "$modelStr ($size GB)"
                model = $modelStr
                device = $dev
                health = $health
                wear_pct = $wearPct
                temp_c = $tempC
                media_errors = $mediaErrors
                power_on_hours = $powerOnHours
                status_severity = $severity
                needs_admin = $false
            }
        } catch {
            # continue with other drives
        }
    }
}

$sw.Stop()
@{ success=$true; duration_ms=$sw.ElapsedMilliseconds; drives=$drives; count=$drives.Count; message="SMART: $($drives.Count) drives" } | ConvertTo-Json -Depth 6 -Compress
exit 0
