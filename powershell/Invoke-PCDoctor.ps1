#Requires -Version 5.1
<#
.SYNOPSIS
    PC Doctor -- weekly non-destructive PC health check and safe maintenance.

.DESCRIPTION
    Runs a suite of diagnostic + safe-maintenance actions and writes a structured
    JSON report plus a human-readable Markdown summary. Designed to run unattended
    from Task Scheduler OR interactively invoked by the pc-doctor Cowork skill.

    By design this script does NOT:
      - Uninstall applications
      - Edit registry (beyond reading)
      - Disable services
      - Delete anything outside of temp folders

    Those actions require a human (via Claude) to judge.

.PARAMETER Mode
    'Auto'        - Non-destructive cleanup + scan (default, safe for unattended).
    'Report'      - Read-only; produce report without modifying anything.
    'DeepScan'    - Auto + run sfc /scannow + DISM /RestoreHealth (slow, ~30 min).

.PARAMETER OutDir
    Where to write the report. Default: C:\ProgramData\PCDoctor\reports

.PARAMETER AllowlistPath
    JSON file of known-quiet events to suppress from findings.
    Default: C:\ProgramData\PCDoctor\event-allowlist.json

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File C:\ProgramData\PCDoctor\Invoke-PCDoctor.ps1 -Mode Auto

.NOTES
    Author: Built for Greg Pajak via Cowork, 2026-04-15.
    Revised 2026-04-16 to add: NAS health, service health, event allowlist,
    Application log event emission, SYSTEM-context temp-cleanup fix.
#>

[CmdletBinding()]
param(
    [ValidateSet('Auto','Report','DeepScan')]
    [string]$Mode = 'Auto',
    [string]$OutDir = 'C:\ProgramData\PCDoctor\reports',
    [string]$AllowlistPath = 'C:\ProgramData\PCDoctor\event-allowlist.json'
)

$ErrorActionPreference = 'Continue'
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportDir = Join-Path $OutDir $ts
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$jsonPath = Join-Path $reportDir 'report.json'
$mdPath   = Join-Path $reportDir 'report.md'
$logPath  = Join-Path $reportDir 'run.log'

function Log([string]$m) {
    $line = "$(Get-Date -Format 'HH:mm:ss') $m"
    $line | Out-File -Append -FilePath $logPath
    Write-Verbose $line
}

# Ensure Application log event source exists for this run (requires admin first time).
$evtSource = 'PCDoctor'
try {
    if (-not [System.Diagnostics.EventLog]::SourceExists($evtSource)) {
        New-EventLog -LogName Application -Source $evtSource -ErrorAction Stop
        Log "Created Application log event source: $evtSource"
    }
} catch {
    Log "Could not create event source (need admin first run): $_"
}

function Write-PCDEvent {
    param([int]$EventId, [ValidateSet('Information','Warning','Error')]$Level = 'Information', [string]$Message)
    try {
        Write-EventLog -LogName Application -Source $evtSource -EntryType $Level -EventId $EventId -Message $Message -ErrorAction Stop
    } catch {
        Log "Event log write failed: $_"
    }
}

$report = [ordered]@{
    timestamp = (Get-Date).ToString('o')
    mode      = $Mode
    hostname  = $env:COMPUTERNAME
    findings  = @()   # list of {severity, area, message, detail, auto_fixed}
    metrics   = @{}
    actions   = @()   # list of {action, result}
}

function Add-Finding {
    param(
        [ValidateSet('critical','warning','info')]$Severity,
        [string]$Area, [string]$Message, $Detail=$null, [bool]$AutoFixed=$false,
        # v2.4.6: long-form rationale shown in AlertDetailModal's
        # "Why this matters" section. Optional - the renderer falls back
        # to a static keyword map when this is absent (older scanner
        # reports), so new finding emits can opt in incrementally.
        [string]$Why=$null
    )
    $entry = [ordered]@{
        severity   = $Severity
        area       = $Area
        message    = $Message
        detail     = $Detail
        auto_fixed = $AutoFixed
    }
    if ($Why) { $entry.why = $Why }
    $report.findings += $entry
}

function Add-Action {
    param([string]$Action, [string]$Result)
    $report.actions += [ordered]@{ action = $Action; result = $Result }
    Log "ACTION: $Action -> $Result"
}

# Load event allowlist (silent if missing).
$allowlist = @()
if (Test-Path $AllowlistPath) {
    try {
        $allowlist = (Get-Content $AllowlistPath -Raw | ConvertFrom-Json).allowlist
        Log "Loaded event allowlist: $($allowlist.Count) entries"
    } catch {
        Log "Failed to parse allowlist: $_"
    }
}

Write-PCDEvent -EventId 1000 -Level Information -Message "PC Doctor run started (mode=$Mode, report=$reportDir)"
Log "=== PC DOCTOR START mode=$Mode ==="

# =================================================================
# 1. SYSTEM BASELINE
# =================================================================
Log "Collecting system baseline..."
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $cpuLoad = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
    $report.metrics.os_build          = $os.BuildNumber
    $report.metrics.uptime_hours      = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
    $report.metrics.ram_total_gb      = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    $report.metrics.ram_free_gb       = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
    $report.metrics.ram_used_pct      = [math]::Round((1 - ($os.FreePhysicalMemory * 1024 / $cs.TotalPhysicalMemory)) * 100, 1)
    $report.metrics.cpu_load_pct      = $cpuLoad

    if ($report.metrics.ram_used_pct -ge 85) {
        Add-Finding warning 'Memory' "RAM usage $($report.metrics.ram_used_pct)% at check time" @{ free_gb = $report.metrics.ram_free_gb } -Why "High RAM usage forces Windows to page active memory to disk (pagefile.sys). Once swap kicks in, apps stutter, input latency spikes, and disk I/O pressure cascades. Common causes on a dev box: Chrome tabs, Electron apps (VS Code / Discord / Slack), WSL2 (vmmemWSL), Docker Desktop. Fix options: kill top consumer (see RAM Pressure panel), cap WSL memory (Apply WSL Memory Cap action), restart Explorer, or reboot."
    }
    if ($report.metrics.uptime_hours -ge 168) {
        Add-Finding info 'Uptime' "System has been up $($report.metrics.uptime_hours) hours; a reboot can resolve accumulated memory issues"
    }
} catch { Log "Baseline error: $_" }

# =================================================================
# 2. DISK HEALTH & SPACE
# =================================================================
Log "Checking disks..."
try {
    $report.metrics.disks = @()
    foreach ($v in Get-Volume | Where-Object DriveLetter) {
        $freePct = if ($v.Size -gt 0) { [math]::Round(($v.SizeRemaining / $v.Size) * 100, 1) } else { 0 }
        $d = @{
            drive      = "$($v.DriveLetter):"
            label      = $v.FileSystemLabel
            fs         = $v.FileSystem
            size_gb    = [math]::Round($v.Size / 1GB, 1)
            free_gb    = [math]::Round($v.SizeRemaining / 1GB, 1)
            free_pct   = $freePct
            drive_type = "$($v.DriveType)"
        }
        $report.metrics.disks += $d

        if ($v.DriveType -eq 'Fixed') {
            if ($freePct -lt 5) {
                Add-Finding critical 'Disk' "$($d.drive) is $(100 - $freePct)% full ($($d.free_gb) GB free)" $d
            } elseif ($freePct -lt 15) {
                Add-Finding warning 'Disk' "$($d.drive) is below 15% free ($($d.free_gb) GB free)" $d
            }
        }
    }

    foreach ($pd in Get-PhysicalDisk) {
        if ($pd.HealthStatus -ne 'Healthy' -or $pd.OperationalStatus -ne 'OK') {
            Add-Finding critical 'DiskHealth' "Physical disk unhealthy: $($pd.FriendlyName)" @{
                health = $pd.HealthStatus
                op     = $pd.OperationalStatus
                media  = $pd.MediaType
            }
        }
    }
} catch { Log "Disk error: $_" }

