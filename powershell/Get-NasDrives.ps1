<#
.SYNOPSIS
    Enumerates mapped network (NAS) drives with capacity, free space, and
    @Recycle folder size for each.

.DESCRIPTION
    v2.4.13: powers the Dashboard NasRecycleBinPanel tile. Emits one record
    per DriveType=4 (network) logical disk visible to the OS, with:
      - letter      e.g. "M:"
      - unc         the provider path (\\server\share) or null if unknown
      - used_bytes  Size - FreeSpace from CIM (null when unreachable)
      - free_bytes  FreeSpace from CIM
      - total_bytes Size from CIM
      - recycle_bytes  sum of files in {letter}:\@Recycle (QNAP convention)
      - reachable   true when CIM Size is populated (non-zero) AND
                    Test-Path on the root succeeds within the time budget

    Design: the top-level Win32_LogicalDisk query reads the OS drive table
    and never hits the network, so it is always instant. The per-drive
    reachability probe + recycle-size scan are wrapped individually in
    Test-Path / Get-ChildItem -ErrorAction SilentlyContinue so one offline
    share doesn't stall the whole enumeration.

.PARAMETER JsonOutput
    Emit compressed JSON (the only supported output format; param kept for
    API parity with other scripts).

.NOTES
    @Recycle is the QNAP / Synology convention for per-share recycle bins.
    Local Windows drives use $Recycle.Bin and are NOT reported here - see
    Empty-RecycleBins.ps1 for the local flow.

    This script does not require admin. Read-only CIM + filesystem queries.
#>
param([switch]$JsonOutput)

$ErrorActionPreference = 'Continue'

trap {
    $errRecord = @{
        code    = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' }
        message = $_.Exception.Message
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# v2.4.13 (W1 fix): probe SMB:445 on the remote host with a hard 2s
# timeout BEFORE calling Test-Path on the mapped drive root. The naive
# `Test-Path \\server\share\` path blocks for the Windows SMB client
# timeout (20-30s) when a share is in a stale/half-open state - 6 drives
# * 30s easily blows past the IPC's 30s timeout and returns no data at
# all. TcpClient.BeginConnect + WaitOne gives us a deterministic cap.
function Test-NasHostReachable {
    param([string]$HostName, [int]$TimeoutMs = 2000)
    if ([string]::IsNullOrWhiteSpace($HostName)) { return $false }
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect($HostName, 445, $null, $null)
        $succeeded = $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if (-not $succeeded) { return $false }
        $client.EndConnect($async)
        return $client.Connected
    } catch {
        return $false
    } finally {
        if ($null -ne $client) { try { $client.Close() } catch { } }
    }
}

# v2.4.14: enumerate ALL Win32_LogicalDisk drive types that make sense to
# show in a storage panel:
#   DriveType=2 Removable (USB flash, GoldKey-style tokens)
#   DriveType=3 Local fixed (internal SSD/HDD, Google Drive File Stream)
#   DriveType=4 Network (SMB mounts)
# Skip 5 (CD-ROM) and 6 (RAM drive) - neither is actionable here.
#
# TCP reachability probe only applies to network drives. Local + removable
# drives that Win32_LogicalDisk sees are by definition already reachable
# (Size > 0) - if they weren't, the OS wouldn't list them. No need to pay
# the 2s probe cost or `Test-Path` round-trip for them.
$allDrives = @(Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue |
    Where-Object { $_.DriveType -in 2, 3, 4 })

$result = @()

foreach ($d in $allDrives) {
    $letter = ($d.DeviceID -replace ':$', '').ToUpper()
    $root   = "$letter`:\"
    $isNetwork = ($d.DriveType -eq 4)
    $kind = switch ($d.DriveType) {
        2 { 'removable' }
        3 { 'local' }
        4 { 'network' }
        default { 'local' }
    }

    # Parse the server hostname from the provider UNC path - network only.
    $hostName = $null
    if ($isNetwork -and $d.ProviderName -and $d.ProviderName -match '^\\\\([^\\]+)\\') {
        $hostName = $Matches[1]
    }

    # Layered reachability:
    #   Network:  CIM Size populated + TCP :445 within 2s + Test-Path works.
    #   Local:    CIM Size populated is enough (no remote round-trip).
    $reachable = $false
    if ($null -ne $d.Size -and [int64]$d.Size -gt 0) {
        if ($isNetwork) {
            if ($hostName -and (Test-NasHostReachable -HostName $hostName -TimeoutMs 2000)) {
                try { $reachable = Test-Path $root -ErrorAction SilentlyContinue }
                catch { $reachable = $false }
            }
        } else {
            $reachable = $true
        }
    }

    $usedBytes    = $null
    $freeBytes    = $null
    $totalBytes   = $null
    $recycleBytes = $null

    if ($reachable) {
        try {
            $usedBytes  = [int64]($d.Size - $d.FreeSpace)
            $freeBytes  = [int64]$d.FreeSpace
            $totalBytes = [int64]$d.Size
        } catch { }

        # v2.4.50 (B49-NAS-1): @Recycle size scanning REMOVED from this
        # hot path. Pre-2.4.50 the script ran `Get-ChildItem -Recurse` over
        # each network share's @Recycle folder. On Greg's QNAP that took
        # 21.5s for M:\@Recycle alone (4 huge Plex video files producing
        # SMB metadata round-trips per directory) plus 3.5s for Z:, easily
        # blowing the 30s IPC timeout and breaking the entire drive panel.
        #
        # `recycle_bytes` is now always `$null` for network drives. The UI
        # gates the trash button on `unc` presence instead of size > 0.
        # The actual empty operation (Empty-NasRecycleBin.ps1) computes
        # size on-demand in the action runner, which has its own 5-min
        # action timeout (not the 30s IPC budget) so a slow share is
        # tolerable there.
        #
        # Future v2.4.51+: scheduled-task background refresh of @Recycle
        # sizes into a cache; UI reads cache (always fast). For now,
        # simplicity wins.
        $recycleBytes = $null
        # Local + removable drives also leave $recycleBytes = $null. The
        # UI uses `kind === 'network'` to decide whether to show the @Recycle
        # button at all (local $Recycle.Bin is handled by the existing
        # empty_recycle_bins Quick Action).
    }

    $result += [ordered]@{
        letter        = "$letter`:"
        unc           = if ($isNetwork -and $d.ProviderName) { "$($d.ProviderName)" } else { $null }
        volume_name   = if ($d.VolumeName) { "$($d.VolumeName)" } else { $null }
        kind          = $kind
        used_bytes    = $usedBytes
        free_bytes    = $freeBytes
        total_bytes   = $totalBytes
        recycle_bytes = $recycleBytes
        reachable     = $reachable
    }
}

$sw.Stop()

$payload = [ordered]@{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    drives      = $result
}

if ($JsonOutput) {
    $payload | ConvertTo-Json -Depth 5 -Compress
} else {
    $payload | ConvertTo-Json -Depth 5
}
exit 0
