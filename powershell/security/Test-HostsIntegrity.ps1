param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$hostsPath = 'C:\Windows\System32\drivers\etc\hosts'
if (-not (Test-Path $hostsPath)) { throw "hosts file not found" }
$content = Get-Content $hostsPath -Raw
$lines = $content -split "`r?`n"

$nonDefault = @()
$suspiciousPatterns = @(
    '(microsoft|update)\.(microsoft|com)',
    'bankofamerica|chase\.com|wellsfargo|paypal|amazon',
    '(google|googleapis|googletagmanager|gstatic)\.',
    'github|githubusercontent',
    'anthropic|openai|claude\.ai'
)
$suspicious = @()

foreach ($line in $lines) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    # strip inline comment
    $t = ($t -split '#')[0].Trim()
    if (-not $t) { continue }
    # Skip default localhost entries
    if ($t -match '^\s*(127\.0\.0\.1|::1)\s+localhost\s*$') { continue }
    $nonDefault += $t
    foreach ($p in $suspiciousPatterns) {
        if ($t -match $p) {
            $suspicious += @{ line = $t; pattern = $p }
        }
    }
}

$fileHash = (Get-FileHash $hostsPath -Algorithm SHA256).Hash
$severity = if ($suspicious.Count -gt 0) { 'crit' } elseif ($nonDefault.Count -gt 5) { 'warn' } else { 'good' }

$sw.Stop()
@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    file_sha256 = $fileHash
    non_default_entry_count = $nonDefault.Count
    non_default_entries = $nonDefault
    suspicious_entries = $suspicious
    severity = $severity
    message = "Hosts file has $($nonDefault.Count) non-default entries, $($suspicious.Count) suspicious"
} | ConvertTo-Json -Depth 6 -Compress
exit 0