# =================================================================
# 3. EVENT LOG REVIEW (last 7 days, critical/error only) + allowlist filter
# =================================================================
Log "Reviewing event logs..."
try {
    $since = (Get-Date).AddDays(-7)
    $sysErrors = Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2; StartTime=$since} -MaxEvents 500 -EA SilentlyContinue
    $appErrors = Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2; StartTime=$since} -MaxEvents 500 -EA SilentlyContinue

    $report.metrics.event_errors_7d = @{
        system_count      = ($sysErrors | Measure-Object).Count
        application_count = ($appErrors | Measure-Object).Count
    }

    # Build quick lookup for allowlist
    $suppressIndex = @{}
    foreach ($entry in $allowlist) {
        $key = "$($entry.provider)|$($entry.event_id)"
        $suppressIndex[$key] = $entry
    }

    # Look for recurring problems (same provider+event occurring >= 10 times)
    $recurring = @()
    $suppressed = @()
    foreach ($group in ($sysErrors + $appErrors | Group-Object { "$($_.ProviderName)|$($_.Id)" })) {
        if ($group.Count -ge 10) {
            $first = $group.Group | Select-Object -First 1
            $entry = $suppressIndex[$group.Name]
            $item = @{
                provider = $first.ProviderName
                event_id = $first.Id
                count    = $group.Count
                sample   = ($first.Message -split "`n")[0].Substring(0, [math]::Min(200, ($first.Message -split "`n")[0].Length))
            }
            if ($entry) {
                # Allowlisted -- but raise as warning if count exceeds the configured max for this window.
                if ($group.Count -gt [int]$entry.max_7d) {
                    Add-Finding warning 'EventLog' ("ANOMALY: allowlisted event {0}/{1} exceeded 7d max -- observed {2}, max {3}. Investigate why rate changed." -f $first.ProviderName, $first.Id, $group.Count, $entry.max_7d) $item
                } else {
                    $item.reason = $entry.reason
                    $suppressed += $item
                }
            } else {
                $recurring += $item
                $sev = if ($group.Count -ge 100) { 'warning' } else { 'info' }
                Add-Finding $sev 'EventLog' "Recurring error: $($first.ProviderName) event $($first.Id) occurred $($group.Count) times in 7 days" $item $false -Why "A single event in the Windows Event Log is usually noise. A recurring pattern (same EventID, same source, multiple times per day) indicates a service, driver, or hardware component that's failing silently. Hyper-V VmSwitch errors (event 76) often trace to a virtual network adapter that WSL / Docker / a VM left in a bad state; usually benign on the host but worth investigating. Click Investigate with Claude to have Claude read the Event Log around this event and identify the root cause."
            }
        }
    }
    $report.metrics.event_errors_7d.recurring  = $recurring
    $report.metrics.event_errors_7d.suppressed = $suppressed

    # Specific problem signatures (v2.4.34: split BSOD from unexpected shutdown).
    # Event 41 Kernel-Power alone is NOT a BSOD -- it fires on ANY unclean boot
    # (power loss, forced reset, system hang, PSU cutoff). Prior logic treated
    # 41 + 1001 the same, which produced false-positive BSOD alerts every time
    # Windows booted after any unclean event. Fix: require BugCheck event 1001
    # OR a minidump file < 7 days old to call it a BSOD.
    $bugCheckEvents     = @($sysErrors | Where-Object { $_.Id -eq 1001 -and $_.ProviderName -match 'BugCheck' })
    $minidumps          = @(Get-ChildItem 'C:\Windows\Minidump\*.dmp' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $since })
    $unexpectedShutdown = @($sysErrors | Where-Object { $_.Id -eq 41 -and $_.ProviderName -match 'Kernel-Power' })

    if ($bugCheckEvents.Count -gt 0 -or $minidumps.Count -gt 0) {
        # v2.4.37 (code-reviewer): use BugCheck event count as authoritative.
        # Minidump files can accumulate from OUTSIDE the 7-day window and
        # linger (Windows doesn't auto-purge), which overstated the count
        # with the prior Math::Max. Minidumps remain part of the detection
        # OR-gate (so a BSOD with no event log entry still fires), but the
        # displayed count reflects only the events Windows recorded in the
        # scanned window.
        $bsodCount = if ($bugCheckEvents.Count -gt 0) { $bugCheckEvents.Count } else { $minidumps.Count }
        Add-Finding warning 'Stability' "BSOD detected in last 7 days (count: $bsodCount)" $null $false -Why "A true BSOD writes a BugCheck event (ID 1001) and a minidump file to C:\Windows\Minidump. Analyze Latest Minidump runs WinDbg's !analyze -v against those .dmp files to identify the faulting module. If the analyzer returns empty fields, WinDbg couldn't load symbols -- the raw output is still shown so Claude can interpret it."
    }

    if ($unexpectedShutdown.Count -gt 0 -and $bugCheckEvents.Count -eq 0 -and $minidumps.Count -eq 0) {
        Add-Finding info 'Stability' "Unexpected shutdown(s) in last 7 days: $($unexpectedShutdown.Count) (Event 41; no BSOD evidence)" $null $false -Why "Event 41 'Kernel-Power' fires whenever Windows boots without a clean prior shutdown. Causes include power loss, forced reset, PSU cutoff, or holding the power button through a hang. Without a matching BugCheck event 1001 or a file in C:\Windows\Minidump, this is not a BSOD -- it's logged here for visibility only and does not trigger an alert."
    }
} catch { Log "Event log error: $_" }

