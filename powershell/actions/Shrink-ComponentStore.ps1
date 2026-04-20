<#
.SYNOPSIS
    Shrinks the Windows Component Store (WinSxS) via DISM /StartComponentCleanup /ResetBase.
.DESCRIPTION
    Long-running (5-30 min). Irreversible: after ResetBase, superseded updates
    cannot be uninstalled. Requires admin. Reports WinSxS size before and after.
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
    @{ success = $true; dry_run = $true; duration_ms = $sw.ElapsedMilliseconds; message = 'DryRun' } | ConvertTo-Json -Compress
    exit 0
}

# --- Admin pre-check ---
$currentId = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentId)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $errRecord = @{ code = 'E_NOT_ADMIN'; message = 'This action requires administrator privileges.' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

function Get-WinSxSSizeGb {
    try {
        $path = 'C:\Windows\WinSxS'
        if (-not (Test-Path $path)) { return $null }
        $bytes = (Get-ChildItem -Path $path -Recurse -Force -File -ErrorAction SilentlyContinue |
                  Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
        if ($null -eq $bytes) { return $null }
        return [math]::Round($bytes / 1GB, 2)
    } catch { return $null }
}

$beforeGb = Get-WinSxSSizeGb

# Run DISM with 30-minute cap
$log = Join-Path $env:TEMP "pcdoctor-dism-shrink-$([int](Get-Date -UFormat %s)).log"
$proc = Start-Process -FilePath 'dism.exe' `
        -ArgumentList '/Online','/Cleanup-Image','/StartComponentCleanup','/ResetBase' `
        -RedirectStandardOutput $log `
        -NoNewWindow -PassThru

if (-not $proc.WaitForExit(30 * 60 * 1000)) {
    try { $proc.Kill() } catch {}
    throw "DISM did not complete within 30 minutes (timeout). See $log for partial output."
}
$exit = $proc.ExitCode

$afterGb = Get-WinSxSSizeGb
$reclaimedGb = if ($beforeGb -ne $null -and $afterGb -ne $null) { [math]::Round($beforeGb - $afterGb, 2) } else { $null }

$tail = $null
try { $tail = (Get-Content $log -Tail 20 -ErrorAction SilentlyContinue) -join "`n" } catch {}

$sw.Stop()
$result = @{
    success        = ($exit -eq 0)
    duration_ms    = $sw.ElapsedMilliseconds
    exit_code      = $exit
    before_size_gb = $beforeGb
    after_size_gb  = $afterGb
    reclaimed_gb   = $reclaimedGb
    log_path       = $log
    dism_tail      = $tail
    message        = if ($exit -eq 0) { "Component store shrunk from ${beforeGb}GB to ${afterGb}GB (reclaimed ${reclaimedGb}GB)" } else { "DISM exited with code $exit" }
}
$result | ConvertTo-Json -Depth 4 -Compress
exit $(if ($exit -eq 0) { 0 } else { 1 })
