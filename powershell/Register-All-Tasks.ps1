param([switch]$DryRun, [switch]$JsonOutput, [switch]$ForceRecreate)
# v2.4.46: $ErrorActionPreference deliberately stays 'Continue' for the
# native cmd.exe / schtasks.exe sections below. The pre-2.4.46 'Stop'
# value combined with cmd.exe stderr output was treated by PowerShell as
# a terminating error, which the trap then re-emitted as
# E_PS_UNHANDLED -- masking the real schtasks message. We still rely on
# the trap for genuinely unhandled exceptions in the managed-PS code
# (Test-Path failures, file IO, etc.). Local 'Stop' is reapplied around
# those small islands.
$ErrorActionPreference = 'Continue'

# v2.4.49 (B47-2): read script version from package.json so the registered
# task XML's <Author> field tracks the live release. Pre-2.4.49 the Author
# string was hardcoded to 'PCDoctor v2.4.46' and drifted across releases,
# making it impossible to tell from a registered task which version of the
# installer last touched it. The read is best-effort: if package.json is
# missing (e.g. running from C:\ProgramData\PCDoctor where ..\package.json
# doesn't exist), the hardcoded fallback below applies. The fallback literal
# is updated alongside the package.json bump per release.
$ScriptVersion = '2.5.15'
try {
    $pkgPath = Join-Path $PSScriptRoot '..\package.json'
    if (Test-Path $pkgPath) {
        $pkg = Get-Content -Path $pkgPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ($pkg.version) { $ScriptVersion = [string]$pkg.version }
    }
} catch {
    # Fallback already set above; swallow.
}

trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$root = 'C:\ProgramData\PCDoctor'
$logDir = "$root\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# ---- v2.3.0 B2: task-context categorization ----
# Tasks that read HKCU / user-profile state (startup items, per-user services,
# browser caches, HWiNFO CSV in the user profile) MUST run in the user's
# interactive context -- otherwise the scanner reads the SYSTEM hive and
# reports bogus counts. Tasks that require elevation (SFC/DISM, VSS, DISM
# /ResetBase) stay at SYSTEM.
$userContextTasks = @(
    @{ name = 'PCDoctor-Weekly-Review';  sched = '/SC WEEKLY /D SUN /ST 22:00'; script = "$root\Invoke-WeeklyReview.ps1" }
    @{ name = 'PCDoctor-Forecast';       sched = '/SC DAILY /ST 07:00';          script = "$root\Get-Forecast.ps1" }
    @{ name = 'PCDoctor-Security-Daily'; sched = '/SC DAILY /ST 06:00';          script = "$root\security\Get-SecurityPosture.ps1" }
)

# Stays SYSTEM because some probes need elevated rights.
$systemContextTasks = @(
    @{ name = 'PCDoctor-Security-Weekly';sched = '/SC WEEKLY /D SAT /ST 23:00';  script = "$root\security\Get-SecurityPosture.ps1" }
    @{ name = 'PCDoctor-Prune-Rollbacks';sched = '/SC DAILY /ST 03:00';          script = "$root\Prune-Rollbacks.ps1" }
)

