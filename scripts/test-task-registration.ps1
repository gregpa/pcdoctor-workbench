#Requires -Version 5.1
<#
.SYNOPSIS
    Source-only validation gate for the generated Scheduled Task manifest.
.DESCRIPTION
    This gate never calls Task Scheduler. The retired live create/delete round-trip
    belongs to the separately authorized installed-smoke phase.
#>
param(
    [switch]$StaticOnly
)

$ErrorActionPreference = 'Stop'

function Assert-PCDoctorGate {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$sourcePath = Join-Path $repoRoot 'src\shared\task-manifest.json'
$generatedPath = Join-Path $repoRoot 'powershell\task-manifest.json'
Assert-PCDoctorGate (Test-Path -LiteralPath $sourcePath -PathType Leaf) "Canonical manifest missing: $sourcePath"
Assert-PCDoctorGate (Test-Path -LiteralPath $generatedPath -PathType Leaf) "Generated manifest missing: $generatedPath"

$manifest = Get-Content -LiteralPath $generatedPath -Raw -Encoding UTF8 | ConvertFrom-Json
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $sourceHash = -join ($sha256.ComputeHash([IO.File]::ReadAllBytes($sourcePath)) | ForEach-Object { $_.ToString('x2') })
} finally {
    $sha256.Dispose()
}
Assert-PCDoctorGate ($manifest.schema_version -eq 1) 'Generated manifest schema must be 1'
Assert-PCDoctorGate ([string]$manifest.source_sha256 -ceq $sourceHash) 'Generated manifest source hash is stale'

$tasks = @($manifest.tasks)
Assert-PCDoctorGate ($tasks.Count -gt 0) 'Generated manifest must contain tasks'
$ids = @($tasks | ForEach-Object { [string]$_.id })
$names = @($tasks | ForEach-Object { [string]$_.name })
Assert-PCDoctorGate ((@($ids | Select-Object -Unique)).Count -eq $ids.Count) 'Task IDs must be unique'
Assert-PCDoctorGate ((@($names | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)).Count -eq $names.Count) 'Task names must be unique'
Assert-PCDoctorGate ((@($ids | Sort-Object) -join "`n") -ceq ($ids -join "`n")) 'Tasks must be sorted by stable ID'

$activeTimes = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
foreach ($task in $tasks) {
    Assert-PCDoctorGate ([string]$task.name -cmatch '^PCDoctor-[A-Za-z0-9_-]{1,64}$') "Invalid task name '$($task.name)'"
    Assert-PCDoctorGate ([string]$task.state -in @('active', 'deferred', 'remove')) "Invalid state for '$($task.id)'"
    Assert-PCDoctorGate ([string]$task.migration.strategy -eq $(if ($task.state -eq 'active') { 'register' } else { 'unregister' })) "Invalid migration strategy for '$($task.id)'"

    if ($task.state -ne 'active') { continue }
    Assert-PCDoctorGate ($task.hidden -eq $true) "Active task '$($task.id)' must be hidden"
    Assert-PCDoctorGate ([string]$task.context -ceq 'interactive-user') "Active task '$($task.id)' must use the interactive user"
    Assert-PCDoctorGate ([string]$task.effect -cne 'system-mutation') "Active task '$($task.id)' cannot mutate the system"
    Assert-PCDoctorGate ([string]$task.executable -in @('powershell.exe', 'PCDoctor Workbench.exe')) "Active task '$($task.id)' has an invalid executable"
    $commandText = @($task.executable, $task.script) + @($task.arguments) -join ' '
    Assert-PCDoctorGate ($commandText -cnotmatch '(?i)Run-AutopilotScheduled|reboot|shutdown|ResetBase') "Active task '$($task.id)' contains a forbidden command"
    if ($task.schedule.PSObject.Properties.Name -contains 'at') {
        $time = [string]$task.schedule.at
        Assert-PCDoctorGate ($time -cmatch '^(?:[01]\d|2[0-3]):[0-5]\d$') "Active task '$($task.id)' has an invalid time"
        Assert-PCDoctorGate (-not $time.EndsWith(':00')) "Active task '$($task.id)' is not staggered"
        Assert-PCDoctorGate ($activeTimes.Add($time)) "Active schedule time '$time' is duplicated"
    }
}

$summary = [ordered]@{
    mode = 'static'
    success = $true
    source_sha256_valid = $true
    total = $tasks.Count
    active = @($tasks | Where-Object { $_.state -eq 'active' }).Count
    deferred = @($tasks | Where-Object { $_.state -eq 'deferred' }).Count
    remove = @($tasks | Where-Object { $_.state -eq 'remove' }).Count
    live_task_scheduler_calls = 0
}
$summary | ConvertTo-Json -Compress
