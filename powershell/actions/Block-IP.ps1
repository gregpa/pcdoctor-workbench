param([string]$Ip, [string]$Reason = 'PCDoctor auto-block', [switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }
if (-not $Ip) { throw 'Ip parameter is required' }

$ruleName = "PCDoctor Block $Ip"
# Remove existing rule with same name first
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName "$ruleName (out)" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Block -RemoteAddress $Ip -Description $Reason -ErrorAction Stop | Out-Null
New-NetFirewallRule -DisplayName "$ruleName (out)" -Direction Outbound -Action Block -RemoteAddress $Ip -Description $Reason -ErrorAction Stop | Out-Null

$sw.Stop()
@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    ip = $Ip
    rules_created = 2
    message = "Blocked inbound + outbound to $Ip"
} | ConvertTo-Json -Compress
exit 0
