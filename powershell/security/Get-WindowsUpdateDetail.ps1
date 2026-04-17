param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$pending = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")

$pendingList = @()
foreach ($u in $pending.Updates) {
    $isSecurity = $false
    $categories = @()
    foreach ($c in $u.Categories) {
        $categories += $c.Name
        if ($c.Name -match 'Security') { $isSecurity = $true }
    }
    $kb = if ($u.KBArticleIDs.Count -gt 0) { "KB$($u.KBArticleIDs[0])" } else { '' }
    $sizeMb = if ($u.MaxDownloadSize) { [math]::Round($u.MaxDownloadSize / 1MB, 1) } else { 0 }
    $pendingList += @{
        title = "$($u.Title)"
        kb = $kb
        size_mb = $sizeMb
        categories = $categories
        is_security = $isSecurity
        severity = "$($u.MsrcSeverity)"
        reboot_behavior = "$($u.InstallationBehavior.RebootBehavior)"
        eula_accepted = [bool]$u.EulaAccepted
    }
}

$history = $searcher.QueryHistory(0, 50)
$installed = @()
foreach ($h in $history) {
    if ($h.ResultCode -eq 2) {
        $installed += @{
            title = "$($h.Title)"
            date = "$($h.Date)"
        }
    }
}

$result = @{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    pending = $pendingList
    pending_count = $pendingList.Count
    installed_last_50 = $installed
}
$result | ConvertTo-Json -Depth 6 -Compress
exit 0
