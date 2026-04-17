<#
.SYNOPSIS
    Run TRIM/retrim on all SSD volumes.
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

$ssds = Get-PhysicalDisk | Where-Object { $_.MediaType -eq 'SSD' }
$results = @()
foreach ($d in $ssds) {
    $partitions = Get-Partition -DiskNumber $d.DeviceId -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter }
    foreach ($p in $partitions) {
        $letter = "$($p.DriveLetter):"
        try {
            $out = & defrag $letter /L 2>&1 | Out-String
            $results += @{ drive = $letter; success = ($LASTEXITCODE -eq 0); exit_code = $LASTEXITCODE; output = $out.Trim() }
        } catch {
            $results += @{ drive = $letter; success = $false; error = $_.Exception.Message }
        }
    }
}
$result = @{ success = $true; duration_ms = $sw.ElapsedMilliseconds; trim_results = $results; message = "Ran TRIM on $($results.Count) SSD drive(s)" }

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
