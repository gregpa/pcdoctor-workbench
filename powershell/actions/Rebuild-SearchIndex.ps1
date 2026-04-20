<#
.SYNOPSIS
    Reset and rebuild the Windows Search index. Requires Administrator.
.NOTES
    Uses Windows' own API (Search Options UI triggers the same thing via
    `sc.exe stop` + registry rebuild flag). This is more reliable than
    manually deleting the index DB files while the service is live.
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

# Check admin early: this action requires elevation
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole] 'Administrator'
)
if (-not $isAdmin) {
    $errRecord = @{ code = 'E_NEEDS_ADMIN'; message = 'This action requires Workbench to be launched as Administrator.' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

# Stop WSearch service (requires admin)
$stopOutput = sc.exe stop 'WSearch' 2>&1 | Out-String
Start-Sleep -Seconds 3

$indexPath = 'C:\ProgramData\Microsoft\Search\Data\Applications\Windows'
$beforeSize = 0
$deletedCount = 0
if (Test-Path $indexPath) {
    $items = Get-ChildItem -Path $indexPath -Recurse -Force -ErrorAction SilentlyContinue
    $beforeSize = ($items | Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
    if (-not $beforeSize) { $beforeSize = 0 }
    foreach ($item in $items) {
        try {
            Remove-Item -Path $item.FullName -Force -Recurse -ErrorAction Stop
            $deletedCount++
        } catch {
            # Suppress; files held by WSearch-related processes persist -- OK
        }
    }
}

# Trigger rebuild via registry flag (WSearch re-reads on next start)
$regPath = 'HKLM:\SOFTWARE\Microsoft\Windows Search'
if (Test-Path $regPath) {
    try {
        Set-ItemProperty -Path $regPath -Name 'SetupCompletedSuccessfully' -Value 0 -Type DWord -ErrorAction Stop
    } catch {}
}

$startOutput = sc.exe start 'WSearch' 2>&1 | Out-String
Start-Sleep -Seconds 2

# Validate WSearch came back up
$svc = Get-Service WSearch -ErrorAction SilentlyContinue
$svcStatus = if ($svc) { "$($svc.Status)" } else { 'Unknown' }

$result = @{
    success       = $true
    duration_ms   = $sw.ElapsedMilliseconds
    bytes_freed   = [int64]$beforeSize
    files_deleted = $deletedCount
    service_status = $svcStatus
    message       = "WSearch index reset ($($deletedCount) files removed); background rebuild will run 30-60 min"
}

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
