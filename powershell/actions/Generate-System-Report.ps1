<#
.SYNOPSIS
    Generate a comprehensive system report (msinfo32, computer info, drivers).
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

$outDir = "$env:TEMP\PCDoctor-SystemReport-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
& msinfo32 /report "$outDir\msinfo32.txt" | Out-Null
Get-ComputerInfo | ConvertTo-Json -Depth 5 | Out-File "$outDir\computerinfo.json" -Encoding UTF8
Get-CimInstance Win32_PnPSignedDriver | Select-Object DeviceName, DriverVersion, DriverDate, Manufacturer | ConvertTo-Json -Depth 3 | Out-File "$outDir\drivers.json" -Encoding UTF8
$result = @{ success = $true; duration_ms = $sw.ElapsedMilliseconds; output_dir = $outDir; message = "System report generated at $outDir" }

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
