param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$smartctl = 'C:\Program Files\smartmontools\bin\smartctl.exe'
if (-not (Test-Path $smartctl)) {
    # Fallback to PATH
    $smartctl = (Get-Command smartctl -ErrorAction SilentlyContinue).Source
    if (-not $smartctl) { throw 'smartctl.exe not found. Install smartmontools.' }
}

$drives = @()
$scanOut = & $smartctl --scan 2>&1 | Out-String
foreach ($line in ($scanOut -split "`r?`n")) {
    if ($line -match '^(/dev/\S+|\\\\\.\\PhysicalDrive\d+)') {
        $dev = $Matches[1]
        try {
            $json = & $smartctl -a -j $dev 2>&1 | Out-String
            $d = $json | ConvertFrom-Json
            $driveLetter = if ($d.device.name) { $d.device.name } else { $dev }
            $model = "$($d.model_name)"
            $size = if ($d.user_capacity.bytes) { [math]::Round($d.user_capacity.bytes / 1GB, 1) } else { 0 }
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
                # ATA/SATA SSD or HDD
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
                drive = "$($model) ($size GB)"
                model = $model
                device = $dev
                health = $health
                wear_pct = $wearPct
                temp_c = $tempC
                media_errors = $mediaErrors
                power_on_hours = $powerOnHours
                status_severity = $severity
            }
        } catch {
            # continue with other drives
        }
    }
}

$sw.Stop()
@{ success=$true; duration_ms=$sw.ElapsedMilliseconds; drives=$drives; count=$drives.Count; message="SMART: $($drives.Count) drives" } | ConvertTo-Json -Depth 6 -Compress
exit 0
