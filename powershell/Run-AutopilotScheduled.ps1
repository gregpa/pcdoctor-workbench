#Requires -Version 5.1
<#
.SYNOPSIS
    Compatibility refusal for legacy direct-mutation Scheduled Tasks.
#>
param(
    [string]$RuleId = '',
    [int]$Tier = 0,
    [string]$ActionScript = ''
)

$code = 'E_DIRECT_SCHEDULED_MUTATION_DISABLED'
$record = [ordered]@{
    ts = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    code = $code
    rule_id = if ($RuleId.Length -gt 128) { $RuleId.Substring(0, 128) } else { $RuleId }
    tier = $Tier
    action_name = if ($ActionScript) { [IO.Path]::GetFileName($ActionScript) } else { $null }
    message = 'Legacy Scheduled Task mutation dispatch is disabled; use the reviewed manual action boundary.'
}
$line = $record | ConvertTo-Json -Compress
$logDirectory = 'C:\ProgramData\PCDoctor\logs'
$logPath = Join-Path $logDirectory 'scheduled-mutation-refusals.jsonl'
try {
    if (-not (Test-Path -LiteralPath $logDirectory)) {
        New-Item -Path $logDirectory -ItemType Directory -Force | Out-Null
    }
    [IO.File]::AppendAllText($logPath, "$line`r`n", (New-Object Text.UTF8Encoding($false)))
} catch {
    # Refusal remains fail-closed even if durable telemetry cannot be appended.
}
Write-Host "PCDOCTOR_ERROR:$line"
exit 42
