!macro customInstall
  ; v2.3.0: seed C:\ProgramData\PCDoctor\ with the bundled powershell/ tree so
  ; the app works on a fresh install. We copy every script/subdir from the
  ; installer's resources\powershell into ProgramData, overwriting existing
  ; files with the new versions.
  CreateDirectory "$APPDATA\..\..\..\ProgramData\PCDoctor"
  CopyFiles /SILENT "$INSTDIR\resources\powershell\*.*" "C:\ProgramData\PCDoctor"

  ; v2.3.13 security: Lock down ACLs on C:\ProgramData\PCDoctor so
  ; non-admin users cannot overwrite PS scripts that later run elevated.
  ; Default ProgramData inheritance grants BUILTIN\Users:(I)(M) which is a
  ; "bring your own elevator" pathway - malware running as the user can
  ; swap Block-IP.ps1 etc. and have the next UAC prompt run the replacement
  ; as Administrator.
  ;
  ; Two-tier ACL:
  ;   - Root + scripts (read-only for Users): SYSTEM:F, Admins:F, Users:RX
  ;   - Data subdirs (writable for Users):    + Users:M on data paths
  ; SIDs are locale-safe (SYSTEM=S-1-5-18, Admins=S-1-5-32-544, Users=S-1-5-32-545).
  ; v2.3.15: stop Defender real-time scan from holding PS files open during
  ; the icacls pass (observed in v2.3.13: two Defender-config scripts ended
  ; up with zero ACEs because Defender locked them). Temporarily exclude the
  ; PCDoctor directory, run icacls, then remove the exclusion.
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath C:\ProgramData\PCDoctor -ErrorAction SilentlyContinue"'
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" /grant:r "*S-1-5-32-544:(OI)(CI)F" /grant:r "*S-1-5-32-545:(OI)(CI)RX" /T /C /Q'
  ; Second pass: re-enable inheritance on any file that ended up with zero
  ; ACEs because icacls /grant:r silently failed on an in-use file. This is
  ; a self-healing step that catches the v2.3.13 Defender-lock bug.
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Repair-ScriptAcls.ps1"'
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath C:\ProgramData\PCDoctor -ErrorAction SilentlyContinue"'
  CreateDirectory "C:\ProgramData\PCDoctor\logs"
  CreateDirectory "C:\ProgramData\PCDoctor\reports"
  CreateDirectory "C:\ProgramData\PCDoctor\snapshots"
  CreateDirectory "C:\ProgramData\PCDoctor\exports"
  CreateDirectory "C:\ProgramData\PCDoctor\claude-bridge"
  CreateDirectory "C:\ProgramData\PCDoctor\history"
  CreateDirectory "C:\ProgramData\PCDoctor\baseline"
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\logs" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q'
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\reports" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q'
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\snapshots" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q'
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\exports" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q'
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\claude-bridge" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q'
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\history" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q'
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\baseline" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q'
  ; workbench.db lives at the root but must be writable by the user.
  ; Grant Modify on the specific files (won't propagate to other root files).
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\workbench.db" /grant "*S-1-5-32-545:M" /C /Q'
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\workbench.db-wal" /grant "*S-1-5-32-545:M" /C /Q'
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\workbench.db-shm" /grant "*S-1-5-32-545:M" /C /Q'

  ; Register Windows Scheduled Task for autostart at user logon.
  ; Writing an XML task definition avoids the nested-quote parser issue with schtasks /Create /TR.
  FileOpen $0 "$TEMP\PCDoctor-Autostart.xml" w
  FileWrite $0 `<?xml version="1.0" encoding="UTF-16"?>$\r$\n`
  FileWrite $0 `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">$\r$\n`
  FileWrite $0 `<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>$\r$\n`
  FileWrite $0 `<Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>$\r$\n`
  FileWrite $0 `<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession><UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>$\r$\n`
  FileWrite $0 `<Actions Context="Author"><Exec><Command>$INSTDIR\PCDoctor Workbench.exe</Command></Exec></Actions>$\r$\n`
  FileWrite $0 `</Task>$\r$\n`
  FileClose $0
  ExecWait 'schtasks.exe /Create /TN "PCDoctor-Workbench-Autostart" /XML "$TEMP\PCDoctor-Autostart.xml" /F'
  Delete "$TEMP\PCDoctor-Autostart.xml"

  ; After first launch the app calls Register-All-Tasks.ps1 which sets up the rest.
  ; As a redundancy + so tasks exist even before app opens, trigger the registration now:
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Register-All-Tasks.ps1" -ForceRecreate'
!macroend

!macro customUnInstall
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Workbench-Autostart" /F'
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Weekly-Review" /F'
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Forecast" /F'
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Security-Daily" /F'
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Security-Weekly" /F'
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Prune-Rollbacks" /F'
!macroend
