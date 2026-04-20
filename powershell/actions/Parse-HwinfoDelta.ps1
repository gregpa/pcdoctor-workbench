<#
.SYNOPSIS
    Reads the 2 most recent HWiNFO sensor CSVs in
    C:\ProgramData\PCDoctor\reports\sensors\, computes average per column, and
    returns per-component delta-T (current - baseline). Flags regressions >5C.

.NOTES
    HWiNFO CSVs are Windows-1252 encoded by default. We decode accordingly.
#>
param(
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

$sensorDir = 'C:\ProgramData\PCDoctor\reports\sensors'
if (-not (Test-Path $sensorDir)) {
    $err = @{ code = 'E_NO_SENSOR_RUNS'; message = "$sensorDir does not exist" } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}
$files = Get-ChildItem -Path $sensorDir -Filter '*.csv' -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 2
if (@($files).Count -lt 2) {
    # Not an error - just nothing to compare yet.
    $result = @{
        success = $true; duration_ms = $sw.ElapsedMilliseconds
        regressions = @(); baseline_ts = $null; current_ts = $null
        message = "Need at least 2 HWiNFO runs to compute delta-T; found $(@($files).Count)."
    }
    $result | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

$current  = $files[0]
$baseline = $files[1]

function Read-HwinfoCsv {
    param([string]$Path)
    $enc = [System.Text.Encoding]::GetEncoding(1252)
    $content = [System.IO.File]::ReadAllLines($Path, $enc)
    if (@($content).Count -lt 2) { return $null }
    $header = $content[0] -split ','
    $rows = @()
    for ($i = 1; $i -lt $content.Count; $i++) {
        $vals = $content[$i] -split ','
        if (@($vals).Count -ne @($header).Count) { continue }
        $row = [ordered]@{}
        for ($j = 0; $j -lt $header.Count; $j++) {
            $row[$header[$j]] = $vals[$j]
        }
        $rows += [pscustomobject]$row
    }
    return @{ header = $header; rows = $rows }
}

function Compute-AverageByColumn {
    param($parsed)
    if (-not $parsed) { return @{} }
    $avgs = [ordered]@{}
    foreach ($col in $parsed.header) {
        if ($col -match '^(Date|Time)$') { continue }
        $nums = @()
        foreach ($r in $parsed.rows) {
            $v = $r.$col
            if ($v -match '^-?\d+(\.\d+)?$') { $nums += [double]$v }
        }
        if (@($nums).Count -gt 0) {
            $avgs[$col] = ($nums | Measure-Object -Average).Average
        }
    }
    return $avgs
}

$cur  = Read-HwinfoCsv -Path $current.FullName
$base = Read-HwinfoCsv -Path $baseline.FullName

$curAvg  = Compute-AverageByColumn -parsed $cur
$baseAvg = Compute-AverageByColumn -parsed $base

$regressions = @()
foreach ($k in $curAvg.Keys) {
    if ($baseAvg.Contains($k)) {
        # Heuristic: treat column as temperature if name mentions 'Temp' or '°C'
        $isTemp = ($k -match 'Temp' -or $k -match 'CPU Package|GPU Core')
        $delta = [double]$curAvg[$k] - [double]$baseAvg[$k]
        if ($isTemp -and $delta -gt 5) {
            $regressions += [ordered]@{
                component  = $k
                prior_avg  = [math]::Round([double]$baseAvg[$k], 1)
                current_avg = [math]::Round([double]$curAvg[$k], 1)
                delta_c    = [math]::Round($delta, 1)
            }
        }
    }
}

$sw.Stop()
$result = [ordered]@{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    regressions = @($regressions)
    baseline_ts = $baseline.LastWriteTime.ToString('o')
    current_ts  = $current.LastWriteTime.ToString('o')
    message     = "$(@($regressions).Count) thermal regression(s) >5C vs baseline."
}
$result | ConvertTo-Json -Depth 6 -Compress
exit 0
