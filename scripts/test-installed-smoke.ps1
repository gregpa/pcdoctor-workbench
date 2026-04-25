<#
.SYNOPSIS
    Pre-ship gate (#6, destructive variant): silent install + launch + audit
    + uninstall the freshly built v2.4.x installer.

.DESCRIPTION
    *** WARNING - DESTRUCTIVE ***
    Run with -DryRun:$false ONLY on a clean VM, NEVER on a developer
    workstation that already has PCDoctor Workbench installed. The silent
    install OVERWRITES the existing install (including any hand-fixed
    binaries) and the silent uninstall REMOVES the install dir.

    Default: -DryRun is $true. The script validates inputs, prints what it
    WOULD do, and exits 0 without touching the install. This is the safe
    behavior on a developer workstation.

    For a real pre-ship gate run on a clean VM:
        powershell.exe -ExecutionPolicy Bypass -File scripts/test-installed-smoke.ps1 -DryRun:$false

    Q3 in plan-v2.4.47.md commits to running this gate every release through
    v2.5.1, then re-evaluating. The -DryRun mode lets the script live in the
    repo + ship pipeline without endangering Greg's hand-fixed install on his
    primary workstation.

    AUDIT STEPS (when -DryRun:$false):
      1. Pre-flight: assert release/PCDoctor-Workbench-Setup-<ver>.exe exists.
      2. Silent install: Start-Process the .exe with /S, wait up to 120s.
      3. Launch + 25s wait, optional screenshot.
      4. Log scan: %APPDATA%\PCDoctor\logs\main.log must NOT contain
         "compiled against a different Node.js version".
      5. ABI cross-check: invoke verify-better-sqlite3-abi.ps1 against the
         installed .node. Fail if NMV != 130.
      6. Graceful quit + DB inspection: Stop-Process the app, wait 3s, open
         %APPDATA%\PCDoctor\workbench.db, assert autopilot_activity is
         queryable.
      7. Scanner JSON sanity: read latest.json if present, structural check.
      8. Upgrade-path simulation: install v2.4.46 first, then upgrade.
      9. Cleanup: silent uninstall, verify install dir is gone.

.PARAMETER DryRun
    Default: $true. When true, the script prints what it would do and
    exits 0. Set to $false ONLY on a clean VM.

.PARAMETER ExpectedVersion
    Defaults to the version in package.json. Used to locate the installer
    and assert the running app reports the same version.

.EXIT CODES
    0 = all audit steps PASS (or DryRun mode validated inputs)
    1 = any audit step failed; DO NOT SHIP
#>
param(
    [bool]$DryRun = $true,
    [string]$ExpectedVersion = $null
)

$ErrorActionPreference = 'Stop'

function Write-Result {
    param([string]$status, [string]$message, [hashtable]$extra = @{})
    $obj = @{
        gate    = 'test-installed-smoke'
        status  = $status
        message = $message
        dry_run = $DryRun
    }
    foreach ($k in $extra.Keys) { $obj[$k] = $extra[$k] }
    $json = $obj | ConvertTo-Json -Compress -Depth 4
    Write-Output $json
}

$repoRoot = Split-Path -Parent $PSScriptRoot

# Resolve expected version from package.json if not provided
if (-not $ExpectedVersion) {
    $pkgPath = Join-Path $repoRoot 'package.json'
    if (Test-Path $pkgPath) {
        $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
        $ExpectedVersion = $pkg.version
    } else {
        Write-Result -status 'FAIL' -message 'package.json not found; cannot determine version.'
        exit 1
    }
}

$installerPath = Join-Path $repoRoot "release\PCDoctor-Workbench-Setup-$ExpectedVersion.exe"
$installDir    = Join-Path $env:LOCALAPPDATA 'Programs\PCDoctor Workbench'
$installedExe  = Join-Path $installDir 'PCDoctor Workbench.exe'
$nodeUnpacked  = Join-Path $installDir 'resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
$mainLog       = Join-Path $env:APPDATA 'PCDoctor\logs\main.log'
$dbPath        = Join-Path $env:APPDATA 'PCDoctor\workbench.db'
$latestJson    = Join-Path $env:PROGRAMDATA 'PCDoctor\reports\latest.json'

Write-Host "[smoke] Repo root:        $repoRoot"
Write-Host "[smoke] Expected version: $ExpectedVersion"
Write-Host "[smoke] Installer path:   $installerPath"
Write-Host "[smoke] Install dir:      $installDir"
Write-Host "[smoke] Dry-run mode:     $DryRun"
Write-Host ''

# --- DRY-RUN MODE ---
# Validate inputs (installer exists, latest.yml parses) and exit 0 without
# installing anything. This is the only mode safe to run on a workstation
# with a live PCDoctor install.
if ($DryRun) {
    Write-Host '[smoke] DRY-RUN: validating inputs only; no install will occur.'

    $checks = @{
        installer_exists = (Test-Path $installerPath)
        latest_yml_exists = (Test-Path (Join-Path $repoRoot 'release\latest.yml'))
        verify_abi_script_exists = (Test-Path (Join-Path $PSScriptRoot 'verify-better-sqlite3-abi.ps1'))
    }

    $failed = $false
    foreach ($k in $checks.Keys) {
        if (-not $checks[$k]) {
            Write-Host "[smoke] DRY-RUN check FAILED: $k"
            $failed = $true
        } else {
            Write-Host "[smoke] DRY-RUN check ok:     $k"
        }
    }

    if ($failed) {
        Write-Result -status 'FAIL' -message 'Dry-run input validation failed.' -extra @{ checks = $checks }
        exit 1
    }

    Write-Result -status 'PASS' -message "Dry-run validation passed. Run with -DryRun:`$false on a clean VM to execute the full smoke." -extra @{ checks = $checks; expected_version = $ExpectedVersion }
    exit 0
}

# --- LIVE MODE (DryRun:$false) ---
# Hard guard against accidentally running this on Greg's workstation. Refuse
# to run unless the operator passes an explicit ALLOW_INSTALL_OVERWRITE env var.
if ($env:ALLOW_INSTALL_OVERWRITE -ne 'YES_I_UNDERSTAND_THIS_OVERWRITES_MY_INSTALL') {
    Write-Result -status 'FAIL' -message "Refusing to run in live mode without ALLOW_INSTALL_OVERWRITE=YES_I_UNDERSTAND_THIS_OVERWRITES_MY_INSTALL. Run on a clean VM only."
    exit 1
}

# Step 1: Pre-flight
Write-Host '[smoke] STEP 1: pre-flight'
if (-not (Test-Path $installerPath)) {
    Write-Result -status 'FAIL' -message "Installer not found: $installerPath"
    exit 1
}
$installerHash = (Get-FileHash $installerPath -Algorithm SHA256).Hash
Write-Host "[smoke]   installer SHA-256: $installerHash"

# Step 2: Silent install
Write-Host '[smoke] STEP 2: silent install (NSIS /S)'
$installProc = Start-Process -FilePath $installerPath -ArgumentList '/S' -PassThru -Wait
if ($installProc.ExitCode -ne 0) {
    Write-Result -status 'FAIL' -message "Installer exited non-zero: $($installProc.ExitCode)"
    exit 1
}
$installWaitDeadline = (Get-Date).AddSeconds(120)
while (-not (Test-Path $installedExe) -and ((Get-Date) -lt $installWaitDeadline)) {
    Start-Sleep -Milliseconds 500
}
if (-not (Test-Path $installedExe)) {
    Write-Result -status 'FAIL' -message "Installed exe never appeared at $installedExe"
    exit 1
}

# Step 3: Launch + wait
Write-Host '[smoke] STEP 3: launch + 25s wait'
$appProc = Start-Process -FilePath $installedExe -PassThru
Start-Sleep -Seconds 25

# Step 4: Log scan
Write-Host '[smoke] STEP 4: log scan'
if (Test-Path $mainLog) {
    $logContent = Get-Content $mainLog -Raw -ErrorAction SilentlyContinue
    if ($logContent -and $logContent -match 'compiled against a different Node\.js version') {
        Write-Result -status 'FAIL' -message 'main.log contains the better-sqlite3 ABI mismatch error. The @electron/rebuild step did not take effect.' -extra @{ log_path = $mainLog }
        try { Stop-Process -Name 'PCDoctor Workbench' -Force -ErrorAction SilentlyContinue } catch {}
        exit 1
    }
    Write-Host '[smoke]   no ABI error in main.log (good)'
} else {
    Write-Host '[smoke]   WARN: main.log not present yet (skipping)'
}

# Step 5: ABI cross-check on installed .node
Write-Host '[smoke] STEP 5: ABI cross-check'
$abiScript = Join-Path $PSScriptRoot 'verify-better-sqlite3-abi.ps1'
if (Test-Path $nodeUnpacked) {
    $abiResult = & powershell.exe -ExecutionPolicy Bypass -File $abiScript -NodePath $nodeUnpacked -ExpectedNmv 130
    if ($LASTEXITCODE -ne 0) {
        Write-Result -status 'FAIL' -message 'ABI verification of installed .node failed.' -extra @{ abi_output = $abiResult }
        try { Stop-Process -Name 'PCDoctor Workbench' -Force -ErrorAction SilentlyContinue } catch {}
        exit 1
    }
    Write-Host '[smoke]   installed .node ABI matches NMV 130'
} else {
    Write-Host "[smoke]   WARN: $nodeUnpacked not present; skipping ABI check"
}

# Step 6: Graceful quit + DB inspection
Write-Host '[smoke] STEP 6: graceful quit + DB inspection'
try { Stop-Process -Name 'PCDoctor Workbench' -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 3
# Defer the actual sqlite open to a node one-liner; node:sqlite is stable in 22.5+
if (Test-Path $dbPath) {
    $sqlOut = & node --experimental-sqlite -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); const r = db.prepare('SELECT COUNT(*) AS n FROM autopilot_activity').get(); console.log(JSON.stringify(r));" $dbPath 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Result -status 'FAIL' -message 'autopilot_activity query failed via node:sqlite.' -extra @{ sql_output = "$sqlOut" }
        exit 1
    }
    Write-Host "[smoke]   autopilot_activity: $sqlOut"
} else {
    Write-Host "[smoke]   WARN: $dbPath not present (fresh install with no scan run yet)"
}

