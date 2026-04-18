param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }
# Forecast regeneration is driven by the Electron main process via api:regenerateForecast.
# This script is a scheduled-task bookmark that the main process picks up.
@{ success=$true; duration_ms=0; message='Forecast scheduled-task ping' } | ConvertTo-Json -Compress
