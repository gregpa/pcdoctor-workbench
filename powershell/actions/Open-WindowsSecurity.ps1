param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;message='Would open Windows Security'}|ConvertTo-Json -Compress; exit 0 }

# Opens the Virus & threat protection settings page directly so the user
# can toggle PUA / Controlled Folder Access / Tamper Protection manually.
# These settings are blocked from Set-MpPreference when Tamper Protection
# is on; the Windows Security UI is the only supported entry point.
Start-Process 'ms-settings:windowsdefender'

$sw.Stop()
@{ success=$true; duration_ms=$sw.ElapsedMilliseconds; message='Opened Windows Security (ms-settings:windowsdefender)' } | ConvertTo-Json -Compress
exit 0
