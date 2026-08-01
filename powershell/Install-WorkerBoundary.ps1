#Requires -Version 5.1
<#
.SYNOPSIS
    Provisions or removes PCDoctor's fixed privileged worker boundary.
.DESCRIPTION
    Install mode creates administrator-owned, inheritance-protected directories
    before copying the exact elevated worker and nine allowlisted action scripts.
    The queue root grants ordinary users read/list/traverse only; the elevated
    worker creates each short-lived writable session leaf with an exact ACL.
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Uninstall')]
    [string]$Mode,

    [string]$SourceRoot = ''
)

$ErrorActionPreference = 'Stop'
$privilegedRoot = 'C:\Program Files\PCDoctor Workbench\privileged'
$queueRoot = 'C:\ProgramData\PCDoctorWorkerQueue'
$expectedSourceRoot = 'C:\Program Files\PCDoctor Workbench\resources\powershell'
$administratorSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$usersSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
$pinnedBoundaryHandles = New-Object 'System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
$powerShellPath = Join-Path ([Environment]::GetFolderPath(
    [Environment+SpecialFolder]::System
)) 'WindowsPowerShell\v1.0\powershell.exe'
$trustedAncestors = @(
    'C:\Program Files'
    'C:\Program Files\PCDoctor Workbench'
    'C:\Program Files\PCDoctor Workbench\resources'
    'C:\Program Files\PCDoctor Workbench\resources\powershell'
    'C:\ProgramData'
)

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class PCDoctorBoundaryHandle
{
    private const uint READ_CONTROL = 0x00020000;
    private const uint WRITE_DAC = 0x00040000;
    private const uint WRITE_OWNER = 0x00080000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const int FileAttributeTagInfo = 9;
    private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ATTRIBUTE_TAG_INFO
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string name, uint access, uint share, IntPtr security, uint creation,
        uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle handle, int infoClass, out FILE_ATTRIBUTE_TAG_INFO info, uint size);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetKernelObjectSecurity(
        SafeFileHandle handle, uint securityInformation, byte[] descriptor,
        uint length, out uint lengthNeeded);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetKernelObjectSecurity(
        SafeFileHandle handle, uint securityInformation, byte[] descriptor);

    public static SafeFileHandle OpenDirectoryForSecurity(string path)
    {
        SafeFileHandle handle = CreateFileW(
            path, READ_CONTROL | WRITE_DAC | WRITE_OWNER,
            FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), path);
        return handle;
    }

    public static bool IsReparsePoint(SafeFileHandle handle)
    {
        FILE_ATTRIBUTE_TAG_INFO info;
        uint size = (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO));
        if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out info, size))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    }

    public static byte[] ReadOwnerAndDacl(SafeFileHandle handle)
    {
        uint needed;
        uint info = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
        if (GetKernelObjectSecurity(handle, info, null, 0, out needed))
            throw new InvalidOperationException("Unexpected empty security descriptor");
        int error = Marshal.GetLastWin32Error();
        if (error != ERROR_INSUFFICIENT_BUFFER)
            throw new Win32Exception(error);
        byte[] descriptor = new byte[needed];
        if (!GetKernelObjectSecurity(handle, info, descriptor, needed, out needed))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return descriptor;
    }

    public static void ApplyOwnerAndDacl(SafeFileHandle handle, byte[] descriptor)
    {
        if (!SetKernelObjectSecurity(handle,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
            PROTECTED_DACL_SECURITY_INFORMATION, descriptor))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'E_NOT_ADMIN: worker-boundary provisioning requires an administrator token'
    }
}

function Assert-NoReparseAncestors {
    foreach ($path in $trustedAncestors) {
        if ([IO.File]::Exists($path)) { throw "E_ANCESTOR_FILE: $path" }
        if (-not [IO.Directory]::Exists($path)) { continue }
        $item = Get-Item -LiteralPath $path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "E_ANCESTOR_REPARSE: $path"
        }
    }
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return -join ($sha256.ComputeHash([IO.File]::ReadAllBytes($Path)) |
            ForEach-Object { $_.ToString('x2') })
    } finally {
        $sha256.Dispose()
    }
}

function New-ProtectedDirectorySecurity {
    param([Parameter(Mandatory = $true)][bool]$AllowUsersRead)

    $security = New-Object Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($administratorSid)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $none = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $administratorSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $none, $allow)))
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $none, $allow)))
    if ($AllowUsersRead) {
        $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            $usersSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inherit, $none, $allow)))
    }
    return $security
}

function New-ProtectedFileSecurity {
    $security = New-Object Security.AccessControl.FileSecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($administratorSid)
    $none = [Security.AccessControl.InheritanceFlags]::None
    $propagation = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $administratorSid, [Security.AccessControl.FileSystemRights]::FullControl, $none, $propagation, $allow)))
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $none, $propagation, $allow)))
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $usersSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $none, $propagation, $allow)))
    return $security
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

