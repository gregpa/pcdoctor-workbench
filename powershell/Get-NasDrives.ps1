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

# DriveType=4 is "Network Drive" per Win32_LogicalDisk. This never hits
# the remote share; it reads the OS drive letter table from the SMB client.
$netDrives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=4' -ErrorAction SilentlyContinue)

$result = @()

foreach ($d in $netDrives) {
    $letter = ($d.DeviceID -replace ':$', '').ToUpper()
    $root   = "$letter`:\"

    # Parse the server hostname from the provider UNC path
    # (\\server-or-ip\share). Fall back to no-host if unparseable.
    $hostName = $null
    if ($d.ProviderName -and $d.ProviderName -match '^\\\\([^\\]+)\\') {
        $hostName = $Matches[1]
    }

    # Layered reachability:
    #   1. CIM Size must be populated (OS has a live mount record).
    #   2. TCP :445 on the host responds within 2s (SMB port open).
    #   3. Test-Path on the drive root succeeds (share still mounted).
    # Only when all three pass do we consider the drive reachable for
    # the purpose of measuring @Recycle size. Any earlier step failing
    # short-circuits the expensive Test-Path + Get-ChildItem calls.
    $reachable = $false
    if ($null -ne $d.Size -and [int64]$d.Size -gt 0 -and $hostName) {
        if (Test-NasHostReachable -HostName $hostName -TimeoutMs 2000) {
            try {
                $reachable = Test-Path $root -ErrorAction SilentlyContinue
            } catch { $reachable = $false }
        }
    }

    $usedBytes = $null
    $freeBytes = $null
    $totalBytes = $null
    $recycleBytes = $null

    if ($reachable) {
        try {
            $usedBytes = [int64]($d.Size - $d.FreeSpace)
            $freeBytes = [int64]$d.FreeSpace
            $totalBytes = [int64]$d.Size
        } catch { }

        # @Recycle sizing. Missing folder = 0 bytes (not null). Access errors
        # during the walk are tolerated; we'd rather report a possibly-stale
        # low number than fail the whole tile.
        $recyclePath = Join-Path $root '@Recycle'
        if (Test-Path $recyclePath -ErrorAction SilentlyContinue) {
            try {
                $sum = (Get-ChildItem -Path $recyclePath -Recurse -Force -File -ErrorAction SilentlyContinue |
                        Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
                $recycleBytes = if ($null -eq $sum) { [int64]0 } else { [int64]$sum }
            } catch {
                $recycleBytes = $null
            }
        } else {
            $recycleBytes = [int64]0
        }
    }

    $result += [ordered]@{
        letter        = "$letter`:"
        unc           = if ($d.ProviderName) { "$($d.ProviderName)" } else { $null }
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
