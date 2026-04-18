param([string]$Ip, [switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }
if (-not $Ip) { throw 'Ip parameter is required' }

$ruleName1 = "PCDoctor Block $Ip"
$ruleName2 = "$ruleName1 (out)"
$removed = 0
foreach ($n in @($ruleName1, $ruleName2)) {
    $r = Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue
    if ($r) {
        Remove-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue
        $removed++
    }
}

@{ success=$true; duration_ms=$sw.ElapsedMilliseconds; ip=$Ip; rules_removed=$removed; message="Unblocked $Ip ($removed rules)" } | ConvertTo-Json -Compress
exit 0
