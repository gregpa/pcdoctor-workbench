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

function Resolve-TrustedWinget {
    $windowsAppsRoot = 'C:\Program Files\WindowsApps'
    $systemRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
    $appxModule = Join-Path $systemRoot 'WindowsPowerShell\v1.0\Modules\Appx\Appx.psd1'
    $securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    Import-Module -Name $appxModule -Force -ErrorAction Stop
    Import-Module -Name $securityModule -Force -ErrorAction Stop
    $package = Appx\Get-AppxPackage -AllUsers -Name Microsoft.DesktopAppInstaller |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $package -or [string]::IsNullOrWhiteSpace([string]$package.InstallLocation)) {
        return $null
    }
    $installRoot = [IO.Path]::GetFullPath([string]$package.InstallLocation).TrimEnd('\')
    $requiredPrefix = "$windowsAppsRoot\"
    if (-not $installRoot.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }
    $candidate = Join-Path $installRoot 'winget.exe'
    foreach ($trustedNode in @($windowsAppsRoot, $installRoot, $candidate)) {
        if (-not (Test-Path -LiteralPath $trustedNode)) { return $null }
        $item = Get-Item -LiteralPath $trustedNode -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
    }
    $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $candidate
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
        $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
        return $null
    }
    return $candidate
}

$winget = Resolve-TrustedWinget
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
        $out = & $winget upgrade --id $u.winget_id --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-String
        $results += @{ winget_id = $u.winget_id; exit_code = $LASTEXITCODE; output = $out.Trim() }
    }
} else {
    if (-not $WingetId) {
        $e = @{ code='E_MISSING_PARAM'; message='WingetId required when -All not set' } | ConvertTo-Json -Compress
        Write-Host "PCDOCTOR_ERROR:$e"; exit 1
    }
    $out = & $winget upgrade --id $WingetId --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-String
    $results += @{ winget_id = $WingetId; exit_code = $LASTEXITCODE; output = $out.Trim() }
}

# After upgrading, re-run the check so the cache reflects the new state.
try {
    $windowsPowerShell = Join-Path ([Environment]::GetFolderPath(
        [Environment+SpecialFolder]::System
    )) 'WindowsPowerShell\v1.0\powershell.exe'
    $checkScript = Join-Path $PSScriptRoot 'Check-ToolUpdates.ps1'
    & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $checkScript -JsonOutput -TrustedWingetPath $winget | Out-Null
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
