<#
.SYNOPSIS
    Reset Windows Firewall rules to defaults.
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'

trap {
    $errRecord = @{
        code    = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' }
        message = $_.Exception.Message
        script  = $MyInvocation.MyCommand.Name
        line    = $_.InvocationInfo.ScriptLineNumber
        stack   = $_.ScriptStackTrace
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($DryRun) {
    $result = @{ success = $true; dry_run = $true; duration_ms = $sw.ElapsedMilliseconds; message = 'DryRun' }
    $result | ConvertTo-Json -Depth 3 -Compress
    exit 0
}

$output = & netsh advfirewall reset 2>&1 | Out-String
$result = @{ success = ($LASTEXITCODE -eq 0); duration_ms = $sw.ElapsedMilliseconds; exit_code = $LASTEXITCODE; message = 'Windows Firewall reset to defaults'; output = $output.Trim() }

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
