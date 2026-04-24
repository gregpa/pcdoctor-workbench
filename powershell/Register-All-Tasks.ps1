param([switch]$DryRun, [switch]$JsonOutput, [switch]$ForceRecreate)
$ErrorActionPreference = 'Stop'
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
$userAutopilotTasks = @(
    @{ name = 'PCDoctor-Autopilot-EmptyRecycleBins';        sched = '/SC WEEKLY /D SUN /ST 03:00';             script = "$root\actions\Empty-RecycleBins.ps1";          ruleId = 'empty_recycle_bins_weekly';       tier = 1 }
    @{ name = 'PCDoctor-Autopilot-ClearBrowserCaches';       sched = '/SC WEEKLY /D SAT /ST 03:00';             script = "$root\actions\Clear-BrowserCaches.ps1";        ruleId = 'clear_browser_caches_weekly';     tier = 1 }
    @{ name = 'PCDoctor-Autopilot-DefenderQuickScan';         sched = '/SC DAILY /ST 02:00';                      script = "$root\actions\Run-DefenderQuickScan.ps1";      ruleId = 'defender_quick_scan_daily';       tier = 1 }
    @{ name = 'PCDoctor-Autopilot-UpdateDefenderDefs';        sched = '/SC DAILY /ST 06:00';                      script = "$root\actions\Update-DefenderDefs.ps1";        ruleId = 'update_defender_defs_daily';      tier = 1 }
    @{ name = 'PCDoctor-Autopilot-SmartCheck';                sched = '/SC DAILY /ST 01:00';                      script = "$root\actions\Run-SmartCheck.ps1";             ruleId = 'run_smart_check_daily';           tier = 1 }
    @{ name = 'PCDoctor-Autopilot-MalwarebytesCli';           sched = '/SC WEEKLY /D MON /ST 03:00';              script = "$root\actions\Run-MalwarebytesCli.ps1";        ruleId = 'run_malwarebytes_cli_weekly';     tier = 1 }
    @{ name = 'PCDoctor-Autopilot-AdwCleanerScan';            sched = '/SC MONTHLY /D 1 /ST 04:00';               script = "$root\actions\Run-AdwCleanerScan.ps1";         ruleId = 'run_adwcleaner_scan_monthly';     tier = 1 }
    @{ name = 'PCDoctor-Autopilot-HwinfoLog';                 sched = '/SC MONTHLY /MO FIRST /D SAT /ST 23:00';    script = "$root\actions\Run-HwinfoLog.ps1";              ruleId = 'run_hwinfo_log_monthly';          tier = 1 }
    @{ name = 'PCDoctor-Autopilot-SafetyScanner';             sched = '/SC MONTHLY /MO THIRD /D SAT /ST 04:00';    script = "$root\actions\Run-SafetyScanner.ps1";          ruleId = 'run_safety_scanner_monthly';      tier = 1 }
    # Tier 2 per DEFAULT_RULES in autopilotEngine.ts:77 (post-review fix).
    @{ name = 'PCDoctor-Autopilot-UpdateHostsStevenBlack';    sched = '/SC MONTHLY /MO FIRST /D SUN /ST 04:00';    script = "$root\actions\Update-HostsFromStevenBlack.ps1"; ruleId = 'update_hosts_stevenblack_monthly'; tier = 2 }
    # v2.4.0 tool updates: weekly winget upgrade check (reports only; user
    # presses Upgrade in the Tools page to actually apply).
    # No ruleId -- not an autopilot rule; remains unwrapped.
    @{ name = 'PCDoctor-Weekly-Tool-Updates';                  sched = '/SC WEEKLY /D SUN /ST 04:00';              script = "$root\Check-ToolUpdates.ps1" }
)

$systemAutopilotTasks = @(
    # DISM /ResetBase requires admin, so keep it SYSTEM.
    @{ name = 'PCDoctor-Autopilot-ShrinkComponentStore';      sched = '/SC MONTHLY /MO SECOND /D SAT /ST 04:00';   script = "$root\actions\Shrink-ComponentStore.ps1";      ruleId = 'shrink_component_store_monthly';  tier = 1 }
)

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
    # v2.4.45: When a rule_id is supplied the task is wrapped via
    # Run-AutopilotScheduled.ps1 which emits a structured JSON line per run
    # to autopilot-scheduled-YYYYMMDD.log. The wrapped script's stdout is
    # still relayed to our stdout, so the existing >> $log redirect below
    # continues to capture debugging output unchanged.
    if ($RuleId -and $Tier -ge 1) {
        $dispatcher = "$root\Run-AutopilotScheduled.ps1"
        # Post-review guard: if the dispatcher isn't present yet (fresh
        # install before Sync-ScriptsFromBundle runs, or a bundle-copy
        # failure left the tree partial), skip the task rather than
        # register a scheduled task that silently fails at runtime with
        # exit 1 (PowerShell file-not-found).
        if (-not (Test-Path -LiteralPath $dispatcher)) {
            return @{ name = $Name; status = 'skipped'; reason = "Dispatcher missing: $dispatcher" }
        }
        $psCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$dispatcher`" -RuleId `"$RuleId`" -Tier $Tier -ActionScript `"$Script`" >> `"$log`" 2>&1"
    }
    else {
        # Legacy path (non-autopilot tasks or tasks without a matching rule).
        $psCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Script`" -JsonOutput >> `"$log`" 2>&1"
    }

    if ($ForceRecreate) {
        # Idempotent recreate: delete then recreate so the /RU change is picked up.
        cmd.exe /c "schtasks.exe /Delete /TN `"$Name`" /F" *>$null
    }

    if ($Context -eq 'user') {
        # Run interactively as the current user so HKCU StartupApproved / per-user
        # caches resolve correctly. /RL LIMITED == least privilege.
        $runUser = "$env:USERDOMAIN\$env:USERNAME"
        $createArgs = "/Create /TN `"$Name`" /TR `"$psCmd`" $Sched /RU `"$runUser`" /IT /RL LIMITED /F"
    }
    else {
        # SYSTEM context with elevation; used for SFC/DISM/VSS-heavy tasks.
        $createArgs = "/Create /TN `"$Name`" /TR `"$psCmd`" $Sched /RU SYSTEM /RL HIGHEST /F"
    }
    $out = cmd.exe /c "schtasks.exe $createArgs" 2>&1 | Out-String
    $ok = $LASTEXITCODE -eq 0
    return @{ name = $Name; status = if ($ok) { 'registered' } else { 'failed' }; context = $Context; output = $out.Trim() }
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
$result = @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    results     = $results
    message     = "Processed $totalCount tasks"
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
