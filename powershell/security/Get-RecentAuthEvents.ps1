param([int]$Hours = 24, [switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$since = (Get-Date).AddHours(-$Hours)
$events = @()
try {
    $raw = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4625; StartTime=$since } -MaxEvents 30 -ErrorAction SilentlyContinue
    foreach ($e in $raw) {
        $msg = $e.Message
        $ip = ($msg -split "`n" | Where-Object { $_ -match 'Source Network Address:' } | Select-Object -First 1) -replace '.*Source Network Address:\s*', '' -replace '\s+$', ''
        $ws = ($msg -split "`n" | Where-Object { $_ -match 'Source Workstation:' } | Select-Object -First 1) -replace '.*Source Workstation:\s*', '' -replace '\s+$', ''
        $acc = ($msg -split "`n" | Where-Object { $_ -match 'Account Name:' } | Select-Object -First 1) -replace '.*Account Name:\s*', '' -replace '\s+$', ''
        $events += @{
            time = $e.TimeCreated.ToString('o')
            event_id = $e.Id
            account = $acc.Trim()
            source_ip = $ip.Trim()
            workstation = $ws.Trim()
        }
    }
} catch {}

@{ success=$true; duration_ms=$sw.ElapsedMilliseconds; events=$events; count=$events.Count; message="$($events.Count) recent auth events" } | ConvertTo-Json -Depth 4 -Compress
exit 0
