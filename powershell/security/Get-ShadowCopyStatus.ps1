param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$shadows = @()
try {
    $out = & vssadmin.exe list shadows 2>&1 | Out-String
    # Parse "Contained X shadow copies" sections
    $blocks = $out -split '(?=Contained \d+ shadow copies at creation time:)'
    foreach ($b in $blocks) {
        if ($b -match 'Contained \d+ shadow copies at creation time:\s*(.+)') {
            $tsLine = $Matches[1].Trim()
            $volMatch = [regex]::Match($b, 'Original Volume:\s*\(([^)]+)\)')
            $volume = if ($volMatch.Success) { $volMatch.Groups[1].Value } else { '?' }
            $shadows += @{ volume = $volume; created = $tsLine }
        }
    }
} catch {}

$oldestDaysAgo = $null
if ($shadows.Count -gt 0) {
    try {
        $dates = $shadows | ForEach-Object { [DateTime]::Parse($_.created) }
        $oldest = ($dates | Measure-Object -Minimum).Minimum
        $oldestDaysAgo = [math]::Round(([DateTime]::Now - $oldest).TotalDays, 1)
    } catch {}
}

$severity = if ($shadows.Count -eq 0) { 'warn' } elseif ($oldestDaysAgo -ne $null -and $oldestDaysAgo -gt 14) { 'warn' } else { 'good' }

$sw.Stop()
@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    count = $shadows.Count
    shadows = $shadows
    oldest_days_ago = $oldestDaysAgo
    severity = $severity
    message = "Shadow copies: $($shadows.Count)"
} | ConvertTo-Json -Depth 5 -Compress
exit 0
