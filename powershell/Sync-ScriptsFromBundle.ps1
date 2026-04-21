<#
.SYNOPSIS
    Startup self-heal: sync missing / size-mismatched PowerShell scripts
    from the installed bundle to C:\ProgramData\PCDoctor\.
.DESCRIPTION
    Belt-and-braces for the installer: even if Copy-Item fails mid-way
    (AV lock, disk pressure, interrupted update), the next app launch
    detects the drift and repairs it.

    Phase 1 (-WhatIf-like): run as the user, compute the mismatch list.
      If nothing is stale, exit success. No UAC.
    Phase 2 (-Elevated): if phase 1 reported mismatches, Workbench
      re-invokes this script elevated and it performs the copies.

    v2.4.6: introduced to fix the cascade where auto-update installs
    left stale PS scripts (Enable-PUAProtection.ps1 frozen at pre-v2.4.4,
    Open-WindowsSecurity.ps1 never deployed, Run-SFC.ps1 missing UTF-16
    decode, etc.).
.PARAMETER SourceDir
    The bundled resources/powershell/ path from inside the installed
    Electron app. Passed in from main.ts via app.getAppPath().
.PARAMETER DestDir
    Target tree. Defaults to C:\ProgramData\PCDoctor.
.PARAMETER Elevated
    Set to $true only when invoked from the elevated re-run path. Gates
    the actual write operations.
#>
param(
    [Parameter(Mandatory=$true)][string]$SourceDir,
    [string]$DestDir = 'C:\ProgramData\PCDoctor',
    [switch]$Elevated,
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Continue'

trap {
    $e = @{ code='E_PS_UNHANDLED'; message=$_.Exception.Message } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if (-not (Test-Path $SourceDir)) {
    $e = @{ code='E_SOURCE_MISSING'; message="Bundled script directory not found: $SourceDir" } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"
    exit 1
}

# Walk the bundle and compare each .ps1 to its deployed counterpart.
$mismatches = @()
$srcRootLen = $SourceDir.TrimEnd('\').Length + 1

Get-ChildItem -Path $SourceDir -Recurse -File -Filter '*.ps1' | ForEach-Object {
    $rel = $_.FullName.Substring($srcRootLen)
    # v2.4.10: reject traversal. A tampered bundle containing a symlink or
    # file named `..\..\Windows\System32\evil.ps1` would otherwise have its
    # $rel include `..` segments, letting the elevated Copy-Item land it
    # outside $DestDir. Not exploitable under a signed installer in normal
    # flow, but cheap defense-in-depth.
    #   MATCHES (rejected):  "..\evil.ps1", "foo/../bar.ps1", ".."
    #   REJECTS (allowed):   "..txt.ps1", "ab..cd.ps1", "normal\path.ps1"
    if ($rel -match '\.\.[\\/]' -or $rel -match '^\.\.$') {
        Write-Host "SKIP (path traversal): $rel"
        return
    }
    $dstPath = Join-Path $DestDir $rel
    $srcLen = $_.Length

    if (-not (Test-Path $dstPath)) {
        $mismatches += [pscustomobject]@{
            rel   = $rel
            src   = $srcLen
            dst   = -1
            cause = 'missing'
        }
        return
    }

    try {
        $dstLen = (Get-Item $dstPath -EA Stop).Length
        if ($dstLen -ne $srcLen) {
            $mismatches += [pscustomobject]@{
                rel   = $rel
                src   = $srcLen
                dst   = $dstLen
                cause = 'size_mismatch'
            }
        }
    } catch {
        # ACL-stripped file: can't Get-Item. Flag for elevated repair.
        $mismatches += [pscustomobject]@{
            rel   = $rel
            src   = $srcLen
            dst   = -2
            cause = 'unreadable'
        }
    }
}

if ($mismatches.Count -eq 0) {
    $result = @{
        success       = $true
        no_op         = $true
        duration_ms   = $sw.ElapsedMilliseconds
        checked       = (Get-ChildItem -Path $SourceDir -Recurse -File -Filter '*.ps1').Count
        needs_elevation = $false
        copied        = 0
        message       = 'All scripts in sync.'
    }
    if ($JsonOutput) { $result | ConvertTo-Json -Depth 5 -Compress } else { $result | ConvertTo-Json -Depth 5 }
    exit 0
}

if (-not $Elevated) {
    # Non-elevated phase: report mismatches, request elevation.
    $result = @{
        success         = $true
        no_op           = $false
        duration_ms     = $sw.ElapsedMilliseconds
        checked         = (Get-ChildItem -Path $SourceDir -Recurse -File -Filter '*.ps1').Count
        needs_elevation = $true
        mismatches      = $mismatches
        copied          = 0
        message         = "$($mismatches.Count) script(s) need updating; re-run with -Elevated."
    }
    if ($JsonOutput) { $result | ConvertTo-Json -Depth 5 -Compress } else { $result | ConvertTo-Json -Depth 5 }
    exit 0
}

# Elevated: perform the copies. Running with Admins:F lets us overwrite
# Users:RX files.
$currentId = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentId)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $e = @{ code='E_NOT_ADMIN'; message='-Elevated was passed but process is not admin.' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"
    exit 1
}

$copied = @()
$failed = @()
foreach ($m in $mismatches) {
    $srcPath = Join-Path $SourceDir $m.rel
    $dstPath = Join-Path $DestDir $m.rel
    $dstDir = Split-Path $dstPath -Parent
    try {
        if (-not (Test-Path $dstDir)) {
            New-Item -ItemType Directory -Force -Path $dstDir -EA Stop | Out-Null
        }
        Copy-Item -Path $srcPath -Destination $dstPath -Force -EA Stop
        # v2.4.8: reset THIS file's ACL to inherit from its parent. Scoped
        # per-file. Previous code ran `icacls $DestDir /inheritance:e /T` AFTER
        # the loop, which re-enabled inheritance on the ENTIRE tree and thus
        # re-opened the "bring-your-own-elevator" security hole the installer
        # works to close by locking Users to RX on script subdirs. This
        # per-file reset touches only files we just copied — no tree-wide
        # ACL changes. The file then inherits from its parent (actions/,
        # security/, or root), which already has the correct tier-A/tier-B
        # ACL from the installer.
        & icacls $dstPath '/reset' '/C' '/Q' 2>&1 | Out-Null
        $copied += $m.rel
    } catch {
        $failed += @{ rel = $m.rel; error = $_.Exception.Message }
    }
}

$sw.Stop()
$result = @{
    success       = ($failed.Count -eq 0)
    no_op         = $false
    duration_ms   = $sw.ElapsedMilliseconds
    needs_elevation = $false
    copied        = $copied.Count
    copied_files  = $copied
    failed        = $failed
    message       = "Synced $($copied.Count) script(s); $($failed.Count) failed."
}
if ($JsonOutput) { $result | ConvertTo-Json -Depth 5 -Compress } else { $result | ConvertTo-Json -Depth 5 }
exit ([int]($failed.Count -gt 0))
