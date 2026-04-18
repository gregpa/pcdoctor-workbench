param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$indicators = @()
$now = [int][double]::Parse((Get-Date -UFormat %s))

# ==== Process whitelist (comprehensive) ====
$knownGoodProcesses = @(
    'svchost','System','MsMpEng','chrome','msedge','claude','Code','Cursor','node','pwsh','powershell',
    'Discord','Spotify','Teams','explorer','Idle','wininit','services','lsass','fontdrvhost',
    'csrss','winlogon','dwm','ctfmon','RuntimeBroker','SearchHost','SearchIndexer','SearchApp',
    'ShellExperienceHost','StartMenuExperienceHost','TextInputHost','ApplicationFrameHost',
    'iCloudPhotos','iCloudServices','iCloudOutlook','AppleMobileDeviceService','AppleMobileDeviceHelper',
    'OneDrive','GoogleDriveFS','Dropbox','googledrivesync','vmmemWSL','vmmem','Docker Desktop Backend','docker','dockerd',
    'AwCC','AlienFX','AWCCSvc','AlienwareCoService',
    'nvcontainer','nvtelemetryservice','NVDisplay.Container','nvidia_smi','nvtopps',
    'steam','spotify','brave','firefox','edge','teams','outlook','winword','excel','powerpnt','visio',
    'backgroundTaskHost','SystemSettings','WindowsTerminal','WidgetService','Widgets',
    'audiodg','WindowsInternal.ComposableShell.Experiences.TextInput.InputApp',
    'Procmon64','Procexp64','Autoruns64','dotnet','Registry','Memory Compression',
    'ShadowPlayHelper','RTSS','RTSSHooksLoader64','MSIAfterburner','OneDriveSync'
)
$whitelistPattern = '^(' + ($knownGoodProcesses -join '|') + ')$'

# ==== 1. Cryptominer: sustained high-CPU AND process not whitelisted ====
try {
    $topCpu = Get-Process | Sort-Object CPU -Descending | Select-Object -First 5
    foreach ($p in $topCpu) {
        if ($p.CPU -gt 20000 -and $p.ProcessName -notmatch $whitelistPattern) {
            $indicators += @{
                id = [guid]::NewGuid().ToString()
                severity = 'medium'
                category = 'cryptominer_candidate'
                detected_at = $now
                message = "Process '$($p.ProcessName)' has accumulated $([math]::Round($p.CPU, 0)) CPU seconds and is not on the known-good list"
                detail = @{ pid = $p.Id; name = $p.ProcessName; cpu_seconds = [math]::Round($p.CPU, 0) }
            }
        }
    }
} catch {}

# ==== 2. Suspicious PowerShell patterns ====
try {
    $since = (Get-Date).AddDays(-1)
    $psEvents = Get-WinEvent -FilterHashtable @{ LogName='Microsoft-Windows-PowerShell/Operational'; Id=4104; StartTime=$since } -MaxEvents 50 -ErrorAction SilentlyContinue
    $seenPs = $false
    foreach ($e in $psEvents) {
        if ($e.Message -match 'FromBase64String|IEX\s*\(|DownloadString|-EncodedCommand|bypass|\\x[0-9a-f]{2}') {
            if (-not $seenPs) {
                $indicators += @{
                    id = [guid]::NewGuid().ToString()
                    severity = 'high'
                    category = 'suspicious_powershell'
                    detected_at = $now
                    message = "Obfuscated PowerShell pattern detected in script-block log (Event 4104)"
                    detail = @{ time = "$($e.TimeCreated)" }
                }
                $seenPs = $true
            }
        }
    }
} catch {}

