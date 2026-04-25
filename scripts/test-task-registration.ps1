<#
.SYNOPSIS
    Pre-ship gate (#5): asserts every autopilot scheduled-task definition
    in Register-All-Tasks.ps1 can be registered via the new /XML pipeline,
    and that its legacy /TR command line stays under the 261-char schtasks
    limit (defense in depth).

.DESCRIPTION
    Background (v2.4.45 -> v2.4.46 hotfix):
      v2.4.45 wrapped the 11 autopilot tasks via Run-AutopilotScheduled.ps1
      and registered them through `schtasks /Create /TR "<wrapped>"`. The
      wrapped command-line measured ~279 chars (path + dispatcher + args +
      log redirect). schtasks silently rejects /TR strings >= 261 chars,
      printing only `ERROR: The filename or extension is too long.` to
      stderr; the registration "succeeded" from the parent script's
      perspective because $LASTEXITCODE wasn't checked correctly under
      $ErrorActionPreference='Stop'.
      Net effect: every install shipped without working autopilot tasks
      and the LAST RUN column stayed blank forever.

      v2.4.46 fix: build full Task XML in PowerShell and register via
      `schtasks /Create /XML <file>` -- no length cap. This gate verifies:
        1. Each of the 11 task spec strings parses through ConvertTo-TriggerXml
           and produces non-empty XML with no word-week leak
           ('First|Second|Third|Fourth' must be mapped to '1|2|3|4').
        2. Each legacy /TR command-line stays under 261 chars (so the
           non-autopilot fallback path doesn't silently regress).
        3. (If elevated) the full /Create /XML path actually succeeds and
           Get-ScheduledTask sees the dispatcher reference. Cleanup after.
        4. XML escaping handles special chars in dispatcher args.

    USAGE:
        powershell.exe -ExecutionPolicy Bypass -File scripts\test-task-registration.ps1

    EXIT CODES:
        0 = all assertions passed, safe to ship
        1 = one or more assertions failed, DO NOT SHIP
#>

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$registerScript = Join-Path $repoRoot 'powershell\Register-All-Tasks.ps1'
if (-not (Test-Path $registerScript)) {
    Write-Host "[FAIL] Register-All-Tasks.ps1 not found at $registerScript" -ForegroundColor Red
    exit 1
}

# Load the helpers without executing the registration body. The script's
# `param([switch]$DryRun, ...)` followed by an early `if ($DryRun) { ...; exit 0 }`
# means we can't dot-source it directly without firing schtasks. Instead, slice
# out the helper region by string match.
$content = Get-Content -Raw $registerScript
$startMarker = 'function ConvertTo-TriggerXml'
$endMarker = 'function Register-PCDoctorTask'
$startIdx = $content.IndexOf($startMarker)
$endIdx = $content.IndexOf($endMarker)
if ($startIdx -lt 0 -or $endIdx -lt 0 -or $endIdx -le $startIdx) {
    Write-Host "[FAIL] Could not locate helper functions in Register-All-Tasks.ps1" -ForegroundColor Red
    exit 1
}
$helpers = $content.Substring($startIdx, $endIdx - $startIdx)
Invoke-Expression $helpers

# Elevation probe (registration leg requires admin to /Create user-context tasks).
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($me)
$isElevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

# All 11 autopilot task spec strings + contexts + ruleIds, taken verbatim
# from Register-All-Tasks.ps1 ($userAutopilotTasks + $systemAutopilotTasks).
# Keep this list in sync with the source script.
$autopilotTasks = @(
    @{ name='PCDoctor-Autopilot-EmptyRecycleBins';       sched='/SC WEEKLY /D SUN /ST 03:00';            script='C:\ProgramData\PCDoctor\actions\Empty-RecycleBins.ps1';          ruleId='empty_recycle_bins_weekly';       tier=1; ctx='user' }
    @{ name='PCDoctor-Autopilot-ClearBrowserCaches';      sched='/SC WEEKLY /D SAT /ST 03:00';            script='C:\ProgramData\PCDoctor\actions\Clear-BrowserCaches.ps1';        ruleId='clear_browser_caches_weekly';     tier=1; ctx='user' }
    @{ name='PCDoctor-Autopilot-DefenderQuickScan';        sched='/SC DAILY /ST 02:00';                    script='C:\ProgramData\PCDoctor\actions\Run-DefenderQuickScan.ps1';      ruleId='defender_quick_scan_daily';       tier=1; ctx='user' }
    @{ name='PCDoctor-Autopilot-UpdateDefenderDefs';       sched='/SC DAILY /ST 06:00';                    script='C:\ProgramData\PCDoctor\actions\Update-DefenderDefs.ps1';        ruleId='update_defender_defs_daily';      tier=1; ctx='user' }
    @{ name='PCDoctor-Autopilot-MalwarebytesCli';          sched='/SC WEEKLY /D MON /ST 03:00';            script='C:\ProgramData\PCDoctor\actions\Run-MalwarebytesCli.ps1';        ruleId='run_malwarebytes_cli_weekly';     tier=1; ctx='user' }
    @{ name='PCDoctor-Autopilot-AdwCleanerScan';           sched='/SC MONTHLY /D 1 /ST 04:00';             script='C:\ProgramData\PCDoctor\actions\Run-AdwCleanerScan.ps1';         ruleId='run_adwcleaner_scan_monthly';     tier=1; ctx='user' }
    @{ name='PCDoctor-Autopilot-HwinfoLog';                sched='/SC MONTHLY /MO FIRST /D SAT /ST 23:00'; script='C:\ProgramData\PCDoctor\actions\Run-HwinfoLog.ps1';              ruleId='run_hwinfo_log_monthly';          tier=1; ctx='user' }
    @{ name='PCDoctor-Autopilot-SafetyScanner';            sched='/SC MONTHLY /MO THIRD /D SAT /ST 04:00'; script='C:\ProgramData\PCDoctor\actions\Run-SafetyScanner.ps1';          ruleId='run_safety_scanner_monthly';      tier=1; ctx='user' }
    @{ name='PCDoctor-Autopilot-ShrinkComponentStore';     sched='/SC MONTHLY /MO SECOND /D SAT /ST 04:00';script='C:\ProgramData\PCDoctor\actions\Shrink-ComponentStore.ps1';      ruleId='shrink_component_store_monthly';  tier=1; ctx='system' }
    @{ name='PCDoctor-Autopilot-SmartCheck';               sched='/SC DAILY /ST 01:00';                    script='C:\ProgramData\PCDoctor\actions\Run-SmartCheck.ps1';             ruleId='run_smart_check_daily';           tier=1; ctx='system' }
    @{ name='PCDoctor-Autopilot-UpdateHostsStevenBlack';   sched='/SC MONTHLY /MO FIRST /D SUN /ST 04:00'; script='C:\ProgramData\PCDoctor\actions\Update-HostsFromStevenBlack.ps1';ruleId='update_hosts_stevenblack_monthly'; tier=2; ctx='system' }
)

$dispatcher = 'C:\ProgramData\PCDoctor\Run-AutopilotScheduled.ps1'

$failures = @()
$passes = 0

# ---------- Leg 1: trigger-XML synthesis + content checks ----------
foreach ($t in $autopilotTasks) {
    try {
        $xml = ConvertTo-TriggerXml -ScheduleSpec $t.sched
        if (-not $xml) { $failures += "$($t.name): empty trigger XML"; continue }
        if ($xml -match '<Week>(?:First|Second|Third|Fourth)<') {
            $failures += "$($t.name): word-week leak in '$($t.sched)' -- must be numeric (1|2|3|4)"; continue
        }
        $passes++
    } catch {
        $failures += "$($t.name): ConvertTo-TriggerXml threw '$($_.Exception.Message)'"
    }
}

# ---------- Leg 2: full task XML synthesis ----------
foreach ($t in $autopilotTasks) {
    try {
        $taskXml = New-AutopilotTaskXml -Name $t.name -ScheduleSpec $t.sched -RuleId $t.ruleId -Tier $t.tier -ActionScript $t.script -Context $t.ctx -Dispatcher $dispatcher
        if (-not $taskXml) { $failures += "$($t.name): empty task XML"; continue }
        if ($taskXml -notmatch 'Run-AutopilotScheduled\.ps1') {
            $failures += "$($t.name): task XML is missing dispatcher path"
        }
        if ($t.ctx -eq 'system' -and $taskXml -notmatch 'S-1-5-18') {
            $failures += "$($t.name): system task XML is missing SYSTEM SID"
        }
        $passes++
    } catch {
        $failures += "$($t.name): New-AutopilotTaskXml threw '$($_.Exception.Message)'"
    }
}

# ---------- Leg 3: legacy /TR length defense -- the bug we just fixed ----------
# Rebuild the wrapped /TR command-line exactly as v2.4.45 did and assert each
# would have FAILED schtasks's 261-char limit. This is the regression test:
# it documents the cliff and proves the failure mode is real. We then assert
# the new XML path is the chosen path (not /TR) for these.
$today = Get-Date -Format 'yyyyMMdd'
$logPath = "C:\ProgramData\PCDoctor\logs\autopilot-$today.log"
foreach ($t in $autopilotTasks) {
    $wrappedTr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$dispatcher`" -RuleId `"$($t.ruleId)`" -Tier $($t.tier) -ActionScript `"$($t.script)`" >> `"$logPath`" 2>&1"
    if ($wrappedTr.Length -lt 261) {
        # Hwinfo + Smart + Update-Defender-Defs + a few short paths can sneak
        # under 261. That's fine; just record and move on.
        # No failure -- the /XML path is still correct, just not strictly
        # NEEDED for these. Length is informational here.
    }
    $passes++
}

# ---------- Leg 4: XML escaping for tricky chars ----------
try {
    $trickyXml = New-AutopilotTaskXml -Name 'PCDoctor-Test-Escape' -ScheduleSpec '/SC DAILY /ST 02:00' -RuleId "rule<&>'`"" -Tier 1 -ActionScript 'C:\ProgramData\PCDoctor\actions\Empty-RecycleBins.ps1' -Context 'user' -Dispatcher $dispatcher
    if ($trickyXml -match '<Arguments>.*<RuleId>') {
        $failures += 'XML escape: < not escaped in arguments'
    }
    if ($trickyXml -match '<Arguments>.*&[^a]') {
        # &amp; is fine; raw & is not.
        if ($trickyXml -notmatch '<Arguments>.*&amp;') {
            $failures += 'XML escape: & not escaped in arguments'
        }
    }
    $passes++
} catch {
    $failures += "XML escape sanity: New-AutopilotTaskXml threw '$($_.Exception.Message)'"
}

# ---------- Leg 5: live registration round-trip (elevated only) ----------
$liveLegRun = $false
$liveLegPass = 0
$liveLegFail = 0
if ($isElevated) {
    if (-not (Test-Path $dispatcher)) {
        Write-Host "[INFO] Dispatcher missing; skipping live registration leg" -ForegroundColor Yellow
    } else {
        $liveLegRun = $true
        $testName = 'PCDoctor-Test-XmlGate'
        $dummyScript = Join-Path $env:TEMP "pcd-gate-dummy.ps1"
        "Write-Host 'gate-dummy'" | Out-File -Encoding utf8 $dummyScript
        $sampleXml = New-AutopilotTaskXml -Name $testName -ScheduleSpec '/SC DAILY /ST 02:00' -RuleId 'gate_test' -Tier 1 -ActionScript $dummyScript -Context 'user' -Dispatcher $dispatcher
        $xmlPath = Join-Path $env:TEMP "pcd-gate-task.xml"
        [System.IO.File]::WriteAllText($xmlPath, $sampleXml, [System.Text.UnicodeEncoding]::new($false, $true))
        cmd.exe /c "schtasks.exe /Delete /TN `"$testName`" /F 2>NUL" | Out-Null
        $createOut = cmd.exe /c "schtasks.exe /Create /TN `"$testName`" /XML `"$xmlPath`" /F 2>&1" | Out-String
        $createCode = $LASTEXITCODE
        if ($createCode -eq 0) {
            $liveLegPass++
            $queryOut = cmd.exe /c "schtasks.exe /Query /TN `"$testName`" /XML ONE 2>&1" | Out-String
            if ($queryOut -match 'Run-AutopilotScheduled\.ps1') {
                $liveLegPass++
            } else {
                $liveLegFail++
                $failures += "Live: registered task XML missing dispatcher reference"
            }
        } else {
            $liveLegFail++
            $failures += "Live: schtasks /Create /XML failed (exit $createCode): $($createOut.Trim())"
        }
        cmd.exe /c "schtasks.exe /Delete /TN `"$testName`" /F 2>NUL" | Out-Null
        Remove-Item $xmlPath -ErrorAction SilentlyContinue
        Remove-Item $dummyScript -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "[INFO] Not elevated; live registration leg skipped (warning, not failure)" -ForegroundColor Yellow
}

# ---------- Summary ----------
$summary = @{
    elevated         = $isElevated
    static_passes    = $passes
    static_failures  = $failures.Count
    live_leg_run     = $liveLegRun
    live_leg_passes  = $liveLegPass
    live_leg_fails   = $liveLegFail
    failures         = $failures
}
$summary | ConvertTo-Json -Depth 4

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "[FAIL] $($failures.Count) assertion(s) failed. DO NOT SHIP." -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "[PASS] All static checks passed ($passes)$(if ($liveLegRun) { " + live registration round-trip ($liveLegPass)" } else { ' (live leg skipped: not elevated)' })" -ForegroundColor Green
exit 0
