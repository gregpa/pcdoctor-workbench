<#
.SYNOPSIS
    Upgrade a specific tool (or all outdated tools) via winget. Always runs
    elevated (wired to needs_admin / runElevatedPowerShellScript).
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput,
    [string]$WingetId = '',
    [switch]$All
)
$ErrorActionPreference = 'Continue'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($DryRun) {
    $target = if ($All) { 'ALL' } else { $WingetId }
    @{success=$true;dry_run=$true;target=$target} | ConvertTo-Json -Compress; exit 0
}

# Admin check (elevated runner hits this path; still guard for direct runs).
$currentId = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentId)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $e = @{ code='E_NOT_ADMIN'; message='Tool upgrade requires administrator privileges.' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"; exit 1
}

$winget = (Get-Command winget -ErrorAction SilentlyContinue).Source
if (-not $winget) {
    $e = @{ code='E_NO_WINGET'; message='winget not installed on this machine' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"; exit 1
}

$results = @()
if ($All) {
    # Iterate the cache so we only upgrade tools the user has actually
    # installed (winget upgrade --all would also target unrelated apps).
    $cachePath = 'C:\ProgramData\PCDoctor\tools\updates.json'
    if (-not (Test-Path $cachePath)) {
        $e = @{ code='E_NO_CACHE'; message='No update cache - run Check for Updates first' } | ConvertTo-Json -Compress
        Write-Host "PCDOCTOR_ERROR:$e"; exit 1
    }
    $cache = Get-Content $cachePath -Raw | ConvertFrom-Json
    foreach ($u in $cache.upgrades) {
        if (-not $u.winget_id) { continue }
        $out = & winget upgrade --id $u.winget_id --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-String
        $results += @{ winget_id = $u.winget_id; exit_code = $LASTEXITCODE; output = $out.Trim() }
    }
} else {
    if (-not $WingetId) {
        $e = @{ code='E_MISSING_PARAM'; message='WingetId required when -All not set' } | ConvertTo-Json -Compress
        Write-Host "PCDOCTOR_ERROR:$e"; exit 1
    }
    $out = & winget upgrade --id $WingetId --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-String
    $results += @{ winget_id = $WingetId; exit_code = $LASTEXITCODE; output = $out.Trim() }
}

# After upgrading, re-run the check so the cache reflects the new state.
try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\ProgramData\PCDoctor\Check-ToolUpdates.ps1' -JsonOutput | Out-Null
} catch {}

$sw.Stop()
@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    upgraded_count = ($results | Where-Object { $_.exit_code -eq 0 }).Count
    failed_count = ($results | Where-Object { $_.exit_code -ne 0 }).Count
    results = $results
    message = "Upgraded $(($results | Where-Object { $_.exit_code -eq 0 }).Count) / $($results.Count) tool(s)"
} | ConvertTo-Json -Depth 5 -Compress
exit 0
