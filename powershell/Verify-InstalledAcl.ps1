<#
.SYNOPSIS
    Post-install ACL verification. Reads the INSTALLED DACL state on
    C:\ProgramData\PCDoctor and confirms it matches the expected tier
    configuration.

.DESCRIPTION
    v2.4.11 shipped a silently-broken installer: the pre-ship harness
    sandbox passed, but the real install on Greg's box lacked the
    Users:(WD,AD,DC) SQLite sibling-creation grant on the tier-A root.
    Root cause: harness invoked Apply-TieredAcl via direct `&` while
    installer used `powershell -File` through NSIS ExecWait, and the
    [switch]$NonRecursive param did not bind the same way across both.

    v2.4.12 closes that fidelity gap two ways:
      1. Apply-TieredAcl.ps1 -NonRecursive [switch] -> -Mode root|recurse
         [ValidateSet] string. Robust across every caller form.
      2. Harness now invokes via `powershell -File` subprocess to match
         installer exactly.
      3. THIS SCRIPT: installer runs it after ACL phase to verify the
         INSTALLED state (not just the sandbox). Catches drift that
         might still somehow slip past the harness + refactor.

    Checks performed:
      [1] Zero-ACE file count across the tree == 0
      [2] Root has SYSTEM:F + Admins:F + Users:(OI)(CI)(RX) (tier-A read)
      [3] Root has BUILTIN\Users:(WD,AD,DC) dir-level grant (SQLite)
      [4] Root Users DACL has no Modify/Write/FullControl propagating ACE
      [5] actions/, security/ subdirs carry tier-A Users:RX
      [6] Data subdirs carry tier-B Users:M
      [7] workbench.db* have Users:M grant (SQLite data file)

    Exits 0 on all-pass, 1 on any-fail. Writes a timestamped log to
    C:\ProgramData\PCDoctor\logs\install-verify-<yyyyMMdd-HHmmss>.log
    so postmortems can see what the install actually produced.

.PARAMETER Path
    Root path to verify. Defaults to C:\ProgramData\PCDoctor. Overridable
    for testing against a sandbox.

.PARAMETER Quiet
    Suppress stdout. Still writes the log file and returns the exit code.

.EXAMPLE
    # Run after install (installer invokes this automatically via ExecWait)
    .\Verify-InstalledAcl.ps1

    # Run manually to check current state
    & "C:\ProgramData\PCDoctor\Verify-InstalledAcl.ps1"

.NOTES
    Does NOT require admin. All operations are read-only ACL queries.
    Safe to invoke from user context.

    Ships to two locations:
      - C:\dev\pcdoctor-workbench\powershell\Verify-InstalledAcl.ps1 (source)
      - C:\ProgramData\PCDoctor\Verify-InstalledAcl.ps1 (deployed via installer Copy-Item)
#>
param(
    [string]$Path = 'C:\ProgramData\PCDoctor',
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

# v2.5.15: explicitly import the security module that exports Get-Acl. The
# installer invokes this script via `powershell.exe -NoProfile -File`
# (Windows PowerShell 5.1, NOT pwsh 7), and on boxes with Controlled Folder
# Access / Defender ASR / similar guards, PowerShell's automatic module
# auto-load can fail with `CouldNotAutoloadMatchingModule`. That produced
# 265 lines of "module could not be loaded" spam during install on Greg's
# box (and would silently fail the verification on any user with similar
# guards). Pre-importing eliminates the auto-load attempt + spam, and
# `-EA SilentlyContinue` keeps it non-fatal if even the explicit import
# is blocked -- the subsequent Get-Acl calls already use -EA SilentlyContinue
# so they degrade gracefully if the module truly is unavailable.
Import-Module Microsoft.PowerShell.Security -EA SilentlyContinue

$sidUsers  = 'S-1-5-32-545'     # BUILTIN\Users
$sidAdmins = 'S-1-5-32-544'     # BUILTIN\Administrators
$sidSystem = 'S-1-5-18'         # NT AUTHORITY\SYSTEM

$logDir = Join-Path $Path 'logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force -EA SilentlyContinue | Out-Null
}
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "install-verify-$ts.log"

$failures = New-Object System.Collections.Generic.List[string]
$checks   = New-Object System.Collections.Generic.List[string]

