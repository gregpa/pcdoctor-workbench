<#
.SYNOPSIS
    Pre-ship test harness for the installer's ACL phase.

.DESCRIPTION
    Simulates the installer.nsh ACL sequence against a sandbox directory and
    verifies every file ends with a non-empty DACL. Run this BEFORE every
    rebuild. If ANY file ends zero-ACE, exits 1 and blocks ship.

    v2.4.6, v2.4.7, and v2.4.8 all shipped with broken installers because
    the ACL logic was only tested via mental dry-run. That pattern produced
    83, 14, and 787 zero-ACE files respectively on the real machine during
    upgrade install. This harness exists to prevent that class of bug.

    ROOT CAUSE DISCOVERED:
    `icacls <dir> /inheritance:r /grant:r "SID:(OI)(CI)PERM" /T` fails
    silently on FILE children: (OI)(CI) are directory-only inheritance
    flags, /grant:r rejects the ACE on files, while /inheritance:r still
    succeeds at stripping inherited ACEs. End state: zero-ACE files.

    FIX: call Apply-TieredAcl.ps1 which enumerates dirs and files
    separately, applying (OI)(CI) flags only to dirs.

    USAGE:
        .\scripts\test-installer-acl.ps1
        .\scripts\test-installer-acl.ps1 -Verbose

    EXIT CODES:
        0 = all files have healthy ACLs, safe to ship
        1 = one or more files zero-ACE, DO NOT SHIP
#>
param(
    [switch]$Verbose,
    [string]$Sandbox = $null
)

$ErrorActionPreference = 'Stop'

# Elevation check
$currentId = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentId)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[FAIL] This harness requires elevated PowerShell (takeown + icacls /inheritance:r need admin)." -ForegroundColor Red
    exit 1
}

$applyScript = Join-Path $PSScriptRoot "..\powershell\Apply-TieredAcl.ps1"
if (-not (Test-Path $applyScript)) {
    Write-Host "[FAIL] Apply-TieredAcl.ps1 not found at $applyScript" -ForegroundColor Red
    exit 1
}

if (-not $Sandbox) {
    $Sandbox = Join-Path $env:TEMP "pcdoctor-acl-sandbox-$(Get-Random)"
}

Write-Host "=== PCDoctor installer ACL test harness ==="
Write-Host "Sandbox: $Sandbox"

if (Test-Path $Sandbox) { Remove-Item $Sandbox -Recurse -Force }
New-Item -ItemType Directory -Path $Sandbox -Force | Out-Null

# ========== Phase 1: populate with realistic content ==========
Write-Host ""
Write-Host "[phase 1] Populating sandbox tree..."

$scriptSubdirs = @('actions', 'security')
$dataSubdirs = @('logs', 'reports', 'snapshots', 'exports', 'claude-bridge', 'history', 'baseline', 'settings')

# Root-level scripts
foreach ($i in 1..15) { Set-Content -Path "$Sandbox\Root-Script-$i.ps1" -Value "# test" -Force }
Set-Content -Path "$Sandbox\workbench.db" -Value "mock" -Force
Set-Content -Path "$Sandbox\event-allowlist.json" -Value "{}" -Force

foreach ($sd in $scriptSubdirs) {
    $full = Join-Path $Sandbox $sd
    New-Item -ItemType Directory -Path $full -Force | Out-Null
    $count = if ($sd -eq 'actions') { 64 } else { 14 }
    for ($i = 1; $i -le $count; $i++) {
        Set-Content -Path "$full\file-$i.ps1" -Value "# test" -Force
    }
}

foreach ($sd in $dataSubdirs) {
    $full = Join-Path $Sandbox $sd
    New-Item -ItemType Directory -Path $full -Force | Out-Null
    # Nested subdir to test multi-level tree
    New-Item -ItemType Directory -Path "$full\nested" -Force -EA SilentlyContinue | Out-Null
    for ($i = 1; $i -le 20; $i++) {
        Set-Content -Path "$full\file-$i.json" -Value "{}" -Force
    }
    Set-Content -Path "$full\nested\nested-file.json" -Value "{}" -Force
}

