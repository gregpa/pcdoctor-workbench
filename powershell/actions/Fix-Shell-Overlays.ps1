<#
.SYNOPSIS
    Deprioritizes redundant OneDrive shell icon overlay handlers so Windows preserves
    slots for other overlay providers (Windows allows only 15).
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

$key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers'
if (-not (Test-Path $key)) { throw "Registry key not found: $key" }

$entries = Get-ChildItem -Path $key -ErrorAction SilentlyContinue
$renamed = @()
$oneDriveEntries = $entries | Where-Object { $_.PSChildName -match '^ *OneDrive' } | Sort-Object PSChildName
if ($oneDriveEntries.Count -gt 2) {
    foreach ($e in $oneDriveEntries | Select-Object -Skip 2) {
        $old = $e.PSChildName
        if ($old -notlike 'ZZZZ*') {
            $new = "ZZZZ$old"
            try {
                Rename-Item -Path $e.PSPath -NewName $new -Force -ErrorAction Stop
                $renamed += @{ from = $old; to = $new }
            } catch {}
        }
    }
}

$sw.Stop()
$result = @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    renamed     = $renamed
    count       = $renamed.Count
    message     = "Deprioritized $($renamed.Count) redundant OneDrive overlay handlers"
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
