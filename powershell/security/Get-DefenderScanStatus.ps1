<#
.SYNOPSIS
    Returns JSON describing the state of any in-progress or last-completed
    Windows Defender scan.

.DESCRIPTION
    Driven by Get-MpComputerStatus. A scan is considered "running" when its
    StartTime is greater than its EndTime (or EndTime is null). This script
    never blocks - it only reads status.
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
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($DryRun) {
    @{ success = $true; dry_run = $true; duration_ms = $sw.ElapsedMilliseconds } | ConvertTo-Json -Compress
    exit 0
}

function ConvertTo-Iso {
    param($v)
    if ($null -eq $v) { return $null }
    try {
        if ($v -is [datetime]) { return $v.ToString('o') }
        $dt = [datetime]$v
        return $dt.ToString('o')
    } catch { return $null }
}

function Get-AgeHours {
    param($dt)
    if ($null -eq $dt) { return $null }
    try {
        $d = if ($dt -is [datetime]) { $dt } else { [datetime]$dt }
        return [math]::Round(((Get-Date) - $d).TotalHours, 1)
    } catch { return $null }
}

function Get-AgeDays {
    param($dt)
    if ($null -eq $dt) { return $null }
    try {
        $d = if ($dt -is [datetime]) { $dt } else { [datetime]$dt }
        return [math]::Round(((Get-Date) - $d).TotalDays, 1)
    } catch { return $null }
}

function Is-DefenderScanRunning {
    param($start, $end)
    if ($null -eq $start) { return $false }
    if ($null -eq $end) { return $true }
    try {
        $s = if ($start -is [datetime]) { $start } else { [datetime]$start }
        $e = if ($end -is [datetime])   { $end }   else { [datetime]$end }
        return ($s -gt $e)
    } catch {
        return $false
    }
}

$status = $null
try {
    $status = Get-MpComputerStatus -ErrorAction Stop
} catch {
    # Defender not installed / Get-MpComputerStatus unavailable — return empty shape.
    $result = @{
        success                  = $true
        duration_ms              = $sw.ElapsedMilliseconds
        available                = $false
        message                  = 'Get-MpComputerStatus unavailable'
        realtime_protection      = $null
        quick_scan_running       = $false
        full_scan_running        = $false
        quick_scan_start_time    = $null
        quick_scan_end_time      = $null
        quick_scan_age_hours     = $null
        full_scan_start_time     = $null
        full_scan_end_time       = $null
        full_scan_age_days       = $null
        scan_elapsed_minutes     = $null
        typical_quick_min        = 15
        typical_full_min         = 180
    }
    $result | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

$quickRunning = Is-DefenderScanRunning -start $status.QuickScanStartTime -end $status.QuickScanEndTime
$fullRunning  = Is-DefenderScanRunning -start $status.FullScanStartTime  -end $status.FullScanEndTime

$elapsedMin = $null
if ($quickRunning -or $fullRunning) {
    $runStart = if ($fullRunning) { $status.FullScanStartTime } else { $status.QuickScanStartTime }
    if ($runStart) {
        try {
            $s = if ($runStart -is [datetime]) { $runStart } else { [datetime]$runStart }
            $elapsedMin = [math]::Round(((Get-Date) - $s).TotalMinutes, 1)
        } catch { $elapsedMin = $null }
    }
}

$result = [ordered]@{
    success               = $true
    duration_ms           = $sw.ElapsedMilliseconds
    available             = $true
    realtime_protection   = [bool]$status.RealTimeProtectionEnabled
    quick_scan_running    = $quickRunning
    full_scan_running     = $fullRunning
    quick_scan_start_time = ConvertTo-Iso $status.QuickScanStartTime
    quick_scan_end_time   = ConvertTo-Iso $status.QuickScanEndTime
    quick_scan_age_hours  = Get-AgeHours $status.QuickScanEndTime
    full_scan_start_time  = ConvertTo-Iso $status.FullScanStartTime
    full_scan_end_time    = ConvertTo-Iso $status.FullScanEndTime
    full_scan_age_days    = Get-AgeDays $status.FullScanEndTime
    scan_elapsed_minutes  = $elapsedMin
    typical_quick_min     = 15
    typical_full_min      = 180
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
