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

# Path: prefer Get-Process Path; fall back to CIM ExecutablePath. Resolve
# this BEFORE description so we can use the path for a version-info fallback.
$path = $null
try { if ($proc.Path) { $path = $proc.Path } } catch { }
if (-not $path -and $cim -and $cim.ExecutablePath) { $path = $cim.ExecutablePath }

# v2.5.35: description discovery is layered:
#   1. FileVersionInfo via the live process's MainModule (most accurate, but
#      throws for protected processes like MsMpEng, lsass, SgrmBroker, etc.)
#   2. FileVersionInfo via the file on disk (works when path is known but
#      MainModule is blocked; still fails for files inside Defender's
#      protected platform dir or other ACL-locked locations)
#   3. Curated fallback map keyed on the lower-cased process name -- covers
#      the well-known Windows + common-app names whose path can't be read at
#      all (Greg's report: MsMpEng v2.5.34 modal showed Description blank)
$description = $null
try {
    if ($proc.MainModule -and $proc.MainModule.FileVersionInfo) {
        $fvi = $proc.MainModule.FileVersionInfo
        if ($fvi.FileDescription) { $description = $fvi.FileDescription.Trim() }
    }
} catch { }
if (-not $description -and $path) {
    try {
        $item = Get-Item -LiteralPath $path -ErrorAction Stop
        if ($item.VersionInfo -and $item.VersionInfo.FileDescription) {
            $description = $item.VersionInfo.FileDescription.Trim()
        }
    } catch { }
}
if (-not $description) {
    # Curated map. Keys are LOWER-CASED process names. Source: Microsoft Docs
    # for built-in Windows processes; vendor product pages for third-party.
    # Only include entries we're confident about -- ambiguous names (e.g.
    # 'TbService' which could be Acronis, Lenovo, or Telegram) are NOT in
    # the map; better to show blank than misidentify.
    $KnownProcessDescriptions = @{
        # Windows core + security
        'msmpeng'                = 'Microsoft Defender Antimalware Service core engine'
        'mssense'                = 'Microsoft Defender for Endpoint sensor'
        'securityhealthservice'  = 'Windows Security agent service'
        'securityhealthsystray'  = 'Windows Security tray icon'
        'securityhealthhost'     = 'Windows Security host'
        'sgrmbroker'             = 'System Guard Runtime Monitor Broker'
        'lsaiso'                 = 'Credential Guard / LSA isolation'
        'lsass'                  = 'Local Security Authority Subsystem (handles auth)'
        'lsm'                    = 'Local Session Manager'
        # Shell + UI
        'dwm'                    = 'Desktop Window Manager (composes the Windows desktop)'
        'explorer'               = 'File Explorer & taskbar shell'
        'sihost'                 = 'Shell infrastructure host (UI shell composition)'
        'shellexperiencehost'    = 'Start menu, action center, and taskbar UI'
        'startmenuexperiencehost' = 'Start menu UI'
        'searchhost'             = 'Windows Search UI'
        'searchapp'              = 'Windows Search UI (legacy)'
        'searchindexer'          = 'Windows Search file content indexer'
        'ctfmon'                 = 'Text Services & language input framework'
        'lockapp'                = 'Windows lock screen UI'
        'logonui'                = 'Windows logon UI'
        'taskmgr'                = 'Task Manager'
        'mmc'                    = 'Microsoft Management Console'
        # System services & infrastructure
        'svchost'                = 'Service Host (hosts one or more Windows services)'
        'services'               = 'Service Control Manager'
        'taskhostw'              = 'Host process for tasks scheduled by services'
        'runtimebroker'          = 'Permission broker for UWP apps'
        'wudfhost'               = 'Windows User-Mode Driver Framework host'
        'wmiprvse'               = 'WMI provider host'
        'unsecapp'               = 'WMI sink for asynchronous client callbacks'
        'dllhost'                = 'COM+ Surrogate / COM component host'
        'fontdrvhost'            = 'Font driver host'
        'audiodg'                = 'Windows Audio Device Graph Isolation'
        'spoolsv'                = 'Print spooler'
        'wermgr'                 = 'Windows Error Reporting'
        'conhost'                = 'Console Window Host (terminal renderer)'
        'crashpad_handler'       = 'Crash report uploader (Chromium / Electron)'
        'mscorsvw'               = '.NET runtime optimization service'
        'wsmprovhost'            = 'WS-Management host (PowerShell Remoting)'
        # Kernel + reserved
        'system'                 = 'Windows kernel'
        'idle'                   = 'CPU idle time accounting (not a real process)'
        'csrss'                  = 'Client/Server Runtime Subsystem (Win32 console + GUI)'
        'winlogon'               = 'Windows Logon process'
        'wininit'                = 'Windows initialization process'
        'smss'                   = 'Session Manager Subsystem'
        'registry'               = 'In-memory hive of the Windows Registry'
        'memory compression'     = 'Windows memory compression (compresses RAM in-place)'
        'secure system'          = 'Virtual secure mode (VBS) container'
        # Virtualization
        'vmmem'                  = 'Hyper-V virtual machine memory backing process'
        'vmmemwsl'               = 'WSL2 memory backing process (Linux container memory)'
        'wslservice'             = 'Windows Subsystem for Linux service'
        'wsl'                    = 'Windows Subsystem for Linux'
        # Browsers / WebView
        'msedge'                 = 'Microsoft Edge browser'
        'chrome'                 = 'Google Chrome browser'
        'firefox'                = 'Mozilla Firefox browser'
        'msedgewebview2'         = 'Edge WebView2 (embedded browser used by other apps)'
        'opera'                  = 'Opera browser'
        'brave'                  = 'Brave browser'
        # Dev tools
        'code'                   = 'Visual Studio Code'
        'devenv'                 = 'Visual Studio IDE'
        'pwsh'                   = 'PowerShell 7+ (cross-platform)'
        'powershell'             = 'Windows PowerShell 5.1'
        'cmd'                    = 'Command Prompt (cmd.exe)'
        'node'                   = 'Node.js runtime'
        'python'                 = 'Python interpreter'
        # Common third-party apps
        'discord'                = 'Discord chat client'
        'slack'                  = 'Slack desktop'
        'teams'                  = 'Microsoft Teams'
        'zoom'                   = 'Zoom video conferencing'
        'spotify'                = 'Spotify music player'
        'steam'                  = 'Steam gaming client'
        'everything'             = 'Everything (instant file search by voidtools)'
        # GPU vendors
        'nvcontainer'            = 'NVIDIA Container (driver subsystem)'
        'nvtelemetrycontainer'   = 'NVIDIA Telemetry'
        'amdrsserv'              = 'AMD Radeon Software service'
        'igccservicemodule'      = 'Intel Graphics Command Center service'
    }
    if ($KnownProcessDescriptions.ContainsKey($lower)) {
        $description = $KnownProcessDescriptions[$lower]
    }
}

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
