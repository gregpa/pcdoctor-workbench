param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;message='Would open wf.msc'}|ConvertTo-Json -Compress; exit 0 }

# Launch Windows Firewall with Advanced Security MMC snap-in so the user can
# review + edit rules manually. No state change; no admin required to *open*,
# though most edits inside wf.msc will prompt for elevation.
Start-Process 'mmc.exe' -ArgumentList 'wf.msc' -WindowStyle Normal

$sw.Stop()
@{ success=$true; duration_ms=$sw.ElapsedMilliseconds; message='Opened Windows Firewall with Advanced Security (wf.msc)' } | ConvertTo-Json -Compress
exit 0
