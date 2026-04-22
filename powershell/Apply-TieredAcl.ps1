<#
.SYNOPSIS
    Apply a deterministic tier-A or tier-B ACL to a directory subtree.

.DESCRIPTION
    Both the installer (via NSIS ExecWait) and the pre-ship test harness
    call this script. Sharing the ACL logic between them guarantees they
    cannot drift.

    WHY THIS EXISTS:
    v2.4.6, v2.4.7, v2.4.8 all shipped broken installers because the
    `icacls <root> /inheritance:r /grant:r "SID:(OI)(CI)PERM" /T` pattern
    fails silently on FILE children: the (OI)(CI) inheritance flags are
    directory-only, so `/grant:r` rejects the ACE on files, while
    `/inheritance:r` still succeeds at stripping inherited ACEs. End
    state: files with zero ACEs tree-wide.

    THIS script fixes that by enumerating directories and files separately
    and applying the right flags to each:
      - DIRECTORIES get (OI)(CI) inheritance flags so the ACE propagates
        to their children.
      - FILES get the same permissions WITHOUT (OI)(CI) - the flags are
        meaningless on leaf nodes anyway.

    The result is deterministic and reproducible: every file and folder
    in the target tree ends with a non-empty DACL with exactly the three
    ACEs (SYSTEM:F, Admins:F, Users:<RX|M>).

.PARAMETER Path
    Root of the subtree to lock down.

.PARAMETER Tier
    'A' = script-only (Users:RX, read-only) - used for root, actions/, security/
    'B' = data (Users:M, writable) - used for logs/, reports/, snapshots/, etc.

.PARAMETER Mode
    'recurse' (default): fully recursive - tier applied to this dir + all
        subdirs + all files underneath.
    'root': applies tier to the target directory + its IMMEDIATE files only,
        and ALSO adds the tier-A SQLite sibling-creation grant on the dir
        object. Does NOT descend into subdirectories. Use this for the top
        container (C:\ProgramData\PCDoctor) where the subdirs each get their
        own invocation with their own tier.

.EXAMPLE
    Apply-TieredAcl.ps1 -Path "C:\ProgramData\PCDoctor\actions" -Tier A
    # Locks actions/ + all children to Users:RX (default Mode=recurse)

    Apply-TieredAcl.ps1 -Path "C:\ProgramData\PCDoctor\reports" -Tier B
    # Locks reports/ + all children to tier-B (SYSTEM:F, Admins:F, Users:M)

    Apply-TieredAcl.ps1 -Path "C:\ProgramData\PCDoctor" -Tier A -Mode root
    # Locks root dir + root-level files only; adds SQLite grant. Subdirs get
    # their own calls.

.NOTES
    Requires elevated context (caller is responsible for admin privilege).

    WHY -Mode IS A STRING, NOT A [switch]:
    v2.4.11's installer shipped with a [switch]$NonRecursive param. The
    pre-ship harness (invoking via PowerShell `& $script -NonRecursive`)
    saw the switch bind and the SQLite grant applied. The real installer
    (invoking via NSIS `ExecWait 'powershell.exe -File ... -NonRecursive'`)
    did NOT apply the grant on Greg's box - the installed C:\ProgramData\
    PCDoctor root lacked Users:(WD,AD,DC) after a clean install. Required a
    manual icacls hotfix.

    Exact NSIS-side mechanism was never reproduced in isolation, but the
    fix closes two independent holes regardless:

      1. String param with ValidateSet is unambiguous across every
         invocation form (direct `&`, subprocess `-File`, NSIS ExecWait,
         Start-Process -ArgumentList). A [switch] requires the caller to
         emit the literal token with no value; misquoting by any
         intermediate tokenizer drops the switch silently.
      2. The harness now invokes Apply-TieredAcl via the same
         `powershell -File` subprocess form the installer uses, so drift
         between test and ship is impossible by construction (E-19).
#>
param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][ValidateSet('A','B')][string]$Tier,
    [ValidateSet('root','recurse')][string]$Mode = 'recurse'
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path $Path)) {
    Write-Error "Path does not exist: $Path"
    exit 1
}

# Tier-A = Users:RX. Tier-B = Users:M. SYSTEM and Admins always F (Full).
$usersPerm = if ($Tier -eq 'A') { 'RX' } else { 'M' }
$sidSystem = '*S-1-5-18'
$sidAdmins = '*S-1-5-32-544'
$sidUsers  = '*S-1-5-32-545'

# Module-scope flag tracking whether ANY icacls call in this invocation
# returned a non-zero exit code. Consumed by the final `exit` at the
# bottom of this script so the caller (installer / harness) can detect
# silent-but-partial failures. Initialised to $false; set to $true by
# Invoke-IcaclsChecked on any non-zero exit.
$script:anyFailed = $false

<#
.SYNOPSIS
    Wrap an icacls call so non-zero exit codes surface as warnings.

.DESCRIPTION
    Prior to v2.4.10 the icacls invocations were piped `2>&1 | Out-Null`
    which swallowed BOTH the error output AND the exit signal - a failed
    grant looked identical to a successful one. Debugging was blind.

    This wrapper runs icacls with splat, checks $LASTEXITCODE, emits a
    Write-Warning with the captured output on failure, and flips the
    module-scope $script:anyFailed flag.

.PARAMETER Description
    Human-readable label for the operation (e.g. "root dir C:\...").
    Included in the warning so a user reading the log can tell which
    step failed without cross-referencing line numbers.