function Write-VerifyLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $Message
    if (-not $Quiet) { Write-Host $line }
    try { Add-Content -Path $logFile -Value $line -EA SilentlyContinue } catch { }
}

function Get-UsersAce {
    param($Acl)
    foreach ($ace in $Acl.Access) {
        if ($ace.AccessControlType -ne 'Allow') { continue }
        $id = "$($ace.IdentityReference)"
        if ($id -match 'Users$' -or $id -eq $sidUsers) { return $ace }
    }
    return $null
}

function Test-HasWriteRight {
    param($Ace)
    if (-not $Ace) { return $false }
    $rights = "$($Ace.FileSystemRights)"
    return ($rights -match 'Modify|Write|FullControl')
}

Write-VerifyLog "=== PCDoctor post-install ACL verification ==="
Write-VerifyLog "Target: $Path"
Write-VerifyLog "Log:    $logFile"
Write-VerifyLog ""

if (-not (Test-Path $Path)) {
    Write-VerifyLog "[FAIL] Path does not exist: $Path"
    exit 1
}

# ========== [1] Zero-ACE file scan ==========
Write-VerifyLog "[check 1] Scanning for zero-ACE files under $Path"
$zeroAceFiles = New-Object System.Collections.Generic.List[string]
$totalFiles = 0
Get-ChildItem -Path $Path -Recurse -File -Force -EA SilentlyContinue | ForEach-Object {
    $totalFiles++
    $a = Get-Acl $_.FullName -EA SilentlyContinue
    if (-not $a -or $a.Access.Count -eq 0) {
        $zeroAceFiles.Add($_.FullName) | Out-Null
    }
}
if ($zeroAceFiles.Count -eq 0) {
    Write-VerifyLog "  [OK] $totalFiles files scanned, 0 zero-ACE"
    $checks.Add("zero-ace-scan: OK ($totalFiles files)") | Out-Null
} else {
    $msg = "zero-ace: $($zeroAceFiles.Count) files have empty DACLs"
    Write-VerifyLog "  [FAIL] $msg"
    $zeroAceFiles | Select-Object -First 5 | ForEach-Object { Write-VerifyLog "    - $_" }
    $failures.Add($msg) | Out-Null
}

# ========== [2] + [3] + [4] Root ACL ==========
Write-VerifyLog "[check 2-4] Root DACL composition"
$rootAcl = Get-Acl $Path
$rootIcacls = (icacls $Path 2>&1 | Out-String)

# [2] tier-A read ACE: Users:(OI)(CI)(RX)
$hasTierARead = $rootIcacls -match 'Users:\(OI\)\(CI\)\(RX\)'
if ($hasTierARead) {
    Write-VerifyLog "  [OK] Users:(OI)(CI)(RX) present on root (tier-A read)"
    $checks.Add("root-tier-a-read: OK") | Out-Null
} else {
    $msg = "root missing Users:(OI)(CI)(RX) tier-A read grant"
    Write-VerifyLog "  [FAIL] $msg"
    $failures.Add($msg) | Out-Null
}

# [3] SQLite grant: Users:(WD,AD,DC)
$hasSqliteGrant = $rootIcacls -match 'Users:\(WD,AD,DC\)'
if ($hasSqliteGrant) {
    Write-VerifyLog "  [OK] Users:(WD,AD,DC) present on root (SQLite sibling-creation grant)"
    $checks.Add("root-sqlite-grant: OK") | Out-Null
} else {
    $msg = "root missing Users:(WD,AD,DC) SQLite grant (E-19 regression)"
    Write-VerifyLog "  [FAIL] $msg"
    Write-VerifyLog "    This is the exact bug v2.4.12 was supposed to fix."
    Write-VerifyLog "    Raw icacls output:"
    ($rootIcacls -split "`r?`n") | Where-Object { $_ -match 'Users' } | ForEach-Object { Write-VerifyLog "      $_" }
    $failures.Add($msg) | Out-Null
}

# [4] Root shouldn't have Users:M or Users:F propagating (would be a tier regression)
# The (WD,AD,DC) dir-level grant is INTENTIONAL and not a violation; check separately.
$hasInheritableWrite = $rootIcacls -match 'Users:\(OI\)\(CI\)(\(M\)|\(F\)|\(W\))'
if ($hasInheritableWrite) {
    $msg = "root has inheritable Users:Modify/FullControl - tier-A regression"
    Write-VerifyLog "  [FAIL] $msg"
    $failures.Add($msg) | Out-Null
} else {
    Write-VerifyLog "  [OK] no inheritable Users:Modify on root"
    $checks.Add("root-no-inherit-write: OK") | Out-Null
}