# =================================================================
# 4. WINDOWS SEARCH INDEX HEALTH + NAS scope leak check
# =================================================================
Log "Checking Windows Search..."
try {
    $ws = Get-Service WSearch -EA SilentlyContinue
    if ($ws) {
        $report.metrics.windows_search = @{ status = "$($ws.Status)"; start = "$($ws.StartType)" }
        if ($ws.Status -ne 'Running' -and $ws.StartType -ne 'Disabled') {
            Add-Finding warning 'Search' 'Windows Search service is not running - Explorer will be slow'
        }
        # Check recent Search errors, but only AFTER the most recent rebuild.
        # Three signals, whichever is newest wins:
        #   1) EventID 1004 "Full Index Reset" (Windows-initiated rebuild)
        #   2) Our own rebuild marker at baseline\search-rebuilt.marker
        #      (written by Rebuild-SearchIndex.ps1 on success)
        #   3) WSearch service start time (any restart wipes the in-memory
        #      state that would keep throwing the same corruption errors)
        # Reviewer-observed bug v2.3.14: previous check only used (1), so a
        # successful rebuild via our script didn't clear the finding unless
        # Windows happened to log Event 1004 - which it doesn't when the
        # rebuild is user-initiated via folder-delete + service restart.
        $cutoffs = @()
        $lastReset = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Search'; Id=1004; StartTime=(Get-Date).AddDays(-7)} -MaxEvents 1 -EA SilentlyContinue |
                     Where-Object { $_.Message -match 'Full Index Reset' } |
                     Select-Object -First 1
        if ($lastReset) { $cutoffs += $lastReset.TimeCreated }
        $markerPath = 'C:\ProgramData\PCDoctor\baseline\search-rebuilt.marker'
        if (Test-Path $markerPath) {
            try { $cutoffs += (Get-Item $markerPath).LastWriteTime } catch {}
        }
        try {
            $wsearchStart = (Get-Process -Name SearchIndexer -EA SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1).StartTime
            if ($wsearchStart) { $cutoffs += $wsearchStart }
        } catch {}
        $newestCutoff = if ($cutoffs.Count -gt 0) { ($cutoffs | Sort-Object -Descending | Select-Object -First 1) } else { $null }
        $errWindowStart = if ($newestCutoff) { $newestCutoff.AddMinutes(2) } else { (Get-Date).AddDays(-2) }
        $searchErr = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Search'; Level=1,2; StartTime=$errWindowStart} -MaxEvents 10 -EA SilentlyContinue
        if ($searchErr | Where-Object { $_.Message -match 'Recovery phase failed|recreate the index' }) {
            Add-Finding warning 'Search' 'Windows Search index is corrupted and needs rebuild (Settings > Search > Advanced > Rebuild)'
        }
        # NAS index-scope leak check -- critical for this PC (caused 2026-04-15 cascade freeze)
        try {
            $mgr = New-Object -ComObject Microsoft.Search.Administration.SearchManager -EA Stop
            $cat = $mgr.GetCatalog("SystemIndex")
            $csm = $cat.GetCrawlScopeManager()
            $rules = $csm.EnumerateScopeRules()
            $nasPaths = @()
            foreach ($r in $rules) {
                if ($r.IsIncluded -and ($r.PatternOrURL -match '^\\\\' -or $r.PatternOrURL -match '^(file:)?(\\\\|[B-Z]:\\?)')) {
                    # Flag any UNC path (\\server\share) OR a mapped drive letter known to be NAS-backed
                    $pattern = $r.PatternOrURL
                    if ($pattern -match '\\\\192\.168\.50\.226' -or $pattern -match '^(file:\/\/\/)?[MZWVBU]:\\?') {
                        $nasPaths += $pattern
                    }
                }
            }
            if ($nasPaths.Count -gt 0) {
                Add-Finding critical 'Search' "NAS paths are in Windows Search index scope -- will cause Explorer freezes under heavy NAS load. Remove via Control Panel -> Indexing Options -> Modify." @{ nas_paths = $nasPaths }
            }
            $report.metrics.windows_search.nas_in_scope = $nasPaths
        } catch {
            Log "Search scope check failed: $_"
        }
    }
} catch { Log "Search check error: $_" }

# =================================================================
# 5. SHELL OVERLAY HANDLER PRESSURE (Explorer lag cause)
# =================================================================
Log "Checking shell overlay handlers..."
try {
    $overlays = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers' -EA SilentlyContinue
    $totalCount = ($overlays | Measure-Object).Count
    # Fix-Shell-Overlays.ps1 renames deprioritized duplicates with a "ZZZZ" prefix
    # so Windows' alphabetical top-15 cutoff skips them. Count only the effective
    # (non-tombstoned) handlers for the finding threshold; keep totals visible for debug.
    $active = $overlays | Where-Object { $_.PSChildName -notmatch '^\s*ZZZZ\s' }
    $activeCount = ($active | Measure-Object).Count
    $report.metrics.shell_overlay_count = $activeCount
    $report.metrics.shell_overlay_total = $totalCount
    $report.metrics.shell_overlay_tombstoned = $totalCount - $activeCount
    if ($activeCount -gt 15) {
        # Identify likely-redundant overlays among the ACTIVE set
        $byPrefix = $active | Group-Object { $_.PSChildName.Trim() -replace '\d+$','' } | Where-Object Count -gt 1
        Add-Finding warning 'Explorer' "Shell has $activeCount active overlay handlers (Windows honors only 15). Excess handlers waste CPU on folder renders." @{
            active_count     = $activeCount
            total_count      = $totalCount
            tombstoned_count = ($totalCount - $activeCount)
            redundant_groups = ($byPrefix | ForEach-Object { @{ prefix = $_.Name; count = $_.Count } })
        }
    }
} catch { Log "Overlay check error: $_" }

# =================================================================
# 6. PENDING REBOOT
# =================================================================
$pend = @()
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') { $pend += 'CBS' }
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { $pend += 'WU' }

# PendingFileRenameOperations can be a permanent no-op because Gaming Services
# (and a few other MS components) register rename-on-reboot for a DLL they
# re-lock at boot - the rename NEVER completes. Filter known-stuck entries
# before deciding whether to flag. Only flag if there is at least one
# actionable entry remaining.
$pfroBenignPatterns = @(
    'gamingservicesproxy_e\.dll',           # Microsoft Gaming Services re-registers every boot
    'gamingservices_e\.dll',
    'InstallerService',                     # Known to queue stale renames after MSIX upgrades
    # v2.4.6: Chrome / Edge / Firefox auto-updaters queue old-binary deletes
    # into their Temp folders and never finish if the browser is running at
    # reboot time. Safe to treat as benign; the `Clear Stale Pending Renames`
    # action proactively scrubs them from the queue.
    # (?:\\|$) catches both the subfolder form (\Chrome\Temp\...) and the
    # bare-dir form (...\Chrome\Temp at end of entry string). Without the
    # end anchor, the bare-dir entry silently slipped past the filter and
    # kept PendingFileRename flagged even after a Clear action ran.
    # v2.4.37 (critical): ALL patterns use DOUBLE backslash (`\\`), not
    # quadruple. In a PS single-quoted string, `\\` is 2 literal chars,
    # which .NET regex parses as ONE escape + literal backslash = matches
    # a single `\` in input. Registry PendingFileRenameOperations strings
    # have single backslashes between path components, so `\\` matches
    # correctly. The previous `\\\\` form (4 literal chars → regex
    # escape-for-\ + escape-for-\ = matches TWO consecutive backslashes)
    # never matched ANY realistic input. Verified via
    # `scripts/test-pfro-pattern-match.ps1`, which is now a pre-ship gate.
    '\\Google\\Chrome\\Temp(?:\\|$)',
    '\\Microsoft\\Edge\\Temp(?:\\|$)',
    '\\Mozilla Firefox\\updated(?:\\|$)',
    # Firefox staging dirs use a GUID suffix -- mirror the scrub script's
    # pattern so scanner and scrub stay in sync.
    '\\Mozilla Firefox\\[0-9a-f-]+(?:\\|$)',
    # Office Click-to-Run + print-spooler V4 driver rename-on-reboot
    # queues. Observed on Greg's box: 17 entries surviving reboots.
    '\\Common Files\\microsoft shared\\ClickToRun\\backup(?:\\|$)',
    '\\Common Files\\microsoft shared\\ClickToRun\\Updates(?:\\|$)',
    '\\Microsoft Office\\Updates\\Apply\\FilesInUse(?:\\|$)',
    '\\System32\\spool\\V4Dirs(?:\\|$)'
)
$pfro = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -EA SilentlyContinue
if ($pfro) {
    $rawEntries = @($pfro.PendingFileRenameOperations | Where-Object { $_ -and $_.Length -gt 0 })
    $actionable = @()
    foreach ($e in $rawEntries) {
        $isBenign = $false
        foreach ($pat in $pfroBenignPatterns) {
            if ($e -match $pat) { $isBenign = $true; break }
        }
        if (-not $isBenign) { $actionable += $e }
    }
    if ($actionable.Count -gt 0) { $pend += 'PendingFileRename' }
    # else: all entries are known-stuck; don't flag.
}

