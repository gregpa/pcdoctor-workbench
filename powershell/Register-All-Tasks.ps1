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
$userAutopilotTasks = @(
    @{ name = 'PCDoctor-Autopilot-EmptyRecycleBins';        sched = '/SC WEEKLY /D SUN /ST 03:00';         script = "$root\actions\Empty-RecycleBins.ps1" }
    @{ name = 'PCDoctor-Autopilot-ClearBrowserCaches';       sched = '/SC WEEKLY /D SAT /ST 03:00';         script = "$root\actions\Clear-BrowserCaches.ps1" }
    @{ name = 'PCDoctor-Autopilot-DefenderQuickScan';         sched = '/SC DAILY /ST 02:00';                  script = "$root\actions\Run-DefenderQuickScan.ps1" }
    @{ name = 'PCDoctor-Autopilot-UpdateDefenderDefs';        sched = '/SC DAILY /ST 06:00';                  script = "$root\actions\Update-DefenderDefs.ps1" }
    @{ name = 'PCDoctor-Autopilot-SmartCheck';                sched = '/SC DAILY /ST 01:00';                  script = "$root\actions\Run-SmartCheck.ps1" }
    @{ name = 'PCDoctor-Autopilot-MalwarebytesCli';           sched = '/SC WEEKLY /D MON /ST 03:00';          script = "$root\actions\Run-MalwarebytesCli.ps1" }
    @{ name = 'PCDoctor-Autopilot-AdwCleanerScan';            sched = '/SC MONTHLY /D 1 /ST 04:00';           script = "$root\actions\Run-AdwCleanerScan.ps1" }
    @{ name = 'PCDoctor-Autopilot-HwinfoLog';                 sched = '/SC MONTHLY /MO FIRST /D SAT /ST 23:00';  script = "$root\actions\Run-HwinfoLog.ps1" }
    @{ name = 'PCDoctor-Autopilot-SafetyScanner';             sched = '/SC MONTHLY /MO THIRD /D SAT /ST 04:00';  script = "$root\actions\Run-SafetyScanner.ps1" }
    @{ name = 'PCDoctor-Autopilot-UpdateHostsStevenBlack';    sched = '/SC MONTHLY /MO FIRST /D SUN /ST 04:00';  script = "$root\actions\Update-HostsFromStevenBlack.ps1" }
)

$systemAutopilotTasks = @(
    # DISM /ResetBase requires admin, so keep it SYSTEM.
    @{ name = 'PCDoctor-Autopilot-ShrinkComponentStore';      sched = '/SC MONTHLY /MO SECOND /D SAT /ST 04:00'; script = "$root\actions\Shrink-ComponentStore.ps1" }
)

function Register-PCDoctorTask {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [string]$Sched,
        [Parameter(Mandatory)] [string]$Script,
        [string]$LogDir = 'C:\ProgramData\PCDoctor\logs',
        [ValidateSet('user','system')] [string]$Context = 'system',
        [switch]$ForceRecreate
    )
    if (-not (Test-Path $Script)) {
        return @{ name = $Name; status = 'skipped'; reason = "Script missing: $Script" }
    }
    $today = Get-Date -Format 'yyyyMMdd'
    $log = Join-Path $LogDir "autopilot-$today.log"
    # Single-line shell command; writes script output into the autopilot log.
    $psCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Script`" -JsonOutput >> `"$log`" 2>&1"

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

$results = @()
foreach ($t in $userContextTasks)     { $results += Register-PCDoctorTask -Name $t.name -Sched $t.sched -Script $t.script -Context 'user'   -ForceRecreate:$ForceRecreate }
foreach ($t in $systemContextTasks)   { $results += Register-PCDoctorTask -Name $t.name -Sched $t.sched -Script $t.script -Context 'system' -ForceRecreate:$ForceRecreate }
foreach ($t in $userAutopilotTasks)   { $results += Register-PCDoctorTask -Name $t.name -Sched $t.sched -Script $t.script -Context 'user'   -LogDir $logDir -ForceRecreate:$ForceRecreate }
foreach ($t in $systemAutopilotTasks) { $results += Register-PCDoctorTask -Name $t.name -Sched $t.sched -Script $t.script -Context 'system' -LogDir $logDir -ForceRecreate:$ForceRecreate }

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
