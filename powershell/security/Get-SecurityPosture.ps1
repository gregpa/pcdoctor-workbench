param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap {
    $e = @{ code = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' };
            message = $_.Exception.Message; script = $MyInvocation.MyCommand.Name } | ConvertTo-Json -Depth 3 -Compress
    Write-Host "PCDOCTOR_ERROR:$e"; exit 1
}
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{ success=$true; dry_run=$true; duration_ms=$sw.ElapsedMilliseconds; message='DryRun' } | ConvertTo-Json -Compress; exit 0 }

# Defender
$defender = $null
try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    $defsAge = [math]::Round(([DateTime]::Now - $mp.AntivirusSignatureLastUpdated).TotalHours, 1)
    $lastQuick = if ($mp.QuickScanEndTime) { [math]::Round(([DateTime]::Now - $mp.QuickScanEndTime).TotalHours, 1) } else { $null }
    $lastFull = if ($mp.FullScanEndTime) { [math]::Round(([DateTime]::Now - $mp.FullScanEndTime).TotalDays, 1) } else { $null }
    $sev = 'good'
    if (-not $mp.RealTimeProtectionEnabled) { $sev = 'crit' }
    elseif ($defsAge -gt 72 -or ($lastFull -ne $null -and $lastFull -gt 30)) { $sev = 'warn' }
    $defender = @{
        realtime_protection = [bool]$mp.RealTimeProtectionEnabled
        antispyware_enabled = [bool]$mp.AntispywareEnabled
        defs_version = "$($mp.AntivirusSignatureVersion)"
        defs_age_hours = $defsAge
        engine_version = "$($mp.AMEngineVersion)"
        last_quick_scan_hours = $lastQuick
        last_full_scan_days = $lastFull
        threats_quarantined_7d = 0
        threats_active = 0
        tamper_protection = [bool]$mp.IsTamperProtected
        cloud_protection = $mp.MAPSReporting -ne 0
        puaprotection = "$($mp.PUAProtection)"
        controlled_folder_access = "$($mp.EnableControlledFolderAccess)"
        network_protection = "$($mp.EnableNetworkProtection)"
        exclusions_count = 0
        severity = $sev
    }
} catch {}

# Firewall
$firewall = $null
try {
    $profiles = Get-NetFirewallProfile -ErrorAction Stop
    $domain = $profiles | Where-Object Name -eq 'Domain'
    $private = $profiles | Where-Object Name -eq 'Private'
    $public = $profiles | Where-Object Name -eq 'Public'
    $allRules = Get-NetFirewallRule -ErrorAction SilentlyContinue
    $total = $allRules.Count
    $sev = 'good'
    if (-not $domain.Enabled -or -not $private.Enabled -or -not $public.Enabled) { $sev = 'crit' }
    $firewall = @{
        domain_enabled = [bool]$domain.Enabled
        private_enabled = [bool]$private.Enabled
        public_enabled = [bool]$public.Enabled
        default_inbound_action = "$($public.DefaultInboundAction)"
        rules_total = $total
        rules_added_7d = 0
        severity = $sev
    }
} catch {}

# Windows Update posture (native COM API, no PSWindowsUpdate)
$windowsUpdate = $null
try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $pending = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
    $secCount = 0
    foreach ($u in $pending.Updates) {
        foreach ($c in $u.Categories) { if ($c.Name -match 'Security') { $secCount++; break } }
    }
    $history = $searcher.QueryHistory(0, 100)
    $lastSuccess = $null
    foreach ($h in $history) { if ($h.ResultCode -eq 2) { $lastSuccess = $h.Date; break } }
    $daysSince = if ($lastSuccess) { [math]::Round(([DateTime]::Now - $lastSuccess).TotalDays, 1) } else { $null }
    $wuSvc = Get-Service wuauserv -ErrorAction SilentlyContinue
    $cbsPending = Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
    $winUpdPending = Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
    $sev = 'good'
    if ($pending.Updates.Count -gt 0 -and $secCount -gt 0) { $sev = 'warn' }
    if ($daysSince -ne $null -and $daysSince -gt 30) { $sev = 'warn' }
    $windowsUpdate = @{
        pending_count = $pending.Updates.Count
        pending_security_count = $secCount
        last_success_days = $daysSince
        reboot_pending = [bool]($cbsPending -or $winUpdPending)
        wu_service_status = if ($wuSvc) { "$($wuSvc.Status)" } else { 'missing' }
        severity = $sev
    }
} catch {}