$report.metrics.pending_reboot = $pend
if ($pend) {
    $uptimeH = $report.metrics.uptime_hours
    $sev = if ($uptimeH -gt 168) { 'warning' } else { 'info' }
    $rebootWhy = if ($pend -contains 'PendingFileRename' -and $pend.Count -eq 1) {
        "The only pending operation is a file-rename queue. If this flag has survived multiple reboots, the stuck entries are almost certainly browser auto-updater leftovers (Chrome's old_chrome.exe deletes that never complete when Chrome is running at reboot time). Run Clear Stale Pending Renames to scrub those entries so the flag clears without another reboot."
    } else {
        "Windows queued a file rename, service restart, or component update that only completes on reboot. Ignoring it leaves the system half-patched -- new Windows Updates may refuse to install until you reboot. If CBS / WU flags are present, a real reboot IS needed; PendingFileRename alone is usually benign updater leftovers (use Clear Stale Pending Renames)."
    }
    Add-Finding $sev 'Reboot' "Pending reboot flags: $($pend -join ', ') (uptime $uptimeH h)" @{ flags = $pend; uptime_hours = $uptimeH } $false -Why $rebootWhy
}

# =================================================================
# 7. STARTUP BLOAT
# =================================================================
Log "Auditing startup entries..."
try {
    $rawStartup = @(Get-CimInstance Win32_StartupCommand -EA SilentlyContinue)
    $report.metrics.startup_count_raw = $rawStartup.Count

    # Win32_StartupCommand enumerates HKU\* for every loaded hive, which includes
    # well-known service accounts (SYSTEM/LOCAL SERVICE/NETWORK SERVICE). Entries
    # there don't fire on interactive logon -- they're phantom counts that
    # triple-count installers like OneDrive/GoogleDriveFS. Filter them out.
    $serviceSidPatterns = @(
        'HKU\\S-1-5-18',            # LocalSystem
        'HKU\\S-1-5-19',            # LocalService
        'HKU\\S-1-5-20',            # NetworkService
        'HKU\\S-1-5-21-.*_Classes', # per-user *_Classes hives (not real user accounts)
        'HKU\\S-1-5-82',            # AppPoolIdentity
        'HKU\\S-1-5-90',            # WindowManager
        'HKU\\S-1-5-96',            # FontDriverHost
        'HKU\\\\.DEFAULT'           # default profile for not-yet-logged-in users
    )
    $serviceSidRegex = ($serviceSidPatterns -join '|')

    $startup = $rawStartup | Where-Object { $_.Location -notmatch $serviceSidRegex }
    $startup = @($startup)

    # Check Windows' StartupApproved registry to exclude user-disabled entries.
    # Task Manager's Startup tab writes byte[0] = 0x03 (vs 0x02 enabled) here.
    $approvedPaths = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32'
    )
    $disabledNames = @{}
    foreach ($apath in $approvedPaths) {
        if (Test-Path $apath) {
            try {
                $props = Get-ItemProperty -Path $apath -ErrorAction SilentlyContinue
                foreach ($p in $props.PSObject.Properties) {
                    if ($p.Name -match '^PS' -or $p.Name -eq '(default)') { continue }
                    if ($p.Value -is [byte[]] -and $p.Value.Length -ge 1 -and $p.Value[0] -eq 0x03) {
                        # Store both raw name and without .lnk so matching works for both folders and registry
                        $disabledNames[$p.Name] = $true
                        $disabledNames[($p.Name -replace '\.lnk$','')] = $true
                    }
                }
            } catch {}
        }
    }
    $startupEnabled = $startup | Where-Object { -not $disabledNames.ContainsKey($_.Name) }
    $startupEnabled = @($startupEnabled)

    $report.metrics.startup_count = $startupEnabled.Count
    $report.metrics.startup_count_phantom = $rawStartup.Count - $startup.Count
    $report.metrics.startup_count_user_disabled = $startup.Count - $startupEnabled.Count
    $startup = $startupEnabled

    # v2.3.0 C1: emit a full-context list of every enabled startup item so the
    # renderer's StartupPickerModal can let the user multi-select without
    # needing another IPC round-trip. Essential apps are marked is_essential=true
    # and get pre-unchecked by the UI.
    $essentialRegex = '^(SecurityHealth|Windows Security|OneDrive|Microsoft Teams|MicrosoftEdgeAutoLaunch|GoogleDriveFS|Notifiarr|LGHUB|PrivateVpnAutoLaunch|RtkAudUService|GoldKey|Docker Desktop|Plex)'

    # v2.4.13: read user-configured startup threshold + allowlist from the
    # sidecar JSON written by main.ts's syncStartupConfigToDisk(). Missing
    # or malformed file -> defaults (threshold=20, empty allowlist). The
    # allowlist is a HashSet of "<kind>::<name>" keys matching how the UI
    # identifies items in StartupPickerModal.
    $startupThreshold = 20
    $startupAllowlist = New-Object System.Collections.Generic.HashSet[string]
    try {
        $startupConfigPath = 'C:\ProgramData\PCDoctor\settings\startup.json'
        if (Test-Path $startupConfigPath) {
            $scfg = Get-Content $startupConfigPath -Raw -ErrorAction Stop | ConvertFrom-Json
            if ($scfg.threshold -is [int] -and $scfg.threshold -ge 5 -and $scfg.threshold -le 200) {
                $startupThreshold = [int]$scfg.threshold
            }
            if ($scfg.allowlist -is [System.Array]) {
                foreach ($k in $scfg.allowlist) {
                    if ($k -is [string] -and $k) { [void]$startupAllowlist.Add($k) }
                }
            }
        }
    } catch { Log "startup config read error: $_" }

    $report.metrics.startup_items = @(
        foreach ($e in $startupEnabled) {
            $loc = "$($e.Location)"
            $kind = if ($loc -match 'HKCU.*Run') { 'Run' }
                    elseif ($loc -match 'HKLM.*Run') { 'HKLM_Run' }
                    elseif ($loc -match 'Startup') { 'StartupFolder' }
                    else { 'Run' }
            $path = "$($e.Command)"
            $sizeBytes = $null
            # Best-effort size lookup for resolved file paths
            try {
                $m = [regex]::Match($path, '"?([A-Z]:\\[^"]+?\.(exe|dll|lnk|cmd|bat|scr))')
                if ($m.Success) {
                    $fp = $m.Groups[1].Value
                    if (Test-Path $fp) {
                        $sizeBytes = (Get-Item $fp -ErrorAction SilentlyContinue).Length
                    }
                }
            } catch {}
            $itemKey = "$kind::$($e.Name)"
            @{
                name = "$($e.Name)"
                location = $loc
                kind = $kind
                is_essential = ("$($e.Name)" -match $essentialRegex)
                disabled_in_registry = $false
                publisher = "$($e.User)"
                path = $path
                size_bytes = $sizeBytes
                # v2.4.13: surface allowlist state to the UI so the picker
                # can render the "Never warn" toggle in the right state.
                allowlisted = $startupAllowlist.Contains($itemKey)
            }
        }
    )

    # v2.4.13: count used for the warn check excludes allowlisted items.
    # Display count ($startup.Count) is unchanged - we still show "32 real
    # entries" in the message so the user sees the true count.
    $countForWarning = 0
    foreach ($e in $startupEnabled) {
        $loc = "$($e.Location)"
        $kind = if ($loc -match 'HKCU.*Run') { 'Run' }
                elseif ($loc -match 'HKLM.*Run') { 'HKLM_Run' }
                elseif ($loc -match 'Startup') { 'StartupFolder' }
                else { 'Run' }
        if (-not $startupAllowlist.Contains("$kind::$($e.Name)")) {
            $countForWarning++
        }
    }
    $report.metrics.startup_threshold = $startupThreshold
    $report.metrics.startup_allowlist_count = $startupAllowlist.Count

    if ($countForWarning -gt $startupThreshold) {
        # Pick a top candidate to disable: favor HKCU Run entries (user-writable,
        # safest to disable) and skip items whose name looks load-bearing.
        # User-specific keeps (Greg): Notifiarr routes phone alerts, LGHUB drives
        # keyboard/mouse, PrivateVpn for security, cloud sync apps for work state.
        $essential = @(
            'SecurityHealth','Windows Security','OneDrive','Microsoft Teams','MicrosoftEdgeAutoLaunch',
            'GoogleDriveFS','Notifiarr','LGHUB','PrivateVpnAutoLaunch','RtkAudUService','GoldKey'
        )
        $candidate = $startup |
            Where-Object { $_.Location -match 'HKCU.*Run' -or $_.Location -match 'Startup' } |
            Where-Object {
                $n = $_.Name
                -not ($essential | Where-Object { $n -like "*$_*" })
            } |
            Select-Object -First 1
        if (-not $candidate) { $candidate = $startup | Select-Object -First 1 }

        $itemName = if ($candidate) { $candidate.Name } else { $null }
        $sampleList = ($startup | Select-Object -First 5 Name, Location | ForEach-Object { "$($_.Name) [$($_.Location)]" })

        $detail = [ordered]@{
            count             = $startup.Count
            count_for_warning = $countForWarning
            threshold         = $startupThreshold
            allowlist_count   = $startupAllowlist.Count
            phantom_filtered  = $rawStartup.Count - $startup.Count
            raw_count         = $rawStartup.Count
            samples           = $sampleList
            item_name         = $itemName
            suggested_target_location = if ($candidate) { $candidate.Location } else { $null }
        }
        $phantomNote = if ($rawStartup.Count -ne $startup.Count) { " (filtered $($rawStartup.Count - $startup.Count) phantom entries from service-account hives)" } else { "" }
        $allowNote = if ($startupAllowlist.Count -gt 0) { " ($($startupAllowlist.Count) allowlisted, $countForWarning counted)" } else { "" }
        $msg = if ($itemName) {
            "$($startup.Count) real auto-start entries$phantomNote$allowNote (healthy: under $startupThreshold). Fix button disables '$itemName' as a starting point; use Autoruns for the rest."
        } else {
            "$($startup.Count) real auto-start entries$phantomNote$allowNote (healthy: under $startupThreshold). Boot time and idle RAM suffer."
        }
        Add-Finding warning 'Startup' $msg $detail $false -Why "Windows auto-starts programs from ~15 different registry and folder locations at every boot. Each entry adds startup time plus background memory. Healthy is under the threshold you configure (default 20; phantom service-account rows are filtered out and do not count). You can raise the threshold or mark specific entries as 'Never warn' from the Fix button's picker - v2.4.13 replaces the old hardcoded 20/25 split. For bulk cleanup, Sysinternals Autoruns remains the gold standard."
    }
} catch { Log "Startup error: $_" }

