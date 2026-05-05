<#
.SYNOPSIS
    Pre-ship gate (v2.5.31): boot the elevated worker briefly and verify it
    writes a valid heartbeat. Catches startup bugs that vitest mocks miss.

.DESCRIPTION
    v2.5.30 (post-mortem): Elevated-Worker.ps1 line 96 had `$pid = $PID`,
    which fails because $PID is a read-only automatic variable (and $pid is
    the case-insensitive same name). The worker died on startup before
    writing heartbeat. Every Services/Processes mutate in v2.5.30 hung for
    60s then surfaced a misleading E_UAC_DENIED.

    test-ps51-syntax.ps1 catches parse errors but not runtime errors.
    vitest tests mock the worker entirely. This gate runs the actual worker
    UNelevated (elevation only matters for the action dispatchers it calls)
    for a few seconds and confirms it produces a valid .heartbeat JSON file.

    What it catches:
      - Read-only-variable assignments at startup (the v2.5.30 bug)
      - Param block / mandatory-arg errors
      - Hashtable / ConvertTo-Json shape errors in heartbeat
      - Missing functions, typos, import failures

    What it does NOT catch:
      - Action-script execution bugs (those need their own per-action gates)
      - UAC / elevation-only failure modes
      - Idle timeout bugs (would need 600+s)

.NOTES
    Runs unelevated. The worker doesn't need elevation to start, write
    heartbeat, or enter its main loop -- elevation only matters for the
    actions it would dispatch (which we don't call).
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$worker = Join-Path $repoRoot 'powershell\worker\Elevated-Worker.ps1'
$basePath = Join-Path $repoRoot 'powershell'

if (-not (Test-Path $worker)) {
    Write-Host "[FAIL] Worker script not found at $worker"
    exit 1
}

# Use a unique queue dir per run so concurrent test invocations don't collide.
$queueDir = Join-Path $env:TEMP "pcdoctor-worker-smoke-$([guid]::NewGuid().ToString('N').Substring(0,8))"
if (Test-Path $queueDir) { Remove-Item $queueDir -Recurse -Force }
New-Item -ItemType Directory -Path $queueDir | Out-Null

Write-Host "Worker:    $worker"
Write-Host "BasePath:  $basePath"
Write-Host "QueueDir:  $queueDir"
Write-Host ""

# Pick the same shell scriptRunner picks in production: pwsh 7 if available,
# otherwise Windows PowerShell 5.1 fallback. The bug must not regress on
# either shell.
$pwsh7 = 'C:\Program Files\PowerShell\7\pwsh.exe'
$ps51  = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$shells = @()
if (Test-Path $pwsh7) { $shells += @{ Path = $pwsh7; Name = 'pwsh 7' } }
if (Test-Path $ps51)  { $shells += @{ Path = $ps51;  Name = 'PS 5.1' } }
if ($shells.Count -eq 0) {
    Write-Host "[FAIL] Neither pwsh 7 nor PS 5.1 found"
    exit 1
}

$failed = 0
foreach ($shell in $shells) {
    Write-Host "=== $($shell.Name) ==="
    $hbPath = Join-Path $queueDir '.heartbeat'
    if (Test-Path $hbPath) { Remove-Item $hbPath -Force }

    # Run the worker as a background job with 5s idle timeout.
    $job = Start-Job -ScriptBlock {
        param($sh, $w, $b, $q)
        & $sh -NoProfile -ExecutionPolicy Bypass -File $w -BasePath $b -QueueDir $q -IdleTimeoutSeconds 5 2>&1
    } -ArgumentList $shell.Path, $worker, $basePath, $queueDir

    # Poll for heartbeat file every 100ms up to 3s.
    $deadline = (Get-Date).AddSeconds(3)
    $hbContent = $null
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $hbPath) {
            try {
                $hbContent = Get-Content $hbPath -Raw -ErrorAction Stop
                if ($hbContent) { break }
            } catch { }
        }
        Start-Sleep -Milliseconds 100
    }

    # Stop and clean up the job, regardless of outcome.
    $jobOutput = $null
    try {
        $job | Stop-Job -ErrorAction SilentlyContinue
        $jobOutput = $job | Receive-Job -ErrorAction SilentlyContinue
        $job | Remove-Job -Force -ErrorAction SilentlyContinue
    } catch { }

    if (-not $hbContent) {
        Write-Host "[FAIL] No heartbeat appeared within 3s"
        if ($jobOutput) {
            Write-Host "--- worker output: ---"
            $jobOutput | ForEach-Object { Write-Host "  $_" }
        }
        $failed++
        continue
    }

    # Validate heartbeat JSON shape.
    $hb = $null
    try { $hb = $hbContent | ConvertFrom-Json -ErrorAction Stop } catch {
        Write-Host "[FAIL] Heartbeat is not valid JSON: $($_.Exception.Message)"
        Write-Host "Raw content: $hbContent"
        $failed++
        continue
    }

    $missing = @()
    foreach ($field in @('pid', 'started_at', 'last_seen', 'version')) {
        if ($null -eq $hb.$field) { $missing += $field }
    }
    if ($missing.Count -gt 0) {
        Write-Host "[FAIL] Heartbeat missing fields: $($missing -join ', ')"
        Write-Host "Raw heartbeat: $hbContent"
        $failed++
        continue
    }

    # Sanity-check pid is a positive integer (would be 0 / null if $PID
    # assignment regressed).
    if ($hb.pid -le 0) {
        Write-Host "[FAIL] heartbeat.pid is $($hb.pid); expected a positive integer"
        $failed++
        continue
    }

    # Sanity-check timestamps are recent (within last 10s).
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $age = $now - [int64]$hb.last_seen
    if ($age -gt 10000 -or $age -lt -1000) {
        Write-Host "[FAIL] heartbeat.last_seen is $age ms off; expected within +/- 10s"
        $failed++
        continue
    }

    Write-Host "[OK]  heartbeat: pid=$($hb.pid) version=$($hb.version) age=${age}ms"
}

# Cleanup
if (Test-Path $queueDir) {
    try { Remove-Item $queueDir -Recurse -Force } catch { }
}

Write-Host ""
if ($failed -eq 0) {
    Write-Host "[PASS] Worker smoke test passed on all shells"
    exit 0
} else {
    Write-Host "[FAIL] $failed shell(s) failed worker smoke test"
    exit 1
}
