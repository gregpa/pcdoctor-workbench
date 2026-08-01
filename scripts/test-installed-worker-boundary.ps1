#Requires -Version 5.1
param(
    [ValidateSet('no', 'yes')]
    [string]$AuthorizedInstalledSmoke = 'no'
)

$ErrorActionPreference = 'Stop'
if ($AuthorizedInstalledSmoke -cne 'yes') {
    Write-Error 'E_INSTALLED_SMOKE_NOT_AUTHORIZED: rerun only after explicit installed-smoke authorization'
    exit 2
}

$queueRoot = 'C:\ProgramData\PCDoctorWorkerQueue'
$privilegedRoot = 'C:\Program Files\PCDoctor Workbench\privileged'
$expectedFiles = @(
    'worker\Elevated-Worker.ps1'
    'actions\Set-ServiceStartup.ps1'
    'actions\Stop-Service.ps1'
    'actions\Start-Service.ps1'
    'actions\Restart-Service.ps1'
    'actions\Kill-Process.ps1'
    'actions\Set-ProcessPriority.ps1'
    'actions\Set-ProcessAffinity.ps1'
    'actions\Suspend-Process.ps1'
    'actions\Resume-Process.ps1'
)
$expectedRelativePaths = @('worker', 'actions') + $expectedFiles

$failures = New-Object 'System.Collections.Generic.List[string]'

function Get-AccountSid {
    param([Parameter(Mandatory = $true)]$IdentityReference)
    try {
        return $IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
        return [string]$IdentityReference.Value
    }
}

function Test-ProtectedNode {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        $failures.Add("Missing boundary node: $Path")
        return
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $failures.Add("Boundary node is a reparse point: $Path")
    }
    $acl = Get-Acl -LiteralPath $Path
    try { $ownerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate(
        [Security.Principal.SecurityIdentifier]).Value } catch { $ownerSid = $acl.Owner }
    if ($ownerSid -cne 'S-1-5-32-544') { $failures.Add("Wrong owner on ${Path}: $ownerSid") }
    if (-not $acl.AreAccessRulesProtected) { $failures.Add("Inherited DACL on $Path") }

    $seen = @{}
    foreach ($ace in $acl.Access) {
        $sid = Get-AccountSid -IdentityReference $ace.IdentityReference
        if ($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $sid -notin @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-32-545')) {
            $failures.Add("Unexpected ACE on ${Path}: $sid $($ace.AccessControlType)")
            continue
        }
        $seen[$sid] = $true
        $rights = [int64]$ace.FileSystemRights.value__
        if ($sid -eq 'S-1-5-32-545') {
            $forbidden = 2 -bor 4 -bor 16 -bor 64 -bor 256 -bor 65536 -bor 262144 -bor 524288
            if (($rights -band $forbidden) -ne 0) {
                $failures.Add("Users ACE is writable on ${Path}: $rights")
            }
            $requiredRead = [int64][Security.AccessControl.FileSystemRights]::ReadAndExecute
            if (($rights -band $requiredRead) -ne $requiredRead) {
                $failures.Add("Users ACE lacks ReadAndExecute on ${Path}: $rights")
            }
        } elseif (($rights -band [int64][Security.AccessControl.FileSystemRights]::FullControl) -ne
            [int64][Security.AccessControl.FileSystemRights]::FullControl) {
            $failures.Add("Administrator/SYSTEM ACE lacks FullControl on ${Path}: $sid $rights")
        }
    }
    foreach ($sid in @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-32-545')) {
        if (-not $seen[$sid]) { $failures.Add("Missing required ACE on ${Path}: $sid") }
    }
}

Test-ProtectedNode -Path $queueRoot
Test-ProtectedNode -Path $privilegedRoot
foreach ($relative in $expectedRelativePaths) {
    Test-ProtectedNode -Path (Join-Path $privilegedRoot $relative)
}
foreach ($relative in @('worker', 'actions')) {
    $path = Join-Path $privilegedRoot $relative
    if ((Test-Path -LiteralPath $path) -and -not (Test-Path -LiteralPath $path -PathType Container)) {
        $failures.Add("Expected privileged directory is not a directory: $relative")
    }
}
foreach ($relative in $expectedFiles) {
    $path = Join-Path $privilegedRoot $relative
    if ((Test-Path -LiteralPath $path) -and -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $failures.Add("Expected privileged file is not a file: $relative")
    }
}

$expectedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($relative in $expectedRelativePaths) { [void]$expectedSet.Add($relative) }
if (Test-Path -LiteralPath $privilegedRoot -PathType Container) {
    $actualSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($item in @(Get-ChildItem -LiteralPath $privilegedRoot -Recurse -Force)) {
        [void]$actualSet.Add($item.FullName.Substring($privilegedRoot.Length).TrimStart('\'))
    }
    foreach ($relative in $actualSet) {
        if (-not $expectedSet.Contains($relative)) {
            $failures.Add("Unexpected privileged payload: $relative")
        }
    }
    foreach ($relative in $expectedSet) {
        if (-not $actualSet.Contains($relative)) {
            $failures.Add("Missing privileged payload: $relative")
        }
    }
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Host '[PASS] Installed worker boundary ACL and payload smoke checks passed.'
exit 0
