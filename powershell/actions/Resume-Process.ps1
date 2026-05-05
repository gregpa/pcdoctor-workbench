<#
.SYNOPSIS
    Resume a previously-suspended process via NtResumeProcess (v2.5.30).

.DESCRIPTION
    Pair of Suspend-Process.ps1. Uses NtResumeProcess from ntdll.dll via
    the same Add-Type P/Invoke (loaded once per shell, guarded against
    re-load).

    Error code surface:
      E_PROC_NOT_FOUND   -- no process with that pid
      E_NTDLL_LOAD       -- could not load ntdll P/Invoke
      E_NT_FAILED        -- NtResumeProcess returned non-zero NTSTATUS
      E_PS_UNHANDLED     -- catch-all

.NOTES
    PowerShell 5.1 compatible.
#>
param(
    [Parameter(Mandatory=$true)]
    [int]$Target,

    [switch]$DryRun,
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'

trap {
    $errRecord = @{
        code    = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' }
        message = $_.Exception.Message
        script  = $MyInvocation.MyCommand.Name
        line    = $_.InvocationInfo.ScriptLineNumber
        stack   = $_.ScriptStackTrace
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if (-not ('PCDoctor.NtDll' -as [type])) {
    try {
        Add-Type -Namespace 'PCDoctor' -Name 'NtDll' -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("ntdll.dll", SetLastError = true)]
public static extern int NtSuspendProcess(System.IntPtr processHandle);
[System.Runtime.InteropServices.DllImport("ntdll.dll", SetLastError = true)]
public static extern int NtResumeProcess(System.IntPtr processHandle);
"@
    } catch {
        $errRecord = @{
            code    = 'E_NTDLL_LOAD'
            message = "Could not load NtResumeProcess from ntdll.dll: $($_.Exception.Message)"
        } | ConvertTo-Json -Compress
        Write-Host "PCDOCTOR_ERROR:$errRecord"
        exit 1
    }
}

$proc = $null
try {
    $proc = Get-Process -Id $Target -ErrorAction Stop
} catch {
    $errRecord = @{
        code    = 'E_PROC_NOT_FOUND'
        message = "No process with pid=$Target"
        target  = $Target
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$before = @{ status = 'Suspended' }

if ($DryRun) {
    $sw.Stop()
    $payload = @{
        success     = $true
        target      = "pid=$Target"
        pid         = $Target
        name        = "$($proc.ProcessName)"
        before      = $before
        after       = @{ status = 'Running' }
        duration_ms = $sw.ElapsedMilliseconds
        dry_run     = $true
    }
    $payload | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

$nt = [PCDoctor.NtDll]::NtResumeProcess($proc.Handle)
if ($nt -ne 0) {
    $errRecord = @{
        code    = 'E_NT_FAILED'
        message = ("NtResumeProcess(pid={0}) returned NTSTATUS=0x{1:X8}" -f $Target, $nt)
        target  = $Target
        ntstatus = $nt
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw.Stop()
$payload = @{
    success     = $true
    target      = "pid=$Target"
    pid         = $Target
    name        = "$($proc.ProcessName)"
    before      = $before
    after       = @{ status = 'Running' }
    duration_ms = $sw.ElapsedMilliseconds
    dry_run     = $false
}
$payload | ConvertTo-Json -Depth 5 -Compress
exit 0
