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
        [string]$Area, [string]$Message, $Detail=$null, [bool]$AutoFixed=$false
    )
    $report.findings += [ordered]@{
        severity   = $Severity
        area       = $Area
        message    = $Message
        detail     = $Detail
        auto_fixed = $AutoFixed
    }
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
        Add-Finding warning 'Memory' "RAM usage $($report.metrics.ram_used_pct)% at check time" @{ free_gb = $report.metrics.ram_free_gb }
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
                Add-Finding $sev 'EventLog' "Recurring error: $($first.ProviderName) event $($first.Id) occurred $($group.Count) times in 7 days" $item
            }
        }
    }
    $report.metrics.event_errors_7d.recurring  = $recurring
    $report.metrics.event_errors_7d.suppressed = $suppressed

    # Specific problem signatures
    if ($sysErrors | Where-Object { $_.Id -in 41, 1001 -and $_.ProviderName -match 'Kernel-Power|BugCheck' }) {
        Add-Finding warning 'Stability' 'Unexpected shutdowns or BSODs detected in last 7 days'
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
        # Check recent Search errors
        $searchErr = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Microsoft-Windows-Search'; Level=1,2; StartTime=(Get-Date).AddDays(-2)} -MaxEvents 10 -EA SilentlyContinue
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
    $count = ($overlays | Measure-Object).Count
    $report.metrics.shell_overlay_count = $count
    if ($count -gt 15) {
        # (Windows honors only 15 overlay handlers; excess wastes CPU on every folder render)
        # Identify likely-redundant overlays
        $byPrefix = $overlays | Group-Object { $_.PSChildName.Trim() -replace '\d+$','' } | Where-Object Count -gt 1
        Add-Finding warning 'Explorer' "Shell has $count overlay handlers (Windows honors only 15). Excess handlers waste CPU on folder renders." @{
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
if (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -EA SilentlyContinue) { $pend += 'PendingFileRename' }
$report.metrics.pending_reboot = $pend
if ($pend) {
    # Estimate age of pending reboot by looking at the last boot timestamp.
    $uptimeH = $report.metrics.uptime_hours
    $sev = if ($uptimeH -gt 168) { 'warning' } else { 'info' }
    Add-Finding $sev 'Reboot' "Pending reboot flags: $($pend -join ', ') (uptime $uptimeH h)" @{ flags = $pend; uptime_hours = $uptimeH }
}

# =================================================================
# 7. STARTUP BLOAT
# =================================================================
Log "Auditing startup entries..."
try {
    $startup = @(Get-CimInstance Win32_StartupCommand -EA SilentlyContinue)
    $report.metrics.startup_count = $startup.Count
    if ($startup.Count -gt 30) {
        Add-Finding warning 'Startup' "$($startup.Count) auto-start entries (healthy: under 20). Boot time and idle RAM suffer." @{
            count = $startup.Count
            samples = ($startup | Select-Object -First 5 Name, Location | ForEach-Object { "$($_.Name) [$($_.Location)]" })
        }
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
# 9. NAS & SMB HEALTH (new in 2026-04-16 revision)
#    The 2026-04-15 cascade freeze originated here. Critical to monitor.
# =================================================================
Log "Checking NAS and SMB health..."
try {
    # ===== NAS section (robust detection) =====
    $nasIp = '192.168.50.226'
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
$report | ConvertTo-Json -Depth 8 | Out-File -FilePath $jsonPath -Encoding UTF8

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

# Maintain "latest" alias for quick access by the skill
$latestLink = Join-Path $OutDir 'latest.json'
Copy-Item -Path $jsonPath -Destination $latestLink -Force
$latestMd = Join-Path $OutDir 'latest.md'
Copy-Item -Path $mdPath -Destination $latestMd -Force

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