# Simulate prior-install corruption
Write-Host "[phase 1b] Simulating prior-install corruption (zero-ACE on ~15%)..."
$allFiles = Get-ChildItem $Sandbox -Recurse -File
$corruptCount = [int]($allFiles.Count * 0.15)
$corruptTargets = $allFiles | Get-Random -Count $corruptCount
foreach ($f in $corruptTargets) {
    & icacls $f.FullName /inheritance:r /C /Q 2>&1 | Out-Null
    # Remove any remaining explicit ACEs
    & icacls $f.FullName /remove:g "*S-1-5-32-545" /C /Q 2>&1 | Out-Null
    & icacls $f.FullName /remove:g "*S-1-5-18" /C /Q 2>&1 | Out-Null
    & icacls $f.FullName /remove:g "*S-1-5-32-544" /C /Q 2>&1 | Out-Null
}
Write-Host "[phase 1b] Corrupted $corruptCount files."

# ========== Phase 2: run the installer ACL sequence ==========
Write-Host ""
Write-Host "[phase 2] Running installer ACL sequence (via Apply-TieredAcl.ps1)..."

Write-Host "  [step 1] takeown /r /d y"
& takeown /f $Sandbox /r /d y 2>&1 | Out-Null

Write-Host "  [step 2] /reset /T (clear corruption)"
& icacls $Sandbox /reset /T /C /Q 2>&1 | Out-Null

Write-Host "  [step 3] tier-A on root (non-recursive — dir + immediate files)"
# Root container + root-level files. Apply-TieredAcl -Recursive:false covers both.
& $applyScript -Path $Sandbox -Tier A -NonRecursive

Write-Host "  [step 4] tier-A on script subdirs (recursive)"
foreach ($sd in $scriptSubdirs) {
    & $applyScript -Path (Join-Path $Sandbox $sd) -Tier A
}

Write-Host "  [step 5] tier-B on data subdirs (recursive)"
foreach ($sd in $dataSubdirs) {
    & $applyScript -Path (Join-Path $Sandbox $sd) -Tier B
}

Write-Host "  [step 6] workbench.db Users:M"
& icacls "$Sandbox\workbench.db" /grant "*S-1-5-32-545:M" /C /Q 2>&1 | Out-Null

# ========== Phase 3: verify every file has non-empty DACL ==========
Write-Host ""
Write-Host "[phase 3] Verifying ACLs..."

$checked = 0
$bad = @()          # Zero-ACE files
$wrongTier = @()    # Non-empty DACL but wrong permission tier
$tierAFiles = 0
$tierBFiles = 0
# v2.4.10: tier-correctness check. Prior version only rejected zero-ACE
# files — but if Apply-TieredAcl silently no-op'd (e.g. $Args automatic-
# variable clash issuing icacls with no args), files would retain their
# default inherited Users:M ACE from ProgramData. That passes a non-empty
# check while leaving script dirs with writable Users access — a security
# regression the harness would miss. Explicit tier verification closes it.
#
# Expected Users permission per tier:
#   Tier-A (root, actions/, security/):  Read + Execute only (no Write)
#   Tier-B (data subdirs):               Modify (Read + Write + Delete)
Get-ChildItem $Sandbox -Recurse -File -Force | ForEach-Object {
    $checked++
    $a = Get-Acl $_.FullName -EA SilentlyContinue
    if (-not $a -or $a.Access.Count -eq 0) {
        $bad += $_.FullName
        return
    }
    $rel = $_.FullName.Substring($Sandbox.Length + 1)
    $topDir = ($rel -split '\\')[0]
    $expectedTier = if ($dataSubdirs -contains $topDir) { 'B' } else { 'A' }

    # Find the Users ACE. BUILTIN\Users on English systems, or SID-matched.
    $usersAce = $a.Access | Where-Object {
        $_.IdentityReference.Value -match 'Users$' -or $_.IdentityReference.Value -eq 'S-1-5-32-545'
    } | Select-Object -First 1

    $rightsStr = "$($usersAce.FileSystemRights)"
    # Tier-A must have ReadAndExecute-class rights WITHOUT Write or Modify or FullControl.
    # Tier-B must have Modify (which includes Write).
    # workbench.db is a tier-A-neighbour root file but gets a specific Users:M
    # grant — whitelist it.
    $isWorkbenchDb = $rel -match '^(workbench\.db(-wal|-shm)?)$'
    $hasWriteAccess = $rightsStr -match 'Modify|Write|FullControl'

    if ($isWorkbenchDb) {
        # Expect Users:M specifically
        if (-not ($rightsStr -match 'Modify')) {
            $wrongTier += "$rel : expected Users:Modify (db file), got '$rightsStr'"
        }
    } elseif ($expectedTier -eq 'A') {
        if ($hasWriteAccess) {
            $wrongTier += "$rel : tier-A should be Users:RX (read-only), got '$rightsStr'"
        } else {
            $tierAFiles++
        }
    } else {
        # tier-B: must have Modify
        if (-not $hasWriteAccess) {
            $wrongTier += "$rel : tier-B should be Users:M (writable), got '$rightsStr'"
        } else {
            $tierBFiles++
        }
    }
    if ($Verbose) {
        Write-Host "  OK: $rel ($($a.Access.Count) ACEs, Users=$rightsStr)"
    }
}

