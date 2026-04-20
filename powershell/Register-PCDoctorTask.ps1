#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Registers (or replaces) PC Doctor scheduled tasks.
.DESCRIPTION
    Creates three tasks under the SYSTEM account:
      1. PCDoctor-Weekly       — Sundays 02:00, runs Run-PCDoctorWeekly.ps1
                                 (Invoke -Mode Auto + Get-PCDoctorTrends + retention prune)
      2. PCDoctor-Daily-Quick  — Daily 08:00, runs Invoke-PCDoctor.ps1 -Mode Report
                                 (read-only, ~20 sec, catches fast-moving issues)
      3. PCDoctor-Monthly-Deep — Sundays 03:00 first week of month,
                                 runs Invoke-PCDoctor.ps1 -Mode DeepScan
                                 (SFC + DISM /RestoreHealth, 10-30 min)

    All tasks use schtasks.exe API for registration since Get-ScheduledTask is broken
    on this PC. Register-ScheduledTask still works via a different code path so this
    script uses it for cleaner XML generation.
#>

$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\PCDoctor'

if (-not (Test-Path "$root\Run-PCDoctorWeekly.ps1")) { throw "Wrapper script not found at $root\Run-PCDoctorWeekly.ps1" }
if (-not (Test-Path "$root\Invoke-PCDoctor.ps1"))    { throw "Main script not found at $root\Invoke-PCDoctor.ps1" }

# Register Application event source for PCDoctor (idempotent — checks first)
try {
    if (-not [System.Diagnostics.EventLog]::SourceExists('PCDoctor')) {
        New-EventLog -LogName Application -Source 'PCDoctor'
        Write-Host "Created Application log event source: PCDoctor"
    } else {
        Write-Host "Event source 'PCDoctor' already exists"
    }
} catch {
    Write-Warning "Could not create event source (need admin): $_"
}

function Register-PCDTask {
    param(
        [string]$TaskName,
        [string]$Description,
        $Trigger,
        [string]$Argument,
        [int]$TimeLimitMinutes = 120
    )
    # Use schtasks.exe /Delete because Get-ScheduledTask cmdlet is broken on this system
    # (returns 0 results due to MSFT_ScheduledTask provider issue from 2026-04-15 SPP work).
    # Suppress all output (stdout+stderr) and exit codes — "task not found" is expected on first run.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try { & schtasks.exe /Delete /TN $TaskName /F *>&1 | Out-Null } catch {}
    $ErrorActionPreference = $prevEAP
    if ($LASTEXITCODE -eq 0) { Write-Host "Removed existing task: $TaskName" }
    $action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $Argument
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet `
                    -AllowStartIfOnBatteries `
                    -DontStopIfGoingOnBatteries `
                    -StartWhenAvailable `
                    -ExecutionTimeLimit (New-TimeSpan -Minutes $TimeLimitMinutes) `
                    -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName `
                           -Description $Description `
                           -Action $action `
                           -Trigger $Trigger `
                           -Principal $principal `
                           -Settings $settings | Out-Null
    Write-Host "Registered: $TaskName"
}

# ---- Task 1: Weekly (existing) ----
$wrapperArg = "-NoProfile -ExecutionPolicy Bypass -File `"$root\Run-PCDoctorWeekly.ps1`""
$weeklyTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 2:00AM
Register-PCDTask -TaskName 'PCDoctor-Weekly' `
                 -Description 'Weekly PC Doctor: full health check + trend analysis + safe cleanup + retention prune. See C:\ProgramData\PCDoctor\reports' `
                 -Trigger $weeklyTrigger `
                 -Argument $wrapperArg `
                 -TimeLimitMinutes 120

# ---- Task 2: Daily quick check (NEW) ----
$dailyArg = "-NoProfile -ExecutionPolicy Bypass -File `"$root\Invoke-PCDoctor.ps1`" -Mode Report"
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At 8:00AM
Register-PCDTask -TaskName 'PCDoctor-Daily-Quick' `
                 -Description 'Daily PC Doctor read-only quick check. Fast issue detection between weekly runs.' `
                 -Trigger $dailyTrigger `
                 -Argument $dailyArg `
                 -TimeLimitMinutes 10

# ---- Task 3: Monthly DeepScan (NEW) ----
# Trigger weekly on Sunday at 03:00; the wrapper script gates "first Sunday of month".
$deepArg = "-NoProfile -ExecutionPolicy Bypass -Command `"if ((Get-Date).Day -le 7) { & '$root\Invoke-PCDoctor.ps1' -Mode DeepScan }`""
$deepTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3:00AM
Register-PCDTask -TaskName 'PCDoctor-Monthly-Deep' `
                 -Description 'First Sunday of each month at 03:00: DeepScan (SFC + DISM /RestoreHealth). Trigger fires every Sunday but inline gate skips if not within first 7 days.' `
                 -Trigger $deepTrigger `
                 -Argument $deepArg `
                 -TimeLimitMinutes 60

Write-Host ""
Write-Host "All PC Doctor tasks registered."
Write-Host ""
Write-Host "Verify with:"
Write-Host "  schtasks.exe /Query /TN PCDoctor-Weekly /V /FO LIST | Select-String 'Last|Next|Status'"
Write-Host "  schtasks.exe /Query /TN PCDoctor-Daily-Quick /V /FO LIST | Select-String 'Last|Next|Status'"
Write-Host "  schtasks.exe /Query /TN PCDoctor-Monthly-Deep /V /FO LIST | Select-String 'Last|Next|Status'"