# ==== 3. LOLBAS abuse: known binaries spawning network processes ====
try {
    $lolbins = @('certutil.exe','bitsadmin.exe','mshta.exe','regsvr32.exe','rundll32.exe','msiexec.exe')
    $since = (Get-Date).AddHours(-24)
    $processEvents = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4688; StartTime=$since } -MaxEvents 300 -ErrorAction SilentlyContinue
    foreach ($e in $processEvents) {
        $msg = $e.Message
        foreach ($bin in $lolbins) {
            if ($msg -match [regex]::Escape($bin)) {
                # Check if it's running from an unusual location
                if ($msg -match 'New Process Name:\s*(\S+)') {
                    $newProc = $Matches[1]
                    if ($newProc -like "*\AppData\*" -or $newProc -like "*\Temp\*" -or $newProc -like "*\Downloads\*") {
                        $indicators += @{
                            id = [guid]::NewGuid().ToString()
                            severity = 'high'
                            category = 'lolbas_abuse'
                            detected_at = $now
                            message = "LOLBAS '$bin' detected from suspicious path"
                            detail = @{ new_process = $newProc; time = "$($e.TimeCreated)" }
                        }
                        break
                    }
                }
            }
        }
    }
} catch {}

# ==== 4. Unusual parent-child (office → cmd/powershell) ====
try {
    $since = (Get-Date).AddHours(-24)
    $events = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4688; StartTime=$since } -MaxEvents 500 -ErrorAction SilentlyContinue
    foreach ($e in $events) {
        $msg = $e.Message
        $parent = $null; $child = $null
        if ($msg -match 'Creator Process Name:\s*(\S+)') { $parent = $Matches[1] }
        if ($msg -match 'New Process Name:\s*(\S+)') { $child = $Matches[1] }
        if ($parent -and $child) {
            $p = [System.IO.Path]::GetFileName($parent).ToLower()
            $c = [System.IO.Path]::GetFileName($child).ToLower()
            $risky = ($p -match '^(winword|excel|powerpnt|outlook|acrord32|acrobat)\.exe$' -and $c -match '^(cmd|powershell|pwsh|wscript|cscript|mshta)\.exe$')
            if ($risky) {
                $indicators += @{
                    id = [guid]::NewGuid().ToString()
                    severity = 'high'
                    category = 'unusual_parent_child'
                    detected_at = $now
                    message = "$p spawned $c (macro-like pattern)"
                    detail = @{ parent = $p; child = $c; time = "$($e.TimeCreated)" }
                }
                break  # one is enough
            }
        }
    }
} catch {}

# ==== 5. RDP brute-force signal ====
try {
    $since = (Get-Date).AddHours(-24)
    $rdpFails = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4625; StartTime=$since } -ErrorAction SilentlyContinue -MaxEvents 200 | Where-Object {
        $_.Message -match 'Logon Type:\s*(10|3)\s'
    }
    if ($rdpFails.Count -gt 10) {
        # Group by source IP
        $ipCounts = @{}
        foreach ($f in $rdpFails) {
            if ($f.Message -match 'Source Network Address:\s*([0-9\.]+)') {
                $ipX = $Matches[1]
                if ($ipX -ne '-' -and $ipX -ne '127.0.0.1') {
                    if ($ipCounts.ContainsKey($ipX)) { $ipCounts[$ipX]++ } else { $ipCounts[$ipX] = 1 }
                }
            }
        }
        $topIps = $ipCounts.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 3
        $indicators += @{
            id = [guid]::NewGuid().ToString()
            severity = 'high'
            category = 'rdp_bruteforce'
            detected_at = $now
            message = "$($rdpFails.Count) failed remote-logon attempts in last 24h; top offenders: $($topIps.Key -join ', ')"
            detail = @{ count = $rdpFails.Count; top_ips = @($topIps | ForEach-Object { @{ ip = $_.Key; count = $_.Value } }) }
            auto_block_candidates = @($topIps | Where-Object { $_.Value -ge 10 } | ForEach-Object { $_.Key })
        }
    }
} catch {}

$sw.Stop()
@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    indicators = $indicators
    count = $indicators.Count
    message = "Threat indicator scan: $($indicators.Count) findings"
} | ConvertTo-Json -Depth 5 -Compress
exit 0
