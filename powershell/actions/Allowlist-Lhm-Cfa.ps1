<#
.SYNOPSIS
    Add LibreHardwareMonitor.exe to Windows Defender's Controlled Folder
    Access (CFA) allowlist so it stops getting blocked while reading
    sensors / writing log files.

.DESCRIPTION
    v2.5.6 (B47): Greg's box has CFA enabled. LHM periodically gets
    blocked when Defender re-evaluates its trust list, surfacing as
    Windows Security toasts. He's manually allowlisted it; this action
    automates that and is idempotent.

    Algorithm:
      1. Find LHM exe via Get-Process (live process is the most accurate
         path on a running system) → fall back to known WinGet location
         → fall back to Program Files default.
      2. Check current allowlist with Get-MpPreference. If LHM path
         already present, exit success with no_op=true.
      3. Add via `Add-MpPreference -ControlledFolderAccessAllowedApplications`.
      4. Verify by re-reading the allowlist post-call.

    Failure modes:
      - Tamper Protection ON: blocks Set-MpPreference and friends. Action
        returns E_TAMPER_PROTECTION with a hint pointing to Windows
        Security UI. Same fail mode as Enable-ControlledFolderAccess.ps1.
      - LHM not installed: returns E_LHM_NOT_FOUND.
      - Not elevated: throws permission error in Add-MpPreference.

    Output JSON:
      { success, dry_run, duration_ms, lhm_path, no_op, before, after, message }
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
        script  = $MyInvocation.MyCommand.Name
        line    = $_.InvocationInfo.ScriptLineNumber
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Resolve-LhmPath {
    # Prefer live process — most accurate when LHM is running.
    $proc = Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc -and $proc.Path) { return $proc.Path }

    $candidates = @(
        # WinGet default — same template as resolveLhmCandidatePaths in src/main/ipc.ts
        (Join-Path $env:USERPROFILE 'AppData\Local\Microsoft\WinGet\Packages\LibreHardwareMonitor.LibreHardwareMonitor_Microsoft.Winget.Source_8wekyb3d8bbwe\LibreHardwareMonitor.exe'),
        'C:\Program Files\LibreHardwareMonitor\LibreHardwareMonitor.exe'
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }

    # Glob fallback for future WinGet manifests with version suffixes.
    $wingetParent = Join-Path $env:USERPROFILE 'AppData\Local\Microsoft\WinGet\Packages'
    if (Test-Path $wingetParent) {
        Get-ChildItem -Path $wingetParent -Directory -Filter 'LibreHardwareMonitor*' -ErrorAction SilentlyContinue | ForEach-Object {
            $cand = Join-Path $_.FullName 'LibreHardwareMonitor.exe'
            if (Test-Path $cand) { return $cand }
        }
    }
    return $null
}

$lhmPath = Resolve-LhmPath
if (-not $lhmPath) {
    $err = @{
        code = 'E_LHM_NOT_FOUND'
        message = 'LibreHardwareMonitor.exe could not be located. Install via WinGet (LibreHardwareMonitor.LibreHardwareMonitor) before running this action.'
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}

if ($DryRun) {
    $sw.Stop()
    $result = @{
        success     = $true
        dry_run     = $true
        duration_ms = $sw.ElapsedMilliseconds
        lhm_path    = $lhmPath
        message     = "DryRun: would allowlist $lhmPath"
    }
    if ($JsonOutput) { $result | ConvertTo-Json -Compress } else { $result | ConvertTo-Json -Depth 3 }
    exit 0
}

# Snapshot before. Get-MpPreference works non-admin (read-only).
try {
    $before = Get-MpPreference -ErrorAction Stop
} catch {
    $err = @{
        code    = 'E_GET_MPPREFERENCE_FAILED'
        message = "Failed to read MpPreference: $($_.Exception.Message). Defender service may be off or Tamper Protection blocking the call."
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}

$beforeList = @($before.ControlledFolderAccessAllowedApplications)

# v2.5.6: case-insensitive contains check. Path comparisons on Windows
# should be case-insensitive (NTFS is by default).
$alreadyAllowed = $false
foreach ($p in $beforeList) {
    if ($p -and ($p.ToLowerInvariant() -eq $lhmPath.ToLowerInvariant())) {
        $alreadyAllowed = $true
        break
    }
}

if ($alreadyAllowed) {
    $sw.Stop()
    $result = @{
        success         = $true
        dry_run         = $false
        no_op           = $true
        duration_ms     = $sw.ElapsedMilliseconds
        lhm_path        = $lhmPath
        before_count    = $beforeList.Count
        message         = 'LHM already on Controlled Folder Access allowlist.'
    }
    if ($JsonOutput) { $result | ConvertTo-Json -Compress } else { $result | ConvertTo-Json -Depth 3 }
    exit 0
}

# Apply. Add-MpPreference is the additive cmdlet (Set-MpPreference replaces;
# Add appends without disturbing the existing list).
try {
    Add-MpPreference -ControlledFolderAccessAllowedApplications $lhmPath -ErrorAction Stop
} catch {
    $msg = $_.Exception.Message
    # Tamper Protection failure mode mirrors Enable-ControlledFolderAccess.ps1.
    if ($msg -match 'tamper' -or $msg -match '0x800704EC' -or $msg -match 'access.*denied') {
        $err = @{
            code = 'E_TAMPER_PROTECTION'
            message = 'Tamper Protection blocks Add-MpPreference. Open Windows Security -> Virus & threat protection -> Ransomware protection -> Allow an app through Controlled folder access, then add LibreHardwareMonitor.exe manually.'
            lhm_path = $lhmPath
        } | ConvertTo-Json -Compress
        Write-Host "PCDOCTOR_ERROR:$err"
        exit 1
    }
    throw
}

# Verify by re-reading.
Start-Sleep -Milliseconds 200
$after = Get-MpPreference -ErrorAction Stop
$afterList = @($after.ControlledFolderAccessAllowedApplications)
$nowAllowed = $false
foreach ($p in $afterList) {
    if ($p -and ($p.ToLowerInvariant() -eq $lhmPath.ToLowerInvariant())) {
        $nowAllowed = $true
        break
    }
}

$sw.Stop()

if (-not $nowAllowed) {
    $err = @{
        code = 'E_VERIFY_FAILED'
        message = 'Add-MpPreference returned success but LHM path is not in the allowlist on re-read. Defender state may be partially controlled by Tamper Protection.'
        lhm_path = $lhmPath
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}

$result = @{
    success      = $true
    dry_run      = $false
    no_op        = $false
    duration_ms  = $sw.ElapsedMilliseconds
    lhm_path     = $lhmPath
    before_count = $beforeList.Count
    after_count  = $afterList.Count
    message      = "Added $lhmPath to Controlled Folder Access allowlist."
}
if ($JsonOutput) { $result | ConvertTo-Json -Compress } else { $result | ConvertTo-Json -Depth 3 }
exit 0