# ========== Phase 4: functional check — SQLite sibling creation ==========
# v2.4.11: tier-A ACL correctness wasn't enough. The v2.4.10 installer passed
# all tier checks but broke SQLite because root directory was Users:RX (no
# add-file). workbench.db at root needs Users:(WD,AD,DC) on the PARENT dir
# so SQLite can create journal (.db-wal, .db-shm) siblings at startup.
#
# Simulate this: as the (non-admin) test-harness user, try to create a file
# in the sandbox root. If creation fails, tier-A is over-locked and a
# SQLite-using app will break at runtime.
#
# We can't drop admin to run this check, but we CAN compare the DACL's
# effective permissions for the Users group. Look for a Users ACE that
# grants CreateFiles (WriteData) on the directory.
Write-Host ""
Write-Host "[phase 4] Verifying tier-A root permits SQLite journal creation..."
$rootAcl = Get-Acl $Sandbox
$sqliteGrant = $false
foreach ($ace in $rootAcl.Access) {
    $isUsers = $ace.IdentityReference.Value -match 'Users$' -or $ace.IdentityReference.Value -eq 'S-1-5-32-545'
    if (-not $isUsers) { continue }
    if ($ace.AccessControlType -ne 'Allow') { continue }
    # FileSystemRights enum: CreateFiles = 2, AppendData = 4. SQLite needs
    # both (create .db-wal AND create .db-shm). Also needs DeleteSubdirectoriesAndFiles
    # to clean up journal on close.
    $rights = $ace.FileSystemRights.value__
    $hasCreate = ($rights -band 2) -ne 0     # CreateFiles / WriteData
    $hasAppend = ($rights -band 4) -ne 0     # AppendData
    if ($hasCreate -and $hasAppend) {
        $sqliteGrant = $true
        break
    }
}

Write-Host ""
Write-Host "=== RESULT ==="
Write-Host "Checked $checked files ($tierAFiles tier-A verified, $tierBFiles tier-B verified)."
Write-Host "SQLite sibling-creation grant on tier-A root: $(if ($sqliteGrant) { 'YES' } else { 'NO (app will fail with "unable to open database file")' })"
$anyFailure = ($bad.Count -gt 0) -or ($wrongTier.Count -gt 0) -or (-not $sqliteGrant)
if (-not $anyFailure) {
    Write-Host "[PASS] All files have healthy ACLs with correct tiers. Safe to ship." -ForegroundColor Green
    Remove-Item $Sandbox -Recurse -Force
    exit 0
}
if ($bad.Count -gt 0) {
    Write-Host "[FAIL] $($bad.Count) files have zero ACEs (unreadable)." -ForegroundColor Red
    $bad | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" }
}
if ($wrongTier.Count -gt 0) {
    Write-Host "[FAIL] $($wrongTier.Count) files have WRONG TIER (non-empty DACL but permissions mismatch):" -ForegroundColor Red
    $wrongTier | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    Write-Host "This typically means Apply-TieredAcl.ps1 silently no-op'd — check for"
    Write-Host "icacls help-text in the phase 2 output above, or add -Verbose."
}
if (-not $sqliteGrant) {
    Write-Host "[FAIL] Tier-A root lacks the SQLite sibling-creation grant." -ForegroundColor Red
    Write-Host "  SQLite cannot create workbench.db-wal / workbench.db-shm at runtime."
    Write-Host "  App will fail with 'unable to open database file' on first DB access."
    Write-Host "  Expected: Users:(WD,AD,DC) ACE on the root directory object."
    Write-Host "  Fix: Apply-TieredAcl.ps1 tier-A / NonRecursive branch must add this grant."
}
Write-Host ""
Write-Host "Sandbox preserved at: $Sandbox"
exit 1
