<#
.SYNOPSIS
    Kills a process by PID (numeric) or by name.
#>
param(
    [string]$Target,
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

if ($DryRun) {
    $result = @{ success = $true; dry_run = $true; duration_ms = $sw.ElapsedMilliseconds; message = 'DryRun' }
    $result | ConvertTo-Json -Depth 3 -Compress
    exit 0
}

if (-not $Target) { throw "Target parameter is required" }

$killed = @()
if ($Target -match '^\d+$') {
    $procId = [int]$Target
    $proc = Get-Process -Id $procId -ErrorAction Stop
    $name = $proc.ProcessName
    Stop-Process -Id $procId -Force -ErrorAction Stop
    $killed += @{ pid = $procId; name = $name }
} else {
    $procs = Get-Process -Name $Target -ErrorAction Stop
    foreach ($p in $procs) {
        try {
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
            $killed += @{ pid = $p.Id; name = $p.ProcessName }
        } catch {}
    }
}

$sw.Stop()
$result = @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    killed      = $killed
    count       = $killed.Count
    message     = "Killed $($killed.Count) process(es)"
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
