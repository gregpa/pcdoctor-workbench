<#
.SYNOPSIS
    Remap NAS drives from a QNAP / SMB server using the sidecar config at
    C:\ProgramData\PCDoctor\settings\nas.json (Workbench writes this from
    the settings DB). Falls back to the previous hardcoded Greg defaults
    if the sidecar is missing so pre-v2.4.6 installs upgrade silently.
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

# v2.4.6: load NAS config from the sidecar JSON. Workbench writes this on
# startup + whenever settings are edited. If absent (fresh install before
# first Workbench launch, or user deleted it), fall back to the original
# hardcoded defaults so Greg's existing install keeps working.
$configPath = 'C:\ProgramData\PCDoctor\settings\nas.json'
$nasIp = '192.168.50.226'
$mappings = @(
    @{ drive = 'M:'; share = 'Plex Movies' }
    @{ drive = 'Z:'; share = 'Plex TV Shows' }
    @{ drive = 'W:'; share = '14TB' }
    @{ drive = 'V:'; share = '14TB-2' }
    @{ drive = 'B:'; share = 'Backups' }
    @{ drive = 'U:'; share = 'Greg 4TB USB' }
)
$configSource = 'defaults'
if (Test-Path $configPath) {
    try {
        $cfg = Get-Content $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ($cfg.nas_server) { $nasIp = "$($cfg.nas_server)" }
        if ($cfg.nas_mappings -and $cfg.nas_mappings.Count -gt 0) {
            $mappings = @($cfg.nas_mappings | ForEach-Object { @{ drive = "$($_.drive)"; share = "$($_.share)" } })
        }
        $configSource = 'sidecar'
    } catch {
        # Keep defaults on malformed sidecar.
    }
}

# Remove stale mappings first
Get-SmbMapping -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-SmbMapping -LocalPath $_.LocalPath -Force -UpdateProfile -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Seconds 2
$results = @()
foreach ($m in $mappings) {
    $remote = "\\$nasIp\$($m.share)"
    try {
        New-SmbMapping -LocalPath $m.drive -RemotePath $remote -Persistent $true -ErrorAction Stop | Out-Null
        $results += @{ drive = $m.drive; remote = $remote; status = 'OK' }
    } catch {
        $results += @{ drive = $m.drive; remote = $remote; status = 'FAILED'; error = $_.Exception.Message }
    }
}
$okCount = ($results | Where-Object { $_.status -eq 'OK' }).Count
$result = @{
    success = ($okCount -eq $mappings.Count)
    duration_ms = $sw.ElapsedMilliseconds
    nas_server = $nasIp
    config_source = $configSource
    mappings = $results
    mapped_ok = $okCount
    mapped_total = $mappings.Count
    message = "Mapped $okCount of $($mappings.Count) NAS drives ($configSource config, server $nasIp)"
}

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
