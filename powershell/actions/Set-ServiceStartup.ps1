<#
.SYNOPSIS
    Idempotent change of a single service's StartupType, with full
    before-state capture for undo (v2.5.30).

.DESCRIPTION
    Tries `Set-Service -StartupType` first because it's the idiomatic
    PowerShell path. Falls back to `sc.exe config` when:
      1. StartupType is 'AutomaticDelayedStart' -- Set-Service in PS5.1
         only accepts Automatic/Manual/Disabled, not delayed-auto.
      2. Set-Service fails with "Access denied" (ACL-locked services
         like Microsoft Store-registered services -- the GamingServices
         class of bug Greg hit in v2.5.1).

    Error code surface:
      E_INVALID_PARAM         -- StartupType not in {Automatic,
                                  AutomaticDelayedStart, Manual, Disabled}
      E_SVC_NOT_FOUND         -- service does not exist
      E_SVC_NO_PERMISSION     -- both Set-Service AND sc.exe failed
                                 (probably driver service or TrustedInstaller-
                                 locked); reason text suggests the
                                 Get-AppxPackage | Remove-AppxPackage path
                                 for Microsoft Store services
      E_PS_UNHANDLED          -- catch-all from the trap

    On success returns:
      { success, service, before:{status,start_type}, after:{status,start_type},
        method, duration_ms }

    DryRun returns the same shape with `dry_run: true` and the projected
    after block computed from the requested StartupType (without firing
    the actual mutation). Used by the renderer's confirm dialog.

.NOTES
    PowerShell 5.1 compatible.
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$Service,

    [Parameter(Mandatory=$true)]
    [ValidateSet('Automatic','AutomaticDelayedStart','Manual','Disabled')]
    [string]$StartupType,

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

# ---------------------------------------------------------------------------
# Read current state.
# ---------------------------------------------------------------------------
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
$cim = Get-CimInstance -ClassName Win32_Service -Filter "Name='$Service'" -ErrorAction Stop

function Get-StartTypeLabel {
    param($cimRow)
    $mode = "$($cimRow.StartMode)"
    switch ($mode) {
        'Auto'     { if ($cimRow.DelayedAutoStart) { return 'AutomaticDelayedStart' } else { return 'Automatic' } }
        'Manual'   { return 'Manual' }
        'Disabled' { return 'Disabled' }
        'Boot'     { return 'Boot' }
        'System'   { return 'System' }
        default    { return $mode }
    }
}

$beforeStartType = Get-StartTypeLabel -cimRow $cim
$beforeStatus    = "$($svc.Status)"
$before = @{ status = $beforeStatus; start_type = $beforeStartType }

# ---------------------------------------------------------------------------
# Idempotency: if we're already in the requested state, no-op.
# ---------------------------------------------------------------------------
if ($beforeStartType -eq $StartupType) {
    $sw.Stop()
    $payload = @{
        success     = $true
        service     = $Service
        before      = $before
        after       = $before
        method      = 'noop'
        duration_ms = $sw.ElapsedMilliseconds
        dry_run     = [bool]$DryRun
    }
    $payload | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

# ---------------------------------------------------------------------------
# DryRun: just project the after state.
# ---------------------------------------------------------------------------
if ($DryRun) {
    $sw.Stop()
    $payload = @{
        success     = $true
        service     = $Service
        before      = $before
        after       = @{ status = $beforeStatus; start_type = $StartupType }
        method      = 'dry-run'
        duration_ms = $sw.ElapsedMilliseconds
        dry_run     = $true
    }
    $payload | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

# ---------------------------------------------------------------------------
# Mutate: prefer Set-Service, fall back to sc.exe.
# ---------------------------------------------------------------------------
$method = $null
$mutateErr = $null

# AutomaticDelayedStart can only be set via sc.exe in PS5.1.
$tryNative = ($StartupType -ne 'AutomaticDelayedStart')

if ($tryNative) {
    try {
        Set-Service -Name $Service -StartupType $StartupType -ErrorAction Stop
        $method = 'Set-Service'
    } catch {
        $mutateErr = $_.Exception.Message
    }
}

if (-not $method) {
    # Translate to sc.exe's start= argument values.
    $scStart = switch ($StartupType) {
        'Automatic'             { 'auto' }
        'AutomaticDelayedStart' { 'delayed-auto' }
        'Manual'                { 'demand' }
        'Disabled'              { 'disabled' }
    }
    # NOTE: `start=` argument requires a SPACE after `=` for sc.exe.
    $scOut = & sc.exe config $Service "start=" $scStart 2>&1
    $scExit = $LASTEXITCODE
    if ($scExit -ne 0) {
        $errRecord = @{
            code    = 'E_SVC_NO_PERMISSION'
            message = "Could not change startup type of '$Service'. Set-Service: $mutateErr. sc.exe exit $scExit. " +
                      "If this is a Microsoft Store service (e.g. GamingServices), try " +
                      "Get-AppxPackage -AllUsers *<name>* | Remove-AppxPackage -AllUsers from elevated PowerShell."
            service = $Service
            sc_output = "$scOut"
        } | ConvertTo-Json -Compress
        Write-Host "PCDOCTOR_ERROR:$errRecord"
        exit 1
    }
    $method = 'sc.exe'
}

# ---------------------------------------------------------------------------
# Read after state for confirmation.
# ---------------------------------------------------------------------------
$svcAfter = Get-Service -Name $Service -ErrorAction SilentlyContinue
$cimAfter = Get-CimInstance -ClassName Win32_Service -Filter "Name='$Service'" -ErrorAction SilentlyContinue
$afterStartType = if ($cimAfter) { Get-StartTypeLabel -cimRow $cimAfter } else { $StartupType }
$afterStatus    = if ($svcAfter) { "$($svcAfter.Status)" } else { $beforeStatus }
$after = @{ status = $afterStatus; start_type = $afterStartType }

$sw.Stop()
$payload = @{
    success     = $true
    service     = $Service
    before      = $before
    after       = $after
    method      = $method
    duration_ms = $sw.ElapsedMilliseconds
    dry_run     = $false
}
$payload | ConvertTo-Json -Depth 5 -Compress
exit 0
