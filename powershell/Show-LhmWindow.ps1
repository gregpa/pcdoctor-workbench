<#
.SYNOPSIS
    Find the LibreHardwareMonitor process and bring its main window to
    the foreground (restore from tray-hide / minimize).

.DESCRIPTION
    v2.5.3: companion to the Dashboard "Open LHM" banner button.
    `shell.openPath` from the Electron main process re-launches LHM via
    `ShellExecute`, which works when LHM is NOT running but does NOT
    restore an already-running tray-hidden process — Greg's LHM is
    configured with "Minimize To Tray" so the main window is hidden
    (not minimized) when the user closes the title bar X. The single-
    instance mutex catches the second launch and the user sees nothing.

    This script handles the running-but-hidden case by walking
    EnumWindows, finding all top-level windows owned by LHM's PID,
    and calling ShowWindow(SW_RESTORE) + SetForegroundWindow on each.

    Output: JSON line on stdout.
      { ok: true, action: 'restored', pid: <int>, window_count: <int> }
      { ok: false, reason: 'not_running' }
      { ok: false, reason: 'no_windows', pid: <int> }

    Caller (api:openLhm in src/main/ipc.ts) interprets `ok:false` +
    reason='not_running' as a signal to fall through to shell.openPath
    and launch a fresh instance.

    SetForegroundWindow has Windows foreground-lock restrictions that
    can fail silently if the calling process doesn't have foreground
    privilege. ShowWindow(SW_RESTORE) makes the window visible
    regardless; the foreground bring-up is best-effort. For the tray
    case Greg saw, restoring visibility is the headline outcome.
#>
param()

$ErrorActionPreference = 'Continue'

trap {
    $err = @{
        ok      = $false
        reason  = 'ps_unhandled'
        message = "$($_.Exception.Message)"
    } | ConvertTo-Json -Compress
    Write-Output $err
    exit 1
}

$proc = Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) {
    @{ ok = $false; reason = 'not_running' } | ConvertTo-Json -Compress | Write-Output
    exit 0
}

# P/Invoke. Defined inline so the script is self-contained.
Add-Type -Namespace U -Name Win32 -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
public delegate bool EnumProc(IntPtr h, IntPtr l);
"@

$lhmPid = $proc.Id
$found = New-Object System.Collections.Generic.List[IntPtr]

# EnumWindows callback: collect every top-level window owned by LHM's PID
# that has a non-zero-length title. Tray-hidden Forms windows still have
# a title; truly-orphaned popups don't.
$cb = [U.Win32+EnumProc] {
    param([IntPtr]$h, [IntPtr]$l)
    $wpid = 0
    [U.Win32]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
    if ($wpid -eq $lhmPid) {
        $titleLen = [U.Win32]::GetWindowTextLength($h)
        if ($titleLen -gt 0) {
            $found.Add($h)
        }
    }
    return $true
}

[U.Win32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($found.Count -eq 0) {
    @{ ok = $false; reason = 'no_windows'; pid = $lhmPid } | ConvertTo-Json -Compress | Write-Output
    exit 0
}

# SW_RESTORE = 9 (un-minimize / un-hide). SetForegroundWindow lifts
# z-order; soft-failure is acceptable (window is at least visible).
foreach ($h in $found) {
    [U.Win32]::ShowWindow($h, 9) | Out-Null
    [U.Win32]::SetForegroundWindow($h) | Out-Null
}

@{ ok = $true; action = 'restored'; pid = $lhmPid; window_count = $found.Count } | ConvertTo-Json -Compress | Write-Output
exit 0
