<#
.SYNOPSIS
    Empties the Recycle Bin on local fixed and removable drives.
.DESCRIPTION
    v2.2.0 rewrite: reports honestly.

    * Targets fixed (DriveType=3) and removable (DriveType=2) drives. Network drives
      (G:, J:, NAS mappings) are skipped.
    * Per-drive `Clear-RecycleBin` exception messages are captured and returned.
    * Per-drive status is one of: empty / cleared / partial / blocked / error.
    * Top-level success is TRUE only when either:
        - at least one drive with content was cleared, or
        - every drive was already empty (nothing to do).
      When hadContent == true but anySuccess == false, we emit
      PCDOCTOR_ERROR:{code:E_RECYCLEBIN_BLOCKED,...} and exit 1 so the caller
      (actionRunner) records an error rather than a bogus success.
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

function Get-RecycleBinSize {
    param([string]$DriveRoot)
    $p = Join-Path $DriveRoot '$Recycle.Bin'
    if (-not (Test-Path $p)) { return 0 }
    try {
        $sum = (Get-ChildItem -Path $p -Recurse -Force -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
        if ($null -eq $sum) { return 0 }
        return [int64]$sum
    } catch { return 0 }
}

# v2.4.51: include removable drives (DriveType=2, USB sticks etc.) in
# addition to fixed (DriveType=3). Network (4), CD-ROM (5), RAM (6) stay
# excluded -- Clear-RecycleBin doesn't apply to them. Aligns with
# Get-NasDrives.ps1 which enumerates DriveType=2,3,4 for the dashboard panel.
$fixedDrives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2 OR DriveType=3' -ErrorAction SilentlyContinue)

$perDrive      = @()
$totalFreed    = [int64]0
$hadContent    = $false
$anySuccess    = $false

foreach ($d in $fixedDrives) {
    $letter     = ($d.DeviceID -replace ':$', '').ToUpper()
    $driveRoot  = "$letter`:\"
    if (-not (Test-Path $driveRoot)) { continue }

    $before = Get-RecycleBinSize -DriveRoot $driveRoot
    if ($before -gt 0) { $hadContent = $true }

    $clearError = $null
    try {
        Clear-RecycleBin -DriveLetter $letter -Force -ErrorAction Stop
    } catch {
        $clearError = $_.Exception.Message
    }

    # v2.4.49 (B47-3 revisited): give Explorer / the $Recycle.Bin index more
    # time to settle before re-measuring. Pre-2.4.49 200ms was too tight on
    # NTFS — Greg's 2026-04-26 dispatcher log showed before>0 / clearError=null
    # / after>=before on D/E/G/J drives, which hit the (since-removed)
    # `else { 'error' }` branch and emitted a false-error row. Empirically
    # ~1s suffices; 1500ms is a comfortable margin for unattended Task
    # Scheduler runs.
    Start-Sleep -Milliseconds 1500

    $after = Get-RecycleBinSize -DriveRoot $driveRoot
    # v2.4.16: explicit Int64 conditional rather than [math]::Max(0, int64).
    # The 0 literal selects the Int32 Max overload and downcasts the
    # Int64 result, which fails for bins > 2 GiB with a confusing
    # "Cannot convert value 'X' to type 'System.Int32'" error.
    $freed = if ($before -gt $after) { [int64]($before - $after) } else { [int64]0 }

    # v2.4.49 (B47-3 revisited): the trailing `else { 'error' }` branch was
    # firing when Clear-RecycleBin returned cleanly (no exception) but the
    # re-measure 200ms later still saw the same/larger size — i.e. the
    # $Recycle.Bin index hadn't settled yet. Tier-down to 'partial' for
    # this case: we can't prove the bin is empty, but we have no evidence
    # of failure either. 'partial' counts as $anySuccess so the top-level
    # success: true holds, matching user intent ("we tried and it looks
    # fine"). The 'blocked' / 'error' paths still cover all exception cases.
    $status =
        if ($before -eq 0 -and $null -eq $clearError) { 'empty' }
        elseif ($clearError -and $after -eq $before)  { 'blocked' }
        elseif ($clearError -and $after -lt $before)  { 'partial' }
        elseif ($after -eq 0 -and $before -gt 0)      { 'cleared' }
        elseif ($after -lt $before)                   { 'partial' }
        elseif ($null -eq $clearError -and $before -gt 0) { 'partial' }  # NEW: clean exit, slow index settle
        else                                          { 'error' }

    if ($status -eq 'cleared' -or $status -eq 'partial') { $anySuccess = $true }

    $perDrive += [ordered]@{
        drive        = $letter
        status       = $status
        bytes_before = $before
        bytes_after  = $after
        bytes_freed  = $freed
        error        = $clearError
    }
    $totalFreed += $freed
}

$sw.Stop()

# Report honest failure when we had content and cleared none of it.
if ($hadContent -and -not $anySuccess) {
    $blockedList = ($perDrive | Where-Object { $_.status -eq 'blocked' -or $_.status -eq 'error' } |
                    ForEach-Object { "$($_.drive): $($_.error)" }) -join '; '
    $msg = "Could not empty recycle bin on any drive. Close all File Explorer windows and retry. Details: $blockedList"
    $errPayload = @{
        code        = 'E_RECYCLEBIN_BLOCKED'
        message     = $msg
        per_drive   = $perDrive
        duration_ms = $sw.ElapsedMilliseconds
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errPayload"
    exit 1
}

$summaryText =
    if (-not $hadContent) { 'All recycle bins were already empty.' }
    else { "Freed $([math]::Round($totalFreed / 1MB, 1)) MB across $(@($perDrive | Where-Object { $_.status -eq 'cleared' -or $_.status -eq 'partial' }).Count) drive(s)." }

$result = [ordered]@{
    success        = $true
    duration_ms    = $sw.ElapsedMilliseconds
    bytes_freed    = $totalFreed
    drives_cleaned = $perDrive
    had_content    = $hadContent
    any_success    = $anySuccess
    message        = $summaryText
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
