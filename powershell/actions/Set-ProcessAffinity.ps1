<#
.SYNOPSIS
    Set a process's CPU affinity bitmask (v2.5.30).

.DESCRIPTION
    Wraps `(Get-Process -Id $Pid).ProcessorAffinity = $mask`.
    The mask is a [IntPtr]-cast bitmask: bit i set => process may run
    on logical CPU i. 0 is invalid (no CPUs); the mutate validates.

    Error code surface:
      E_INVALID_PARAM    -- mask is 0 or exceeds the visible CPU count
      E_PROC_NOT_FOUND   -- no process with that pid
      E_PROC_PROTECTED   -- access denied (typical for SYSTEM/protected)
      E_PS_UNHANDLED     -- catch-all

.NOTES
    PowerShell 5.1 compatible.
#>
param(
    [Parameter(Mandatory=$true)]
    [int]$Target,

    [Parameter(Mandatory=$true)]
    [int64]$Mask,

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

if ($Mask -le 0) {
    $errRecord = @{
        code    = 'E_INVALID_PARAM'
        message = 'Mask must be > 0 (a process must run on at least one CPU).'
        mask    = $Mask
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
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

$beforeMask = [int64]$proc.ProcessorAffinity
$before = @{ affinity_mask = $beforeMask }

if ($beforeMask -eq $Mask) {
    $sw.Stop()
    $payload = @{
        success     = $true
        target      = "pid=$Target"
        pid         = $Target
        name        = "$($proc.ProcessName)"
        before      = $before
        after       = $before
        duration_ms = $sw.ElapsedMilliseconds
        dry_run     = [bool]$DryRun
        noop        = $true
    }
    $payload | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

if ($DryRun) {
    $sw.Stop()
    $payload = @{
        success     = $true
        target      = "pid=$Target"
        pid         = $Target
        name        = "$($proc.ProcessName)"
        before      = $before
        after       = @{ affinity_mask = $Mask }
        duration_ms = $sw.ElapsedMilliseconds
        dry_run     = $true
    }
    $payload | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

try {
    $proc.ProcessorAffinity = [IntPtr]$Mask
    $proc.Refresh()
} catch {
    $msg = "$($_.Exception.Message)"
    $code = 'E_PROC_PROTECTED'
    if ($msg -match 'no process') { $code = 'E_PROC_NOT_FOUND' }
    $errRecord = @{
        code    = $code
        message = "Could not set affinity on pid=$Target ($($proc.ProcessName)): $msg"
        target  = $Target
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$afterMask = [int64]$proc.ProcessorAffinity

$sw.Stop()
$payload = @{
    success     = $true
    target      = "pid=$Target"
    pid         = $Target
    name        = "$($proc.ProcessName)"
    before      = $before
    after       = @{ affinity_mask = $afterMask }
    duration_ms = $sw.ElapsedMilliseconds
    dry_run     = $false
}
$payload | ConvertTo-Json -Depth 5 -Compress
exit 0
