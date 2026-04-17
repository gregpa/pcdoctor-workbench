<#
.SYNOPSIS
    Release and renew DHCP IP address.
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

& ipconfig /release 2>&1 | Out-Null
Start-Sleep -Seconds 1
$renewOutput = & ipconfig /renew 2>&1 | Out-String
$newIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' -and $_.IPAddress -notmatch '^169\.254' } | Select-Object -First 1).IPAddress
$result = @{ success = $true; duration_ms = $sw.ElapsedMilliseconds; new_ip = $newIp; message = "IP released + renewed. New IP: $newIp" }

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