# =================================================================
# 8. TOP MEMORY CONSUMERS (snapshot)
# =================================================================
try {
    $topMem = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 |
              ForEach-Object { @{ name = $_.Name; pid = $_.Id; ram_mb = [math]::Round($_.WorkingSet64 / 1MB, 0) } }
    $report.metrics.top_memory = $topMem
} catch { Log "Top memory error: $_" }

# =================================================================
# 8b. WSL CONFIG + MEMORY PRESSURE (v2.3.0 - B4 + C3)
#     Scanner emits enough to power the RamPressurePanel + the WSL-aware
#     apply_wsl_cap recommendation. Never fatal if Get-Counter is unavailable.
# =================================================================
try {
    $wslConfig = @{
        exists = Test-Path "$env:USERPROFILE\.wslconfig"
        has_memory_cap = $false
        memory_gb = $null
        vmmem_utilization_pct = $null
    }
    if ($wslConfig.exists) {
        $content = Get-Content "$env:USERPROFILE\.wslconfig" -Raw -ErrorAction SilentlyContinue
        if ($content -match 'memory\s*=\s*(\d+)\s*GB') {
            $wslConfig.has_memory_cap = $true
            $wslConfig.memory_gb = [int]$Matches[1]
        }
    }
    $vmmem = Get-Process -Name 'vmmemWSL','vmmem' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($vmmem -and $wslConfig.memory_gb) {
        $wslCapBytes = $wslConfig.memory_gb * 1GB
        $wslConfig.vmmem_utilization_pct = [math]::Round(($vmmem.WorkingSet64 / $wslCapBytes) * 100, 1)
    }
    $report.metrics.wsl_config = $wslConfig
} catch { Log "WSL config error: $_" }

try {
    $memPressure = @{
        committed_bytes = $null
        commit_limit = $null
        pages_per_sec = $null
        page_faults_per_sec = $null
        compression_mb = $null
        top_processes = @()
    }
    try {
        $mem = Get-Counter -Counter '\Memory\Committed Bytes','\Memory\Commit Limit','\Memory\Pages/sec','\Memory\Page Faults/sec' -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue
        if ($mem) {
            foreach ($s in $mem.CounterSamples) {
                switch -Wildcard ($s.Path) {
                    '*committed bytes*'      { $memPressure.committed_bytes      = [int64]$s.CookedValue }
                    '*commit limit*'         { $memPressure.commit_limit         = [int64]$s.CookedValue }
                    '*pages/sec*'            { $memPressure.pages_per_sec        = [math]::Round($s.CookedValue, 1) }
                    '*page faults/sec*'      { $memPressure.page_faults_per_sec  = [math]::Round($s.CookedValue, 1) }
                }
            }
        }
    } catch {}
    try {
        $compProc = Get-Process -Name 'MemCompression' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($compProc) {
            $memPressure.compression_mb = [math]::Round($compProc.WorkingSet64 / 1MB, 0)
        }
    } catch {}

    # Top 5 memory consumers with a rough user/service/system classification so
    # the UI can decide whether to show a Kill or Restart button.
    $sysProcs = @('System','Registry','MemCompression','Idle','Secure System','csrss','smss','wininit','services','lsass','winlogon','fontdrvhost','dwm')
    $srvRegex = '^(Svc|svchost|WmiPrv|spool|TrustedInstaller|RuntimeBroker|sihost|ctfmon)$'
    $top = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5
    $memPressure.top_processes = @(
        foreach ($p in $top) {
            $kind = if ($sysProcs -contains $p.Name) { 'system' }
                    elseif ($p.Name -match $srvRegex) { 'service' }
                    else { 'user' }
            @{
                name = $p.Name
                pid = $p.Id
                ws_bytes = $p.WorkingSet64
                kind = $kind
            }
        }
    )
    $report.metrics.memory_pressure = $memPressure
} catch { Log "Memory pressure error: $_" }

