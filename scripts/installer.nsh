!macro customInstall
  ; Register Windows Scheduled Task for autostart at user logon
  ExecWait 'schtasks.exe /Create /TN "PCDoctor-Workbench-Autostart" /TR "$\"$INSTDIR\PCDoctor Workbench.exe$\"" /SC ONLOGON /RL LIMITED /F'
!macroend

!macro customUnInstall
  ; Remove autostart task on uninstall
  ExecWait 'schtasks.exe /Delete /TN "PCDoctor-Workbench-Autostart" /F'
!macroend
