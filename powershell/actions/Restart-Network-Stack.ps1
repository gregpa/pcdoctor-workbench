<#
.SYNOPSIS
    Restarts core Windows network stack services (DHCP, DNS cache, NLA, NSI).
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

$services = @('Dhcp', 'Dnscache', 'NlaSvc', 'nsi')
$results = @{}
foreach ($s in $services) {
    try {
        Restart-Service -Name $s -Force -ErrorAction Stop
        $results[$s] = (Get-Service -Name $s).Status.ToString()
    } catch {
        $results[$s] = "FAILED: $($_.Exception.Message)"
    }
}

$sw.Stop()
$result = @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    services    = $results
    message     = 'Network stack services restarted'
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