function Assert-TrustedExistingDirectory {
    param(
        [Parameter(Mandatory = $true)][Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ([PCDoctorBoundaryHandle]::IsReparsePoint($Handle)) {
        throw "E_EXISTING_BOUNDARY_REPARSE: $Path"
    }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetSecurityDescriptorBinaryForm([PCDoctorBoundaryHandle]::ReadOwnerAndDacl($Handle))
    $ownerSid = Get-IdentitySidValue -IdentityReference $acl.Owner
    if ($ownerSid -cne 'S-1-5-32-544' -or -not $acl.AreAccessRulesProtected) {
        throw "E_EXISTING_BOUNDARY_UNTRUSTED: owner/DACL $Path"
    }
    $seenFullControl = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $forbiddenUsersRights = [int64](2 -bor 4 -bor 16 -bor 64 -bor 256 -bor 65536 -bor 262144 -bor 524288)
    foreach ($ace in $acl.Access) {
        $sid = Get-IdentitySidValue -IdentityReference $ace.IdentityReference
        if ($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $sid -notin @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-32-545')) {
            throw "E_EXISTING_BOUNDARY_UNTRUSTED: unexpected ACE $sid on $Path"
        }
        $rights = [int64]$ace.FileSystemRights.value__
        if ($sid -eq 'S-1-5-32-545' -and ($rights -band $forbiddenUsersRights) -ne 0) {
            throw "E_EXISTING_BOUNDARY_UNTRUSTED: writable Users ACE on $Path"
        }
        if ($sid -in @('S-1-5-32-544', 'S-1-5-18') -and
            ($rights -band [int64][Security.AccessControl.FileSystemRights]::FullControl) -eq
            [int64][Security.AccessControl.FileSystemRights]::FullControl) {
            [void]$seenFullControl.Add($sid)
        }
    }
    if (-not $seenFullControl.Contains('S-1-5-32-544') -or
        -not $seenFullControl.Contains('S-1-5-18')) {
        throw "E_EXISTING_BOUNDARY_UNTRUSTED: missing privileged ACE on $Path"
    }
}

function Set-ProtectedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$AllowUsersRead
    )

    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ([IO.File]::Exists($fullPath)) { throw "Expected directory is a file: $fullPath" }
    $security = New-ProtectedDirectorySecurity -AllowUsersRead $AllowUsersRead
    if (-not [IO.Directory]::Exists($fullPath)) {
        [void][IO.Directory]::CreateDirectory($fullPath, $security)
    }
    # Pin the exact non-reparse object without FILE_SHARE_DELETE. Validation
    # and ACL application both use this handle, so the pathname cannot be
    # exchanged between check and mutation. A racing pre-creation must already
    # satisfy the complete trusted contract or installation fails closed.
    $handle = [PCDoctorBoundaryHandle]::OpenDirectoryForSecurity($fullPath)
    try {
        Assert-TrustedExistingDirectory -Handle $handle -Path $fullPath
        $descriptor = New-Object byte[] $security.BinaryLength
        $security.GetSecurityDescriptorBinaryForm($descriptor, 0)
        [PCDoctorBoundaryHandle]::ApplyOwnerAndDacl($handle, $descriptor)
        [void]$pinnedBoundaryHandles.Add($handle)
    } catch {
        $handle.Dispose()
        throw
    }
}