# =================================================================
# 9. NAS & SMB HEALTH (new in 2026-04-16 revision)
#    The 2026-04-15 cascade freeze originated here. Critical to monitor.
# =================================================================
Log "Checking NAS and SMB health..."
try {
    # ===== NAS section (robust detection) =====
    # v2.4.6: NAS server IP moved to the settings sidecar at
    # C:\ProgramData\PCDoctor\settings\nas.json. Scanner reads that if
    # present and falls back to the pre-v2.4.6 Greg default so upgrades
    # don't break existing installs that haven't opened Workbench yet.
    $nasIp = '192.168.50.226'
    try {
        $nasCfgPath = 'C:\ProgramData\PCDoctor\settings\nas.json'
        if (Test-Path $nasCfgPath) {
            $cfg = Get-Content $nasCfgPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            if ($cfg.nas_server) { $nasIp = "$($cfg.nas_server)" }
        }
    } catch { }
    $nasData = @{
        ip = $nasIp
        ping = $false
        smb_port_open = $false
        session_timeout = $null
        extended_session_timeout = $null
        mappings = @()
        persistent_registry_maps = @()
    }
    try {
        $nasData.ping = Test-Connection -ComputerName $nasIp -Count 1 -Quiet -ErrorAction SilentlyContinue
    } catch {}
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $task = $tcp.BeginConnect($nasIp, 445, $null, $null)
        $nasData.smb_port_open = $task.AsyncWaitHandle.WaitOne(3000, $false) -and $tcp.Connected
        $tcp.Close()
    } catch { $nasData.smb_port_open = $false }
    try {
        $smbClient = Get-SmbClientConfiguration -ErrorAction SilentlyContinue
        if ($smbClient) {
            $nasData.session_timeout = $smbClient.SessionTimeout
            $nasData.extended_session_timeout = $smbClient.ExtendedSessionTimeout
        }
    } catch {}

    # Source 1: Get-SmbMapping (user session only -- may return empty when run as SYSTEM)
    try {
        $smbMaps = Get-SmbMapping -ErrorAction SilentlyContinue
        foreach ($m in $smbMaps) {
            $nasData.mappings += @{
                local = $m.LocalPath
                remote = $m.RemotePath
                status = "$($m.Status)"
                source = 'smb'
            }
        }
    } catch {}

    # Source 2: net use output parsing -- works as SYSTEM
    try {
        $netUseOutput = & net use 2>&1 | Out-String
        $lines = $netUseOutput -split "`r?`n"
        foreach ($line in $lines) {
            if ($line -match '^\s*(OK|Disconnected|Unavailable)?\s+([A-Z]:)\s+(\\\\[^\s]+)') {
                $status = if ($Matches[1]) { $Matches[1] } else { 'OK' }
                $local = $Matches[2]
                $remote = $Matches[3]
                # Only add if not already in mappings
                if (-not ($nasData.mappings | Where-Object { $_.local -eq $local })) {
                    $nasData.mappings += @{ local = $local; remote = $remote; status = $status; source = 'netuse' }
                }
            }
        }
    } catch {}

    # Source 3: HKCU Network registry (persistent mappings per user)
    try {
        $regPath = 'Registry::HKEY_USERS'
        $userHives = Get-ChildItem -Path $regPath -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'S-1-5-21' -and $_.Name -notmatch '_Classes$' }
        foreach ($hive in $userHives) {
            $networkKey = "$($hive.PSPath)\Network"
            if (Test-Path $networkKey) {
                $letters = Get-ChildItem -Path $networkKey -ErrorAction SilentlyContinue
                foreach ($l in $letters) {
                    $props = Get-ItemProperty -Path $l.PSPath -ErrorAction SilentlyContinue
                    if ($props -and $props.RemotePath) {
                        $nasData.persistent_registry_maps += @{
                            letter = "$($l.PSChildName):"
                            remote = $props.RemotePath
                            user_sid = $hive.PSChildName
                        }
                        # Also promote into mappings if not there yet
                        if (-not ($nasData.mappings | Where-Object { $_.local -eq "$($l.PSChildName):" })) {
                            $nasData.mappings += @{
                                local = "$($l.PSChildName):"
                                remote = $props.RemotePath
                                status = 'Persistent'
                                source = 'registry'
                            }
                        }
                    }
                }
            }
        }
    } catch {}

    # SessionTimeout finding (unchanged behavior)
    if ($nasData.session_timeout -and $nasData.session_timeout -gt 30) {
        Add-Finding warning 'NAS' "SMB SessionTimeout is $($nasData.session_timeout)s (target <=30s). High timeout lets a wedged NAS freeze Explorer for up to this duration." @{ session_timeout = $nasData.session_timeout }
    }

    # Ping / SMB port findings
    if (-not $nasData.ping) {
        Add-Finding critical 'NAS' "NAS $nasIp not responding to ping. Plex libraries, Backups, all 6 mapped drives are offline until NAS recovers."
    } elseif (-not $nasData.smb_port_open) {
        Add-Finding critical 'NAS' "NAS reachable via ping but SMB port 445 NOT answering. Samba service likely crashed on QNAP (check RAM disk: ssh admin@$nasIp, then df -h /)."
    }

    # Count mappings that EXIST (registered) and ones that are actively connected.
    $expected = @('M:','Z:','W:','V:','B:','U:')
    $registered = @($nasData.mappings | ForEach-Object { $_.local })
    $unavailable = @($nasData.mappings | Where-Object { "$($_.status)" -eq 'Unavailable' } | ForEach-Object { $_.local })
    $missing = @($expected | Where-Object { $_ -notin $registered })
    if ($nasData.smb_port_open -and $missing.Count -gt 0) {
        Add-Finding warning 'NAS' "Expected NAS drives not registered as persistent mappings: $($missing -join ', '). Run New-SmbMapping to restore." @{ missing = $missing }
    }
    if ($nasData.smb_port_open -and $unavailable.Count -gt 0) {
        Add-Finding warning 'NAS' "NAS drives in Unavailable state (auto-reconnect failed): $($unavailable -join ', '). Try Get-SmbMapping then accessing the drive in Explorer." @{ unavailable = $unavailable }
    }

    # Dedupe mappings by local-letter
    $seen = @{}
    $deduped = @()
    foreach ($m in $nasData.mappings) {
        $k = $m.local
        if (-not $seen.ContainsKey($k)) {
            $seen[$k] = $true
            $deduped += $m
        }
    }
    $nasData.mappings = $deduped
    $metrics = $report.metrics
    $metrics.nas = $nasData
    # ===== End NAS section =====
} catch {
    Log "NAS health error: $_"
    Add-Finding info 'NAS' "NAS health check errored: $_"
}

