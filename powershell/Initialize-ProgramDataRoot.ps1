#Requires -Version 5.1
<#
.SYNOPSIS
    Establishes a non-reparse, administrator-controlled PCDoctor data tree.
.DESCRIPTION
    Runs from the fixed Program Files bundle before the installer copies or
    recursively touches C:\ProgramData\PCDoctor. Each directory is protected
    before its children are inspected, so an existing writable data subtree
    cannot introduce a junction into a later recursive installer operation.
#>

$ErrorActionPreference = 'Stop'
$programDataRoot = 'C:\ProgramData\PCDoctor'
$programDataParent = 'C:\ProgramData'
$administratorSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$usersSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class PCDoctorNoReparseAcl
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
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    private const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;

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
    private static extern bool SetKernelObjectSecurity(
        SafeFileHandle handle, uint securityInformation, byte[] securityDescriptor);

    private static SafeFileHandle Open(string path, bool directory, uint access)
    {
        uint flags = FILE_FLAG_OPEN_REPARSE_POINT;
        if (directory) flags |= FILE_FLAG_BACKUP_SEMANTICS;
        SafeFileHandle handle = CreateFileW(
            path, access, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero,
            OPEN_EXISTING, flags, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), path);
        return handle;
    }

    public static SafeFileHandle OpenForInspection(string path, bool directory)
    {
        return Open(path, directory, READ_CONTROL);
    }

    public static SafeFileHandle OpenForDacl(string path, bool directory)
    {
        return Open(path, directory, READ_CONTROL | WRITE_DAC);
    }

    public static SafeFileHandle OpenForOwner(string path, bool directory)
    {
        return Open(path, directory, READ_CONTROL | WRITE_DAC | WRITE_OWNER);
    }

    public static bool IsReparsePoint(SafeFileHandle handle)
    {
        FILE_ATTRIBUTE_TAG_INFO info;
        uint size = (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO));
        if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out info, size))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    }

    public static void ApplyDacl(SafeFileHandle handle, byte[] descriptor)
    {
        if (!SetKernelObjectSecurity(handle,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor))
            throw new Win32Exception(Marshal.GetLastWin32Error());
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
        throw 'E_NOT_ADMIN: ProgramData initialization requires an administrator token'
    }
}

function New-TemporarySecurity {
    param([Parameter(Mandatory = $true)][bool]$IsDirectory)

    $security = if ($IsDirectory) {
        New-Object Security.AccessControl.DirectorySecurity
    } else {
        New-Object Security.AccessControl.FileSecurity
    }
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($administratorSid)
    $inheritance = if ($IsDirectory) {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    $propagation = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    foreach ($entry in @(
        @{ Sid = $administratorSid; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
        @{ Sid = $systemSid; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
        @{ Sid = $usersSid; Rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
    )) {
        $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            $entry.Sid, $entry.Rights, $inheritance, $propagation, $allow)))
    }
    return $security
}

function Protect-TreeNode {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$IsDirectory
    )

    $security = New-TemporarySecurity -IsDirectory $IsDirectory
    $descriptor = New-Object byte[] $security.BinaryLength
    $security.GetSecurityDescriptorBinaryForm($descriptor, 0)
    $daclHandle = [PCDoctorNoReparseAcl]::OpenForDacl($Path, $IsDirectory)
    try {
        if ([PCDoctorNoReparseAcl]::IsReparsePoint($daclHandle)) {
            throw "E_PROGRAMDATA_REPARSE: $Path"
        }
        # The no-delete-share handle pins this exact object while its DACL is
        # protected. A second handle can then set Administrators ownership
        # without reopening an attacker-swappable pathname.
        [PCDoctorNoReparseAcl]::ApplyDacl($daclHandle, $descriptor)
        $ownerHandle = [PCDoctorNoReparseAcl]::OpenForOwner($Path, $IsDirectory)
        try {
            if ([PCDoctorNoReparseAcl]::IsReparsePoint($ownerHandle)) {
                throw "E_PROGRAMDATA_REPARSE: $Path"
            }
            [PCDoctorNoReparseAcl]::ApplyOwnerAndDacl($ownerHandle, $descriptor)
        } finally {
            $ownerHandle.Dispose()
        }

        if ($IsDirectory) {
            $current = $Path
            foreach ($item in @(Get-ChildItem -LiteralPath $current -Force)) {
                Protect-TreeNode -Path $item.FullName -IsDirectory ([bool]$item.PSIsContainer)
            }
        }
    } finally {
        $daclHandle.Dispose()
    }
}

Assert-Administrator
if (-not [IO.Directory]::Exists($programDataParent)) { throw "E_PROGRAMDATA_PARENT_MISSING: $programDataParent" }
$parentHandle = [PCDoctorNoReparseAcl]::OpenForInspection($programDataParent, $true)
try {
    if ([PCDoctorNoReparseAcl]::IsReparsePoint($parentHandle)) {
        throw "E_PROGRAMDATA_REPARSE: $programDataParent"
    }
} finally {
    $parentHandle.Dispose()
}

$rootSecurity = New-TemporarySecurity -IsDirectory $true
if ([IO.File]::Exists($programDataRoot)) { throw "E_PROGRAMDATA_ROOT_FILE: $programDataRoot" }
if (-not [IO.Directory]::Exists($programDataRoot)) {
    # The security descriptor is supplied at creation rather than applied in
    # a second step, so another medium process never observes a writable root.
    [void][IO.Directory]::CreateDirectory($programDataRoot, $rootSecurity)
}
Protect-TreeNode -Path $programDataRoot -IsDirectory $true

exit 0