# ---- v2.2.0 Autopilot schedule rules (split by context) ----
# v2.4.45: Each Autopilot task carries `ruleId` + `tier` so
# Register-PCDoctorTask wraps the action via Run-AutopilotScheduled.ps1.
# The dispatcher appends one JSON line per run to
# autopilot-scheduled-YYYYMMDD.log, which autopilotLogIngestor.ts inserts
# into the autopilot_activity table -- populating the Autopilot page's
# LAST RUN column for scheduled-task runs (which previously bypassed
# actionRunner and never wrote to autopilot_activity).
# ruleId values are taken verbatim from DEFAULT_RULES in autopilotEngine.ts.
# tier is 1 for every schedule-triggered autopilot rule.
# Check-ToolUpdates has no corresponding autopilot_rules row, so it remains
# unwrapped (the tool-updates page reads its own log path).
#
# v2.4.46 (B45-2): SmartCheck and UpdateHosts moved to $systemAutopilotTasks
# because their underlying Run-* scripts require admin rights at runtime --
# Get-Disk + ConfigureDefenderExclusions + writing C:\Windows\System32\drivers\
# etc\hosts. Running them under user/InteractiveToken silently exits with
# UAC failure or 'access denied' and the autopilot LAST RUN column shows
# only red error rows.
$userAutopilotTasks = @(
    @{ name = 'PCDoctor-Autopilot-EmptyRecycleBins';        sched = '/SC WEEKLY /D SUN /ST 03:00';             script = "$root\actions\Empty-RecycleBins.ps1";          ruleId = 'empty_recycle_bins_weekly';       tier = 1 }
    @{ name = 'PCDoctor-Autopilot-ClearBrowserCaches';       sched = '/SC WEEKLY /D SAT /ST 03:00';             script = "$root\actions\Clear-BrowserCaches.ps1";        ruleId = 'clear_browser_caches_weekly';     tier = 1 }
    @{ name = 'PCDoctor-Autopilot-DefenderQuickScan';         sched = '/SC DAILY /ST 02:00';                      script = "$root\actions\Run-DefenderQuickScan.ps1";      ruleId = 'defender_quick_scan_daily';       tier = 1 }
    @{ name = 'PCDoctor-Autopilot-UpdateDefenderDefs';        sched = '/SC DAILY /ST 06:00';                      script = "$root\actions\Update-DefenderDefs.ps1";        ruleId = 'update_defender_defs_daily';      tier = 1 }
    @{ name = 'PCDoctor-Autopilot-MalwarebytesCli';           sched = '/SC WEEKLY /D MON /ST 03:00';              script = "$root\actions\Run-MalwarebytesCli.ps1";        ruleId = 'run_malwarebytes_cli_weekly';     tier = 1 }
    @{ name = 'PCDoctor-Autopilot-AdwCleanerScan';            sched = '/SC MONTHLY /D 1 /ST 04:00';               script = "$root\actions\Run-AdwCleanerScan.ps1";         ruleId = 'run_adwcleaner_scan_monthly';     tier = 1 }
    @{ name = 'PCDoctor-Autopilot-HwinfoLog';                 sched = '/SC MONTHLY /MO FIRST /D SAT /ST 23:00';    script = "$root\actions\Run-HwinfoLog.ps1";              ruleId = 'run_hwinfo_log_monthly';          tier = 1 }
    @{ name = 'PCDoctor-Autopilot-SafetyScanner';             sched = '/SC MONTHLY /MO THIRD /D SAT /ST 04:00';    script = "$root\actions\Run-SafetyScanner.ps1";          ruleId = 'run_safety_scanner_monthly';      tier = 1 }
    # v2.4.51 (B49-NAS-2): nightly refresh of per-NAS-drive @Recycle folder
    # sizes. Top-level Refresh-NasRecycleSizes.ps1 (NOT actions/...) because
    # this is a maintenance task that writes to the DB cache directly via
    # the node-script bridge / queue file -- no actionRunner routing.
    @{ name = 'PCDoctor-Autopilot-RefreshNasRecycleSizes';     sched = '/SC DAILY /ST 03:00';                       script = "$root\Refresh-NasRecycleSizes.ps1";            ruleId = 'refresh_nas_recycle_sizes_daily'; tier = 1 }
    # v2.4.0 tool updates: weekly winget upgrade check (reports only; user
    # presses Upgrade in the Tools page to actually apply).
    # No ruleId -- not an autopilot rule; remains unwrapped.
    @{ name = 'PCDoctor-Weekly-Tool-Updates';                  sched = '/SC WEEKLY /D SUN /ST 04:00';              script = "$root\Check-ToolUpdates.ps1" }
)

