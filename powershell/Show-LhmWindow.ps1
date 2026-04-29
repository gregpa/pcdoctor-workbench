<#
.SYNOPSIS
    Find LibreHardwareMonitor's main window and restore it to the
    foreground (covers the tray-hidden case where Form.Hide() was called).

.DESCRIPTION
    v2.5.3 introduced this script using ShowWindow(SW_RESTORE) — that
    DID NOT WORK against a Form.Hide()-ed .NET Forms window because
    the Win32 ShowWindow API alone cannot flip the form's internal
    Visible state machine. v2.5.4 switches to PostMessage(WM_SYSCOMMAND,
    SC_RESTORE) which routes through the form's WndProc and triggers
    the Forms layer's own restore handler — empirically verified on
    Greg's box: IsWindowVisible flipped False → True.

    Algorithm:
      1. Get-Process LibreHardwareMonitor. If absent, emit
         {ok:false, reason:'not_running'} so the caller (api:openLhm)
         falls through to a launch via shell.openPath.
      2. EnumWindows + GetWindowThreadProcessId to find windows owned
         by LHM's PID. Filter to: class matches WindowsForms10.Window.8.*
         AND non-empty title. The main form's class is consistently
         the .8. subclass; other LHM windows use .0, .20808, etc., or
         are infrastructure (.NET-BroadcastEventWindow, GDI+ Hook,
         IME UI, etc.). Fallback if no .8. match: any top-level window
         whose title contains 'Libre' or 'Hardware Monitor'.
      3. PostMessage(WM_SYSCOMMAND=0x0112, SC_RESTORE=0xF120, 0).
         This is asynchronous — the Forms message pump processes it
         on its own thread.
      4. Sleep 200ms to let the message land.
      5. SetForegroundWindow(hwnd) — best-effort. Foreground-lock
         restrictions can refuse the assert silently. Visibility is
         the headline outcome; focus is a nice-to-have.

    Output: single JSON line on stdout.
      {ok:true, action:'restored', pid:<int>, hwnd:<int>, visible_after:<bool>}
      {ok:false, reason:'not_running'}
      {ok:false, reason:'no_main_window', pid:<int>}

    runPowerShellScript expects clean JSON on stdout. Anything else
    (Write-Verbose, Write-Warning, Write-Host) goes to other streams
    and won't pollute the JSON parse.
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

Add-Type -Namespace U -Name Win32 -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
public delegate bool EnumProc(IntPtr h, IntPtr l);
"@

$lhmPid = $proc.Id
$primaryHwnd = [IntPtr]::Zero  # Class .8. + non-empty title (preferred match)
$fallbackHwnd = [IntPtr]::Zero # Title contains 'Libre' or 'Hardware Monitor'

$cb = [U.Win32+EnumProc] {
    param([IntPtr]$h, [IntPtr]$l)
    $wpid = 0
    [U.Win32]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
    if ($wpid -ne $lhmPid) { return $true }

    $tsb = New-Object System.Text.StringBuilder 256
    [U.Win32]::GetWindowText($h, $tsb, 256) | Out-Null
    $title = $tsb.ToString()
    if ([string]::IsNullOrEmpty($title)) { return $true }

    $csb = New-Object System.Text.StringBuilder 256
    [U.Win32]::GetClassName($h, $csb, 256) | Out-Null
    $cls = $csb.ToString()

    # Primary: class .8. subclass + non-empty title is the main Forms form.
    # Stop enumerating once found.
    if ($cls -like 'WindowsForms10.Window.8.*' -and $script:primaryHwnd -eq [IntPtr]::Zero) {
        $script:primaryHwnd = $h
        return $false
    }
    # Fallback: title-based match for unforeseen LHM internals or
    # future LHM versions where the .NET Forms class numbering shifts.
    if (($title -like '*Libre*' -or $title -like '*Hardware Monitor*') -and $script:fallbackHwnd -eq [IntPtr]::Zero) {
        $script:fallbackHwnd = $h
    }
    return $true
}
[U.Win32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

$mainHwnd = if ($primaryHwnd -ne [IntPtr]::Zero) { $primaryHwnd } else { $fallbackHwnd }

if ($mainHwnd -eq [IntPtr]::Zero) {
    @{ ok = $false; reason = 'no_main_window'; pid = $lhmPid } | ConvertTo-Json -Compress | Write-Output
    exit 0
}

# WM_SYSCOMMAND = 0x0112, SC_RESTORE = 0xF120. Routes through the
# Forms WndProc, which calls Form.WindowState=Normal + Form.Show()
# internally. Empirically verified to flip IsWindowVisible False→True
# on Greg's box where ShowWindow(SW_RESTORE) had no effect.
$WM_SYSCOMMAND = 0x0112
$SC_RESTORE    = 0xF120
[U.Win32]::PostMessage($mainHwnd, $WM_SYSCOMMAND, [IntPtr]$SC_RESTORE, [IntPtr]::Zero) | Out-Null

# Give the Forms message pump time to process the system command on
# its own thread. Empirical 200ms is enough on Greg's i9-10900KF.
Start-Sleep -Milliseconds 200

# Foreground assert. Best-effort — Windows can refuse if PCDoctor
# doesn't have foreground privilege. ShowWindow already flipped
# WS_VISIBLE on, so the user sees the window on the taskbar even
# if focus assignment fails.
[U.Win32]::SetForegroundWindow($mainHwnd) | Out-Null

$visibleAfter = [U.Win32]::IsWindowVisible($mainHwnd)

@{
    ok            = $true
    action        = 'restored'
    pid           = $lhmPid
    hwnd          = [int64]$mainHwnd
    visible_after = $visibleAfter
    method        = if ($primaryHwnd -ne [IntPtr]::Zero) { 'class_match' } else { 'title_fallback' }
} | ConvertTo-Json -Compress | Write-Output

exit 0
