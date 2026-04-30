<#
.SYNOPSIS
    Pre-ship test: every sidecar file declared in $bundledSidecars (in
    Sync-ScriptsFromBundle.ps1) must exist as a real file under powershell/
    so bundle-sync has something to copy at runtime.

.DESCRIPTION
    v2.5.12 (B11) introduced an explicit allowlist of non-.ps1 sidecar
    files (event-allowlist.json today; future: rules.json, thresholds.json,
    etc.) that must be hash-compared and synced from the bundle to
    C:\ProgramData\PCDoctor\.

    Failure modes this gate catches:
      - Listed a file in $bundledSidecars but forgot to actually create
        the source file. Runtime: bundle-sync silently skips (Test-Path
        guard), file never deploys, scanner reads stale or missing config.
      - Renamed the source file but forgot to update $bundledSidecars.
        Runtime: same silent skip.
      - Source file is empty / zero-byte. Runtime: deploys empty config,
        scanner produces unexpected behavior depending on consumer.

    All three would have shipped silently in v2.5.11 if event-allowlist.json
    had been listed but missing. Static check; runs in <500ms.

    MANDATORY PRE-SHIP GATE: run alongside the existing 6 gates.

    USAGE:
        pwsh -File scripts\test-bundle-sync-coverage.ps1

    EXIT CODES:
        0 = all sidecars resolve to real non-empty source files
        1 = one or more sidecars are missing or empty in source
#>

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$syncScript = Join-Path $repoRoot 'powershell\Sync-ScriptsFromBundle.ps1'
$bundleDir = Join-Path $repoRoot 'powershell'

if (-not (Test-Path $syncScript)) {
    Write-Host "[FAIL] Sync-ScriptsFromBundle.ps1 not found at $syncScript" -ForegroundColor Red
    exit 1
}

# Extract the $bundledSidecars array literal from the source file. This
# parses the actual ship-text rather than re-declaring the list here, so
# the gate can't drift from what bundle-sync uses at runtime.
$src = Get-Content $syncScript -Raw
$pattern = '(?ms)\$bundledSidecars\s*=\s*@\(\s*(.+?)\s*\)'
if ($src -notmatch $pattern) {
    Write-Host "[FAIL] Could not locate `$bundledSidecars array in Sync-ScriptsFromBundle.ps1" -ForegroundColor Red
    exit 1
}
$arrayBody = $Matches[1]

# Pull single- OR double-quoted entries; ignore commented-out lines (#) and blanks.
# v2.5.15: previously matched only single-quoted entries, which was a latent
# coverage gap -- a future contributor using PowerShell double-quote string
# syntax would silently slip past this gate (gate would report 0 sidecars
# tracked instead of the real count). Match both quote styles.
$sidecars = @()
foreach ($line in ($arrayBody -split "`r?`n")) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    if ($trimmed -match "^'([^']+)'") {
        $sidecars += $Matches[1]
    } elseif ($trimmed -match '^"([^"]+)"') {
        $sidecars += $Matches[1]
    }
}

if ($sidecars.Count -eq 0) {
    # Empty sidecar list is valid -- means bundle-sync syncs only .ps1.
    # Pass quietly so this gate is a no-op when no sidecars are tracked.
    Write-Host "[PASS] No sidecars declared. Bundle-sync covers .ps1 only." -ForegroundColor Green
    exit 0
}

Write-Host '==================================================================='
Write-Host 'PCDoctor bundle-sync coverage test harness'
Write-Host '==================================================================='
Write-Host ''
Write-Host "Tracking $($sidecars.Count) sidecar file(s):"
foreach ($s in $sidecars) { Write-Host "  - $s" }
Write-Host ''

$failures = 0
foreach ($side in $sidecars) {
    $fullPath = Join-Path $bundleDir $side
    if (-not (Test-Path $fullPath)) {
        Write-Host "[FAIL] $side -- source file does not exist at $fullPath" -ForegroundColor Red
        $failures++
        continue
    }
    $size = (Get-Item $fullPath).Length
    if ($size -eq 0) {
        Write-Host "[FAIL] $side -- source file is empty (0 bytes)" -ForegroundColor Red
        $failures++
        continue
    }
    Write-Host "[PASS] $side -- $size bytes" -ForegroundColor Green
}

Write-Host ''
Write-Host '==================================================================='
if ($failures -gt 0) {
    Write-Host "[RESULT] $failures FAILED. DO NOT SHIP." -ForegroundColor Red
    exit 1
} else {
    Write-Host "[RESULT] All $($sidecars.Count) sidecar(s) resolve to real non-empty source files. Safe to ship." -ForegroundColor Green
    exit 0
}
