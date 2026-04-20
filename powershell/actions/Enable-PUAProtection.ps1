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

# v2.4.4: Tamper Protection blocks Set-MpPreference by design. Detect up
# front + return a structured E_TAMPER_PROTECTION so the UI can guide the
# user to the Windows Security settings page (the only supported way to
# toggle this with Tamper Protection on).
try {
    $status = Get-MpComputerStatus -ErrorAction Stop
    if ($status.IsTamperProtected) {
        $err = @{
            code='E_TAMPER_PROTECTION'
            message='Tamper Protection is enabled and blocks Set-MpPreference. Toggle PUA in Windows Security manually: Virus & threat protection -> Manage settings -> Potentially unwanted app blocking.'
            open_windows_security = $true
        } | ConvertTo-Json -Compress
        Write-Host "PCDOCTOR_ERROR:$err"
        exit 1
    }
} catch {}

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

# v2.4.4: Also report SmartScreen-side PUA state (it's a different
# subsystem, toggled via App & browser -> Reputation-based protection).
# For a home user, SmartScreen PUA ON is ~90% of the practical posture
# even if Defender PUA stays off.
$smartScreen = @{ enabled = $null; block_apps = $null; block_downloads = $null; source = 'unknown' }
try {
    # SmartScreenPuaEnabled is the official key.
    $ssKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\SmartScreen'
    $ssVal = (Get-ItemProperty -Path $ssKey -Name 'EnableSmartScreen' -EA SilentlyContinue).EnableSmartScreen
    $puaPolicyKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System'
    $puaVal = (Get-ItemProperty -Path $puaPolicyKey -Name 'ShellSmartScreenLevel' -EA SilentlyContinue).ShellSmartScreenLevel
    # Consumer (per-user) path is the real source for the Reputation-based
    # UI toggles in Windows Security on Win 11.
    $userKey = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppHost'
    $ssEnabled = (Get-ItemProperty -Path $userKey -Name 'EnableWebContentEvaluation' -EA SilentlyContinue).EnableWebContentEvaluation
    $smartScreen.enabled = if ($ssVal -ne $null) { [bool]$ssVal } elseif ($ssEnabled -ne $null) { [bool]$ssEnabled } else { $null }
    $smartScreen.source = if ($ssVal -ne $null) { 'policy' } elseif ($ssEnabled -ne $null) { 'user' } else { 'unknown' }
} catch {}

$sw.Stop()
$result = @{
    success        = $true
    no_op          = (-not $changed)
    duration_ms    = $sw.ElapsedMilliseconds
    defender_pua_before = $before
    defender_pua_after  = $after
    smartscreen_pua     = $smartScreen
    changed        = $changed
    message        = if ($changed) {
        "Defender PUA: $before -> $after. SmartScreen PUA (separate) is $(if ($smartScreen.enabled -eq $true) { 'ON' } elseif ($smartScreen.enabled -eq $false) { 'OFF' } else { 'unknown' })."
    } else {
        "Already in desired state: Defender PUA is $before. SmartScreen PUA is $(if ($smartScreen.enabled -eq $true) { 'ON' } elseif ($smartScreen.enabled -eq $false) { 'OFF' } else { 'unknown' })."
    }
}
$result | ConvertTo-Json -Depth 3 -Compress
exit 0
