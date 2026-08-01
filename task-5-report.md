# Task 5 Report: Manifest-Driven Tasks and Installer Trust Boundaries

Date: 2026-08-01 17:54 CDT
Branch: `feature/phase0-safety`
Base: `2a49786 security: harden elevated worker queue boundary`

## Outcome

Task 5 is source-complete. One canonical manifest now drives registration, removal, migration verification, IPC allowlisting, UI inventory, and report export. Phase 0 active tasks are hidden, interactive-user diagnostics or PCDoctor-owned data refreshes. Direct scheduled mutation is refused with `E_DIRECT_SCHEDULED_MUTATION_DISABLED`.

The installer is now per-machine and fixed to `C:\Program Files\PCDoctor Workbench`. Elevated code resolves only from that protected bundle. It provisions the worker at `C:\Program Files\PCDoctor Workbench\privileged` and the queue root at `C:\ProgramData\PCDoctorWorkerQueue`. No installer, elevation, live Scheduled Task, production worker/action, service/process/registry mutation, publish, or reboot occurred in this source-only task.

## Canonical manifest

Canonical source: `src/shared/task-manifest.json`
Generated copy: `powershell/task-manifest.json`
Source SHA-256: `e60bfdab3b1acb992751b420760d05c6b7262dd607ebb8230f7c49cdbbd443a4`

| State | ID | Task | Trigger |
|---|---|---|---|
| active | daily-quick-report | PCDoctor-Daily-Quick | daily 08:07 |
| active | nas-size-refresh | PCDoctor-NAS-Size-Refresh | daily 03:23 |
| active | security-posture-daily | PCDoctor-Security-Daily | daily 06:17 |
| active | security-posture-weekly | PCDoctor-Security-Weekly | weekly SAT 23:29 |
| active | smart-readonly-daily | PCDoctor-SMART-Daily | daily 01:13 |
| active | tool-updates-weekly | PCDoctor-Weekly-Tool-Updates | weekly SUN 04:37 |
| active | workbench-autostart | PCDoctor-Workbench-Autostart | logon |
| deferred | defender-definitions-daily | PCDoctor-Defender-Definitions | daily 06:41 |
| deferred | defender-quick-scan-daily | PCDoctor-Defender-Quick-Scan | daily 02:31 |
| deferred | maintenance-broker | PCDoctor-Maintenance-Broker | demand |
| deferred | monthly-deep-scan | PCDoctor-Monthly-Deep | first SUN 03:43 |
| deferred | retention-daily | PCDoctor-Prune-Rollbacks | daily 03:53 |
| deferred | weekly-maintenance | PCDoctor-Weekly | weekly SUN 02:47 |
| deferred | weekly-review | PCDoctor-Weekly-Review | weekly SUN 22:19 |
| remove | forecast-without-consumer | PCDoctor-Forecast | exact-name removal |
| remove | legacy-autopilot-adwcleaner | PCDoctor-Autopilot-AdwCleanerScan | exact-name removal |
| remove | legacy-autopilot-browser-cache | PCDoctor-Autopilot-ClearBrowserCaches | exact-name removal |
| remove | legacy-autopilot-defender-definitions | PCDoctor-Autopilot-UpdateDefenderDefs | exact-name removal |
| remove | legacy-autopilot-defender-quick-scan | PCDoctor-Autopilot-DefenderQuickScan | exact-name removal |
| remove | legacy-autopilot-hosts-rewrite | PCDoctor-Autopilot-UpdateHostsStevenBlack | exact-name removal |
| remove | legacy-autopilot-hwinfo | PCDoctor-Autopilot-HwinfoLog | exact-name removal |
| remove | legacy-autopilot-malwarebytes | PCDoctor-Autopilot-MalwarebytesCli | exact-name removal |
| remove | legacy-autopilot-nas-size-refresh | PCDoctor-Autopilot-RefreshNasRecycleSizes | exact-name removal |
| remove | legacy-autopilot-recycle-bins | PCDoctor-Autopilot-EmptyRecycleBins | exact-name removal |
| remove | legacy-autopilot-safety-scanner | PCDoctor-Autopilot-SafetyScanner | exact-name removal |
| remove | legacy-autopilot-smart | PCDoctor-Autopilot-SmartCheck | exact-name removal |
| remove | legacy-autopilot-winsxs-resetbase | PCDoctor-Autopilot-ShrinkComponentStore | exact-name removal |

Counts: 27 total, 7 active, 7 deferred, 13 remove.

## Installer boundary contract

