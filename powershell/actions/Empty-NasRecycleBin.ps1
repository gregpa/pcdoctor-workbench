<#
.SYNOPSIS
    Empties the @Recycle folder contents on ONE network (NAS) drive.

.DESCRIPTION
    v2.4.13: companion to Empty-RecycleBins.ps1. The local action targets
    fixed drives and uses Clear-RecycleBin (which only works on the Windows
    $Recycle.Bin convention). QNAP/Synology NAS shares use @Recycle at the
    share root, which Clear-RecycleBin cannot touch. This script:

      1. Validates the drive is DriveType=4 (network). Refuses otherwise.
      2. Measures {letter}:\@Recycle size before.
      3. Removes every child of @Recycle (preserving the @Recycle folder
         itself - QNAP's filestation expects it to exist).
      4. Measures after. Reports bytes_freed + per-entry failure count.

    Destructive + irreversible. Caller is responsible for user confirmation
    (actionRunner routes this through the confirm-modal flow via the
    `confirm_level: 'destructive'` registration in src/shared/actions.ts).

.PARAMETER DriveLetter
    Single uppercase letter - "M", "Z", "U", etc. No colon, no backslash.
    Validated against ^[A-Za-z]$. v2.4.16: aligned with actionRunner's
    snake_case -> PascalCase transform ('drive_letter' -> '-DriveLetter').

.PARAMETER DryRun
    Skip the deletion phase. Still measures before-size and reports what
    WOULD be freed. actionRunner invokes this via the action's `dry_run`
    flag for the confirm-modal preview.

.PARAMETER JsonOutput
    Emit compressed JSON (default behaviour; kept for API parity).

.NOTES
    No admin required. Greg's user token has Modify on the QNAP shares.
    A third-party NAS that locks @Recycle behind admin will surface as
    E_NAS_RECYCLE_BLOCKED; caller should show the per-entry error list.
#>
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z]$')][string]$DriveLetter,
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
$letter = $DriveLetter.ToUpper()

# Safety: refuse to run on anything that isn't a network drive. Catches
# the case where a caller passes a local drive letter - Clear-RecycleBin
# is the right tool there, not @Recycle wiping.
$cim = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'" -ErrorAction SilentlyContinue
if (-not $cim) {
    $e = @{ code='E_DRIVE_NOT_FOUND'; message="Drive ${letter}: is not present in the OS drive table" } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"
    exit 1
}
if ($cim.DriveType -ne 4) {
    $e = @{ code='E_NOT_NETWORK_DRIVE'; message="${letter}: is not a network drive (DriveType=$($cim.DriveType)). Use empty_recycle_bins for local drives." } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"
    exit 1
}

$root        = "${letter}:\"
$recyclePath = Join-Path $root '@Recycle'

function Get-NasRecycleSize {
    param([string]$Path)
    if (-not (Test-Path $Path -ErrorAction SilentlyContinue)) { return [int64]0 }
    try {
        $sum = (Get-ChildItem -Path $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
        if ($null -eq $sum) { return [int64]0 }
        return [int64]$sum
    } catch { return [int64]0 }
}

if (-not (Test-Path $root -ErrorAction SilentlyContinue)) {
    $e = @{ code='E_NAS_UNREACHABLE'; message="${letter}:\\ is not reachable (share offline or drive not connected)" } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"
    exit 1
}

$before = Get-NasRecycleSize -Path $recyclePath
$recycleExists = Test-Path $recyclePath -ErrorAction SilentlyContinue

if ($DryRun) {
    $result = [ordered]@{
        success       = $true
        dry_run       = $true
        drive         = $letter
        recycle_exists= [bool]$recycleExists
        bytes_before  = $before
        would_free    = $before
        duration_ms   = $sw.ElapsedMilliseconds
        message       = if ($recycleExists) {
            "Would delete $([math]::Round($before / 1GB, 2)) GB from ${letter}:\@Recycle"
        } else {
            "${letter}:\@Recycle does not exist - nothing to do"
        }
    }
    $result | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

if (-not $recycleExists) {
    $result = [ordered]@{
        success      = $true
        drive        = $letter
        status       = 'empty'
        bytes_before = 0
        bytes_after  = 0
        bytes_freed  = 0
        duration_ms  = $sw.ElapsedMilliseconds
        message      = "${letter}:\@Recycle does not exist - nothing to do"
    }
    $result | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

# Delete children of @Recycle, NOT the folder itself. QNAP recreates the
# folder on next UI access, but leaving it in place avoids a transient
# window where a concurrent filestation write fails.
$deleted   = 0
$errors    = @()
Get-ChildItem -Path $recyclePath -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction Stop
        $deleted++
    } catch {
        $errors += @{ path = $_.FullName; message = $_.Exception.Message }
    }
}

# Give the SMB layer a moment to settle before re-measuring. On busy QNAP
# volumes, Size queries can lag the actual state by a few hundred ms.
Start-Sleep -Milliseconds 300
$after = Get-NasRecycleSize -Path $recyclePath
# v2.4.16: explicit Int64 conditional rather than [math]::Max(0, int64).
# PowerShell's overload resolver treats the 0 literal as Int32 and
# selects Max(int32, int32), which fails to downcast byte totals
# above 2 GiB with "Cannot convert value 'X' to type 'System.Int32'".
# Greg's M: bin at 45 GB hit this.
$freed = if ($before -gt $after) { [int64]($before - $after) } else { [int64]0 }

$sw.Stop()

$hadContent = $before -gt 0
$fullyCleared = ($after -eq 0)
$status =
    if (-not $hadContent)                               { 'empty' }
    elseif ($fullyCleared)                              { 'cleared' }
    elseif ($errors.Count -gt 0 -and $after -lt $before) { 'partial' }
    elseif ($errors.Count -gt 0)                         { 'blocked' }
    else                                                 { 'partial' }

if ($hadContent -and $status -eq 'blocked') {
    $blockedList = ($errors | ForEach-Object { "$($_.path): $($_.message)" }) -join '; '
    $errPayload = @{
        code        = 'E_NAS_RECYCLE_BLOCKED'
        message     = "Could not delete any entries from ${letter}:\@Recycle. Details: $blockedList"
        drive       = $letter
        errors      = $errors
        duration_ms = $sw.ElapsedMilliseconds
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errPayload"
    exit 1
}

$summaryText =
    if (-not $hadContent) { "${letter}:\@Recycle was already empty." }
    else { "Freed $([math]::Round($freed / 1GB, 2)) GB from ${letter}:\@Recycle ($deleted entries deleted, $($errors.Count) errors)." }

$result = [ordered]@{
    success        = $true
    drive          = $letter
    status         = $status
    bytes_before   = $before
    bytes_after    = $after
    bytes_freed    = $freed
    entries_deleted= $deleted
    entries_errors = $errors
    duration_ms    = $sw.ElapsedMilliseconds
    message        = $summaryText
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
