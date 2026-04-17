param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$indicators = @()

# 1. Sustained high-CPU unknown process
try {
    $topCpu = Get-Process | Sort-Object CPU -Descending | Select-Object -First 5
    foreach ($p in $topCpu) {
        if ($p.CPU -gt 10000 -and $p.ProcessName -notmatch '^(svchost|System|MsMpEng|chrome|msedge|claude|Code|node|pwsh|powershell|cursor|Discord|Spotify|Teams|explorer)$') {
            $indicators += @{
                id = [guid]::NewGuid().ToString()
                severity = 'medium'
                category = 'cryptominer_candidate'
                detected_at = [int][double]::Parse((Get-Date -UFormat %s))
                message = "Process '$($p.ProcessName)' has accumulated $([math]::Round($p.CPU, 0)) CPU seconds - investigate if unfamiliar"
                detail = @{ pid = $p.Id; name = $p.ProcessName; cpu_seconds = [math]::Round($p.CPU, 0) }
            }
        }
    }
} catch {}

# 2. Suspicious PowerShell (Event 4104 with encoded/base64 patterns) - best-effort
try {
    $since = (Get-Date).AddDays(-1)
    $psEvents = Get-WinEvent -FilterHashtable @{ LogName='Microsoft-Windows-PowerShell/Operational'; Id=4104; StartTime=$since } -MaxEvents 50 -ErrorAction SilentlyContinue
    foreach ($e in $psEvents) {
        if ($e.Message -match 'FromBase64String|IEX|DownloadString|-EncodedCommand|bypass|\\xFF') {
            $indicators += @{
                id = [guid]::NewGuid().ToString()
                severity = 'high'
                category = 'suspicious_powershell'
                detected_at = [int][double]::Parse((Get-Date -UFormat %s))
                message = "Suspicious PowerShell pattern detected in script-block log (Event 4104)"
                detail = @{ event_id = 4104; time = "$($e.TimeCreated)" }
            }
            break   # one is enough to alert
        }
    }
} catch {}

# 3. RDP brute force signal
try {
    $since = (Get-Date).AddHours(-24)
    $rdpFails = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4625; StartTime=$since } -ErrorAction SilentlyContinue -MaxEvents 200 | Where-Object {
        $_.Message -match 'Logon Type:\s*10|Logon Type:\s*3'
    }
    if ($rdpFails.Count -gt 10) {
        $indicators += @{
            id = [guid]::NewGuid().ToString()
            severity = 'high'
            category = 'rdp_bruteforce'
            detected_at = [int][double]::Parse((Get-Date -UFormat %s))
            message = "$($rdpFails.Count) failed remote-logon attempts in last 24h"
            detail = @{ count = $rdpFails.Count }
        }
    }
} catch {}

$result = @{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    indicators = $indicators
    count = $indicators.Count
    message = "Threat indicator scan: $($indicators.Count) findings"
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
