param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference='Stop'
trap { $e=@{code='E_PS_UNHANDLED';message=$_.Exception.Message}|ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw=[System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }
Start-MpScan -ScanType QuickScan -ErrorAction Stop
@{success=$true;duration_ms=$sw.ElapsedMilliseconds;message='Quick scan started'}|ConvertTo-Json -Compress
exit 0
