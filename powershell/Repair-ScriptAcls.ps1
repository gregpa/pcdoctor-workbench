<#
.SYNOPSIS
    Scan C:\ProgramData\PCDoctor\ for PS/JSON/MD files missing ACEs and
    restore inheritance. v2.3.13's icacls /inheritance:r + /grant:r /T
    occasionally left files with zero ACEs (observed on
    Enable-PUAProtection.ps1 + Enable-ControlledFolderAccess.ps1) -
    likely because Defender held the files open while icacls ran.
.NOTES
    Safe to run as user OR admin. As user, files owned by the user can be
    repaired. Files owned by Admins/SYSTEM require elevation for their
    ACL to be modified - those are flagged in the output so an elevated
    re-run can pick them up.
#>
param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Continue'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$root = 'C:\ProgramData\PCDoctor'
$repaired = @()
$stillBroken = @()
$checked = 0

# Walk every file and look for the "no ACEs" pattern. Skip the DB files -
# they're allowed to have restricted ACLs.
$skipPatterns = @('\.db$', '\.db-wal$', '\.db-shm$', '\\logs\\', '\\snapshots\\', '\\history\\', '\\exports\\', '\\claude-bridge\\', '\\reports\\')

Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    $p = $_.FullName
    foreach ($skip in $skipPatterns) { if ($p -match $skip) { return } }
    $checked++
    try {
        $acl = Get-Acl -Path $p -ErrorAction Stop
        # Count ACEs (both explicit + inherited).
        if ($acl.Access.Count -eq 0) {
            if ($DryRun) {
                $repaired += @{ path = $p; action = 'would_repair'; reason = 'no_aces' }
                return
            }
            try {
                # Re-enable inheritance; the parent dir has correct ACEs so
                # they'll flow down.
                $acl.SetAccessRuleProtection($false, $true)
                Set-Acl -Path $p -AclObject $acl -ErrorAction Stop
                $repaired += @{ path = $p; action = 'inheritance_restored'; reason = 'no_aces' }
            } catch {
                $stillBroken += @{ path = $p; error = $_.Exception.Message }
            }
        }
    } catch {
        # If Get-Acl itself fails, we don't have read access -> flag as still-broken.
        $stillBroken += @{ path = $p; error = $_.Exception.Message }
    }
}

$sw.Stop()
@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    dry_run = [bool]$DryRun
    checked = $checked
    repaired_count = $repaired.Count
    repaired = $repaired
    still_broken_count = $stillBroken.Count
    still_broken = $stillBroken
    message = if ($repaired.Count -gt 0) { "Repaired $($repaired.Count) file(s); $($stillBroken.Count) still broken" } else { "All $checked files OK" }
} | ConvertTo-Json -Depth 5 -Compress
exit 0
