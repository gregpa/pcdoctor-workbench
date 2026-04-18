param(
    [string]$Kb_Id,
    [switch]$DryRun,
    [switch]$JsonOutput
)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }
if (-not $Kb_Id) { throw 'Kb_Id parameter is required' }

$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$pending = $searcher.Search("IsInstalled=0 and Type='Software'")
$toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $pending.Updates) {
    foreach ($k in $u.KBArticleIDs) {
        if ("KB$k" -ieq $Kb_Id -or "$k" -ieq ($Kb_Id -replace '^KB','')) {
            if (-not $u.EulaAccepted) { try { $u.AcceptEula() } catch {} }
            $toInstall.Add($u) | Out-Null
            break
        }
    }
}
if ($toInstall.Count -eq 0) { throw "Update $Kb_Id not found" }
$downloader = $session.CreateUpdateDownloader()
$downloader.Updates = $toInstall
$downloader.Download() | Out-Null
$installer = $session.CreateUpdateInstaller()
$installer.Updates = $toInstall
$result = $installer.Install()
@{ success=($result.ResultCode -eq 2); duration_ms=$sw.ElapsedMilliseconds; kb=$Kb_Id; reboot_required=[bool]$result.RebootRequired; message="$Kb_Id install result: $($result.ResultCode)" } | ConvertTo-Json -Compress
exit 0
