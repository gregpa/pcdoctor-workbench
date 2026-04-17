<#
.SYNOPSIS
    Disable then re-enable all physical network adapters.
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

$adapters = Get-NetAdapter -Physical | Where-Object { $_.Status -ne 'Disabled' }
$names = @()
foreach ($a in $adapters) {
    try {
        Disable-NetAdapter -Name $a.Name -Confirm:$false -ErrorAction Stop
        Start-Sleep -Seconds 2
        Enable-NetAdapter -Name $a.Name -Confirm:$false -ErrorAction Stop
        $names += $a.Name
    } catch {
        # Continue with others
    }
}
Start-Sleep -Seconds 3
$result = @{ success = $true; duration_ms = $sw.ElapsedMilliseconds; adapters_reset = $names; message = "Reset $($names.Count) network adapter(s)" }

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
