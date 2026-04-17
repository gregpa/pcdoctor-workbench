<#
.SYNOPSIS
    Deletes files from user and system Temp directories.
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

# --- ACTION BODY ---
$paths = @($env:TEMP, "$env:LOCALAPPDATA\Temp", "C:\Windows\Temp")
$totalBytes = 0
$totalFiles = 0
foreach ($p in $paths) {
    if (-not (Test-Path $p)) { continue }
    $items = Get-ChildItem -Path $p -Recurse -Force -ErrorAction SilentlyContinue -File
    foreach ($item in $items) {
        try { $totalBytes += $item.Length; Remove-Item -Path $item.FullName -Force -ErrorAction SilentlyContinue; $totalFiles++ } catch {}
    }
}
$result = @{ success = $true; duration_ms = $sw.ElapsedMilliseconds; bytes_freed = $totalBytes; files_deleted = $totalFiles; message = "Cleared $totalFiles files ($([math]::Round($totalBytes/1MB,1)) MB)" }

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
