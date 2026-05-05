<#
.SYNOPSIS
    Stop a single Windows service, capturing before/after state for undo
    (v2.5.30).

.DESCRIPTION
    Wraps Stop-Service -Force with idempotency (already-stopped no-ops),
    DryRun preview, and structured error codes.

    Error code surface:
      E_SVC_NOT_FOUND     -- service does not exist
      E_SVC_HAS_DEPENDENTS -- the service has running dependents and
                              -Force can't kill them (rare; sc.exe stop
                              would also fail). Reason text lists the
                              blocking dependents so the renderer can
                              surface them.
      E_SVC_STOP_FAILED   -- generic stop failure (timeout, ACL)
      E_PS_UNHANDLED      -- catch-all from the trap

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
if ($svc.Status -eq 'Stopped') {
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

# Surface running dependents so the renderer can warn.
$runningDeps = @()
foreach ($d in $svc.DependentServices) {
    if ($d.Status -eq 'Running') { $runningDeps += $d.Name }
}

if ($DryRun) {
    $sw.Stop()
    $payload = @{
        success           = $true
        service           = $Service
        before            = $before
        after             = @{ status = 'Stopped' }
        dependents_running = $runningDeps
        duration_ms       = $sw.ElapsedMilliseconds
        dry_run           = $true
    }
    $payload | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

# Mutate. -Force kills running dependents too (matches services.msc behavior
# when the user clicks Stop on a service with deps and accepts the prompt).
try {
    Stop-Service -Name $Service -Force -ErrorAction Stop
} catch {
    $code = 'E_SVC_STOP_FAILED'
    if ($runningDeps.Count -gt 0) { $code = 'E_SVC_HAS_DEPENDENTS' }
    $errRecord = @{
        code               = $code
        message            = "Could not stop '$Service': $($_.Exception.Message)"
        service            = $Service
        dependents_running = $runningDeps
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

# Brief settle (services can sit in StopPending for a moment).
Start-Sleep -Milliseconds 200
$svcAfter = Get-Service -Name $Service -ErrorAction SilentlyContinue
$afterStatus = if ($svcAfter) { "$($svcAfter.Status)" } else { 'Stopped' }

$sw.Stop()
$payload = @{
    success           = $true
    service           = $Service
    before            = $before
    after             = @{ status = $afterStatus }
    dependents_stopped = $runningDeps
    duration_ms       = $sw.ElapsedMilliseconds
    dry_run           = $false
}
$payload | ConvertTo-Json -Depth 5 -Compress
exit 0
