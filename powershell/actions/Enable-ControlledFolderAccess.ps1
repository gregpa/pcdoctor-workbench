<#
.SYNOPSIS
    Enables Windows Defender Controlled Folder Access (anti-ransomware).
.DESCRIPTION
    Enables CFA on user + system protected folders. Idempotent. Requires admin.
    Does NOT add application allowlist entries -- that is a follow-up action
    once the user notices blocked legitimate apps.
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

$pref = $null
try { $pref = Get-MpPreference -ErrorAction Stop } catch {
    throw "Cannot read Defender preferences: $($_.Exception.Message). Is Defender installed/active?"
}

# EnableControlledFolderAccess: 0 Disabled, 1 Enabled, 2 AuditMode, 3 BlockDiskModificationOnly, 4 AuditDiskModificationOnly
$beforeRaw = $pref.EnableControlledFolderAccess
$before = switch ($beforeRaw) {
    0 { 'Disabled' } 1 { 'Enabled' } 2 { 'AuditMode' }
    3 { 'BlockDiskModificationOnly' } 4 { 'AuditDiskModificationOnly' }
    default { "Unknown($beforeRaw)" }
}

$changed = $false
if ($beforeRaw -ne 1) {
    Set-MpPreference -EnableControlledFolderAccess Enabled -ErrorAction Stop
    $changed = $true
}

$after = 'Enabled'
try {
    $after2 = (Get-MpPreference -ErrorAction Stop).EnableControlledFolderAccess
    $after = switch ($after2) {
        0 { 'Disabled' } 1 { 'Enabled' } 2 { 'AuditMode' }
        3 { 'BlockDiskModificationOnly' } 4 { 'AuditDiskModificationOnly' }
        default { "Unknown($after2)" }
    }
} catch {}

$sw.Stop()
$result = @{
    success      = $true
    no_op        = (-not $changed)
    duration_ms  = $sw.ElapsedMilliseconds
    before_state = $before
    after_state  = $after
    changed      = $changed
    message      = if ($changed) { "Controlled Folder Access: $before -> $after (review blocked apps in Windows Security)" } else { "Already in desired state: Controlled Folder Access is already $before" }
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
