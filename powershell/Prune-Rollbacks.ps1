param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$snapshotsDir = 'C:\ProgramData\PCDoctor\snapshots'
$pruned = 0
if (Test-Path $snapshotsDir) {
    $cutoff = (Get-Date).AddDays(-30)
    Get-ChildItem -Path $snapshotsDir -Directory | Where-Object { $_.CreationTime -lt $cutoff } | ForEach-Object {
        Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
        $pruned++
    }
}

$sw.Stop()
@{ success=$true; duration_ms=$sw.ElapsedMilliseconds; pruned=$pruned; message="Pruned $pruned expired rollback snapshots" } | ConvertTo-Json -Compress
exit 0
