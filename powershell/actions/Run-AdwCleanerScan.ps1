<#
.SYNOPSIS
    Runs AdwCleaner in /scan mode and writes a report. Report-only; never removes.

.OUTPUT
    { pups_found, report_path, duration_s }
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
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($DryRun) {
    @{ success = $true; dry_run = $true; duration_ms = $sw.ElapsedMilliseconds } | ConvertTo-Json -Compress
    exit 0
}

$candidates = @(
    'C:\ProgramData\PCDoctor\tools\adwcleaner.exe',
    'C:\Program Files\AdwCleaner\adwcleaner.exe'
)
$exe = $null
foreach ($c in $candidates) { if (Test-Path $c) { $exe = $c; break } }
if (-not $exe) {
    $err = @{ code = 'E_ADWCLEANER_NOT_INSTALLED'; message = 'AdwCleaner not installed. Install via Tools page.' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}

$reportDir = 'C:\ProgramData\PCDoctor\reports\adwcleaner'
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }
$reportPath = Join-Path $reportDir ("scan-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".txt")

$proc = Start-Process -FilePath $exe -ArgumentList @('/eula','/scan','/report',"`"$reportPath`"") -PassThru -WindowStyle Hidden
$proc.WaitForExit()

$pupsFound = 0
if (Test-Path $reportPath) {
    $txt = Get-Content -Path $reportPath -ErrorAction SilentlyContinue
    $pupsFound = @($txt | Select-String -Pattern '\bPUP\.|Adware\.|Trojan\.|Hijack\.' -AllMatches).Count
}

$sw.Stop()
$result = [ordered]@{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    pups_found  = $pupsFound
    report_path = $reportPath
    duration_s  = [int]($sw.Elapsed.TotalSeconds)
    exit_code   = $proc.ExitCode
    message     = "AdwCleaner scan complete; $pupsFound PUP(s) flagged in report."
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
