param(
    [string]$KbId,
    [switch]$DryRun,
    [switch]$JsonOutput
)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }
if (-not $KbId) { throw 'KbId parameter is required (e.g. "KB5036893")' }

$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$pending = $searcher.Search("IsInstalled=0 and IsHidden=0")
$target = $null
foreach ($u in $pending.Updates) {
    foreach ($k in $u.KBArticleIDs) {
        if ("KB$k" -ieq $KbId -or "$k" -ieq ($KbId -replace '^KB','')) { $target = $u; break }
    }
    if ($target) { break }
}
if (-not $target) { throw "Update $KbId not found in pending list" }
$target.IsHidden = $true
@{ success=$true; duration_ms=$sw.ElapsedMilliseconds; hidden_kb=$KbId; message="$KbId hidden from future update offerings" } | ConvertTo-Json -Compress
exit 0
