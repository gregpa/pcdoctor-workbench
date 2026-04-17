param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$services = @('wuauserv', 'bits', 'cryptsvc', 'msiserver')
foreach ($s in $services) { Stop-Service -Name $s -Force -ErrorAction SilentlyContinue }

$sdPath = 'C:\Windows\SoftwareDistribution'
$catPath = 'C:\Windows\System32\catroot2'
$sdBak = "$sdPath.old"
$catBak = "$catPath.old"
if (Test-Path $sdBak) { Remove-Item -Recurse -Force $sdBak -ErrorAction SilentlyContinue }
if (Test-Path $catBak) { Remove-Item -Recurse -Force $catBak -ErrorAction SilentlyContinue }
if (Test-Path $sdPath) { Rename-Item -Path $sdPath -NewName 'SoftwareDistribution.old' -ErrorAction SilentlyContinue }
if (Test-Path $catPath) { Rename-Item -Path $catPath -NewName 'catroot2.old' -ErrorAction SilentlyContinue }

& netsh winhttp reset proxy | Out-Null

foreach ($s in $services) { Start-Service -Name $s -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 3
& wuauclt /resetauthorization /detectnow 2>&1 | Out-Null

$result = @{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    message = 'Windows Update components reset. Fresh detection triggered.'
    services_restarted = $services
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
