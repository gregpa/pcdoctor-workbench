param([string]$Csv_Path, [switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }
if (-not $Csv_Path -or -not (Test-Path $Csv_Path)) { throw "Csv_Path required and must exist" }

# OCCT CSV is comma-separated with "Time" in col 1. Parse temps + errors.
$content = Get-Content $Csv_Path -Head 2
if ($content.Count -lt 2) { throw "OCCT CSV appears empty" }
$headers = $content[0] -split ','

function Find-Col([string[]]$haystack, [string[]]$patterns) {
    for ($i=0;$i -lt $haystack.Length;$i++) { foreach ($p in $patterns) { if ($haystack[$i] -match $p) { return $i } } }
    return -1
}

$col = @{
    cpu_temp = Find-Col $headers @('CPU.*Temperature', 'Core Max')
    gpu_temp = Find-Col $headers @('GPU.*Temperature', 'GPU Hot Spot')
    errors = Find-Col $headers @('Errors')
}

$reader = [System.IO.File]::OpenRead($Csv_Path)
$sr = New-Object System.IO.StreamReader($reader)
$null = $sr.ReadLine()  # skip header

$acc = @{ cpu_temp=@{min=[double]::PositiveInfinity;max=[double]::NegativeInfinity;sum=0.0;count=0};
          gpu_temp=@{min=[double]::PositiveInfinity;max=[double]::NegativeInfinity;sum=0.0;count=0} }
$errorsTotal = 0
$sampleCount = 0
while (-not $sr.EndOfStream) {
    $line = $sr.ReadLine()
    if (-not $line) { continue }
    $parts = $line -split ','
    $sampleCount++
    foreach ($k in @('cpu_temp','gpu_temp')) {
        $idx = $col[$k]
        if ($idx -lt 0 -or $idx -ge $parts.Length) { continue }
        $v = 0.0
        if ([double]::TryParse($parts[$idx], [ref]$v)) {
            $a = $acc[$k]; $a.count++; $a.sum += $v
            if ($v -lt $a.min) { $a.min = $v }
            if ($v -gt $a.max) { $a.max = $v }
        }
    }
    if ($col.errors -ge 0 -and $col.errors -lt $parts.Length) {
        $e = 0; if ([int]::TryParse($parts[$col.errors], [ref]$e)) { $errorsTotal = $e }
    }
}
$sr.Close(); $reader.Close()

$findings = @{}
foreach ($k in $acc.Keys) {
    $a = $acc[$k]
    if ($a.count -gt 0) {
        $findings[$k] = @{ count=$a.count; avg=[math]::Round($a.sum/$a.count,2); min=[math]::Round($a.min,2); max=[math]::Round($a.max,2) }
    }
}

@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    csv_path = $Csv_Path
    samples = $sampleCount
    errors = $errorsTotal
    findings = $findings
    message = "Parsed OCCT CSV: $sampleCount samples, $errorsTotal errors"
} | ConvertTo-Json -Depth 5 -Compress
exit 0