$systemAutopilotTasks = @(
    # DISM /ResetBase requires admin, so keep it SYSTEM.
    @{ name = 'PCDoctor-Autopilot-ShrinkComponentStore';      sched = '/SC MONTHLY /MO SECOND /D SAT /ST 04:00';   script = "$root\actions\Shrink-ComponentStore.ps1";      ruleId = 'shrink_component_store_monthly';  tier = 1 }
    # v2.4.46 B45-2: SmartCheck reads physical disk SMART data; needs admin.
    @{ name = 'PCDoctor-Autopilot-SmartCheck';                sched = '/SC DAILY /ST 01:00';                       script = "$root\actions\Run-SmartCheck.ps1";             ruleId = 'run_smart_check_daily';           tier = 1 }
    # v2.4.46 B45-2: UpdateHostsStevenBlack writes %WINDIR%\System32\drivers\etc\hosts.
    # Tier 2 per DEFAULT_RULES in autopilotEngine.ts:77.
    @{ name = 'PCDoctor-Autopilot-UpdateHostsStevenBlack';    sched = '/SC MONTHLY /MO FIRST /D SUN /ST 04:00';    script = "$root\actions\Update-HostsFromStevenBlack.ps1"; ruleId = 'update_hosts_stevenblack_monthly'; tier = 2 }
)

# ---- v2.4.46 helpers: build XML triggers + full task XML for /XML registration ----
# These mirror the proof-of-fix in C:\ProgramData\PCDoctor\logs\wrap-autopilot-xml*.ps1
# which hand-patched Greg's box after the v2.4.45 schtasks /TR 261-char overflow
# silently destroyed the install. Bypassing /TR via /XML removes the length cap
# entirely. Word-week names ('First','Second','Third','Fourth') MUST be mapped
# to their numeric equivalents ('1','2','3','4'); 'Last' stays 'Last'. Without
# the mapping, schtasks /Create /XML rejects the document silently with
# 'The system cannot find the file specified' (exit 1), which also bit Greg
# on 2026-04-24 -- see wrap-autopilot-xml-fixup.ps1.
function ConvertTo-TriggerXml {
    param([Parameter(Mandatory)] [string]$ScheduleSpec)

    # ScheduleSpec examples:
    #   '/SC DAILY /ST 02:00'
    #   '/SC WEEKLY /D SUN /ST 22:00'
    #   '/SC MONTHLY /D 1 /ST 04:00'
    #   '/SC MONTHLY /MO FIRST /D SAT /ST 23:00'

    # Tokenize: split on whitespace, then walk pairs.
    $tokens = $ScheduleSpec.Trim() -split '\s+'
    $kind = $null; $time = $null; $day = $null; $monthOpt = $null; $dayNum = $null
    for ($i = 0; $i -lt $tokens.Length; $i++) {
        switch -Regex ($tokens[$i]) {
            '^/SC$' { $kind = $tokens[$i+1].ToUpperInvariant(); $i++; continue }
            '^/ST$' { $time = $tokens[$i+1]; $i++; continue }
            '^/D$'  {
                $val = $tokens[$i+1]
                if ($val -match '^\d+$') { $dayNum = [int]$val }
                else { $day = $val }
                $i++; continue
            }
            '^/MO$' { $monthOpt = $tokens[$i+1].ToUpperInvariant(); $i++; continue }
        }
    }

    if (-not $time) { throw "ConvertTo-TriggerXml: no /ST in spec '$ScheduleSpec'" }
    $sd = "2026-01-01T${time}:00"

    # Map word-day to XML element name (full English noun, capitalized). schtasks
    # /D accepts MON/TUE/.../SUN abbreviations; the XML schema needs
    # <Sunday/>, <Monday/>, etc.
    $dayMap = @{
        SUN = 'Sunday'; MON = 'Monday'; TUE = 'Tuesday'; WED = 'Wednesday'
        THU = 'Thursday'; FRI = 'Friday'; SAT = 'Saturday'
    }
    $dayElem = if ($day) { $dayMap[$day.ToUpperInvariant()] } else { $null }
    if ($day -and -not $dayElem) { throw "ConvertTo-TriggerXml: unknown /D value '$day'" }

    # Word-week -> numeric. CRITICAL gotcha (caused production-incident #2 on
    # 2026-04-24): the Task Scheduler XML schema requires <Week>1|2|3|4|Last</Week>.
    # 'First','Second','Third','Fourth' (which schtasks /MO accepts) cause silent
    # registration failure when used inside the XML.
    $weekMap = @{
        FIRST = '1'; SECOND = '2'; THIRD = '3'; FOURTH = '4'; LAST = 'Last'
    }

    $monthsXml = '<January/><February/><March/><April/><May/><June/><July/><August/><September/><October/><November/><December/>'

    switch ($kind) {
        'DAILY' {
            return "<CalendarTrigger><StartBoundary>$sd</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>"
        }
        'WEEKLY' {
            if (-not $dayElem) { throw "ConvertTo-TriggerXml: WEEKLY requires /D <day> in '$ScheduleSpec'" }
            return "<CalendarTrigger><StartBoundary>$sd</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><$dayElem /></DaysOfWeek></ScheduleByWeek></CalendarTrigger>"
        }
        'MONTHLY' {
            if ($monthOpt) {
                # MONTHLY /MO <Word> /D <Day> -- day-of-week-of-month
                if (-not $dayElem) { throw "ConvertTo-TriggerXml: MONTHLY /MO requires /D <day> in '$ScheduleSpec'" }
                $weekNum = $weekMap[$monthOpt]
                if (-not $weekNum) { throw "ConvertTo-TriggerXml: unknown /MO value '$monthOpt' (expected First|Second|Third|Fourth|Last)" }
                return "<CalendarTrigger><StartBoundary>$sd</StartBoundary><Enabled>true</Enabled><ScheduleByMonthDayOfWeek><Weeks><Week>$weekNum</Week></Weeks><DaysOfWeek><$dayElem /></DaysOfWeek><Months>$monthsXml</Months></ScheduleByMonthDayOfWeek></CalendarTrigger>"
            }
            elseif ($null -ne $dayNum) {
                # MONTHLY /D <N> -- specific day of month
                return "<CalendarTrigger><StartBoundary>$sd</StartBoundary><Enabled>true</Enabled><ScheduleByMonth><DaysOfMonth><Day>$dayNum</Day></DaysOfMonth><Months>$monthsXml</Months></ScheduleByMonth></CalendarTrigger>"
            }
            else { throw "ConvertTo-TriggerXml: MONTHLY needs either /MO <Word> /D <Day> or /D <N>" }
        }
        default {
            # Reviewer-preempt (plan section 8.a): explicit unknown-schedule guard.
            throw "ConvertTo-TriggerXml: unknown /SC kind '$kind' in spec '$ScheduleSpec' (supported: DAILY|WEEKLY|MONTHLY)"
        }
    }
}