# =================================================================
# 10. SERVICE-SPECIFIC HEALTH (Cloudflared, Docker, critical services)
# =================================================================
Log "Checking critical services..."
try {
    $svcs = @{}
    $watchList = @(
        @{ name='Cloudflared';          display='Cloudflare Tunnel';            critical=$true; aliases=@('cloudflared','Cloudflare Tunnel') },
        @{ name='com.docker.service';   display='Docker Desktop Service';       critical=$true },
        @{ name='LanmanWorkstation';    display='SMB Client (Workstation)';     critical=$true },
        @{ name='LanmanServer';         display='SMB Server';                   critical=$false },
        @{ name='Dnscache';             display='DNS Client';                   critical=$true },
        @{ name='BITS';                 display='Background Intelligent Transfer'; critical=$false },
        @{ name='wuauserv';             display='Windows Update';               critical=$false }
    )
    foreach ($w in $watchList) {
        $svc = Get-Service -Name $w.name -ErrorAction SilentlyContinue
        if (-not $svc -and $w.aliases) {
            foreach ($alias in $w.aliases) {
                $svc = Get-Service -Name $alias -ErrorAction SilentlyContinue
                if ($svc) { break }
                # Also try fuzzy match on display name
                $svc = Get-Service | Where-Object { $_.DisplayName -like "*$alias*" -or $_.Name -like "*$alias*" } | Select-Object -First 1
                if ($svc) { break }
            }
        }
        if ($svc) {
            $svcs[$w.name] = @{ display=$w.display; status="$($svc.Status)"; start="$($svc.StartType)" }
            if ($svc.Status -ne 'Running' -and $svc.StartType -in 'Automatic','AutomaticDelayedStart') {
                $sev = if ($w.critical) { 'critical' } else { 'warning' }
                Add-Finding $sev 'Service' "$($w.display) ($($w.name)) is NOT running but startup type is $($svc.StartType)" $svcs[$w.name]
            }
        } else {
            $svcs[$w.name] = @{ display=$w.display; status='not_installed' }
        }
    }
    # Docker Desktop GUI check: the user-mode "Docker Desktop.exe" must also be running, not just the service.
    # On WSL2 backend (Greg's setup), the GUI is what actually orchestrates containers.
    $dockerProc = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue
    if ($dockerProc) {
        $svcs['DockerDesktopGUI'] = @{ display='Docker Desktop (user GUI)'; status="running ($($dockerProc.Count) procs)"; pid=$dockerProc[0].Id }
    } else {
        $svcs['DockerDesktopGUI'] = @{ display='Docker Desktop (user GUI)'; status='NOT RUNNING' }
        # Only critical if Docker is otherwise expected to be on (the service watch above already flags the service)
        Add-Finding warning 'Docker' "Docker Desktop GUI process not running. Containers will not function until Greg launches Docker Desktop. Auto-start should handle this on login -- if it didn't, check HKCU Run key 'Docker Desktop'."
    }

    # Cloudflared special-case: it's a Windows binary that may run as service OR as foreground process.
    # If the binary exists but neither service nor process is found, the tunnel is OFFLINE -- critical
    # because plex.gregpajak.com depends on it.
    $cfPaths = @(
        'C:\Program Files\cloudflared\cloudflared.exe',
        'C:\Program Files (x86)\cloudflared\cloudflared.exe'
    )
    $cfBin = $cfPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($cfBin) {
        $cfProc = Get-Process cloudflared -ErrorAction SilentlyContinue
        $cfSvc  = Get-CimInstance Win32_Service -Filter "Name='Cloudflared' OR Name='cloudflared'" -ErrorAction SilentlyContinue
        $cfState = if ($cfSvc -and $cfSvc.State -eq 'Running') {
            'service-running'
        } elseif ($cfSvc) {
            "service-$($cfSvc.State.ToLower())"
        } elseif ($cfProc) {
            'process-running'
        } else {
            'OFFLINE'
        }
        $svcs['Cloudflared'] = @{ display='Cloudflare Tunnel (cloudflared)'; status=$cfState; binary=$cfBin }
        if ($cfState -eq 'OFFLINE') {
            Add-Finding critical 'Cloudflared' "Cloudflare tunnel binary present but neither service nor process is running. plex.gregpajak.com is offline. Restore: 'cd ''$($cfBin | Split-Path)''; .\cloudflared.exe service install; Start-Service Cloudflared'." @{ binary=$cfBin }
        } elseif ($cfState -like 'service-*' -and $cfState -ne 'service-running') {
            Add-Finding warning 'Cloudflared' "Cloudflare tunnel service is $cfState. plex.gregpajak.com may be offline." @{ state=$cfState }
        }
    }

    # WSL check: prefer the real Windows service (WSLService on Win11 / LxssManager legacy).
    # Avoid wsl.exe --status because it returns UTF-16 nonsense from SYSTEM context.
    $wslSvc = Get-Service -Name 'WSLService','LxssManager' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($wslSvc) {
        $svcs[$wslSvc.Name] = @{
            display = 'Windows Subsystem for Linux'
            status  = "$($wslSvc.Status)"
            start   = "$($wslSvc.StartType)"
        }
    } else {
        $svcs['WSLService'] = @{
            display = 'Windows Subsystem for Linux'
            status  = 'Not installed'
            start   = 'N/A'
        }
    }
    $report.metrics.services = $svcs
} catch { Log "Service check error: $_" }

