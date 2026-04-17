<#
.SYNOPSIS
    Restarts a named Windows service.
#>
param(
    [string]$Service_Name,
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

if (-not $Service_Name) { throw "Service_Name parameter is required" }
$svc = Get-Service -Name $Service_Name -ErrorAction Stop
$before = $svc.Status
Restart-Service -Name $Service_Name -Force -ErrorAction Stop
Start-Sleep -Seconds 1
$after = (Get-Service -Name $Service_Name).Status

$sw.Stop()
$result = @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    service     = $Service_Name
    before      = "$before"
    after       = "$after"
    message     = "Service ${Service_Name}: $before -> $after"
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
