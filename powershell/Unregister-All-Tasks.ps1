#Requires -Version 5.1
param(
    [switch]$IncludeLegacy,
    [switch]$DryRun,
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'
trap {
    $errorPayload = @{ code = 'E_PS_UNHANDLED'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errorPayload"
    exit 1
}

. (Join-Path $PSScriptRoot 'TaskSchedulerNative.ps1')

$manifestPath = Join-Path $PSScriptRoot 'task-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schema_version -ne 1 -or $manifest.source_sha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Generated task manifest metadata is invalid'
}

$names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($task in @($manifest.tasks)) {
    if ($task.uninstall.remove -eq $true) { [void]$names.Add([string]$task.name) }
    if ($IncludeLegacy) {
        foreach ($legacyName in @($task.migration.legacy_names)) {
            [void]$names.Add([string]$legacyName)
        }
    }
}

$results = @()
$failed = 0
foreach ($name in @($names | Sort-Object)) {
    if ($DryRun) {
        $results += @{ name = $name; status = 'planned' }
        continue
    }
    $queryResult = Invoke-PCDoctorSchtasks -Arguments @('/Query', '/TN', $name)
    if ($queryResult.ExitCode -ne 0) {
        if (Test-PCDoctorTaskQueryAbsent -Result $queryResult) {
            $results += @{ name = $name; status = 'absent' }
        } else {
            $failed++
            $results += @{ name = $name; status = 'failed'; output = $queryResult.Output.Trim() }
        }
        continue
    }
    $deleteResult = Invoke-PCDoctorSchtasks -Arguments @('/Delete', '/TN', $name, '/F')
    if ($deleteResult.ExitCode -eq 0) {
        $results += @{ name = $name; status = 'removed' }
    } else {
        $failed++
        $results += @{ name = $name; status = 'failed'; output = $deleteResult.Output.Trim() }
    }
}

@{
    success = $failed -eq 0
    source_sha256 = [string]$manifest.source_sha256
    results = $results
    message = if ($failed -eq 0) { "Processed $($names.Count) task identities" } else { "$failed task removals failed" }
} | ConvertTo-Json -Depth 6 -Compress
if ($failed -eq 0) { exit 0 } else { exit 1 }
