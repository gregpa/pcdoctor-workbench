<#
.SYNOPSIS
    Remap the 6 NAS drives (M, Z, W, V, B, U) from the QNAP at 192.168.50.226.
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

$nasIp = '192.168.50.226'
$mappings = @(
    @{ drive = 'M:'; share = 'Plex Movies' }
    @{ drive = 'Z:'; share = 'Plex TV Shows' }
    @{ drive = 'W:'; share = '14TB' }
    @{ drive = 'V:'; share = '14TB-2' }
    @{ drive = 'B:'; share = 'Backups' }
    @{ drive = 'U:'; share = 'Greg 4TB USB' }
)
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
$result = @{ success = ($okCount -eq $mappings.Count); duration_ms = $sw.ElapsedMilliseconds; mappings = $results; mapped_ok = $okCount; mapped_total = $mappings.Count; message = "Mapped $okCount of $($mappings.Count) NAS drives" }

$sw.Stop()
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