- NSIS `/D` overrides and obsolete per-user install roots are rejected before mutation; install and uninstall control-plane scripts execute only from the fixed Program Files bundle.
- `Initialize-ProgramDataRoot.ps1` creates the ProgramData root with a protected ACL, opens nodes with `OPEN_REPARSE_POINT` and no delete sharing, and secures each pinned object top-down before copy or recursion.
- The former recursive `takeown /r` plus `icacls /reset /T` trust window is removed; script/data subtrees are configured before the root SQLite creation grant is restored.
- Privileged payload root is exact, administrator-owned, inheritance-protected, and rejects reparse-point ancestors.
- Payload is exactly one worker plus nine allowlisted action scripts.
- Administrators and SYSTEM receive FullControl; ordinary Users receive ReadAndExecute only.
- Queue root is exact, protected, non-reparse, and gives ordinary Users no create, append, delete, ownership, or DACL-write authority. Existing boundary validation and ACL application use the same pinned handle, retained through cleanup.
- Hash comparison uses self-contained .NET SHA-256, and stale cleanup launches through the fixed System32 Windows PowerShell path.
- Stale cleanup considers only top-level 32-lowercase-hex session leaves older than 1,440 minutes.
- Installer and uninstaller use fixed System32 Windows PowerShell and fail closed when initialization, copy, ACL, SQLite preparation, verification, boundary, or manifest operations return nonzero. Defender policy is never changed.
- The ACL pass inventories while protected, applies files first and directories deepest-first, assigns direct Users:M to all three SQLite files, and applies the root last. Verification treats a missing/non-writable DB, WAL, or SHM as fatal.
- Elevated winget uses exact Appx/Security module manifests, a Microsoft-signed executable under protected WindowsApps, and passes that same validated path into its nested cache refresh.
- Scheduled Task XML is registered in-memory through Task Scheduler COM; no XML is reopened from `%TEMP%`.
- Active commands use exact per-script argument tuples, legacy aliases cannot collide with canonical names, and task migration identity includes the generated manifest SHA-256.
- `scripts/test-installed-worker-boundary.ps1` remains disabled unless separately invoked with `-AuthorizedInstalledSmoke yes`.

## RED and GREEN evidence

- Initial manifest/consumer/installer RED: 7 failed, 1 passed, and 2 collection failures across four focused files.
- Initial Task 5 GREEN cohort: 36 of 36 passed.
- Worker coordinate regression cohort: 185 of 185 passed after updating the exact Program Files payload fixtures.
- Scheduler native-helper RED: 2 of 13 failed; fixed exit-code scoping and malformed test command; GREEN 13 of 13.
- Wizard copy RED: 4 of 9 failed on retired `Register All Tasks` text; GREEN 9 of 9 using `Apply Task Manifest`.
- Source-only registration gate RED: old script rejected `-StaticOnly`; GREEN 1 of 1 with zero Task Scheduler calls.
- Installer hardening RED: 2 of 6 failed; GREEN 6 of 6 after self-contained hashing, fixed cleanup executable, and ancestor checks.
- Deterministic generator RED: 1 of 3 failed because unchanged content was rewritten; GREEN 3 of 3 with unchanged mtime preserved.
- Independent test-writer RED: 2 of 5 generator tests failed because malformed and unsafe canonical input was emitted; GREEN 5 of 5 after standalone strict validation was added.
- Security re-review RED: ProgramData control-plane execution, predictable `%TEMP%` task XML, non-exact active arguments, fixed migration versioning, trigger cardinality, payload smoke depth, and legacy alias collisions were confirmed and fixed.
- Final trust-boundary RED: installer helper execution remained ProgramData-backed and the old LocalAppData autostart default remained reachable; GREEN after fixed Program Files resolution, exact install-root checks, and ProgramData pre-copy initialization.

## Final safe verification

| Gate | Result |
|---|---|
| `node scripts/generate-task-manifest.mjs --check` | PASS |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run test:ps51` | PASS, 132 PowerShell files parse on Windows PowerShell 5.1 |
| `npm run test:bundle-sync` | PASS, both tracked sidecars resolve |
| `npm run test:node` | PASS, 97 files and 1,305 tests |
| `npm run build` | PASS; existing nonblocking chunk-size advisory only |
| `git diff --check` | PASS; Git reported only line-ending conversion notices |

The Node suite still emits existing React `act(...)` warnings in unrelated wizard tests; no test failed.

Independent validation:

- Test-writer: PASS, final affected validation 20 of 20 plus PowerShell parsing; regression coverage includes all three SQLite files, pinned boundary handles, exact module/tool paths, and fail-closed installer behavior.
- Output-validator: PASS, final affected cohort 298 of 298; manifest/hash, 132-script PS5.1 parsing, bundle sync, lint, typecheck, build, and diff checks all passed. The parent then reran the exact final tree: 1,305 of 1,305 full regression tests passed.
- Code-reviewer: final bounded security review found no remaining actionable P0/P1/P2 findings.
- Extraction-validator: not applicable; no P&ID, alarm-export, DXF/DWG, or related industrial extraction logic changed.

## Safety state and omitted live gates

- Read-only database check returned no `maintenance_global_enabled` row. Runtime policy enables maintenance only for exact value `1`, so global maintenance is effectively disabled.
- `npm run test:tasks` and composite `npm run verify:source` were intentionally not run under the source-only brief.
- No live task registration/query/delete, installer execution, UAC, production worker/action, ACL mutation, or installed smoke was run.
- Phase 0 remains fail-closed until separately authorized installation and installed-smoke evidence proves real root/file ACLs, pre-UAC trust proof, manual worker path, and stale-session cleanup.
- No reboot was requested or performed.