function New-AutopilotTaskXml {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [string]$ScheduleSpec,
        [Parameter(Mandatory)] [string]$RuleId,
        [Parameter(Mandatory)] [int]$Tier,
        [Parameter(Mandatory)] [string]$ActionScript,
        [Parameter(Mandatory)] [ValidateSet('user','system')] [string]$Context,
        [Parameter(Mandatory)] [string]$Dispatcher
    )
    $triggerXml = ConvertTo-TriggerXml -ScheduleSpec $ScheduleSpec

    $argString = "-NoProfile -ExecutionPolicy Bypass -File `"$Dispatcher`" -RuleId `"$RuleId`" -Tier $Tier -ActionScript `"$ActionScript`""
    $argEscaped = [System.Security.SecurityElement]::Escape($argString)

    if ($Context -eq 'user') {
        $runUser = "$env:USERDOMAIN\$env:USERNAME"
        # User XML uses literal DOMAIN\user. Domain users + accented usernames
        # work because the file is written UTF-16 LE w/ BOM below.
        $principalXml = "<Principal id=`"Author`"><UserId>$runUser</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>"
    } else {
        $principalXml = "<Principal id=`"Author`"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal>"
    }

    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>PCDoctor v$ScriptVersion</Author></RegistrationInfo>
  <Triggers>$triggerXml</Triggers>
  <Principals>$principalXml</Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>$argEscaped</Arguments>
    </Exec>
  </Actions>
</Task>
"@
}

