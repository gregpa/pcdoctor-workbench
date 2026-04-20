<#
.SYNOPSIS
    Kick off a Windows Defender Full Scan in the background and return immediately.
.NOTES
    Start-MpScan without -AsJob blocks for hours. We shell out to MpCmdRun.exe via
    Start-Process so the scan runs detached -- the wrapper returns in <1 sec and the
    Workbench's 5-minute script timeout doesn't matter.

    Progress can be observed via:
      Get-MpComputerStatus | Select QuickScanStartTime,FullScanStartTime,FullScanEndTime
#>
param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference='Stop'
trap { $e=@{code='E_PS_UNHANDLED';message=$_.Exception.Message}|ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw=[System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

# Find MpCmdRun.exe (path varies by platform version under Platform\<ver>\)
$mpCmd = Get-ChildItem 'C:\ProgramData\Microsoft\Windows Defender\Platform' -Filter 'MpCmdRun.exe' -Recurse -ErrorAction SilentlyContinue |
         Sort-Object FullName -Descending | Select-Object -First 1
if (-not $mpCmd) {
    $fallback = 'C:\Program Files\Windows Defender\MpCmdRun.exe'
    if (Test-Path $fallback) { $mpCmd = Get-Item $fallback }
}
if (-not $mpCmd) { throw 'MpCmdRun.exe not found. Is Defender installed?' }

# Fire-and-forget: Start-Process returns immediately; scan continues in background.
# -ScanType 2 = FullScan. Output goes to Defender's own log, not our stdout.
$p = Start-Process -FilePath $mpCmd.FullName -ArgumentList '-Scan','-ScanType','2' `
     -WindowStyle Hidden -PassThru

$result = @{
    success      = $true
    duration_ms  = $sw.ElapsedMilliseconds
    scan_pid     = $p.Id
    scan_engine  = $mpCmd.FullName
    message      = 'Full scan started in background (1-4 hrs). Workbench will not block. Check Windows Security > Protection history for progress.'
}
$result | ConvertTo-Json -Compress
exit 0
