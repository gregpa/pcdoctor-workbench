!macro customInstall
  ; v2.3.0: seed C:\ProgramData\PCDoctor\ with the bundled powershell/ tree so
  ; the app works on a fresh install.
  CreateDirectory "$APPDATA\..\..\..\ProgramData\PCDoctor"
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Copy-Item -Path \"$INSTDIR\resources\powershell\*\" -Destination \"C:\ProgramData\PCDoctor\" -Recurse -Force -ErrorAction Stop"'

  ; =============================================================
  ; v2.4.9 ACL SEQUENCE — shared with scripts/test-installer-acl.ps1
  ; =============================================================
  ; v2.4.6, v2.4.7, v2.4.8 all shipped with broken ACL logic because the
  ; installer used `icacls <dir> /inheritance:r /grant:r "SID:(OI)(CI)PERM" /T`
  ; which FAILS SILENTLY on FILE children — the (OI)(CI) inheritance flags
  ; are directory-only, so /grant:r rejects the ACE on files while
  ; /inheritance:r still succeeds at stripping inherited ACEs. Result:
  ; tree-wide zero-ACE files (83, 14, 787 respectively on Greg's upgrade
  ; installs).
  ;
  ; v2.4.9 fix: delegate ACL application to Apply-TieredAcl.ps1 which
  ; enumerates dirs and files separately and applies the correct flags
  ; to each type. The pre-ship test harness at scripts/test-installer-acl.ps1
  ; uses the SAME Apply-TieredAcl.ps1, guaranteeing what we test is what
  ; we ship.
  ;
  ; Two-tier ACL:
  ;   - Root + script subdirs (actions/, security/) + root-level files:
  ;     Users:RX (read-only). Prevents "bring-your-own-elevator" malware
  ;     pathway where user-writable script is swapped then UAC-elevated.
  ;   - Data subdirs (logs/reports/snapshots/exports/claude-bridge/history/
  ;     baseline): Users:M (writable — app writes scan reports here).
  ; =============================================================

  ; Step 1: Defender exclusion so real-time scan doesn't race icacls.
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath C:\ProgramData\PCDoctor -ErrorAction SilentlyContinue"'
  ; 2s for any in-flight scan to release file locks.
  Sleep 2000

  ; Step 2: admin ownership of every file. On upgrade installs this is
  ; critical — files from prior broken installs may have empty DACLs that
  ; block even admin from modifying ACLs without explicit takeown.
  ExecWait 'takeown.exe /f "C:\ProgramData\PCDoctor" /r /d y'

  ; Step 3: reset tree to default inherited ACLs. Clears any corruption
  ; from prior installs. Transient intermediate state.
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor" /reset /T /C /Q'

  ; Step 4: tier-A on root container + root-level files (root mode).
  ; Apply-TieredAcl's -Mode root handles the dir + immediate files ONLY and
  ; also adds the SQLite sibling-creation grant (Users:(WD,AD,DC)) on the
  ; root dir object so SQLite can create workbench.db-wal / workbench.db-shm
  ; journals at startup. Subdirs (actions/, security/, data subdirs) get
  ; their own invocations below with their own tier.
  ;
  ; v2.4.12 E-19 fix: -Mode is a ValidateSet string param instead of a
  ; [switch]. v2.4.11's installer shipped with [switch]$NonRecursive; the
  ; harness saw it bind but this ExecWait form did not, so the SQLite grant
  ; never made it onto the real install. String params are unambiguous
  ; across every caller form (direct `&`, -File subprocess, NSIS ExecWait).
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Apply-TieredAcl.ps1" -Path "C:\ProgramData\PCDoctor" -Tier A -Mode root'

  ; Step 5: tier-A on script subdirs (recursive — all files inside get Users:RX).
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Apply-TieredAcl.ps1" -Path "C:\ProgramData\PCDoctor\actions" -Tier A'
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Apply-TieredAcl.ps1" -Path "C:\ProgramData\PCDoctor\security" -Tier A'

  ; Step 6a: ensure data subdirectories exist.
  ; v2.4.10: added `settings` — nasConfig.ts writes `settings\nas.json` at
  ; runtime. Without this step the settings dir would be runtime-created
  ; under the tier-A root, inheriting Users:RX, and writes would fail silently.
  CreateDirectory "C:\ProgramData\PCDoctor\logs"
  CreateDirectory "C:\ProgramData\PCDoctor\reports"
  CreateDirectory "C:\ProgramData\PCDoctor\snapshots"
  CreateDirectory "C:\ProgramData\PCDoctor\exports"
  CreateDirectory "C:\ProgramData\PCDoctor\claude-bridge"
  CreateDirectory "C:\ProgramData\PCDoctor\history"
  CreateDirectory "C:\ProgramData\PCDoctor\baseline"
  CreateDirectory "C:\ProgramData\PCDoctor\settings"

  ; Step 6b: tier-B on each data subdir (recursive — all files inside get Users:M).
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Apply-TieredAcl.ps1" -Path "C:\ProgramData\PCDoctor\logs" -Tier B'
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Apply-TieredAcl.ps1" -Path "C:\ProgramData\PCDoctor\reports" -Tier B'
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Apply-TieredAcl.ps1" -Path "C:\ProgramData\PCDoctor\snapshots" -Tier B'
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Apply-TieredAcl.ps1" -Path "C:\ProgramData\PCDoctor\exports" -Tier B'
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Apply-TieredAcl.ps1" -Path "C:\ProgramData\PCDoctor\claude-bridge" -Tier B'
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Apply-TieredAcl.ps1" -Path "C:\ProgramData\PCDoctor\history" -Tier B'
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Apply-TieredAcl.ps1" -Path "C:\ProgramData\PCDoctor\baseline" -Tier B'
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Apply-TieredAcl.ps1" -Path "C:\ProgramData\PCDoctor\settings" -Tier B'

  ; Step 6c (v2.5.7 B1 fix): pre-create workbench.db-wal / workbench.db-shm
  ; as zero-byte files IF they do not exist, so Step 7's additive grants
  ; actually land on the file objects. Without this step, fresh installs
  ; deferred wal/shm creation to first SQLite write -- the new files
  ; inherited Users:(I)(RX) from the tier-A root, and subsequent process
  ; opens hit SQLITE_READONLY despite Step 7 having "succeeded" (no-op
  ; because the targets did not exist yet). Zero-byte wal/shm are valid
  ; SQLite state ("no committed txns in WAL") and are overwritten on first
  ; transaction. We use New-Item -Force only when -not (Test-Path) so we
  ; never clobber an existing journal on upgrade.
  ; Note: NSIS parses '$name' inside strings as variable references, so we
  ; CANNOT use PowerShell variables ($wal, $shm) here — that produces NSIS
  ; warning 6000 ("unknown variable/constant") which is fatal under strict.
  ; The wal/shm paths have no spaces, so unquoted Test-Path / New-Item args
  ; are safe and avoid all NSIS-escape gymnastics.
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if (-not (Test-Path C:\ProgramData\PCDoctor\workbench.db-wal)) { New-Item -Path C:\ProgramData\PCDoctor\workbench.db-wal -ItemType File -Force -ErrorAction Stop | Out-Null }; if (-not (Test-Path C:\ProgramData\PCDoctor\workbench.db-shm)) { New-Item -Path C:\ProgramData\PCDoctor\workbench.db-shm -ItemType File -Force -ErrorAction Stop | Out-Null }"'

  ; Step 7: workbench.db needs Users:M despite living at root (tier-A).
  ; Additive /grant on these specific files; does not propagate. /C
  ; continues on errors. Step 6c above guarantees wal/shm exist so /grant
  ; lands instead of silently no-opping.
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\workbench.db" /grant "*S-1-5-32-545:(M)" /C /Q'
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\workbench.db-wal" /grant "*S-1-5-32-545:(M)" /C /Q'
  ExecWait 'icacls.exe "C:\ProgramData\PCDoctor\workbench.db-shm" /grant "*S-1-5-32-545:(M)" /C /Q'

  ; Step 8: remove Defender exclusion now ACL work is done.
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath C:\ProgramData\PCDoctor -ErrorAction SilentlyContinue"'

  ; Step 9: safety net - Repair-ScriptAcls.ps1 -Elevated scans for any
  ; remaining zero-ACE files. With Apply-TieredAcl's dir/file separation
  ; this should be a no-op, but it costs nothing to keep as a final check.
  ; v2.4.10: guard with IfFileExists. NSIS ExecWait ignores exit codes, so
  ; if the script ever fails to ship in the bundle we'd silently skip the
  ; safety net rather than seeing a clear error. Test-Path equivalent.
  IfFileExists "C:\ProgramData\PCDoctor\Repair-ScriptAcls.ps1" 0 +2
    ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Repair-ScriptAcls.ps1" -Elevated'

  ; Step 10 (v2.4.12 E-19 fix): post-install ACL verification.
  ; Reads the INSTALLED DACL state on C:\ProgramData\PCDoctor and confirms
  ; it matches the expected tier configuration. Writes a timestamped log
  ; to C:\ProgramData\PCDoctor\logs\install-verify-*.log.
  ;
  ; Why this exists as a separate script from the pre-ship harness:
  ; the harness runs in a SANDBOX. v2.4.11 passed the harness but the
  ; real install silently dropped the SQLite grant. This script catches
  ; drift on the REAL install state. NSIS ExecWait ignores the exit
  ; code, but a failing install leaves a log file at a known location
  ; that tells the user exactly what went wrong.
  IfFileExists "C:\ProgramData\PCDoctor\Verify-InstalledAcl.ps1" 0 +2
    ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Verify-InstalledAcl.ps1" -Quiet'

  ; =============================================================
  ; Scheduled task for autostart (unchanged from v2.4.6)
  ; =============================================================
  FileOpen $0 "$TEMP\PCDoctor-Autostart.xml" w
  FileWrite $0 `<?xml version="1.0" encoding="UTF-16"?>$\r$\n`
  FileWrite $0 `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">$\r$\n`
  FileWrite $0 `<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>$\r$\n`
  FileWrite $0 `<Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>$\r$\n`
  FileWrite $0 `<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession><UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>$\r$\n`
  FileWrite $0 `<Actions Context="Author"><Exec><Command>$INSTDIR\PCDoctor Workbench.exe</Command><Arguments>--hidden</Arguments></Exec></Actions>$\r$\n`
  FileWrite $0 `</Task>$\r$\n`
  FileClose $0
  ExecWait 'schtasks.exe /Create /TN "PCDoctor-Workbench-Autostart" /XML "$TEMP\PCDoctor-Autostart.xml" /F'
  Delete "$TEMP\PCDoctor-Autostart.xml"

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
