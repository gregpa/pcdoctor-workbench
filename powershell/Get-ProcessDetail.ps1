<#
.SYNOPSIS
    Returns rich details for a single process by PID (v2.5.34).

.DESCRIPTION
    Powers the RamPressurePanel "click row to inspect" affordance. Greg
    wanted to see what each top-RAM consumer actually IS before deciding
    whether to kill it. The dashboard's per-scan top_processes list only
    carries name/pid/ws_bytes/kind to keep the latest.json payload tiny;
    this script is called on-demand when the user clicks a row.

    Returns one JSON object with:
      pid                   process id (echo of input)
      name                  short name (e.g. 'chrome')
      description           file description from version info, or null
      path                  full image path, or null (some system procs)
      command_line          full command line (Win32_Process), or null
      start_time            ISO 8601 start time, or null
      cpu_pct               null (we don't sample twice; out of scope)
      ws_bytes              working set (resident memory) in bytes
      pm_bytes              private memory in bytes, or null
      thread_count          number of threads
      handle_count          number of handles
      parent_pid            parent process PID, or null
      parent_name           parent process short name, or null
      kind                  'user' | 'system' (matches Get-AllProcesses)
      system_critical       boolean
      system_critical_reason short text or null

    Errors map to PCDOCTOR_ERROR with codes:
      E_PROC_NOT_FOUND      no process exists with that PID
      E_PS_UNHANDLED        anything else

.NOTES
    PowerShell 5.1 compatible. Uses Get-Process for the basics and
    Get-CimInstance Win32_Process for command line + parent + path
    fallback. CIM call is single-PID (fast, sub-100ms) so this whole
    script runs under 200ms typically.
#>
param(
    [Parameter(Mandatory=$true)]
    [int]$ProcessId,

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

# Hardcoded system-critical name -> reason map (mirrors Get-AllProcesses.ps1;
# keep in sync). NOTE: PowerShell variable names are case-insensitive, so
# this MUST NOT be named $SystemCritical -- that would conflict with the
# per-row $systemCritical bool below and PS would clobber the hashtable
# (same bug class as v2.5.30 worker $PID = $PID).
$CriticalNamesMap = @{
    'system'              = 'Windows kernel'
    'idle'                = 'CPU idle process'
    'csrss'               = 'Client/Server Runtime Subsystem'
    'winlogon'            = 'Windows Logon process'
    'wininit'             = 'Windows initialization process'
    'services'            = 'Service Control Manager'
    'lsass'               = 'Local Security Authority'
    'smss'                = 'Session Manager Subsystem'
    'secure system'       = 'Virtual secure mode'
    'registry'            = 'Registry process'
    'memory compression'  = 'Memory compression process'
}
$CriticalPidsMap = @{ 0 = 'CPU idle process'; 4 = 'Windows kernel' }

# Resolve process. Get-Process throws if missing; convert to E_PROC_NOT_FOUND.
$proc = $null
try {
    $proc = Get-Process -Id $ProcessId -ErrorAction Stop
} catch {
    $errPayload = @{
        code = 'E_PROC_NOT_FOUND'
        message = "No process with PID $ProcessId"
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errPayload"
    exit 1
}

# Pull the CIM row for command-line + parent + path. May be null for
# protected processes (we tolerate that).
$cim = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue

$name = $proc.ProcessName
$lower = $name.ToLowerInvariant()

# Classify kind / critical. Use distinct variable names from the lookup
# hashtables above to dodge PS's case-insensitive variable shadowing.
$rowIsCritical = $false
$rowCriticalReason = $null
if ($CriticalPidsMap.ContainsKey([int]$ProcessId)) {
    $rowIsCritical = $true
    $rowCriticalReason = $CriticalPidsMap[[int]$ProcessId]
} elseif ($CriticalNamesMap.ContainsKey($lower)) {
    $rowIsCritical = $true
    $rowCriticalReason = $CriticalNamesMap[$lower]
}
$kind = if ($rowIsCritical) { 'system' } else { 'user' }

# Description from main module's version info. May be null for system procs.
$description = $null
try {
    if ($proc.MainModule -and $proc.MainModule.FileVersionInfo) {
        $fvi = $proc.MainModule.FileVersionInfo
        if ($fvi.FileDescription) { $description = $fvi.FileDescription.Trim() }
    }
} catch { }

# Path: prefer Get-Process Path; fall back to CIM ExecutablePath.
$path = $null
try { if ($proc.Path) { $path = $proc.Path } } catch { }
if (-not $path -and $cim -and $cim.ExecutablePath) { $path = $cim.ExecutablePath }

# Parent
$parentPid = $null
$parentName = $null
if ($cim -and $cim.ParentProcessId) {
    $parentPid = [int]$cim.ParentProcessId
    if ($parentPid -gt 0) {
        try {
            $parent = Get-Process -Id $parentPid -ErrorAction Stop
            $parentName = $parent.ProcessName
        } catch { }
    }
}

# Start time
$startTime = $null
try {
    if ($proc.StartTime) {
        $startTime = $proc.StartTime.ToString('o')
    }
} catch { }

$detail = [ordered]@{
    pid                    = [int]$ProcessId
    name                   = $name
    description            = $description
    path                   = $path
    command_line           = if ($cim) { $cim.CommandLine } else { $null }
    start_time             = $startTime
    cpu_pct                = $null
    ws_bytes               = [int64]$proc.WorkingSet64
    pm_bytes               = [int64]$proc.PrivateMemorySize64
    thread_count           = if ($proc.Threads) { $proc.Threads.Count } else { 0 }
    handle_count           = [int]$proc.HandleCount
    parent_pid             = $parentPid
    parent_name            = $parentName
    kind                   = $kind
    system_critical        = $rowIsCritical
    system_critical_reason = $rowCriticalReason
}

if ($JsonOutput) {
    $detail | ConvertTo-Json -Depth 4 -Compress
} else {
    [pscustomobject]$detail
}
