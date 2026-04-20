<#
.SYNOPSIS
    Starts HWiNFO64 sensor logging for -Duration seconds, then closes it and
    saves the CSV into C:\ProgramData\PCDoctor\reports\sensors\<ts>.csv.

.DESCRIPTION
    HWiNFO CLI sensor-logging flags:
      -so               sensors-only
      -l<path>          logfile
      -poll_rate<ms>    sampling interval (default 1000ms)
    We start HWiNFO64, wait for the duration, then terminate and rename.
#>
param(
    [int]$Duration = 7200,
    [switch]$DryRun,
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'

trap {
    $errRecord = @{ code = 'E_PS_UNHANDLED'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{ success = $true; dry_run = $true; duration_ms = 0 } | ConvertTo-Json -Compress; exit 0 }

$candidates = @(
    'C:\Program Files\HWiNFO64\HWiNFO64.exe',
    'C:\ProgramData\PCDoctor\tools\HWiNFO64\HWiNFO64.exe'
)
$exe = $null
foreach ($c in $candidates) { if (Test-Path $c) { $exe = $c; break } }
if (-not $exe) {
    $err = @{ code = 'E_HWINFO_NOT_INSTALLED'; message = 'HWiNFO64 not installed.' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}

$outDir = 'C:\ProgramData\PCDoctor\reports\sensors'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$csvPath = Join-Path $outDir "$ts.csv"

$proc = Start-Process -FilePath $exe -ArgumentList @('-so',"-l`"$csvPath`"",'-poll_rate1000') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds ([math]::Max(1, $Duration))

try { $proc.Kill() } catch { }
try { $proc.WaitForExit(10000) | Out-Null } catch { }

$sampleCount = 0
if (Test-Path $csvPath) {
    try {
        $lineCount = (Get-Content -Path $csvPath -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
        $sampleCount = [math]::Max(0, $lineCount - 1)   # subtract header
    } catch { }
}

$sw.Stop()
$result = [ordered]@{
    success      = $true
    duration_ms  = $sw.ElapsedMilliseconds
    csv_path     = $csvPath
    duration_s   = $Duration
    sample_count = $sampleCount
    message      = "HWiNFO sensor log written to $csvPath ($sampleCount samples)."
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
