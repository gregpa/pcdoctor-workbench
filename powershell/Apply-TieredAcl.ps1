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

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Path)) {
    Write-Error "Path does not exist: $Path"
    exit 1
}

# Tier-A = Users:RX. Tier-B = Users:M. SYSTEM and Admins always F (Full).
$usersPerm = if ($Tier -eq 'A') { 'RX' } else { 'M' }
$sidSystem = '*S-1-5-18'
$sidAdmins = '*S-1-5-32-544'
$sidUsers  = '*S-1-5-32-545'
$icaclsPath = Join-Path ([Environment]::GetFolderPath(
    [Environment+SpecialFolder]::System
)) 'icacls.exe'

if (-not [IO.File]::Exists($icaclsPath)) {
    Write-Error "Trusted icacls executable is missing: $icaclsPath"
    exit 1
}

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
    $out = & $icaclsPath @IcaclsArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $script:anyFailed = $true
        throw "icacls failed ($Description): $out"
    }
}

function Get-IdentitySidValue {
    param([Parameter(Mandatory = $true)]$IdentityReference)

    try {
        $identity = if ($IdentityReference -is [Security.Principal.IdentityReference]) {
            $IdentityReference
        } else {
            New-Object Security.Principal.NTAccount([string]$IdentityReference)
        }
        return $identity.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
        return [string]$IdentityReference
    }
}

function Assert-SafeTraversalDirectory {
    param([Parameter(Mandatory = $true)][string]$DirectoryPath)

    $item = Get-Item -LiteralPath $DirectoryPath -Force
    if (-not $item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "E_ACL_REPARSE: $DirectoryPath"
    }

    $acl = [IO.Directory]::GetAccessControl($DirectoryPath)
    $ownerSid = Get-IdentitySidValue -IdentityReference $acl.Owner
    if ($ownerSid -cne 'S-1-5-32-544' -or -not $acl.AreAccessRulesProtected) {
        throw "E_ACL_TRAVERSAL_UNTRUSTED: owner/DACL $DirectoryPath"
    }

    $seenFullControl = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $forbiddenUsersRights = [int64](2 -bor 4 -bor 16 -bor 64 -bor 256 -bor 65536 -bor 262144 -bor 524288)
    foreach ($ace in $acl.Access) {
        $sid = Get-IdentitySidValue -IdentityReference $ace.IdentityReference
        if ($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $sid -notin @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-32-545')) {
            throw "E_ACL_TRAVERSAL_UNTRUSTED: unexpected ACE $sid on $DirectoryPath"
        }

        $rights = [int64]$ace.FileSystemRights.value__
        if ($sid -eq 'S-1-5-32-545' -and ($rights -band $forbiddenUsersRights) -ne 0) {
            throw "E_ACL_TRAVERSAL_UNTRUSTED: writable Users ACE on $DirectoryPath"
        }
        if ($sid -in @('S-1-5-32-544', 'S-1-5-18') -and
            ($rights -band [int64][Security.AccessControl.FileSystemRights]::FullControl) -eq
            [int64][Security.AccessControl.FileSystemRights]::FullControl) {
            [void]$seenFullControl.Add($sid)
        }
    }

    if (-not $seenFullControl.Contains('S-1-5-32-544') -or
        -not $seenFullControl.Contains('S-1-5-18')) {
        throw "E_ACL_TRAVERSAL_UNTRUSTED: missing privileged ACE on $DirectoryPath"
    }
}

function Assert-OrdinaryFile {
    param([Parameter(Mandatory = $true)][string]$FilePath)

    $item = Get-Item -LiteralPath $FilePath -Force
    if ($item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "E_ACL_REPARSE: $FilePath"
    }
}

function Set-PCDoctorFileAcl {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][ValidateSet('RX','M')][string]$UsersPermission
    )

    Assert-OrdinaryFile -FilePath $FilePath
    Invoke-IcaclsChecked -Description "file $FilePath" -IcaclsArgs @(
        $FilePath,
        '/inheritance:r',
        '/grant:r', "${sidSystem}:F",
        '/grant:r', "${sidAdmins}:F",
        '/grant:r', "${sidUsers}:${UsersPermission}",
        '/C', '/Q'
    )
}

function Set-PCDoctorDirectoryAcl {
    param([Parameter(Mandatory = $true)][string]$DirectoryPath)

    $item = Get-Item -LiteralPath $DirectoryPath -Force
    if (-not $item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "E_ACL_REPARSE: $DirectoryPath"
    }
    Invoke-IcaclsChecked -Description "directory $DirectoryPath" -IcaclsArgs @(
        $DirectoryPath,
        '/inheritance:r',
        '/grant:r', "${sidSystem}:(OI)(CI)F",
        '/grant:r', "${sidAdmins}:(OI)(CI)F",
        '/grant:r', "${sidUsers}:(OI)(CI)${usersPerm}",
        '/C', '/Q'
    )
}

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
$normalizedRoot = [IO.Path]::GetFullPath($Path).TrimEnd('\')
$directories = New-Object 'System.Collections.Generic.List[string]'
$files = New-Object 'System.Collections.Generic.List[string]'
$pending = New-Object 'System.Collections.Generic.Stack[string]'
$pending.Push($normalizedRoot)

# Inventory the complete recurse target before granting Tier-B Users:M to
# any directory. Once a directory becomes user-writable, no later traversal
# occurs beneath it. Root mode intentionally inspects but does not descend
# into child directories because those receive their own tier invocations.
while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    Assert-SafeTraversalDirectory -DirectoryPath $current
    $directories.Add($current)

    foreach ($item in @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "E_ACL_REPARSE: $($item.FullName)"
        }
        if ($item.PSIsContainer) {
            if ($Mode -eq 'recurse') { $pending.Push($item.FullName) }
        } else {
            $files.Add($item.FullName)
        }
    }
}

# Leaf files cannot redirect traversal. Apply them before exposing any
# Tier-B directory to ordinary-user modification.
foreach ($filePath in $files) {
    $fileUsersPermission = $usersPerm
    if ($Tier -eq 'A' -and $Mode -eq 'root' -and
        [IO.Path]::GetFileName($filePath) -in @('workbench.db', 'workbench.db-wal', 'workbench.db-shm')) {
        # These three files are pre-created while the root is protected. Give
        # them direct Users:M before the root receives its non-inheriting
        # sibling-creation grant. No pathname mutation occurs after exposure.
        $fileUsersPermission = 'M'
    }
    Set-PCDoctorFileAcl -FilePath $filePath -UsersPermission $fileUsersPermission
}

# Secure descendants deepest-first. The root remains administrator-controlled
# until every operation beneath it has completed.
$directoriesBottomUp = @($directories | Sort-Object {
    ($_ -split '[\\/]').Count
} -Descending)
foreach ($directoryPath in $directoriesBottomUp) {
    if ($directoryPath.Equals($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
    Set-PCDoctorDirectoryAcl -DirectoryPath $directoryPath
}

# The root is deliberately last: after this point Tier B may permit Users:M.
Set-PCDoctorDirectoryAcl -DirectoryPath $normalizedRoot

if ($Tier -eq 'A' -and $Mode -eq 'root') {
    Invoke-IcaclsChecked -Description "SQLite root grant $normalizedRoot" -IcaclsArgs @(
        $normalizedRoot,
        '/grant', "${sidUsers}:(WD,AD,DC)",
        '/C', '/Q'
    )
}

# v2.4.10: propagate failure to caller. Previously always exit 0 which
# masked silent icacls errors. The first failure now terminates immediately;
# this final status preserves the explicit subprocess contract.
exit ([int]$script:anyFailed)
