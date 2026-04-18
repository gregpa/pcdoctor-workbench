param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$checks = @()

# 1) Disk free
$cDrive = Get-PSDrive C -ErrorAction SilentlyContinue
$freeGb = if ($cDrive) { [math]::Round($cDrive.Free / 1GB, 1) } else { 0 }
$checks += @{ name='disk_free'; ok=($freeGb -gt 40); value="${freeGb} GB free on C:"; threshold='40 GB recommended' }

# 2) OS version
$os = Get-CimInstance Win32_OperatingSystem
$checks += @{ name='os_version'; ok=$true; value="$($os.Caption) $($os.Version)"; threshold='any supported Windows' }

# 3) Pending reboot
$rebootPending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
$checks += @{ name='reboot_pending'; ok=(-not $rebootPending); value=if ($rebootPending) { 'Yes — reboot before upgrade' } else { 'No' }; threshold='must be No before upgrade' }

# 4) Recent BSODs
try {
    $recentBsods = Get-WinEvent -FilterHashtable @{ LogName='System'; Id=1001; ProviderName='Microsoft-Windows-WER-SystemErrorReporting'; StartTime=(Get-Date).AddDays(-14) } -MaxEvents 20 -ErrorAction SilentlyContinue
    $bsodCount = if ($recentBsods) { $recentBsods.Count } else { 0 }
    $checks += @{ name='recent_bsods'; ok=($bsodCount -eq 0); value="$bsodCount BSODs in last 14 days"; threshold='0 recommended' }
} catch {
    $checks += @{ name='recent_bsods'; ok=$true; value='unavailable'; threshold='0 recommended' }
}

# 5) Older-than-2y drivers
try {
    $drivers = Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DriverDate }
    $oldCount = 0
    foreach ($d in $drivers) {
        try {
            $dt = [Management.ManagementDateTimeConverter]::ToDateTime($d.DriverDate)
            if ($dt -lt (Get-Date).AddYears(-2)) { $oldCount++ }
        } catch {}
    }
    $checks += @{ name='old_drivers'; ok=($oldCount -lt 10); value="$oldCount drivers older than 2 years"; threshold='< 10 recommended' }
} catch {
    $checks += @{ name='old_drivers'; ok=$true; value='unavailable'; threshold='' }
}

$blockers = @($checks | Where-Object { -not $_.ok })
$ready = ($blockers.Count -eq 0)

@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    ready = $ready
    checks = $checks
    blockers = $blockers
    message = if ($ready) { 'Ready for feature upgrade' } else { "$($blockers.Count) blocker(s) — resolve before upgrading" }
} | ConvertTo-Json -Depth 4 -Compress
exit 0