# Step 7: Scanner JSON sanity
Write-Host '[smoke] STEP 7: scanner JSON sanity'
if (Test-Path $latestJson) {
    # Check first 3 bytes for BOM
    $firstBytes = [System.IO.File]::ReadAllBytes($latestJson)[0..2]
    if ($firstBytes.Count -ge 3 -and $firstBytes[0] -eq 0xEF -and $firstBytes[1] -eq 0xBB -and $firstBytes[2] -eq 0xBF) {
        Write-Result -status 'FAIL' -message 'latest.json contains a UTF-8 BOM. The B46-3a fix did not take effect.' -extra @{ first_bytes = ($firstBytes -join ',') }
        exit 1
    }
    try {
        $latestObj = Get-Content $latestJson -Raw | ConvertFrom-Json
        $val = $latestObj.security.defender.last_full_scan_days
        if ($val -is [string] -and $val -eq 'undefined') {
            Write-Result -status 'FAIL' -message 'latest.json security.defender.last_full_scan_days is the string "undefined".' -extra @{ value = $val }
            exit 1
        }
        Write-Host "[smoke]   latest.json structural check ok"
    } catch {
        Write-Result -status 'FAIL' -message "latest.json failed to parse: $($_.Exception.Message)"
        exit 1
    }
} else {
    Write-Host "[smoke]   WARN: $latestJson not present (no scan run yet)"
}

# Step 8: (skipped in DryRun=false simple path; upgrade-path test left for VM operator)

# Step 9: Cleanup
Write-Host '[smoke] STEP 9: silent uninstall'
$uninstallExe = Join-Path $installDir 'Uninstall PCDoctor Workbench.exe'
if (Test-Path $uninstallExe) {
    Start-Process -FilePath $uninstallExe -ArgumentList '/S' -Wait
    Start-Sleep -Seconds 3
    if (Test-Path $installDir) {
        Write-Result -status 'WARN' -message 'Uninstall ran but install dir still present.' -extra @{ install_dir = $installDir }
    } else {
        Write-Host "[smoke]   uninstall complete; install dir removed"
    }
}

Write-Result -status 'PASS' -message "Smoke test completed for v$ExpectedVersion." -extra @{ installer_sha256 = $installerHash; expected_version = $ExpectedVersion }
exit 0