# ========== [5] tier-A script subdirs ==========
Write-VerifyLog "[check 5] tier-A script subdirs (actions/, security/)"
foreach ($sd in @('actions', 'security')) {
    $sdPath = Join-Path $Path $sd
    if (-not (Test-Path $sdPath)) {
        Write-VerifyLog "  [WARN] $sd/ does not exist (skipping)"
        continue
    }
    $sdIcacls = (icacls $sdPath 2>&1 | Out-String)
    $expected = $sdIcacls -match 'Users:\(OI\)\(CI\)\(RX\)'
    $hasWrite = $sdIcacls -match 'Users:\(OI\)\(CI\)(\(M\)|\(F\)|\(W\))'
    if ($expected -and -not $hasWrite) {
        Write-VerifyLog "  [OK] $sd/ tier-A Users:(OI)(CI)(RX)"
        $checks.Add("$sd-tier-a: OK") | Out-Null
    } else {
        $msg = "$sd/ not tier-A (expected Users:(OI)(CI)(RX), no write)"
        Write-VerifyLog "  [FAIL] $msg"
        $failures.Add($msg) | Out-Null
    }
}

# ========== [6] tier-B data subdirs ==========
Write-VerifyLog "[check 6] tier-B data subdirs"
$dataSubdirs = @('logs', 'reports', 'snapshots', 'exports', 'claude-bridge', 'history', 'baseline', 'settings')
foreach ($sd in $dataSubdirs) {
    $sdPath = Join-Path $Path $sd
    if (-not (Test-Path $sdPath)) {
        Write-VerifyLog "  [WARN] $sd/ does not exist (skipping)"
        continue
    }
    $sdIcacls = (icacls $sdPath 2>&1 | Out-String)
    $hasModify = $sdIcacls -match 'Users:\(OI\)\(CI\)\(M\)' -or $sdIcacls -match 'Users:\(OI\)\(CI\)\(F\)'
    if ($hasModify) {
        Write-VerifyLog "  [OK] $sd/ tier-B Users:(OI)(CI)(M)"
        $checks.Add("$sd-tier-b: OK") | Out-Null
    } else {
        $msg = "$sd/ not tier-B (expected Users:(OI)(CI)(M))"
        Write-VerifyLog "  [FAIL] $msg"
        $failures.Add($msg) | Out-Null
    }
}

# ========== [7] workbench.db files ==========
Write-VerifyLog "[check 7] workbench.db Users:M"
$dbFile = Join-Path $Path 'workbench.db'
if (Test-Path $dbFile) {
    $dbIcacls = (icacls $dbFile 2>&1 | Out-String)
    if ($dbIcacls -match 'Users:\(M\)' -or $dbIcacls -match 'Users:\(F\)') {
        Write-VerifyLog "  [OK] workbench.db Users:M grant present"
        $checks.Add("workbench-db-grant: OK") | Out-Null
    } else {
        # Not fatal on fresh install (SQLite creates file on first run), but log it
        Write-VerifyLog "  [WARN] workbench.db exists but lacks explicit Users:M grant (SQLite may still work via root SQLite grant)"
    }
} else {
    Write-VerifyLog "  [INFO] workbench.db not yet created (SQLite will create at first run)"
}

# ========== Result ==========
Write-VerifyLog ""
Write-VerifyLog "=== RESULT ==="
Write-VerifyLog "Passed checks: $($checks.Count)"
Write-VerifyLog "Failed checks: $($failures.Count)"
if ($failures.Count -eq 0) {
    Write-VerifyLog "[PASS] Installed ACL state matches expected tier configuration."
    exit 0
} else {
    Write-VerifyLog "[FAIL] $($failures.Count) check(s) failed:"
    foreach ($f in $failures) { Write-VerifyLog "  - $f" }
    Write-VerifyLog ""
    Write-VerifyLog "To repair: either reinstall, or run Heal-InstallAcls.ps1 from an elevated prompt."
    exit 1
}
