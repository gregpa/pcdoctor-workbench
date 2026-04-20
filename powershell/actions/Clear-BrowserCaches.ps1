<#
.SYNOPSIS
    Clears cache (and optionally cookies) for Chrome / Edge / Brave / Firefox.
.DESCRIPTION
    Does NOT force-kill running browsers. If a browser is running, its cache
    is skipped (with a reason in the response) so we don't crash user sessions.
.PARAMETER IncludeCookies
    Also clears cookies (will sign user out of everything).
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput,
    [switch]$IncludeCookies
)

$ErrorActionPreference = 'Stop'

trap {
    $errRecord = @{
        code    = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' }
        message = $_.Exception.Message
        script  = $MyInvocation.MyCommand.Name
        line    = $_.InvocationInfo.ScriptLineNumber
        stack   = $_.ScriptStackTrace
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($DryRun) {
    @{ success = $true; dry_run = $true; duration_ms = $sw.ElapsedMilliseconds; message = 'DryRun' } | ConvertTo-Json -Compress
    exit 0
}

function Get-FolderSize {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return 0 }
    try {
        return (Get-ChildItem -Path $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
    } catch { return 0 }
}

function Clear-Folder {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return 0 }
    $size = Get-FolderSize -Path $Path
    try {
        Get-ChildItem -Path $Path -Force -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    } catch {}
    return [int64]($size - (Get-FolderSize -Path $Path))
}

# Browsers: each entry says what caches to clear and which process name to
# check. We identify Chrome/Edge/Brave by their unique user-data profile
# folder; Firefox has per-profile subfolders we iterate.
$targets = @(
    @{ name = 'Chrome'; proc = 'chrome'; root = "$env:LOCALAPPDATA\Google\Chrome\User Data" }
    @{ name = 'Edge';   proc = 'msedge'; root = "$env:LOCALAPPDATA\Microsoft\Edge\User Data" }
    @{ name = 'Brave';  proc = 'brave';  root = "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data" }
)
$cacheSubfolders = @('Cache','Code Cache','GPUCache','Service Worker\CacheStorage','Service Worker\ScriptCache')

$browsersCleaned = @()
$totalFreed = 0L

foreach ($t in $targets) {
    $entry = @{ name = $t.name; bytes_freed = 0; skipped = $false; reason = $null }
    if (-not (Test-Path $t.root)) {
        $entry.skipped = $true
        $entry.reason = 'not_installed'
        $browsersCleaned += $entry
        continue
    }
    if (Get-Process -Name $t.proc -ErrorAction SilentlyContinue) {
        $entry.skipped = $true
        $entry.reason = 'browser_running'
        $browsersCleaned += $entry
        continue
    }
    # Iterate Chromium-style profiles (Default, Profile 1, Profile 2 ...)
    $profiles = Get-ChildItem -Path $t.root -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' }
    $freed = 0L
    foreach ($p in $profiles) {
        foreach ($sub in $cacheSubfolders) {
            $freed += Clear-Folder -Path (Join-Path $p.FullName $sub)
        }
        if ($IncludeCookies) {
            $cookies = Join-Path $p.FullName 'Network\Cookies'
            if (Test-Path $cookies) {
                $sz = (Get-Item $cookies -ErrorAction SilentlyContinue).Length
                try { Remove-Item $cookies -Force -ErrorAction SilentlyContinue; $freed += $sz } catch {}
            }
        }
    }
    $entry.bytes_freed = $freed
    $totalFreed += $freed
    $browsersCleaned += $entry
}

# Firefox: per profile under Roaming\Mozilla\Firefox\Profiles
$ff = @{ name = 'Firefox'; proc = 'firefox'; bytes_freed = 0; skipped = $false; reason = $null }
$ffRoot = "$env:APPDATA\Mozilla\Firefox\Profiles"
if (-not (Test-Path $ffRoot)) {
    $ff.skipped = $true; $ff.reason = 'not_installed'
} elseif (Get-Process -Name $ff.proc -ErrorAction SilentlyContinue) {
    $ff.skipped = $true; $ff.reason = 'browser_running'
} else {
    $freed = 0L
    Get-ChildItem -Path $ffRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        # Firefox disk cache lives under Local, not Roaming
        $local = $_.FullName -replace [regex]::Escape('Roaming'), 'Local'
        foreach ($sub in @('cache2','startupCache','thumbnails','offlineCache')) {
            $freed += Clear-Folder -Path (Join-Path $local $sub)
        }
        if ($IncludeCookies) {
            $cookieDb = Join-Path $_.FullName 'cookies.sqlite'
            if (Test-Path $cookieDb) {
                $sz = (Get-Item $cookieDb).Length
                try { Remove-Item $cookieDb -Force -ErrorAction SilentlyContinue; $freed += $sz } catch {}
            }
        }
    }
    $ff.bytes_freed = $freed
    $totalFreed += $freed
}
$browsersCleaned += $ff

$sw.Stop()
$result = @{
    success          = $true
    duration_ms      = $sw.ElapsedMilliseconds
    bytes_freed      = $totalFreed
    cookies_included = [bool]$IncludeCookies
    browsers_cleaned = $browsersCleaned
    message          = "Cleared $([math]::Round($totalFreed/1MB,1)) MB across $(@($browsersCleaned | Where-Object { -not $_.skipped }).Count) browser(s)"
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