.PARAMETER IcaclsArgs
    All positional args to icacls, including the target path as the
    first element. Passed via PowerShell splat (@IcaclsArgs).

    CRITICAL: do not rename this to $Args. $Args is a PowerShell
    automatic variable; binding to it as a parameter causes args to
    bind unreliably and icacls prints its usage help instead of running.
    v2.4.10 harness caught this via stdout usage dump.

.EXAMPLE
    Invoke-IcaclsChecked -Description "actions subdir" -IcaclsArgs @(
        'C:\ProgramData\PCDoctor\actions',
        '/inheritance:r',
        '/grant:r', '*S-1-5-32-544:(OI)(CI)F',
        '/T', '/C', '/Q'
    )
#>
function Invoke-IcaclsChecked {
    param(
        [Parameter(Mandatory=$true)][string]$Description,
        [Parameter(Mandatory=$true)][string[]]$IcaclsArgs
    )
    $out = & icacls @IcaclsArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $script:anyFailed = $true
        Write-Warning "icacls failed ($Description): $out"
    }
}

# Step 1: apply to the root directory itself with (OI)(CI) flags so new
# children inherit. Use /grant:r to replace any existing grants deterministically.
# /inheritance:r to strip inherited ACEs (security: don't inherit Users:M
# from ProgramData on script dirs).
Invoke-IcaclsChecked -Description "root dir $Path" -IcaclsArgs @(
    $Path,
    '/inheritance:r',
    '/grant:r', "$($sidSystem):(OI)(CI)F",
    '/grant:r', "$($sidAdmins):(OI)(CI)F",
    '/grant:r', "$($sidUsers):(OI)(CI)$usersPerm",
    '/C', '/Q'
)

# v2.4.11: on tier-A root ONLY, add dir-level WD+AD+DC grant for Users.
#
# Why: tier-A = Users:RX blocks users from modifying existing files
# (intentional - prevents "bring-your-own-elevator" malware swapping a
# script), but also blocks SQLite from creating `workbench.db-wal` and
# `workbench.db-shm` journal files at startup, breaking every IPC that
# touches workbench.db. Manifested on v2.4.10 install as "unable to
# open database file" on the Security page.
#
# Granular WD (write data = add file) + AD (append data = add subdir) +
# DC (delete child) without (OI)(CI) inheritance flags applies to the
# root directory object ONLY. Existing children keep their propagated
# (OI)(CI)RX from the previous grant - non-admin users still can't
# overwrite scripts. The hole is 'can create NEW files in root', which
# is what SQLite needs and is not a meaningful escalation path (any
# new file the user creates runs with their existing user token).
#
# Applied only on tier-A and only on Mode=root calls -
# script subdirs (actions/, security/) don't host a database and data
# subdirs (tier-B) already have Users:M which includes WD+AD+DC.
if ($Tier -eq 'A' -and $Mode -eq 'root') {
    Invoke-IcaclsChecked -Description "root dir SQLite sibling-creation grant" -IcaclsArgs @(
        $Path,
        '/grant', "$($sidUsers):(WD,AD,DC)",
        '/C', '/Q'
    )
}

if ($Mode -eq 'root') {
    # Root mode: lock the immediate FILES in this directory too,
    # but don't descend into subdirectories. This is used for the root
    # container - root-level .ps1 files and event-allowlist.json need
    # tier-A, but subdirectories (actions/, security/, data dirs) get
    # their own Apply-TieredAcl invocation with their own tier.
    Get-ChildItem -Path $Path -File -Force -EA SilentlyContinue | ForEach-Object {
        Invoke-IcaclsChecked -Description "root-level file $($_.Name)" -IcaclsArgs @(
            $_.FullName,
            '/inheritance:r',
            '/grant:r', "$($sidSystem):F",
            '/grant:r', "$($sidAdmins):F",
            '/grant:r', "$($sidUsers):$usersPerm",
            '/C', '/Q'
        )
    }
    exit ([int]$script:anyFailed)
}

# Step 2: apply to every subdirectory with (OI)(CI) flags (propagates to
# THEIR children). Each subdir gets its inheritance disabled explicitly so
# it doesn't drift from parent's policy.
Get-ChildItem -Path $Path -Recurse -Directory -Force -EA SilentlyContinue | ForEach-Object {
    Invoke-IcaclsChecked -Description "subdir $($_.FullName)" -IcaclsArgs @(
        $_.FullName,
        '/inheritance:r',
        '/grant:r', "$($sidSystem):(OI)(CI)F",
        '/grant:r', "$($sidAdmins):(OI)(CI)F",
        '/grant:r', "$($sidUsers):(OI)(CI)$usersPerm",
        '/C', '/Q'
    )
}

# Step 3: apply to every file WITHOUT (OI)(CI) flags. Inheritance flags
# are meaningless on files (they have no children) and `icacls /grant:r`
# REJECTS them for files, which is the bug that broke v2.4.6/7/8.
Get-ChildItem -Path $Path -Recurse -File -Force -EA SilentlyContinue | ForEach-Object {
    Invoke-IcaclsChecked -Description "file $($_.FullName)" -IcaclsArgs @(
        $_.FullName,
        '/inheritance:r',
        '/grant:r', "$($sidSystem):F",
        '/grant:r', "$($sidAdmins):F",
        '/grant:r', "$($sidUsers):$usersPerm",
        '/C', '/Q'
    )
}

# v2.4.10: propagate failure to caller. Previously always exit 0 which
# masked silent icacls errors. Harness / installer safety-net pick up
# the exit code; Repair-ScriptAcls.ps1 is the final net if anything
# slipped through.
exit ([int]$script:anyFailed)
