<#
.SYNOPSIS
    Runs Microsoft Safety Scanner (msert.exe) in quiet/no-auto-clean mode.

.OUTPUT
    { exit_code, log_path, threats_found }
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'

trap {
    $errRecord = @{ code = 'E_PS_UNHANDLED'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{ success = $true; dry_run = $true; duration_ms = 0 } | ConvertTo-Json -Compress; exit 0 }

$msert = 'C:\ProgramData\PCDoctor\tools\msert.exe'
if (-not (Test-Path $msert)) {
    $err = @{ code = 'E_MSERT_NOT_INSTALLED'; message = 'Microsoft Safety Scanner not present. Install via Tools page (direct download).' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}

# msert writes its log to %SystemRoot%\debug\msert.log
$logPath = Join-Path $env:SystemRoot 'debug\msert.log'

$proc = Start-Process -FilePath $msert -ArgumentList '/Q','/N' -PassThru -WindowStyle Hidden
$proc.WaitForExit()

$threats = 0
if (Test-Path $logPath) {
    $content = Get-Content -Path $logPath -ErrorAction SilentlyContinue
    # msert flags matches with "Threat Detected" style lines. Count defensively.
    $threats = @($content | Select-String -Pattern 'Threat\s*Detected|Infection|Malware' -AllMatches).Count
}

$sw.Stop()
$result = [ordered]@{
    success       = $true
    duration_ms   = $sw.ElapsedMilliseconds
    exit_code     = $proc.ExitCode
    log_path      = $logPath
    threats_found = $threats
    message       = "Safety Scanner completed (exit=$($proc.ExitCode)); $threats threat-mention(s) in log."
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
