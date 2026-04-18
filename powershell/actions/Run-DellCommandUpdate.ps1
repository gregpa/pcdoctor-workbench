param([switch]$ApplyAll, [switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$dcu = @(
    'C:\Program Files\Dell\CommandUpdate\dcu-cli.exe',
    'C:\Program Files (x86)\Dell\CommandUpdate\dcu-cli.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $dcu) { throw 'Dell Command Update not installed — download from dell.com/support' }

if ($ApplyAll) {
    # Run scan first
    & $dcu /scan -silent | Out-Null
    # Apply all updates
    $out = & $dcu /applyUpdates -silent -autoSuspendBitLocker=enable 2>&1 | Out-String
    @{ success=$true; duration_ms=$sw.ElapsedMilliseconds; mode='applied'; output=$out.Trim(); message='Dell updates applied' } | ConvertTo-Json -Compress
} else {
    # Scan only
    $out = & $dcu /scan -silent 2>&1 | Out-String
    @{ success=$true; duration_ms=$sw.ElapsedMilliseconds; mode='scan_only'; output=$out.Trim(); message='Dell Command Update scan complete (check app for details)' } | ConvertTo-Json -Compress
}
exit 0
