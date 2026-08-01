!macro PCDoctorApplyAcl TARGET TIER MODE
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\powershell\Apply-TieredAcl.ps1" -Path "${TARGET}" -Tier ${TIER} -Mode ${MODE}' $0
  IntCmp $0 0 +3
    MessageBox MB_ICONSTOP "PCDoctor could not apply the ${TIER} ACL to ${TARGET} (exit $0). Installation is stopping fail-closed."
    Abort
!macroend

!macro customInstall
  ; The generated NSIS installer still accepts a command-line /D override even
  ; when the directory page is disabled. Refuse anything except the fixed,
  ; administrator-protected Program Files control plane before any mutation.
  StrCmp $INSTDIR "C:\Program Files\PCDoctor Workbench" pcdoctor_install_dir_trusted
    MessageBox MB_ICONSTOP "PCDoctor must be installed in C:\Program Files\PCDoctor Workbench. Installation is stopping fail-closed."
    Abort
  pcdoctor_install_dir_trusted:

  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\powershell\Initialize-ProgramDataRoot.ps1"' $0
  IntCmp $0 0 +3
    MessageBox MB_ICONSTOP "PCDoctor could not establish a safe ProgramData root (exit $0). Installation is stopping fail-closed."
    Abort

  ; v2.3.0: seed C:\ProgramData\PCDoctor\ with the bundled powershell/ tree so
  ; the app works on a fresh install.
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Copy-Item -Path \"$INSTDIR\resources\powershell\*\" -Destination \"C:\ProgramData\PCDoctor\" -Recurse -Force -ErrorAction Stop"' $0
  IntCmp $0 0 +3
    MessageBox MB_ICONSTOP "PCDoctor could not seed its ProgramData files (exit $0). Installation is stopping fail-closed."
    Abort

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

  ; Do not add a temporary Defender exclusion. ACL operations fail closed if
  ; endpoint protection holds a file; installer policy must remain untouched.

  ; The initializer already takes ownership of each exact non-reparse node
  ; and temporarily protects the complete tree. Do not reintroduce a
  ; recursive takeown/icacls-reset window here.

  ; Tier-A on root container + root-level files (root mode) is applied only
  ; after all subtrees are configured below. That keeps root child creation
  ; disabled while recursive ACL operations run.
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
  ; Tier-A on script subdirs (recursive — all files inside get Users:RX).
  !insertmacro PCDoctorApplyAcl "C:\ProgramData\PCDoctor\actions" A recurse
  !insertmacro PCDoctorApplyAcl "C:\ProgramData\PCDoctor\security" A recurse

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
  !insertmacro PCDoctorApplyAcl "C:\ProgramData\PCDoctor\logs" B recurse
  !insertmacro PCDoctorApplyAcl "C:\ProgramData\PCDoctor\reports" B recurse
  !insertmacro PCDoctorApplyAcl "C:\ProgramData\PCDoctor\snapshots" B recurse
  !insertmacro PCDoctorApplyAcl "C:\ProgramData\PCDoctor\exports" B recurse
  !insertmacro PCDoctorApplyAcl "C:\ProgramData\PCDoctor\claude-bridge" B recurse
  !insertmacro PCDoctorApplyAcl "C:\ProgramData\PCDoctor\history" B recurse
  !insertmacro PCDoctorApplyAcl "C:\ProgramData\PCDoctor\baseline" B recurse
  !insertmacro PCDoctorApplyAcl "C:\ProgramData\PCDoctor\settings" B recurse

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
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path C:\ProgramData\PCDoctor\workbench.db) { if (-not (Test-Path C:\ProgramData\PCDoctor\workbench.db -PathType Leaf)) { throw $"workbench.db is not a file$" } } else { New-Item -Path C:\ProgramData\PCDoctor\workbench.db -ItemType File -Force -ErrorAction Stop | Out-Null }; if (Test-Path C:\ProgramData\PCDoctor\workbench.db-wal) { if (-not (Test-Path C:\ProgramData\PCDoctor\workbench.db-wal -PathType Leaf)) { throw $"workbench.db-wal is not a file$" } } else { New-Item -Path C:\ProgramData\PCDoctor\workbench.db-wal -ItemType File -Force -ErrorAction Stop | Out-Null }; if (Test-Path C:\ProgramData\PCDoctor\workbench.db-shm) { if (-not (Test-Path C:\ProgramData\PCDoctor\workbench.db-shm -PathType Leaf)) { throw $"workbench.db-shm is not a file$" } } else { New-Item -Path C:\ProgramData\PCDoctor\workbench.db-shm -ItemType File -Force -ErrorAction Stop | Out-Null }"' $0
  IntCmp $0 0 +3
    MessageBox MB_ICONSTOP "PCDoctor could not prepare its SQLite journal files (exit $0). Installation is stopping fail-closed."
    Abort

  ; Root is last. Apply-TieredAcl gives the three pre-created SQLite files
  ; direct Users:M while the root is still protected, then restores only the
  ; non-inheriting sibling-creation grant (Users:WD,AD,DC) on the root object.
  !insertmacro PCDoctorApplyAcl "C:\ProgramData\PCDoctor" A root

  ; Post-install ACL verification.
  ; Reads the INSTALLED DACL state on C:\ProgramData\PCDoctor and confirms
  ; it matches the expected tier configuration. Writes a timestamped log
  ; to C:\ProgramData\PCDoctor\logs\install-verify-*.log.
  ;
  ; Why this exists as a separate script from the pre-ship harness:
  ; the harness runs in a SANDBOX. v2.4.11 passed the harness but the
  ; real install silently dropped the SQLite grant. This script catches
  ; drift on the REAL install state and fails the install if it differs.
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\powershell\Verify-InstalledAcl.ps1" -Quiet' $0
  IntCmp $0 0 +3
    MessageBox MB_ICONSTOP "PCDoctor's installed ACL verification failed (exit $0). Installation is stopping fail-closed."
    Abort

  ; =============================================================
  ; Phase 0 protected worker boundary
  ; =============================================================
  ; Install-WorkerBoundary.ps1 creates and protects these directories before
  ; copying code into them. Owners/ACEs are SID-based and inheritance is
  ; disabled: Administrators (*S-1-5-32-544) and SYSTEM (*S-1-5-18) get Full
  ; Control; Users (*S-1-5-32-545) get (RX) only. The queue root at
  ; C:\ProgramData\PCDoctorWorkerQueue grants no ordinary-user write rights.
  ; Exact privileged payload: Elevated-Worker.ps1, Set-ServiceStartup.ps1,
  ; Stop-Service.ps1, Start-Service.ps1, Restart-Service.ps1, Kill-Process.ps1,
  ; Set-ProcessPriority.ps1, Set-ProcessAffinity.ps1, Suspend-Process.ps1,
  ; Resume-Process.ps1. Cleanup-StaleWorkerSessions.ps1 removes only old,
  ; exact 32-hex session leaves while running elevated.
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\powershell\Install-WorkerBoundary.ps1" -Mode Install -SourceRoot "$INSTDIR\resources\powershell"' $0
  IntCmp $0 0 +3
    MessageBox MB_ICONSTOP "PCDoctor could not provision its protected worker boundary (exit $0). Installation is stopping fail-closed."
    Abort

  ; One generated manifest owns registration, migration, and removal. No task
  ; identity or command is constructed here in NSIS.
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\powershell\Register-All-Tasks.ps1" -ForceRecreate -InstallDir "$INSTDIR"' $0
  IntCmp $0 0 +3
    MessageBox MB_ICONSTOP "PCDoctor could not apply its Scheduled Task manifest (exit $0). Installation is stopping fail-closed."
    Abort
