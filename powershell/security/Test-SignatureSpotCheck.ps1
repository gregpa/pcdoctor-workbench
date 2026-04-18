param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$suspiciousRoots = @($env:TEMP, "$env:LOCALAPPDATA\Temp", "$env:USERPROFILE\Downloads", "$env:LOCALAPPDATA", $env:ProgramData)
$unsigned = @()
$invalid = @()
$processes = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path }
foreach ($p in $processes) {
    $matched = $false
    foreach ($root in $suspiciousRoots) {
        if ($p.Path -like "$root*") { $matched = $true; break }
    }
    if (-not $matched) { continue }
    try {
        $sig = Get-AuthenticodeSignature $p.Path -ErrorAction Stop
        $entry = @{ name = $p.ProcessName; pid = $p.Id; path = $p.Path; signer = "$($sig.SignerCertificate.Subject)"; status = "$($sig.Status)" }
        if ($sig.Status -eq 'NotSigned') { $unsigned += $entry }
        elseif ($sig.Status -ne 'Valid') { $invalid += $entry }
    } catch {}
}

$severity = if ($unsigned.Count -gt 3 -or $invalid.Count -gt 0) { 'warn' } else { 'good' }

$sw.Stop()
@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    unsigned_count = $unsigned.Count
    invalid_count = $invalid.Count
    unsigned = $unsigned
    invalid = $invalid
    severity = $severity
    message = "$($unsigned.Count) unsigned, $($invalid.Count) invalid signatures in suspicious roots"
} | ConvertTo-Json -Depth 5 -Compress
exit 0
