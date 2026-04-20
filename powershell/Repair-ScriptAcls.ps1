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
param([switch]$DryRun, [switch]$JsonOutput, [switch]$Elevated)
$ErrorActionPreference = 'Continue'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$root = 'C:\ProgramData\PCDoctor'
$repaired = @()
$stillBroken = @()
$unreadable = @()
$checked = 0

# Walk every file and look for the "no ACEs" pattern. Skip the DB files -
# they're allowed to have restricted ACLs.
$skipPatterns = @('\.db$', '\.db-wal$', '\.db-shm$', '\\logs\\', '\\snapshots\\', '\\history\\', '\\exports\\', '\\claude-bridge\\', '\\reports\\')

# We can enumerate names via [System.IO.Directory] even when Get-Acl would
# fail (user has list permission on the parent dir, just no permission on
# individual files). That lets us detect unreadable files the user can't
# Get-Acl.
$allFiles = @()
try {
    $allFiles = [System.IO.Directory]::EnumerateFiles($root, '*', [System.IO.SearchOption]::AllDirectories)
} catch {
    $allFiles = Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
}

foreach ($p in $allFiles) {
    $skipIt = $false
    foreach ($skip in $skipPatterns) { if ($p -match $skip) { $skipIt = $true; break } }
    if ($skipIt) { continue }
    $checked++
    try {
        $acl = Get-Acl -Path $p -ErrorAction Stop
        if ($acl.Access.Count -eq 0) {
            if ($DryRun) {
                $repaired += @{ path = $p; action = 'would_repair'; reason = 'no_aces' }
                continue
            }
            try {
                $acl.SetAccessRuleProtection($false, $true)
                Set-Acl -Path $p -AclObject $acl -ErrorAction Stop
                $repaired += @{ path = $p; action = 'inheritance_restored'; reason = 'no_aces' }
            } catch {
                $stillBroken += @{ path = $p; error = $_.Exception.Message }
            }
        }
    } catch {
        # Get-Acl failed = user can't even read the ACL. File is almost
        # certainly ACE-stripped. We can't fix it without elevation.
        $unreadable += $p
        if (-not $DryRun -and $Elevated) {
            # In elevated mode, icacls can restore inheritance without us
            # needing to Get-Acl first.
            $out = & icacls $p /inheritance:e 2>&1
            if ($LASTEXITCODE -eq 0) {
                $repaired += @{ path = $p; action = 'icacls_inheritance_enabled'; reason = 'unreadable' }
            } else {
                $stillBroken += @{ path = $p; error = ($out -join ' ') }
            }
        }
    }
}

$sw.Stop()
$needsElevation = ($unreadable.Count -gt 0 -and -not $Elevated)
@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    dry_run = [bool]$DryRun
    elevated = [bool]$Elevated
    checked = $checked
    repaired_count = $repaired.Count
    repaired = $repaired
    unreadable_count = $unreadable.Count
    unreadable_paths = $unreadable
    still_broken_count = $stillBroken.Count
    still_broken = $stillBroken
    needs_elevation = $needsElevation
    message = if ($repaired.Count -gt 0) {
        "Repaired $($repaired.Count) file(s); $($unreadable.Count) still unreadable"
    } elseif ($needsElevation) {
        "$($unreadable.Count) files have stripped ACLs; re-run this action with -Elevated to fix (requires admin)"
    } else {
        "All $checked files OK"
    }
} | ConvertTo-Json -Depth 5 -Compress
exit 0