function Remove-ExactBoundary {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedPath
    )

    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $expected = [IO.Path]::GetFullPath($ExpectedPath).TrimEnd('\')
    if (-not $resolved.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unexpected removal target: $resolved"
    }
    if (-not [IO.Directory]::Exists($resolved)) { return }
    $item = Get-Item -LiteralPath $resolved -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing reparse-point removal target: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Assert-ExactPrivilegedPayload {
    param(
        [Parameter(Mandatory = $true)][string[]]$ExpectedRelativePaths,
        [Parameter(Mandatory = $true)][bool]$RequireComplete
    )

    $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($relativePath in $ExpectedRelativePaths) { [void]$expected.Add($relativePath) }
    $actual = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($item in @(Get-ChildItem -LiteralPath $privilegedRoot -Recurse -Force)) {
        $relativePath = $item.FullName.Substring($privilegedRoot.Length).TrimStart('\')
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "E_UNEXPECTED_PRIVILEGED_PAYLOAD: reparse point '$relativePath'"
        }
        if (-not $expected.Contains($relativePath)) {
            throw "E_UNEXPECTED_PRIVILEGED_PAYLOAD: '$relativePath'"
        }
        [void]$actual.Add($relativePath)
    }
    if ($RequireComplete) {
        foreach ($relativePath in $ExpectedRelativePaths) {
            if (-not $actual.Contains($relativePath)) {
                throw "E_PRIVILEGED_PAYLOAD_INCOMPLETE: '$relativePath'"
            }
        }
    }
}

Assert-Administrator
Assert-NoReparseAncestors

if ($Mode -eq 'Uninstall') {
    Remove-ExactBoundary -Path $privilegedRoot -ExpectedPath 'C:\Program Files\PCDoctor Workbench\privileged'
    Remove-ExactBoundary -Path $queueRoot -ExpectedPath 'C:\ProgramData\PCDoctorWorkerQueue'
    exit 0
}

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    throw 'E_SOURCE_MISSING: Install mode requires the bundled powershell source root'
}
$source = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
if (-not $source.Equals($expectedSourceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "E_SOURCE_UNTRUSTED: expected '$expectedSourceRoot', received '$source'"
}
if (-not [IO.Directory]::Exists($source)) { throw "E_SOURCE_MISSING: $source" }

$payload = @(
    @{ Source = 'worker\Elevated-Worker.ps1'; Destination = 'worker\Elevated-Worker.ps1' }
    @{ Source = 'actions\Set-ServiceStartup.ps1'; Destination = 'actions\Set-ServiceStartup.ps1' }
    @{ Source = 'actions\Stop-Service.ps1'; Destination = 'actions\Stop-Service.ps1' }
    @{ Source = 'actions\Start-Service.ps1'; Destination = 'actions\Start-Service.ps1' }
    @{ Source = 'actions\Restart-Service.ps1'; Destination = 'actions\Restart-Service.ps1' }
    @{ Source = 'actions\Kill-Process.ps1'; Destination = 'actions\Kill-Process.ps1' }
    @{ Source = 'actions\Set-ProcessPriority.ps1'; Destination = 'actions\Set-ProcessPriority.ps1' }
    @{ Source = 'actions\Set-ProcessAffinity.ps1'; Destination = 'actions\Set-ProcessAffinity.ps1' }
    @{ Source = 'actions\Suspend-Process.ps1'; Destination = 'actions\Suspend-Process.ps1' }
    @{ Source = 'actions\Resume-Process.ps1'; Destination = 'actions\Resume-Process.ps1' }
)
$expectedRelativePaths = @('worker', 'actions') + @($payload | ForEach-Object { $_.Destination })

# Protect containers before any privileged code becomes reachable from them.
Set-ProtectedDirectory -Path $privilegedRoot -AllowUsersRead $true
Set-ProtectedDirectory -Path (Join-Path $privilegedRoot 'worker') -AllowUsersRead $true
Set-ProtectedDirectory -Path (Join-Path $privilegedRoot 'actions') -AllowUsersRead $true
Assert-ExactPrivilegedPayload -ExpectedRelativePaths $expectedRelativePaths -RequireComplete $false

$fileSecurity = New-ProtectedFileSecurity
foreach ($entry in $payload) {
    $sourcePath = Join-Path $source $entry.Source
    $destinationPath = Join-Path $privilegedRoot $entry.Destination
    if (-not [IO.File]::Exists($sourcePath)) { throw "E_PAYLOAD_MISSING: $($entry.Source)" }
    $sourceItem = Get-Item -LiteralPath $sourcePath -Force
    if (($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "E_PAYLOAD_REPARSE: $($entry.Source)"
    }
    if ([IO.File]::Exists($destinationPath)) {
        $destinationItem = Get-Item -LiteralPath $destinationPath -Force
        if (($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "E_UNEXPECTED_PRIVILEGED_PAYLOAD: reparse point '$($entry.Destination)'"
        }
    }
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
    [IO.File]::SetAccessControl($destinationPath, $fileSecurity)
    $sourceHash = Get-Sha256Hex -Path $sourcePath
    $destinationHash = Get-Sha256Hex -Path $destinationPath
    if ($sourceHash -cne $destinationHash) { throw "E_PAYLOAD_HASH: $($entry.Source)" }
}
Assert-ExactPrivilegedPayload -ExpectedRelativePaths $expectedRelativePaths -RequireComplete $true
foreach ($entry in $payload) {
    $destinationPath = Join-Path $privilegedRoot $entry.Destination
    if (-not [IO.File]::Exists($destinationPath)) {
        throw "E_PRIVILEGED_PAYLOAD_INCOMPLETE: '$($entry.Destination)' is not a file"
    }
}

# Root users may inspect/traverse only. Session leaves are created atomically
# by the already-elevated worker with a per-user file-only write ACL.
Set-ProtectedDirectory -Path $queueRoot -AllowUsersRead $true

$cleanupScript = Join-Path $source 'Cleanup-StaleWorkerSessions.ps1'
if (-not [IO.File]::Exists($cleanupScript)) { throw 'E_CLEANUP_MISSING: Cleanup-StaleWorkerSessions.ps1' }
if (-not [IO.File]::Exists($powerShellPath)) { throw "E_POWERSHELL_MISSING: $powerShellPath" }
& $powerShellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $cleanupScript -MinimumAgeMinutes 1440
if ($LASTEXITCODE -ne 0) { throw "E_CLEANUP_FAILED: exit $LASTEXITCODE" }

foreach ($handle in $pinnedBoundaryHandles) { $handle.Dispose() }
exit 0
