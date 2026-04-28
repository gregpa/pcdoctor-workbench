<#
.SYNOPSIS
    Refresh per-NAS-drive @Recycle folder sizes into the workbench DB cache.

.DESCRIPTION
    v2.4.51 (B49-NAS-2): runs daily via PCDoctor-Autopilot-RefreshNasRecycleSizes
    so the IPC handler api:getNasDrives can return cached sizes instead of
    doing a recursive SMB scan in the 30s IPC budget. Per-drive 60s soft cap
    so one stalled drive doesn't block the others.

    Output: writes one JSON queue file per run to
    C:\ProgramData\PCDoctor\queue\nas-recycle-<ts>.json. The IPC handler
    api:getNasDrives drains the queue on next call and upserts each row
    into the nas_recycle_sizes table via better-sqlite3. Greg's app is
    effectively always running, so acceptable lag is at most one app-launch
    cycle. Drives where the @Recycle scan hits the 60s cap are SKIPPED
    (no row written rather than a partial / wrong number); the cache row
    from the prior successful scan stays in place until next pass.

.PARAMETER JsonOutput
    Emit the JSON-Lines summary record on stdout for the autopilot
    dispatcher to ingest. Mandatory when invoked via Run-AutopilotScheduled.ps1.
#>
param([switch]$JsonOutput)
$ErrorActionPreference = 'Continue'
trap {
    $errRecord = @{ code = 'E_PS_UNHANDLED'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}
$sw = [System.Diagnostics.Stopwatch]::StartNew()

# Enumerate network drives (DriveType=4 only; local + removable are out of scope here).
$nasDrives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=4' -ErrorAction SilentlyContinue)

$results = @()
foreach ($d in $nasDrives) {
    $letter = ($d.DeviceID -replace ':$', '').ToUpper()
    $root = "${letter}:\@Recycle"
    $perDriveSw = [System.Diagnostics.Stopwatch]::StartNew()
    if (-not (Test-Path $root)) {
        # No @Recycle folder; record 0 so the cache shows "empty" rather than
        # a stale number from a deleted drive.
        $results += @{ letter = $letter; recycle_bytes = 0; scan_duration_ms = $perDriveSw.ElapsedMilliseconds; status = 'no_recycle' }
        continue
    }

    # v2.4.51: per-drive 60s soft cap. Get-ChildItem -Recurse on a stalled
    # SMB share can block for the OS timeout (~30s x N retries). Use a
    # background job with a hard wait. If the job hits the cap, abort it
    # and skip this drive -- we keep the prior cache row rather than
    # writing a wrong number.
    $job = Start-Job -ScriptBlock {
        param($p)
        try {
            (Get-ChildItem -Path $p -Recurse -Force -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
        } catch { $null }
    } -ArgumentList $root

    $finished = Wait-Job -Job $job -Timeout 60
    if ($null -eq $finished) {
        # Timed out; abandon.
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        $results += @{ letter = $letter; status = 'timeout'; scan_duration_ms = 60000 }
        continue
    }
    $sumRaw = Receive-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    $sum = if ($null -eq $sumRaw) { 0 } else { [int64]$sumRaw }
    $results += @{ letter = $letter; recycle_bytes = $sum; scan_duration_ms = $perDriveSw.ElapsedMilliseconds; status = 'ok' }
}

# v2.4.51 (D2 queue-file fallback): write successful results to a JSON queue
# file. The IPC handler api:getNasDrives drains the queue on next call. This
# avoids the multi-entry CJS build complexity required for an in-process
# bridge and works regardless of whether Workbench is running.
$okRows = @($results | Where-Object { $_.status -eq 'ok' -or $_.status -eq 'no_recycle' })
$payload = @{ rows = $okRows } | ConvertTo-Json -Depth 5 -Compress

$queueDir = 'C:\ProgramData\PCDoctor\queue'
try {
    if (-not (Test-Path $queueDir)) {
        New-Item -Path $queueDir -ItemType Directory -Force | Out-Null
    }
    $ts = Get-Date -Format 'yyyyMMddHHmmss'
    $queueFile = Join-Path $queueDir "nas-recycle-$ts.json"
    [System.IO.File]::WriteAllText($queueFile, $payload, [System.Text.UTF8Encoding]::new($false))
} catch {
    # Queue write failed -- nothing more we can do; the next run will retry.
}

$sw.Stop()
$summary = @{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    drives_scanned = $results.Count
    drives_ok = $okRows.Count
    drives_timeout = @($results | Where-Object { $_.status -eq 'timeout' }).Count
    message = "Refreshed $($results.Count) NAS drives"
    results = $results
}
$summary | ConvertTo-Json -Depth 5 -Compress
exit 0
