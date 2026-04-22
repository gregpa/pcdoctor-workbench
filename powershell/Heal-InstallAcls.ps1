<#
.SYNOPSIS
    Runtime ACL self-healer. Called by main.ts when startup detects ACL
    corruption on C:\ProgramData\PCDoctor\. Reapplies the installer's full
    ACL sequence via Apply-TieredAcl.ps1.

.DESCRIPTION
    Installs can go bad post-install for reasons outside our control:
    - Malware stripping ACLs
    - Manual icacls misuse
    - Windows Update side-effects
    - Third-party AV interference

    When main.ts detects the app can't read `reports/latest.json` (EPERM),
    it invokes this script elevated. Output is JSON for the caller to parse.

    This is a runtime belt-and-suspenders companion to:
    - `scripts/installer.nsh` (ships correct ACLs on install)
    - `scripts/test-installer-acl.ps1` (pre-ship gate)
    - `powershell/Apply-TieredAcl.ps1` (shared ACL logic)

.PARAMETER JsonOutput
    Emit compressed JSON on stdout (default behaviour). Kept for API parity
    with other PS scripts in the suite.

.EXAMPLE
    # Invoked from main.ts via runElevatedPowerShellScript
    Heal-InstallAcls.ps1 -JsonOutput

.NOTES
    Requires admin. Runs the same sequence as installer steps 2-7:
      takeown /r /d y
      icacls /reset /T
      Apply-TieredAcl -Tier A -Mode root     (root + root-level files + SQLite grant)
      Apply-TieredAcl -Tier A                (actions/, security/ - Mode defaults to recurse)
      Apply-TieredAcl -Tier B                (data subdirs)
      icacls workbench.db /grant Users:M
#>
param([switch]$JsonOutput)

$ErrorActionPreference = 'Continue'

trap {
    $e = @{ code='E_PS_UNHANDLED'; message=$_.Exception.Message } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$root = 'C:\ProgramData\PCDoctor'
$applyAcl = Join-Path $root 'Apply-TieredAcl.ps1'

# Prerequisite: Apply-TieredAcl must be deployed
if (-not (Test-Path $applyAcl)) {
    $e = @{ code='E_MISSING_HELPER'; message="Apply-TieredAcl.ps1 not found at $applyAcl - reinstall required" } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"
    exit 1
}

# Admin check
$currentId = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentId)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $e = @{ code='E_NOT_ADMIN'; message='Heal-InstallAcls.ps1 requires admin privileges' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"
    exit 1
}

# Step 1: take ownership (idempotent, survives prior corruption)
& takeown /f $root /r /d y 2>&1 | Out-Null

# Step 2: reset the tree to default inherited (clears explicit corruption)
& icacls $root /reset /T /C /Q 2>&1 | Out-Null

# Step 3: tier-A on root + root-level files (root mode, adds SQLite grant).
# v2.4.12: -Mode root replaces v2.4.11's -NonRecursive [switch] - see
# Apply-TieredAcl.ps1 notes for E-19 context.
& $applyAcl -Path $root -Tier A -Mode root

# Step 4: tier-A on script subdirectories
foreach ($sd in @('actions', 'security')) {
    $p = Join-Path $root $sd
    if (Test-Path $p) { & $applyAcl -Path $p -Tier A }
}

# Step 5: tier-B on data subdirectories
# v2.4.10: added `settings` - covers nasConfig.ts's `settings\nas.json`
# which would otherwise inherit tier-A (Users:RX) and block writes.
foreach ($sd in @('logs', 'reports', 'snapshots', 'exports', 'claude-bridge', 'history', 'baseline', 'settings')) {
    $p = Join-Path $root $sd
    if (Test-Path $p) { & $applyAcl -Path $p -Tier B }
}

# Step 6: workbench.db files (specific Users:M grant, no propagation)
foreach ($db in @('workbench.db', 'workbench.db-wal', 'workbench.db-shm')) {
    $p = Join-Path $root $db
    if (Test-Path $p) {
        & icacls $p /grant '*S-1-5-32-545:M' /C /Q 2>&1 | Out-Null
    }
}

# Verify: scan for any remaining zero-ACE files
$bad = 0
Get-ChildItem $root -Recurse -File -Force -EA SilentlyContinue | ForEach-Object {
    $a = Get-Acl $_.FullName -EA SilentlyContinue
    if (-not $a -or $a.Access.Count -eq 0) { $bad++ }
}

$sw.Stop()

$result = [ordered]@{
    success            = ($bad -eq 0)
    duration_ms        = $sw.ElapsedMilliseconds
    remaining_bad_acls = $bad
    message            = if ($bad -eq 0) {
        "ACL heal complete - 0 zero-ACE files remain"
    } else {
        "Partial heal - $bad files still have zero ACEs (manual investigation required)"
    }
}

if ($JsonOutput) { $result | ConvertTo-Json -Depth 3 -Compress } else { $result | ConvertTo-Json -Depth 3 }
exit ([int]($bad -gt 0))
