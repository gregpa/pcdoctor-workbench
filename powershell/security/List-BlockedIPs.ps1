param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$rules = Get-NetFirewallRule -DisplayName 'PCDoctor Block*' -ErrorAction SilentlyContinue
$list = @()
foreach ($r in $rules) {
    $addr = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $r -ErrorAction SilentlyContinue
    $list += @{
        rule_name = $r.DisplayName
        direction = "$($r.Direction)"
        description = "$($r.Description)"
        remote_address = "$($addr.RemoteAddress)"
        enabled = [bool]$r.Enabled
    }
}

@{ success=$true; duration_ms=$sw.ElapsedMilliseconds; rules=$list; count=$list.Count; message="$($list.Count) PCDoctor block rules" } | ConvertTo-Json -Depth 5 -Compress
exit 0