# =================================================================
# 11. SAFE AUTO-CLEANUP (Auto / DeepScan modes only)
#     Handle both user-context and SYSTEM-context TEMP paths.
# =================================================================
if ($Mode -ne 'Report') {
    Log "Running safe cleanup..."
    # Enumerate TEMP for all user profiles (works under SYSTEM where $env:TEMP == C:\Windows\Temp)
    $userTemps = @()
    try {
        $userTemps = Get-ChildItem 'C:\Users' -Directory -EA SilentlyContinue |
                     Where-Object { $_.Name -notin 'Public','Default','All Users','Default User' } |
                     ForEach-Object { Join-Path $_.FullName 'AppData\Local\Temp' } |
                     Where-Object { Test-Path $_ }
    } catch {}

    $tempPaths = @(
        $env:TEMP,
        'C:\Windows\Temp',
        "$env:LOCALAPPDATA\Microsoft\Windows\INetCache",
        'C:\Windows\SoftwareDistribution\Download'
    ) + $userTemps | Where-Object { $_ -and (Test-Path $_) } | Sort-Object -Unique

    $totalFreed = 0
    foreach ($p in $tempPaths) {
        try {
            $before = (Get-ChildItem $p -Recurse -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum
            # Only delete files older than 1 day to avoid active temp files
            Get-ChildItem $p -Recurse -Force -File -EA SilentlyContinue |
                Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
                Remove-Item -Force -EA SilentlyContinue
            $after = (Get-ChildItem $p -Recurse -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum
            $freed = (($before - $after) / 1MB)
            if ($freed -lt 0) { $freed = 0 }
            $totalFreed += $freed
            if ($freed -ge 1) {
                Add-Action "Cleared old files from $p" "Freed $([math]::Round($freed, 0)) MB"
            }
        } catch { Log "Cleanup $p error: $_" }
    }
    $report.metrics.temp_freed_mb = [math]::Round($totalFreed, 0)
}

# =================================================================
# 12. DEEP SCAN (DeepScan mode only -- runs sfc + DISM, takes time)
# =================================================================
if ($Mode -eq 'DeepScan') {
    Log "Running DISM /RestoreHealth (may take 10-30 min)..."
    try {
        $dismOut = & DISM /Online /Cleanup-Image /RestoreHealth 2>&1 | Out-String
        $dismOk = $dismOut -match 'The restore operation completed successfully|No component store corruption detected'
        Add-Action "DISM /RestoreHealth" $(if ($dismOk) { 'OK' } else { 'See run.log for details' })
        $dismOut | Out-File -Append "$reportDir\dism-output.log"
        if (-not $dismOk) {
            Add-Finding warning 'Integrity' 'DISM did not report clean completion -- review dism-output.log'
        }
    } catch { Log "DISM error: $_" }

    Log "Running sfc /scannow (may take 5-15 min)..."
    try {
        $sfcOut = & sfc /scannow 2>&1 | Out-String
        $sfcOk = $sfcOut -match 'did not find any integrity violations|successfully repaired them'
        if ($sfcOut -match 'found corrupt files.+could not fix') {
            Add-Finding critical 'Integrity' 'SFC found corrupt files it could NOT repair - manual intervention needed'
        }
        Add-Action "sfc /scannow" $(if ($sfcOk) { 'OK' } else { 'See run.log' })
        $sfcOut | Out-File -Append "$reportDir\sfc-output.log"
    } catch { Log "SFC error: $_" }
}

# =================================================================
# SUMMARY
# =================================================================
$critCount = ($report.findings | Where-Object severity -eq 'critical').Count
$warnCount = ($report.findings | Where-Object severity -eq 'warning').Count
$infoCount = ($report.findings | Where-Object severity -eq 'info').Count
$report.summary = @{
    critical = $critCount
    warning  = $warnCount
    info     = $infoCount
    overall  = if ($critCount) { 'CRITICAL' } elseif ($warnCount -ge 3) { 'ATTENTION' } elseif ($warnCount) { 'OK-minor' } else { 'HEALTHY' }
}

Log "Writing report..."
# v2.4.47 (B46-3a): write report.json WITHOUT a UTF-8 BOM. PowerShell 5.1's
# `Out-File -Encoding UTF8` emits a BOM (EF BB BF), which breaks downstream
# JSON.parse() in the Electron renderer (and many JSON parsers in general,
# which expect raw UTF-8 per RFC 8259). Use [System.IO.File]::WriteAllText
# with UTF8Encoding($false) to write without the BOM. The latest.json copy
# (later via Copy-Item + Move-Item) inherits the BOM-less bytes verbatim.
$reportJson = $report | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($jsonPath, $reportJson, (New-Object System.Text.UTF8Encoding($false)))

# Markdown summary for humans
$md = @()
$md += "# PC Doctor Report"
$md += ""
$md += "**Timestamp:** $($report.timestamp)"
$md += "**Mode:** $Mode"
$md += "**Overall status:** $($report.summary.overall)"
$md += ""
$md += "## Summary"
$md += "- Critical findings: $critCount"
$md += "- Warnings: $warnCount"
$md += "- Informational: $infoCount"
if ($report.metrics.event_errors_7d.suppressed) {
    $md += "- Suppressed (known-quiet): $($report.metrics.event_errors_7d.suppressed.Count) event patterns"
}
$md += ""
$md += "## System"
$md += "- OS build: $($report.metrics.os_build)"
$md += "- RAM: $($report.metrics.ram_free_gb) GB free of $($report.metrics.ram_total_gb) GB ($($report.metrics.ram_used_pct)% used)"
$md += "- CPU load at check: $($report.metrics.cpu_load_pct)%"
$md += "- Uptime: $($report.metrics.uptime_hours) hours"
$md += "- Startup entries: $($report.metrics.startup_count)"
$md += "- Shell overlay handlers: $($report.metrics.shell_overlay_count)"
$md += ""
$md += "## Drives"
foreach ($d in $report.metrics.disks) {
    $md += "- $($d.drive) $($d.fs) [$($d.drive_type)]: $($d.free_gb) GB free of $($d.size_gb) GB ($($d.free_pct)%)"
}
$md += ""
$md += "## NAS ($($report.metrics.nas.ip))"
$md += "- Ping: $($report.metrics.nas.ping)"
$md += "- SMB port 445: $($report.metrics.nas.smb_port_open)"
$md += "- SessionTimeout: $($report.metrics.nas.session_timeout)s (target <=30s)"
if ($report.metrics.nas.mappings) {
    $md += "- Active mappings: $($report.metrics.nas.mappings.Count) of 6 expected"
}
$md += ""
$md += "## Services"
foreach ($k in $report.metrics.services.Keys) {
    $s = $report.metrics.services[$k]
    $md += "- $($s.display): $($s.status)" + $(if ($s.start) { " ($($s.start))" } else { "" })
}
$md += ""
if ($report.findings.Count) {
    $md += "## Findings"
    foreach ($f in $report.findings) {
        $icon = switch ($f.severity) { 'critical' {'[!]'} 'warning' {'[*]'} default {'[i]'} }
        $md += "$icon **$($f.severity.ToUpper())** ($($f.area)): $($f.message)"
    }
    $md += ""
}
if ($report.metrics.event_errors_7d.suppressed) {
    $md += "## Suppressed (known-quiet) event patterns"
    foreach ($s in $report.metrics.event_errors_7d.suppressed) {
        $md += "- $($s.provider) event $($s.event_id): $($s.count) in 7d -- $($s.reason)"
    }
    $md += ""
}
if ($report.actions.Count) {
    $md += "## Actions taken"
    foreach ($a in $report.actions) {
        $md += "- $($a.action): $($a.result)"
    }
    if ($report.metrics.temp_freed_mb) {
        $md += "- **Total freed: $($report.metrics.temp_freed_mb) MB**"
    }
}

$md -join "`n" | Out-File -FilePath $mdPath -Encoding UTF8

# v2.4.43: write latest.json + latest.md atomically via tmp + rename.
# Prior `Copy-Item -Force` opened the destination file for writing while
# streaming contents, which on Windows held a share-mode lock that
# blocked readers (observed in perf log: 64-74 second blocked reads on
# the Electron main-process side when this write ran concurrent with a
# getStatus poll). NTFS Move-Item -Force = MoveFileExW with REPLACE_
# EXISTING = atomic swap. Readers see either old content OR new
# content, never an in-progress locked file.
$latestLink = Join-Path $OutDir 'latest.json'
$latestTmp  = "$latestLink.tmp"
Copy-Item -Path $jsonPath -Destination $latestTmp -Force
Move-Item -LiteralPath $latestTmp -Destination $latestLink -Force

$latestMd    = Join-Path $OutDir 'latest.md'
$latestMdTmp = "$latestMd.tmp"
Copy-Item -Path $mdPath -Destination $latestMdTmp -Force
Move-Item -LiteralPath $latestMdTmp -Destination $latestMd -Force

# Event log emit: severity-mapped entry so the run is visible in Event Viewer
$evtLevel  = switch ($report.summary.overall) {
    'CRITICAL'  { 'Error';       break }
    'ATTENTION' { 'Warning';     break }
    default     { 'Information' }
}
$evtMsg = "PC Doctor run finished (mode=$Mode). Status=$($report.summary.overall). Critical=$critCount Warning=$warnCount Info=$infoCount. Report: $reportDir"
Write-PCDEvent -EventId 1001 -Level $evtLevel -Message $evtMsg

Log "=== PC DOCTOR DONE status=$($report.summary.overall) ==="
Write-Output "Report: $jsonPath"
Write-Output "Summary: $mdPath"
Write-Output "Status: $($report.summary.overall)"
