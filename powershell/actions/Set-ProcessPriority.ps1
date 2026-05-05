<#
.SYNOPSIS
    Set a process's PriorityClass (v2.5.30).

.DESCRIPTION
    Wraps `(Get-Process -Id $Pid).PriorityClass = $Class`. PriorityClass
    is a System.Diagnostics.ProcessPriorityClass enum:
      Idle, BelowNormal, Normal, AboveNormal, High, RealTime

    Error code surface:
      E_INVALID_PARAM   -- Class not in enum
      E_PROC_NOT_FOUND  -- no process with that pid
      E_PROC_PROTECTED  -- access denied (typical for SYSTEM/protected
                           processes; user can't override even elevated)
      E_PS_UNHANDLED    -- catch-all

    On success:
      { success, pid, name, before:{priority}, after:{priority}, duration_ms, dry_run }

.NOTES
    PowerShell 5.1 compatible.
#>
param(
    [Parameter(Mandatory=$true)]
    [int]$Target,

    [Parameter(Mandatory=$true)]
    [ValidateSet('Idle','BelowNormal','Normal','AboveNormal','High','RealTime')]
    [string]$Class,

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

$beforeClass = "$($proc.PriorityClass)"
$before = @{ priority = $beforeClass }

if ($beforeClass -eq $Class) {
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
        after       = @{ priority = $Class }
        duration_ms = $sw.ElapsedMilliseconds
        dry_run     = $true
    }
    $payload | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

try {
    $proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]$Class
    $proc.Refresh()
} catch {
    $msg = "$($_.Exception.Message)"
    $code = 'E_PROC_PROTECTED'
    if ($msg -match 'no process') { $code = 'E_PROC_NOT_FOUND' }
    $errRecord = @{
        code    = $code
        message = "Could not set priority on pid=$Target ($($proc.ProcessName)): $msg"
        target  = $Target
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$afterClass = "$($proc.PriorityClass)"

$sw.Stop()
$payload = @{
    success     = $true
    target      = "pid=$Target"
    pid         = $Target
    name        = "$($proc.ProcessName)"
    before      = $before
    after       = @{ priority = $afterClass }
    duration_ms = $sw.ElapsedMilliseconds
    dry_run     = $false
}
$payload | ConvertTo-Json -Depth 5 -Compress
exit 0
