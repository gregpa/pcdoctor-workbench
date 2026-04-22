<#
.SYNOPSIS
  Batch-disable Windows startup entries via the StartupApproved registry keys.
.DESCRIPTION
  v2.3.0 - C1. Accepts a JSON array of { kind, name } records (via -ItemsJson)
  and marks each entry as user-disabled in the appropriate
  Explorer\StartupApproved\* registry key. Task Manager treats 0x03 as the
  "disabled" byte[0] marker; 0x02 means enabled. This mirrors what the Startup
  tab in Task Manager writes when you click Disable.

  Rollback: the rollback manager's Tier B file-snapshot handler exports the
  affected registry keys before calling this script so `Revert` restores them.
#>
param(
    [string]$ItemsJson,
    [switch]$DryRun,
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'
trap {
    $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Out-Result($obj) { $obj | ConvertTo-Json -Depth 5 -Compress }

if ($DryRun) {
    Out-Result @{ success=$true; dry_run=$true; duration_ms=0; message='DryRun' }
    exit 0
}

if (-not $ItemsJson) {
    Out-Result @{ success=$false; duration_ms=$sw.ElapsedMilliseconds; error=@{ code='E_INVALID_PARAM'; message='items_json required' } }
    exit 1
}

try {
    $items = $ItemsJson | ConvertFrom-Json
} catch {
    Out-Result @{ success=$false; duration_ms=$sw.ElapsedMilliseconds; error=@{ code='E_INVALID_JSON'; message=$_.Exception.Message } }
    exit 1
}

if (-not $items -or @($items).Count -eq 0) {
    Out-Result @{ success=$true; no_op=$true; duration_ms=$sw.ElapsedMilliseconds; message='No items selected' }
    exit 0
}

# Disabled marker: byte[0] = 0x03, rest zero. Task Manager writes 12 bytes.
$disabledBytes = ,0x03 + (0..10 | ForEach-Object { 0x00 })

$results = @()
foreach ($it in $items) {
    $name = "$($it.name)"
    $kind = "$($it.kind)"
    if (-not $name) { continue }

    $keys = switch ($kind) {
        'Run'            { 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' }
        'HKLM_Run'       { 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' }
        'StartupFolder'  { 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder' }
        default          { 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' }
    }

    try {
        if (-not (Test-Path $keys)) {
            New-Item -Path $keys -Force | Out-Null
        }
        # Some StartupFolder entries are stored with the .lnk extension in the
        # approval key -- try both names and take the one that already exists.
        $nameCandidates = @($name, "$name.lnk") | Select-Object -Unique
        $written = $false
        foreach ($nm in $nameCandidates) {
            try {
                $existing = (Get-ItemProperty -Path $keys -Name $nm -ErrorAction SilentlyContinue).$nm
                if ($existing -is [byte[]]) {
                    New-ItemProperty -Path $keys -Name $nm -PropertyType Binary -Value ([byte[]]$disabledBytes) -Force | Out-Null
                    $written = $true
                    break
                }
            } catch {}
        }
        if (-not $written) {
            # No pre-existing entry -- create one at the canonical name.
            New-ItemProperty -Path $keys -Name $name -PropertyType Binary -Value ([byte[]]$disabledBytes) -Force | Out-Null
        }
        $results += @{ name=$name; kind=$kind; status='disabled' }
    } catch {
        $results += @{ name=$name; kind=$kind; status='error'; message=$_.Exception.Message }
    }
}

$sw.Stop()
Out-Result @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    message     = "Disabled $(@($results | Where-Object { $_.status -eq 'disabled' }).Count) of $(@($items).Count) startup items"
    results     = $results
}
exit 0