!macroend

!macro customUnInstall
  StrCmp $INSTDIR "C:\Program Files\PCDoctor Workbench" pcdoctor_uninstall_dir_trusted
    MessageBox MB_ICONSTOP "PCDoctor's uninstall control plane is not in its trusted Program Files location. Uninstall is stopping fail-closed."
    Abort
  pcdoctor_uninstall_dir_trusted:

  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\powershell\Unregister-All-Tasks.ps1" -IncludeLegacy' $0
  IntCmp $0 0 pcdoctor_uninstall_tasks_ok
    MessageBox MB_ICONSTOP "PCDoctor could not remove its Scheduled Tasks (exit $0). Uninstall is stopping fail-closed."
    Abort
  pcdoctor_uninstall_tasks_ok:

  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\powershell\Install-WorkerBoundary.ps1" -Mode Uninstall' $0
  IntCmp $0 0 pcdoctor_uninstall_boundary_ok
    MessageBox MB_ICONSTOP "PCDoctor could not remove its protected worker boundary (exit $0). Uninstall is stopping fail-closed."
    Abort
  pcdoctor_uninstall_boundary_ok:
  ; Install-WorkerBoundary performs exact-path, non-reparse recursive removal
  ; for C:\Program Files\PCDoctor Workbench\privileged and
  ; C:\ProgramData\PCDoctorWorkerQueue. Do not add an NSIS RMDir fallback:
  ; the helper must fail closed instead of following a replaced junction.
!macroend
