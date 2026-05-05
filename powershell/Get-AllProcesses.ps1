<#
.SYNOPSIS
    Enumerates running processes for the new Processes tab (v2.5.30).

.DESCRIPTION
    Each row carries:
      pid                   process id (numeric)
      name                  process short name (e.g. 'chrome')
      ws_mb                 working set (resident memory) in MB
      cpu_pct               null (per-process %CPU requires 2 samples and
                            a delta; renderer can compute from successive
                            polls if it wants. Out of scope for this rev.)
      kind                  'user' | 'system'
                              system  -> name is in the hardcoded critical
                                         set OR pid 0/4
                              user    -> everything else (the page UI does
                                         not distinguish service-account
                                         processes; svchost-hosted services
                                         show up with name 'svchost' under
                                         'user'. Future enhancement could
                                         match against the curated service
                                         list.)
      system_critical       true for PIDs/names whose kill blue-screens the
                            box (winlogon, csrss, wininit, services, lsass,
                            smss, System(4), Idle(0), Secure System,
                            Registry, Memory Compression). The renderer
                            uses this for the red 'I understand' gate.
      system_critical_reason short text (null when system_critical=false)

    Performance: backed by Get-Process (single call, ~100ms for ~250
    processes). The earlier Win32_Process + Invoke-CimMethod GetOwner per
    row took 30s+ -- abandoned in favor of name-based classification.

.NOTES
    PowerShell 5.1 compatible.
#>
param(
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

# ---------------------------------------------------------------------------
# Hardcoded system-critical name set (case-insensitive). Killing any of
# these halts the box (BSOD on lsass; hard hang on csrss/winlogon).
# Comparison is case-insensitive via ToLowerInvariant().
# ---------------------------------------------------------------------------
$CriticalMap = @{
    'system'             = 'Windows kernel; cannot be terminated by any user process.'
    'idle'               = 'Pseudo-process for idle CPU time; cannot be terminated.'
    'csrss'              = 'Client/Server Runtime Subsystem -- killing it bluescreens the system (CRITICAL_PROCESS_DIED).'
    'winlogon'           = 'Windows Logon process -- killing it logs you out unconditionally.'
    'wininit'            = 'Windows Initialization -- killing it bluescreens the system.'
    'services'           = 'Service Control Manager -- killing it stops every Windows service simultaneously.'
    'lsass'              = 'Local Security Authority -- killing it bluescreens the system (security boundary).'
    'smss'               = 'Session Manager Subsystem -- killing it bluescreens the system.'
    'secure system'      = 'Virtualization-Based Security host -- protected, cannot be terminated.'
    'registry'           = 'Kernel registry process -- protected.'
    'memory compression' = 'Kernel memory compression worker -- protected.'
}

$rows = @()
$procs = Get-Process -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    $procPid = $p.Id
    $name = "$($p.ProcessName)"
    $nameLow = $name.ToLowerInvariant()

    $wsMb = 0
    try { $wsMb = [int]([math]::Round($p.WorkingSet64 / 1048576)) } catch {}

    $critical = $false
    $criticalReason = $null
    if ($CriticalMap.ContainsKey($nameLow)) {
        $critical = $true
        $criticalReason = $CriticalMap[$nameLow]
    } elseif ($procPid -eq 0 -or $procPid -eq 4) {
        $critical = $true
        $criticalReason = 'Kernel-level pseudo-process; cannot be terminated.'
    }

    $kind = if ($critical) { 'system' } else { 'user' }

    $row = @{
        pid                    = [int]$procPid
        name                   = $name
        ws_mb                  = $wsMb
        cpu_pct                = $null
        kind                   = $kind
        system_critical        = $critical
        system_critical_reason = $criticalReason
    }
    $rows += ,$row
}

$sw.Stop()
$payload = @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    count       = $rows.Count
    processes   = $rows
}
$payload | ConvertTo-Json -Depth 5 -Compress
exit 0
