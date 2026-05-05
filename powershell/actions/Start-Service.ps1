<#
.SYNOPSIS
    Start a single Windows service, capturing before/after state for undo
    (v2.5.30).

.DESCRIPTION
    Wraps Start-Service with idempotency (already-running no-ops), DryRun
    preview, and structured error codes.

    Error code surface:
      E_SVC_NOT_FOUND     -- service does not exist
      E_SVC_DISABLED      -- service is StartupType=Disabled; the renderer
                              should suggest a Set-ServiceStartup to Manual
                              first
      E_SVC_START_FAILED  -- generic start failure
      E_PS_UNHANDLED      -- catch-all

    On success:
      { success, service, before:{status}, after:{status},
        duration_ms, dry_run }

.NOTES
    PowerShell 5.1 compatible.
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$Service,

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

$svc = $null
try {
    $svc = Get-Service -Name $Service -ErrorAction Stop
} catch {
    $errRecord = @{
        code    = 'E_SVC_NOT_FOUND'
        message = "Service '$Service' does not exist"
        service = $Service
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$beforeStatus = "$($svc.Status)"
$before = @{ status = $beforeStatus }

# Idempotent.
if ($svc.Status -eq 'Running') {
    $sw.Stop()
    $payload = @{
        success     = $true
        service     = $Service
        before      = $before
        after       = $before
        duration_ms = $sw.ElapsedMilliseconds
        dry_run     = [bool]$DryRun
        noop        = $true
    }
    $payload | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

# Disabled-startup pre-check. We could just let Start-Service throw, but a
# distinct error code lets the renderer offer the right next-step UI
# (change StartupType first, then Start) instead of a generic failure toast.
$cim = Get-CimInstance -ClassName Win32_Service -Filter "Name='$Service'" -ErrorAction SilentlyContinue
if ($cim -and "$($cim.StartMode)" -eq 'Disabled') {
    $errRecord = @{
        code    = 'E_SVC_DISABLED'
        message = "Service '$Service' is set to Disabled and cannot be started until its StartupType is changed (Manual or Automatic)."
        service = $Service
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

if ($DryRun) {
    $sw.Stop()
    $payload = @{
        success     = $true
        service     = $Service
        before      = $before
        after       = @{ status = 'Running' }
        duration_ms = $sw.ElapsedMilliseconds
        dry_run     = $true
    }
    $payload | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

try {
    Start-Service -Name $Service -ErrorAction Stop
} catch {
    $errRecord = @{
        code    = 'E_SVC_START_FAILED'
        message = "Could not start '$Service': $($_.Exception.Message)"
        service = $Service
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

# Brief settle.
Start-Sleep -Milliseconds 200
$svcAfter = Get-Service -Name $Service -ErrorAction SilentlyContinue
$afterStatus = if ($svcAfter) { "$($svcAfter.Status)" } else { 'Running' }

$sw.Stop()
$payload = @{
    success     = $true
    service     = $Service
    before      = $before
    after       = @{ status = $afterStatus }
    duration_ms = $sw.ElapsedMilliseconds
    dry_run     = $false
}
$payload | ConvertTo-Json -Depth 5 -Compress
exit 0
