<#
.SYNOPSIS
    Open the NVIDIA driver-update UI that's installed locally. Prefer the
    modern "NVIDIA app" (2024+), fall back to GeForce Experience, then the
    Control Panel, then the NVIDIA Drivers web page.

.DESCRIPTION
    Greg installs drivers through the local NVIDIA app, not nvidia.com.
    The Security detail modal's previous approach (open a web link) sent
    him to the wrong place. This action launches the installed tool so
    Update / Install / Reinstall buttons are one click away.

    Fallback chain:
      1. NVIDIA app (2024+)  - C:\Program Files\NVIDIA Corporation\NVIDIA App\...
      2. GeForce Experience   - C:\Program Files (x86)\NVIDIA Corporation\NVIDIA GeForce Experience\...
      3. NVIDIA Control Panel - nvcplui.exe (in PATH when drivers installed)
      4. Web fallback         - https://www.nvidia.com/Download/index.aspx
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'

trap {
    $errRecord = @{
        code    = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' }
        message = $_.Exception.Message
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# Candidate paths in priority order. Some systems install the new NVIDIA
# App under either Program Files or Program Files (x86) depending on the
# installer version, so we check both. Names without spaces are the
# portable-install variants from drivers-only packages.
$candidates = @(
    @{ path = 'C:\Program Files\NVIDIA Corporation\NVIDIA App\CEF\NVIDIA app.exe';                      label = 'NVIDIA App' }
    @{ path = 'C:\Program Files (x86)\NVIDIA Corporation\NVIDIA App\CEF\NVIDIA app.exe';                label = 'NVIDIA App' }
    @{ path = 'C:\Program Files\NVIDIA Corporation\NVIDIA App\NVIDIA app.exe';                          label = 'NVIDIA App' }
    @{ path = 'C:\Program Files (x86)\NVIDIA Corporation\NVIDIA GeForce Experience\NVIDIA GeForce Experience.exe'; label = 'GeForce Experience' }
    @{ path = 'C:\Program Files\NVIDIA Corporation\Control Panel Client\nvcplui.exe';                   label = 'NVIDIA Control Panel' }
    @{ path = 'C:\Windows\System32\nvcplui.exe';                                                         label = 'NVIDIA Control Panel' }
)

$resolved = $null
foreach ($c in $candidates) {
    if (Test-Path $c.path) {
        $resolved = $c
        break
    }
}

if ($DryRun) {
    $r = [ordered]@{
        success     = $true
        dry_run     = $true
        duration_ms = $sw.ElapsedMilliseconds
        resolved    = $resolved
        message     = if ($resolved) { "Would launch $($resolved.label)" } else { 'Would open web fallback (no local tool detected)' }
    }
    $r | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

if ($resolved) {
    Start-Process -FilePath $resolved.path
    $result = [ordered]@{
        success      = $true
        duration_ms  = $sw.ElapsedMilliseconds
        tool         = $resolved.label
        path         = $resolved.path
        fallback_web = $false
        message      = "Launched $($resolved.label)."
    }
} else {
    $webUrl = 'https://www.nvidia.com/Download/index.aspx'
    Start-Process $webUrl
    $result = [ordered]@{
        success      = $true
        duration_ms  = $sw.ElapsedMilliseconds
        tool         = 'web'
        path         = $webUrl
        fallback_web = $true
        message      = 'No local NVIDIA tool detected. Opened nvidia.com drivers page in browser.'
    }
}

$sw.Stop()
$result.duration_ms = $sw.ElapsedMilliseconds
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
