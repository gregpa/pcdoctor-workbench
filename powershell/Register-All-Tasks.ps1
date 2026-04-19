param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$root = 'C:\ProgramData\PCDoctor'
$tasks = @(
    @{ name = 'PCDoctor-Weekly-Review'; sched = '/SC WEEKLY /D SUN /ST 22:00'; script = "$root\Invoke-WeeklyReview.ps1" }
    @{ name = 'PCDoctor-Forecast';       sched = '/SC DAILY /ST 07:00';         script = "$root\Get-Forecast.ps1" }  # placeholder -- PS script optional
    @{ name = 'PCDoctor-Security-Daily'; sched = '/SC DAILY /ST 06:00';         script = "$root\security\Get-SecurityPosture.ps1" }
    @{ name = 'PCDoctor-Security-Weekly';sched = '/SC WEEKLY /D SAT /ST 23:00'; script = "$root\security\Get-SecurityPosture.ps1" }
    @{ name = 'PCDoctor-Prune-Rollbacks';sched = '/SC DAILY /ST 03:00';         script = "$root\Prune-Rollbacks.ps1" }
)

$results = @()
foreach ($t in $tasks) {
    if (-not (Test-Path $t.script)) {
        $results += @{ name = $t.name; status = 'skipped'; reason = "Script missing: $($t.script)" }
        continue
    }
    $cmd = "pwsh.exe -NoProfile -ExecutionPolicy Bypass -File `"$($t.script)`""
    $createArgs = "/Create /TN `"$($t.name)`" /TR `"$cmd`" $($t.sched) /RL LIMITED /F"
    $out = cmd.exe /c "schtasks.exe $createArgs" 2>&1 | Out-String
    $ok = $LASTEXITCODE -eq 0
    $results += @{ name = $t.name; status = if ($ok) { 'registered' } else { 'failed' }; output = $out.Trim() }
}

# Autostart task: logon-trigger, runs the Electron app itself
$autostartExe = Join-Path $env:LOCALAPPDATA 'Programs\PCDoctor Workbench\PCDoctor Workbench.exe'
if (Test-Path $autostartExe) {
    # Check if already registered (idempotent)
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
$result = @{ success = $true; duration_ms = $sw.ElapsedMilliseconds; results = $results; message = "Registered $($tasks.Count) tasks" }
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
