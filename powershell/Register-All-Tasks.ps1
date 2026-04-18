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

$sw.Stop()
$result = @{ success = $true; duration_ms = $sw.ElapsedMilliseconds; results = $results; message = "Registered $($tasks.Count) tasks" }
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
