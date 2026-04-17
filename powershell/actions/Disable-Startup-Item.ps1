<#
.SYNOPSIS
    Disables a startup item by removing it from the HKCU/HKLM Run keys or the Startup folder.
#>
param(
    [string]$Item_Name,
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

if (-not $Item_Name) { throw "Item_Name parameter is required" }

$keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
)
$removed = $null
foreach ($k in $keys) {
    if (-not (Test-Path $k)) { continue }
    $props = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
    if ($props.PSObject.Properties.Name -contains $Item_Name) {
        $value = $props.$Item_Name
        Remove-ItemProperty -Path $k -Name $Item_Name -Force -ErrorAction Stop
        $removed = @{ key = $k; name = $Item_Name; value = $value }
        break
    }
}

if (-not $removed) {
    $startupFolder = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
    $match = Get-ChildItem -Path $startupFolder -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -eq $Item_Name -or $_.Name -eq $Item_Name } |
        Select-Object -First 1
    if ($match) {
        Remove-Item -Path $match.FullName -Force -ErrorAction Stop
        $removed = @{ key = $startupFolder; name = $match.Name }
    }
}

if (-not $removed) { throw "Startup item '$Item_Name' not found in Run keys or Startup folder" }

$sw.Stop()
$result = @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    removed     = $removed
    message     = "Removed startup item '$Item_Name'"
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
