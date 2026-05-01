<#
.SYNOPSIS
    Add C:\ProgramData\PCDoctor to Windows Defender's exclusion paths so
    scanner reads/writes are not throttled or blocked by real-time protection.

.DESCRIPTION
    v2.5.17 (first-run wizard W2): On first launch, the wizard offers to add
    the PCDoctor data directory to Defender's ExclusionPath list. This
    eliminates per-file AV scanning overhead on every report write, copyFile,
    and DB access under C:\ProgramData\PCDoctor — the root cause of the
    30-70 second disk stalls observed in v2.4.x.

    Algorithm:
      1. Read current ExclusionPath list via Get-MpPreference.
      2. Case-insensitive check: if C:\ProgramData\PCDoctor is already listed,
         exit success with no_op=true.
      3. Add via Add-MpPreference -ExclusionPath (additive; does not disturb
         existing entries).
      4. Re-read to verify the entry landed.

    Failure modes:
      - Tamper Protection ON: blocks Add-MpPreference. Returns
        E_TAMPER_PROTECTION with instructions for manual fallback in
        Windows Security UI.
      - Not elevated: Add-MpPreference throws "Access is denied". The
        action definition has needs_admin:true so UAC runs before this script.

    Output JSON:
      { success, no_op, duration_ms, exclusion_path, message }
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
$exclusionPath = 'C:\ProgramData\PCDoctor'

# Read current exclusions. Get-MpPreference works non-elevated (read-only).
try {
    $prefs = Get-MpPreference -ErrorAction Stop
} catch {
    $err = @{
        code    = 'E_GET_MPPREFERENCE_FAILED'
        message = "Could not read Defender preferences: $($_.Exception.Message). Defender service may be off or Tamper Protection blocking the call."
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}

$currentList = @($prefs.ExclusionPath)

# Case-insensitive membership check (NTFS paths are case-insensitive on Windows).
$alreadyExcluded = $false
foreach ($p in $currentList) {
    if ($p -and ($p.TrimEnd('\').ToLowerInvariant() -eq $exclusionPath.ToLowerInvariant())) {
        $alreadyExcluded = $true
        break
    }
}

if ($alreadyExcluded) {
    $sw.Stop()
    $result = @{
        success        = $true
        no_op          = $true
        duration_ms    = $sw.ElapsedMilliseconds
        exclusion_path = $exclusionPath
        message        = 'C:\ProgramData\PCDoctor is already in the Defender ExclusionPath list.'
    }
    if ($JsonOutput) { $result | ConvertTo-Json -Compress } else { $result | ConvertTo-Json -Depth 3 }
    exit 0
}

if ($DryRun) {
    $sw.Stop()
    $result = @{
        success        = $true
        dry_run        = $true
        no_op          = $false
        duration_ms    = $sw.ElapsedMilliseconds
        exclusion_path = $exclusionPath
        message        = "DryRun: would add $exclusionPath to Defender ExclusionPath."
    }
    if ($JsonOutput) { $result | ConvertTo-Json -Compress } else { $result | ConvertTo-Json -Depth 3 }
    exit 0
}

# Apply exclusion. Add-MpPreference appends; does not overwrite the existing list.
try {
    Add-MpPreference -ExclusionPath $exclusionPath -ErrorAction Stop
} catch {
    $msg = $_.Exception.Message
    if ($msg -match 'tamper' -or $msg -match '0x800704EC' -or $msg -match 'access.*denied') {
        $err = @{
            code    = 'E_TAMPER_PROTECTION'
            message = "Tamper Protection is blocking Add-MpPreference. Open Windows Security -> Virus & threat protection -> Manage settings -> scroll to Exclusions -> Add an exclusion -> Folder -> C:\ProgramData\PCDoctor."
        } | ConvertTo-Json -Compress
        Write-Host "PCDOCTOR_ERROR:$err"
        exit 1
    }
    throw
}

# Verify by re-reading.
Start-Sleep -Milliseconds 200
$after = Get-MpPreference -ErrorAction Stop
$afterList = @($after.ExclusionPath)
$nowExcluded = $false
foreach ($p in $afterList) {
    if ($p -and ($p.TrimEnd('\').ToLowerInvariant() -eq $exclusionPath.ToLowerInvariant())) {
        $nowExcluded = $true
        break
    }
}

$sw.Stop()

if (-not $nowExcluded) {
    $err = @{
        code    = 'E_VERIFY_FAILED'
        message = 'Add-MpPreference returned success but the exclusion path is not present on re-read. Tamper Protection may be partially active.'
        exclusion_path = $exclusionPath
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}

$result = @{
    success        = $true
    no_op          = $false
    duration_ms    = $sw.ElapsedMilliseconds
    exclusion_path = $exclusionPath
    message        = "Added $exclusionPath to Windows Defender ExclusionPath. Scanner reads/writes will no longer be intercepted by real-time protection."
}
if ($JsonOutput) { $result | ConvertTo-Json -Compress } else { $result | ConvertTo-Json -Depth 3 }
exit 0