# Failed logins (Event 4625)
$failedLogins = $null
try {
    $since7 = (Get-Date).AddDays(-7)
    $since24 = (Get-Date).AddHours(-24)
    $failures = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4625; StartTime=$since7 } -ErrorAction SilentlyContinue -MaxEvents 500
    $total7 = $failures.Count
    $total24 = ($failures | Where-Object { $_.TimeCreated -gt $since24 }).Count
    $lockouts = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4740; StartTime=$since7 } -ErrorAction SilentlyContinue -MaxEvents 100
    $byIp = @{}
    foreach ($f in $failures) {
        $ip = ($f.Message -split "`n" | Where-Object { $_ -match 'Source Network Address:' } | Select-Object -First 1) -replace '.*Source Network Address:\s*', '' -replace '\s+$', ''
        if ($ip -and $ip -ne '-' -and $ip -ne '127.0.0.1') {
            if ($byIp.ContainsKey($ip)) { $byIp[$ip]++ } else { $byIp[$ip] = 1 }
        }
    }
    $topSources = $byIp.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 5 | ForEach-Object { @{ ip = $_.Key; count = $_.Value } }
    $rdp = Get-WinEvent -FilterHashtable @{ LogName='Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational'; Id=1149; StartTime=$since7 } -ErrorAction SilentlyContinue -MaxEvents 100
    $sev = 'good'
    if ($total7 -gt 50) { $sev = 'warn' }
    if ($total7 -gt 200) { $sev = 'crit' }
    $failedLogins = @{
        total_7d = $total7
        total_24h = $total24
        lockouts_7d = $lockouts.Count
        top_sources = @($topSources)
        rdp_attempts_7d = $rdp.Count
        severity = $sev
    }
} catch {}

# BitLocker
$bitlocker = @()
try {
    $vols = Get-BitLockerVolume -ErrorAction Stop
    foreach ($v in $vols) {
        $bitlocker += @{
            drive = "$($v.MountPoint)"
            status = "$($v.VolumeStatus)"
            protection_on = $v.ProtectionStatus -eq 'On'
            encryption_pct = $v.EncryptionPercentage
        }
    }
} catch {}

# UAC
$uac = $null
try {
    $lua = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA -ErrorAction Stop
    $consent = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name ConsentPromptBehaviorAdmin -ErrorAction SilentlyContinue
    $enabled = $lua.EnableLUA -eq 1
    $level = switch ($consent.ConsentPromptBehaviorAdmin) {
        2 { 'AlwaysNotify' }
        5 { 'Default' }
        3 { 'NotifyChanges' }
        0 { 'Disabled' }
        default { 'Unknown' }
    }
    $sev = if (-not $enabled) { 'crit' } elseif ($level -eq 'Disabled') { 'crit' } else { 'good' }
    $uac = @{ enabled = $enabled; level = $level; severity = $sev }
} catch {}

# GPU driver (Nvidia)
$gpuDriver = $null
try {
    $gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA|GeForce|RTX|GTX' } | Select-Object -First 1
    if ($gpu) {
        $driverDate = if ($gpu.DriverDate) { [Management.ManagementDateTimeConverter]::ToDateTime($gpu.DriverDate) } else { $null }
        $ageDays = if ($driverDate) { [math]::Round(([DateTime]::Now - $driverDate).TotalDays, 0) } else { $null }
        $sev = if ($ageDays -eq $null) { 'good' } elseif ($ageDays -gt 180) { 'warn' } else { 'good' }
        $gpuDriver = @{
            gpu_vendor = 'NVIDIA'
            gpu_current_version = "$($gpu.DriverVersion)"
            age_days = $ageDays
            severity = $sev
        }
    }
} catch {}

# Overall severity
$severities = @()
foreach ($x in @($defender, $firewall, $windowsUpdate, $failedLogins, $uac, $gpuDriver)) {
    if ($x -and $x.severity) { $severities += $x.severity }
}
$overall = 'good'
if ($severities -contains 'crit') { $overall = 'crit' }
elseif ($severities -contains 'warn') { $overall = 'warn' }

$result = @{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    generated_at = [int][double]::Parse((Get-Date -UFormat %s))
    defender = $defender
    firewall = $firewall
    windows_update = $windowsUpdate
    failed_logins = $failedLogins
    bitlocker = $bitlocker
    uac = $uac
    gpu_driver = $gpuDriver
    overall_severity = $overall
}
$result | ConvertTo-Json -Depth 10 -Compress
exit 0
