param([switch]$DryRun, [switch]$JsonOutput, [switch]$SecurityOnly)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$pending = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")

$toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
$selectedKbs = @()
foreach ($u in $pending.Updates) {
    if (-not $u.EulaAccepted) { try { $u.AcceptEula() } catch {} }
    $isSecurity = $false
    foreach ($c in $u.Categories) { if ($c.Name -match 'Security') { $isSecurity = $true; break } }
    if ($SecurityOnly -and -not $isSecurity) { continue }
    $toInstall.Add($u) | Out-Null
    $selectedKbs += "$($u.Title)"
}

if ($toInstall.Count -eq 0) {
    @{success=$true;duration_ms=$sw.ElapsedMilliseconds;installed=0;message='No applicable updates'}|ConvertTo-Json -Compress
    exit 0
}

$downloader = $session.CreateUpdateDownloader()
$downloader.Updates = $toInstall
$downloadResult = $downloader.Download()

$installer = $session.CreateUpdateInstaller()
$installer.Updates = $toInstall
$installResult = $installer.Install()

$rebootRequired = $installResult.RebootRequired
$resultCodeMap = @{ 0='NotStarted'; 1='InProgress'; 2='Succeeded'; 3='SucceededWithErrors'; 4='Failed'; 5='Aborted' }

$result = @{
    success = ($installResult.ResultCode -eq 2)
    duration_ms = $sw.ElapsedMilliseconds
    installed = $toInstall.Count
    reboot_required = [bool]$rebootRequired
    result_code = $installResult.ResultCode
    result_code_name = $resultCodeMap[$installResult.ResultCode]
    kbs = $selectedKbs
    message = "Installed $($toInstall.Count) updates ($($resultCodeMap[$installResult.ResultCode]))"
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
