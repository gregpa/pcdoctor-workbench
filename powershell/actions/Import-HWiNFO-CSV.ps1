param(
    [string]$CsvPath,
    [switch]$DryRun,
    [switch]$JsonOutput
)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }
if (-not $CsvPath -or -not (Test-Path $CsvPath)) { throw "CsvPath required and must exist" }

# HWiNFO CSVs have a header row, then data rows. Column positions vary by sensor set.
# We stream-read and compute min/avg/max for a fixed set of well-known sensors.
$reader = [System.IO.File]::OpenRead($CsvPath)
$sr = New-Object System.IO.StreamReader($reader)
$headerLine = $sr.ReadLine()
if (-not $headerLine) { throw "Empty CSV" }

# HWiNFO uses semicolon-separated by default but newer versions use comma. Detect.
$sep = if ($headerLine -match ';') { ';' } else { ',' }
$headers = $headerLine -split [regex]::Escape($sep)

# Find columns matching our targets (case-insensitive)
function Find-Col([string[]]$haystack, [string[]]$patterns) {
    for ($i = 0; $i -lt $haystack.Length; $i++) {
        foreach ($p in $patterns) {
            if ($haystack[$i] -match $p) { return $i }
        }
    }
    return -1
}

$col = @{
    cpu_temp_pkg = Find-Col $headers @('CPU Package.*\[°C\]', 'Core Max.*\[°C\]', 'CPU \(Tctl.*')
    cpu_clock_eff = Find-Col $headers @('Effective Clock.*\[MHz\]', 'Core Clocks \(avg\).*')
    cpu_clock_nom = Find-Col $headers @('Core Clocks.*\[MHz\]', 'CPU Clock \(Core.*')
    gpu_core_temp = Find-Col $headers @('GPU Temperature.*\[°C\]')
    gpu_hotspot = Find-Col $headers @('GPU Hot Spot.*\[°C\]', 'GPU Hotspot.*')
    gpu_memory_temp = Find-Col $headers @('GPU Memory Junction.*\[°C\]', 'GPU VRAM.*')
    ram_usage_pct = Find-Col $headers @('Physical Memory Used.*\[%\]', 'Memory Usage.*\[%\]')
    cpu_power_w = Find-Col $headers @('CPU Package Power.*\[W\]')
}

# Initialize accumulators
$acc = @{}
foreach ($k in $col.Keys) {
    if ($col[$k] -ge 0) {
        $acc[$k] = @{ count = 0; sum = 0.0; min = [double]::PositiveInfinity; max = [double]::NegativeInfinity }
    }
}

$sampleCount = 0
$tsStart = $null
$tsEnd = $null

while (-not $sr.EndOfStream) {
    $line = $sr.ReadLine()
    if (-not $line) { continue }
    $parts = $line -split [regex]::Escape($sep)
    if ($parts.Length -lt 2) { continue }
    # HWiNFO first column is date; try to parse
    $ts = $null
    try { $ts = [DateTime]::Parse($parts[0]) } catch {}
    if ($ts) {
        if (-not $tsStart) { $tsStart = $ts }
        $tsEnd = $ts
    }
    $sampleCount++

    foreach ($k in $col.Keys) {
        $idx = $col[$k]
        if ($idx -lt 0 -or $idx -ge $parts.Length) { continue }
        $raw = $parts[$idx]
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }
        $v = 0.0
        if ([double]::TryParse($raw, [ref]$v)) {
            $a = $acc[$k]
            $a.count++; $a.sum += $v
            if ($v -lt $a.min) { $a.min = $v }
            if ($v -gt $a.max) { $a.max = $v }
        }
    }
}
$sr.Close(); $reader.Close()

$findings = @{}
foreach ($k in $acc.Keys) {
    $a = $acc[$k]
    if ($a.count -eq 0) { continue }
    $findings[$k] = @{
        count = $a.count
        avg = [math]::Round($a.sum / $a.count, 2)
        min = [math]::Round($a.min, 2)
        max = [math]::Round($a.max, 2)
    }
}

$sw.Stop()
$result = @{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    csv_path = $CsvPath
    samples = $sampleCount
    ts_start = if ($tsStart) { $tsStart.ToString('o') } else { $null }
    ts_end = if ($tsEnd) { $tsEnd.ToString('o') } else { $null }
    findings = $findings
    message = "Parsed $sampleCount samples from HWiNFO CSV"
}
$result | ConvertTo-Json -Depth 6 -Compress
exit 0
