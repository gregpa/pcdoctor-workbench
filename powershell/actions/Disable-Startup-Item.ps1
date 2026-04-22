<#
.SYNOPSIS
    Disables a startup item by removing it from the HKCU/HKLM Run keys or the Startup folder.
#>
param(
    [string]$ItemName,
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

if (-not $ItemName) { throw "ItemName parameter is required" }

$keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
)
$removed = $null
foreach ($k in $keys) {
    if (-not (Test-Path $k)) { continue }
    $props = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
    if ($props.PSObject.Properties.Name -contains $ItemName) {
        $value = $props.$ItemName
        Remove-ItemProperty -Path $k -Name $ItemName -Force -ErrorAction Stop
        $removed = @{ key = $k; name = $ItemName; value = $value }
        break
    }
}

if (-not $removed) {
    $startupFolder = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
    $match = Get-ChildItem -Path $startupFolder -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -eq $ItemName -or $_.Name -eq $ItemName } |
        Select-Object -First 1
    if ($match) {
        Remove-Item -Path $match.FullName -Force -ErrorAction Stop
        $removed = @{ key = $startupFolder; name = $match.Name }
    }
}

if (-not $removed) { throw "Startup item '$ItemName' not found in Run keys or Startup folder" }

$sw.Stop()
$result = @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    removed     = $removed
    message     = "Removed startup item '$ItemName'"
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