# v2.4.54 (B53-MIG-2 follow-up): one-shot COM enumeration of existing
# tasks so the per-task existence pre-check is an O(1) HashSet lookup
# instead of an O(N) `cmd.exe /c schtasks.exe /Query /TN <name>` spawn
# per task. Pre-2.4.54 the v2.4.53 fix added a cmd.exe spawn per task
# (19 tasks × ~3s = ~57s on slow machines) which blew the migration
# block's 60s IPC timeout. The COM Schedule.Service API enumerates the
# whole root folder in ~3 seconds total — a 19× speedup.
#
# Built once at script top; consulted by Register-PCDoctorTask via the
# script-scope variable.
$existingTaskNames = $null
try {
    $ts = New-Object -ComObject Schedule.Service
    $ts.Connect()
    $folder = $ts.GetFolder('\')
    $existingTaskNames = New-Object System.Collections.Generic.HashSet[string] (
        [System.StringComparer]::OrdinalIgnoreCase
    )
    # GetTasks(1) includes hidden tasks. We only care about PCDoctor-*; capturing
    # all of them is fine — the HashSet is a few dozen entries at most.
    foreach ($t in $folder.GetTasks(1)) {
        [void]$existingTaskNames.Add($t.Name)
    }
} catch {
    # COM enumeration failed (very rare). Fall back to per-task /Query
    # spawn — slow but correct. Setting the HashSet to $null signals
    # Register-PCDoctorTask to use the fallback path.
    $existingTaskNames = $null
}

function Register-PCDoctorTask {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [string]$Sched,
        [Parameter(Mandatory)] [string]$Script,
        [string]$LogDir = 'C:\ProgramData\PCDoctor\logs',
        [ValidateSet('user','system')] [string]$Context = 'system',
        [string]$RuleId = '',
        [int]$Tier = 0,
        [switch]$ForceRecreate
    )
    if (-not (Test-Path $Script)) {
        return @{ name = $Name; status = 'skipped'; reason = "Script missing: $Script" }
    }
    $today = Get-Date -Format 'yyyyMMdd'
    $log = Join-Path $LogDir "autopilot-$today.log"

    # v2.4.53 (B53-MIG-2): steady-state idempotency. When NOT -ForceRecreate
    # AND the task already exists, return 'already_registered' instead of
    # blindly attempting /Create (which fails with "Access is denied" against
    # tasks that were originally created elevated). Pre-2.4.53 every steady-
    # state launch ran Register-All-Tasks.ps1 non-elevated, every task came
    # back 'failed', the new B48-AS-3 exit-code logic surfaced exit 1, and
    # the migration block's outer try/catch swallowed it without affecting
    # behavior — but the silent E_PS_NONZERO_EXIT was real, and the v2.4.51
    # `last_task_migration_version` stuck-at-stale-value bug was the same
    # mechanism manifesting under the upgrade-then-verify sub-path.
    #
    # v2.4.54 (B53-MIG-2 fast path): consult the COM-enumerated HashSet
    # built at script top. O(1) lookup; no cmd.exe spawn for the common
    # case. The COM API enumerates user-context tasks reliably from a
    # non-elevated session, but DOES NOT include SYSTEM-context tasks
    # (verified empirically: 19 tasks total, COM sees 14, the 5 missing
    # are all SYSTEM-context). For tasks NOT in the COM HashSet, fall
    # back to cmd.exe /c schtasks.exe /Query /TN with the v2.4.53
    # two-tier semantics — exit 0 OR stderr matches /Access is denied/
    # both indicate the task exists. The fallback only fires for the
    # ~5 SYSTEM-context tasks per launch, keeping the total spawn count
    # to ~5 × ~3s = ~15s wall clock — well under the 60s IPC timeout.
    if (-not $ForceRecreate) {
        $taskExists = $false
        if ($null -ne $existingTaskNames -and $existingTaskNames.Contains($Name)) {
            $taskExists = $true
        } else {
            # Per-task fallback for tasks the COM HashSet doesn't include
            # (SYSTEM-context tasks aren't returned to non-elevated COM
            # callers, even with GetTasks(1)). Use the PowerShell
            # ScheduledTasks module's `Get-ScheduledTask` cmdlet — it's
            # a managed API call (no cmd.exe spawn → no per-call Defender
            # scan latency). 'NotPresent' or empty means the task is
            # genuinely missing → fall through to /Create. Any other
            # outcome (including the access-denied throw) means it exists
            # → mark already_registered.
            try {
                $existing = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
                $taskExists = $null -ne $existing
            } catch [Microsoft.Management.Infrastructure.CimException] {
                # CimException with HResult 0x80131500 typically wraps
                # ERROR_ACCESS_DENIED for SYSTEM-context tasks. Treat as
                # exists.
                $taskExists = $true
            } catch {
                # Last-ditch fallback: cmd.exe /Query with the v2.4.53
                # two-tier semantic. Only fires when both COM and
                # Get-ScheduledTask are unavailable.
                $queryOut = cmd.exe /c "schtasks.exe /Query /TN `"$Name`" 2>&1" 2>&1 | Out-String
                $queryExit = $LASTEXITCODE
                $taskExists = ($queryExit -eq 0) -or ($queryOut -match 'Access is denied')
            }
        }
        if ($taskExists) {
            return @{ name = $Name; status = 'already_registered'; context = $Context }
        }
    }

    if ($RuleId -and $Tier -ge 1) {
        # v2.4.46 fix path: build full Task XML and register via /XML to bypass
        # the schtasks /TR 261-char limit that silently broke v2.4.45 on every
        # install. The wrapped command-line is ~279 chars (path + dispatcher +
        # args + redirect) -- well over the limit. /XML has no length cap.
        $dispatcher = "$root\Run-AutopilotScheduled.ps1"
        if (-not (Test-Path -LiteralPath $dispatcher)) {
            return @{ name = $Name; status = 'skipped'; reason = "Dispatcher missing: $dispatcher" }
        }

        if ($ForceRecreate) {
            cmd.exe /c "schtasks.exe /Delete /TN `"$Name`" /F" *>$null
        }

        try {
            $taskXml = New-AutopilotTaskXml -Name $Name -ScheduleSpec $Sched -RuleId $RuleId -Tier $Tier -ActionScript $Script -Context $Context -Dispatcher $dispatcher
        } catch {
            return @{ name = $Name; status = 'failed'; context = $Context; output = "XML build failed: $($_.Exception.Message)"; command = '<XML build error>' }
        }

        $xmlPath = Join-Path $env:TEMP "pcd-task-$Name.xml"
        try {
            # UTF-16 LE w/ BOM. schtasks /Create /XML rejects UTF-8.
            [System.IO.File]::WriteAllText($xmlPath, $taskXml, [System.Text.UnicodeEncoding]::new($false, $true))
        } catch {
            return @{ name = $Name; status = 'failed'; context = $Context; output = "WriteAllText failed: $($_.Exception.Message)"; command = '<XML write error>' }
        }

        $out = cmd.exe /c "schtasks.exe /Create /TN `"$Name`" /XML `"$xmlPath`" /F" 2>&1 | Out-String
        $code = $LASTEXITCODE
        Remove-Item $xmlPath -ErrorAction SilentlyContinue
        $ok = $code -eq 0
        # `command` field surfaces the dispatcher invocation for the
        # post-registration verification block in main.ts (so we can prove
        # at least one task is wrapped before writing the migration flag).
        return @{
            name    = $Name
            status  = if ($ok) { 'registered' } else { 'failed' }
            context = $Context
            output  = $out.Trim()
            command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$dispatcher`" -RuleId `"$RuleId`" -Tier $Tier -ActionScript `"$Script`""
        }
    }

    # Legacy non-autopilot path: keep the existing /TR pipeline. These tasks
    # all fit comfortably under 261 chars (verified by test-task-registration.ps1).
    $psCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Script`" -JsonOutput >> `"$log`" 2>&1"

    if ($ForceRecreate) {
        cmd.exe /c "schtasks.exe /Delete /TN `"$Name`" /F" *>$null
    }

    if ($Context -eq 'user') {
        $runUser = "$env:USERDOMAIN\$env:USERNAME"
        $createArgs = "/Create /TN `"$Name`" /TR `"$psCmd`" $Sched /RU `"$runUser`" /IT /RL LIMITED /F"
    }
    else {
        $createArgs = "/Create /TN `"$Name`" /TR `"$psCmd`" $Sched /RU SYSTEM /RL HIGHEST /F"
    }
    $out = cmd.exe /c "schtasks.exe $createArgs" 2>&1 | Out-String
    $ok = $LASTEXITCODE -eq 0
    return @{ name = $Name; status = if ($ok) { 'registered' } else { 'failed' }; context = $Context; output = $out.Trim(); command = $psCmd }
}

# v2.4.45: splat helper so tasks carrying ruleId+tier (the autopilot rows)
# route through the dispatcher while legacy rows without them use the
# unwrapped path. Matches PS5.1+ semantics for conditional splat params.
function _InvokeReg {
    param($Task, [string]$Ctx, [string]$LogDir, [switch]$ForceRecreate)
    $p = @{
        Name          = $Task.name
        Sched         = $Task.sched
        Script        = $Task.script
        Context       = $Ctx
        ForceRecreate = $ForceRecreate
    }
    if ($LogDir) { $p['LogDir'] = $LogDir }
    if ($Task.ContainsKey('ruleId') -and $Task.ruleId) {
        $p['RuleId'] = [string]$Task.ruleId
        $p['Tier']   = [int]$Task.tier
    }
    return (Register-PCDoctorTask @p)
}

$results = @()
foreach ($t in $userContextTasks)     { $results += _InvokeReg -Task $t -Ctx 'user'   -ForceRecreate:$ForceRecreate }
foreach ($t in $systemContextTasks)   { $results += _InvokeReg -Task $t -Ctx 'system' -ForceRecreate:$ForceRecreate }
foreach ($t in $userAutopilotTasks)   { $results += _InvokeReg -Task $t -Ctx 'user'   -LogDir $logDir -ForceRecreate:$ForceRecreate }
foreach ($t in $systemAutopilotTasks) { $results += _InvokeReg -Task $t -Ctx 'system' -LogDir $logDir -ForceRecreate:$ForceRecreate }

# ---- Autostart task (unchanged from v2.1.x) ----
$autostartExe = Join-Path $env:LOCALAPPDATA 'Programs\PCDoctor Workbench\PCDoctor Workbench.exe'
if (Test-Path $autostartExe) {
    $existing = cmd.exe /c 'schtasks.exe /Query /TN "PCDoctor-Workbench-Autostart" 2>NUL' 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        $autostartXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>$autostartExe</Command></Exec></Actions>
</Task>
"@
        $xmlPath = Join-Path $env:TEMP 'PCDoctor-Autostart.xml'
        [System.IO.File]::WriteAllText($xmlPath, $autostartXml, [System.Text.UnicodeEncoding]::new($false, $true))
        $out = cmd.exe /c "schtasks.exe /Create /TN `"PCDoctor-Workbench-Autostart`" /XML `"$xmlPath`" /F" 2>&1 | Out-String
        $ok = $LASTEXITCODE -eq 0
        Remove-Item $xmlPath -ErrorAction SilentlyContinue
        $results += @{ name = 'PCDoctor-Workbench-Autostart'; status = if ($ok) { 'registered' } else { 'failed' }; output = $out.Trim() }
    } else {
        $results += @{ name = 'PCDoctor-Workbench-Autostart'; status = 'already_registered' }
    }
} else {
    $results += @{ name = 'PCDoctor-Workbench-Autostart'; status = 'skipped'; reason = "Workbench exe not found at: $autostartExe" }
}

$sw.Stop()
$totalCount = @($userContextTasks).Count + @($systemContextTasks).Count + @($userAutopilotTasks).Count + @($systemAutopilotTasks).Count + 1

# v2.4.48 (B48-AS-3): emit success=false + exit 1 when any required task
# registration fails. Pre-2.4.48 this script unconditionally wrote
# success=$true regardless of how many rows reported `failed` -- the
# migration block in main.ts saw success and trusted it. The Autostart
# task is excluded from the required set because it legitimately reports
# `skipped` on a fresh install (line ~363 above) before the workbench
# .exe is in %LOCALAPPDATA%; every other failed row is load-bearing.
$failedRequired = @($results | Where-Object {
    $_.status -eq 'failed' -and $_.name -ne 'PCDoctor-Workbench-Autostart'
}).Count
$overallSuccess = ($failedRequired -eq 0)
$result = @{
    success     = $overallSuccess
    duration_ms = $sw.ElapsedMilliseconds
    results     = $results
    message     = if ($overallSuccess) { "Processed $totalCount tasks" } else { "Processed $totalCount tasks; $failedRequired required tasks failed" }
}
$result | ConvertTo-Json -Depth 5 -Compress
if ($overallSuccess) { exit 0 } else { exit 1 }
