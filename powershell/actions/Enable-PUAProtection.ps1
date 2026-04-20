<#
.SYNOPSIS
    Enables Windows Defender Potentially Unwanted Application (PUA) protection.
.DESCRIPTION
    Idempotent: reads current Set-MpPreference value first and reports
    before/after. Requires admin.
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

# Get-MpPreference may throw if Defender isn't installed
$pref = $null
try { $pref = Get-MpPreference -ErrorAction Stop } catch {
    throw "Cannot read Defender preferences: $($_.Exception.Message). Is Defender installed/active?"
}

# PUAProtection values: 0 = Disabled, 1 = Enabled, 2 = AuditMode
$beforeRaw = $pref.PUAProtection
$before = switch ($beforeRaw) { 0 { 'Disabled' } 1 { 'Enabled' } 2 { 'AuditMode' } default { "Unknown($beforeRaw)" } }

$changed = $false
if ($beforeRaw -ne 1) {
    Set-MpPreference -PUAProtection Enabled -ErrorAction Stop
    $changed = $true
}

$after = 'Enabled'
try {
    $after2 = (Get-MpPreference -ErrorAction Stop).PUAProtection
    $after = switch ($after2) { 0 { 'Disabled' } 1 { 'Enabled' } 2 { 'AuditMode' } default { "Unknown($after2)" } }
} catch {}

$sw.Stop()
$result = @{
    success      = $true
    no_op        = (-not $changed)
    duration_ms  = $sw.ElapsedMilliseconds
    before_state = $before
    after_state  = $after
    changed      = $changed
    message      = if ($changed) { "PUA protection: $before -> $after" } else { "Already in desired state: PUA protection is already $before" }
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
