<#
.SYNOPSIS
    Temporarily disables Windows Firewall on all profiles for a specified
    number of minutes, then re-enables it automatically via a one-shot
    scheduled task.
.DESCRIPTION
    Greg's use case: troubleshoot connectivity or an app that Windows Firewall
    is blocking, WITHOUT permanently weakening posture. The script:
      1) Records the current per-profile enabled state (for audit).
      2) Disables Domain + Private + Public profiles via Set-NetFirewallProfile.
      3) Creates a one-shot scheduled task 'PCDoctor-Restore-Firewall' that
         fires at now + N minutes and re-enables all profiles.
      4) Returns the restore time + task name.
    If a previous PCDoctor-Restore-Firewall task exists, it is deleted and
    recreated so the timer resets on each call. Admin required.
.PARAMETER Minutes
    Duration in minutes (1-240). Default 30.
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput,
    [int]$Minutes = 30
)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()

# Validate duration (1 to 4 hours).
if ($Minutes -lt 1 -or $Minutes -gt 240) {
    $e = @{ code='E_INVALID'; message="Minutes must be 1-240. Got: $Minutes" } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"; exit 1
}

if ($DryRun) {
    @{ success=$true; dry_run=$true; duration_ms=0;
       message="Would disable firewall for $Minutes minutes, restore at $((Get-Date).AddMinutes($Minutes).ToString('HH:mm'))" } |
        ConvertTo-Json -Compress
    exit 0
}

# ---- Admin check ----
$currentId = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentId)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $e = @{ code='E_NOT_ADMIN'; message='This action requires administrator privileges.' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"; exit 1
}

# Record pre-state so the audit log has something meaningful.
$preState = @{}
foreach ($p in @('Domain','Private','Public')) {
    try {
        $profile = Get-NetFirewallProfile -Profile $p -ErrorAction Stop
        $preState[$p] = [bool]$profile.Enabled
    } catch { $preState[$p] = $null }
}

# Disable all three profiles.
try {
    Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled False -ErrorAction Stop
} catch {
    $e = @{ code='E_FIREWALL_DISABLE'; message=$_.Exception.Message } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"; exit 1
}

# Create / recreate the one-shot restore task.
$taskName = 'PCDoctor-Restore-Firewall'
$restoreAt = (Get-Date).AddMinutes($Minutes)
# Delete any existing restore task so the timer resets.
& schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null

$restoreCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -NonInteractive -Command `"Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True; schtasks.exe /Delete /TN '$taskName' /F`""
$startTime = $restoreAt.ToString('HH:mm')
$startDate = $restoreAt.ToString('MM/dd/yyyy')
# /SC ONCE + /ST + /SD creates a one-shot run. Runs as SYSTEM so no user
# session needed. The task self-deletes after running.
$createArgs = @(
    '/Create',
    '/TN', $taskName,
    '/TR', $restoreCmd,
    '/SC', 'ONCE',
    '/ST', $startTime,
    '/SD', $startDate,
    '/RU', 'SYSTEM',
    '/RL', 'HIGHEST',
    '/F'
)
$out = & schtasks.exe @createArgs 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    # Firewall was disabled but the restore task didn't register - roll back immediately.
    Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -ErrorAction SilentlyContinue
    $e = @{ code='E_SCHTASKS'; message="Firewall disable rolled back (restore-task creation failed): $($out.Trim())" } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"; exit 1
}

$sw.Stop()
@{
    success         = $true
    duration_ms     = $sw.ElapsedMilliseconds
    disabled_profiles = @('Domain','Private','Public')
    pre_state       = $preState
    restore_at_iso  = $restoreAt.ToString('s')
    restore_at_pretty = $restoreAt.ToString('yyyy-MM-dd HH:mm')
    minutes         = $Minutes
    restore_task    = $taskName
    message         = "Firewall disabled for $Minutes minute(s); auto-restores at $($restoreAt.ToString('HH:mm')) via $taskName"
} | ConvertTo-Json -Depth 5 -Compress
exit 0
