!macro customInstall
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
  ExecWait 'pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Register-All-Tasks.ps1"'
!macroend

!macro customUnInstall
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Workbench-Autostart" /F'
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Weekly-Review" /F'
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Forecast" /F'
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Security-Daily" /F'
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Security-Weekly" /F'
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Prune-Rollbacks" /F'
!macroend
