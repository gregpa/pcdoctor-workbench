param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;message='Would open Windows Security'}|ConvertTo-Json -Compress; exit 0 }

# Opens the Windows Security UI directly on the Virus & threat protection
# pane so the user can toggle PUA / Controlled Folder Access / Tamper
# Protection manually. These settings are blocked from Set-MpPreference
# when Tamper Protection is on; the Windows Security UI is the only
# supported entry point.
#
# v2.4.7 (E-7): switched from `ms-settings:windowsdefender` (opens
# Settings > Privacy & security > Windows Security summary page, user
# then has to click through) to `windowsdefender://threat` which opens
# the Windows Security app itself on the V&T protection pane. Fall back
# to the settings URI if the app URI fails (shouldn't, but belt-and-braces).
try {
    Start-Process 'windowsdefender://threat' -ErrorAction Stop
    $uri = 'windowsdefender://threat'
} catch {
    Start-Process 'ms-settings:windowsdefender'
    $uri = 'ms-settings:windowsdefender'
}

$sw.Stop()
@{ success=$true; duration_ms=$sw.ElapsedMilliseconds; message="Opened Windows Security ($uri)"; uri=$uri } | ConvertTo-Json -Compress
exit 0
