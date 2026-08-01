# PCDoctor Workbench Structural Audit

**Date:** 2026-08-01

**Audit mode:** Read-only source, installed-runtime, database, test-gate, dependency, and release-pipeline analysis. No installed-app, task, service, repair, or reboot change was made.

## Executive assessment

PCDoctor Workbench has a strong functional base: sandboxed Electron renderer, an explicit PowerShell action catalog, parameter allowlisting, audit logs, rollback infrastructure, notification deduplication, a broad automated test suite, and an installed tray application that has remained running. The weaknesses are not a lack of features. They are trust boundaries and accumulated coupling.

The first priority is to make telemetry and automation truthful and enforceable. The current history mechanism relabels old scan results as new observations, while automatic execution can bypass the action catalog's destructive/risky classification. Adding more automatic fixes before correcting those foundations would make the tool more powerful but less safe.

## Current snapshot

- Repository: `C:\dev\pcdoctor-workbench`
- Source and installed version: 2.5.47
- Installed executable: `%LOCALAPPDATA%\Programs\PCDoctor Workbench\PCDoctor Workbench.exe`
- Latest GitHub release: v2.5.47, published 2026-05-11
- TypeScript typecheck: pass
- ESLint gate: cannot run because ESLint 9 has no `eslint.config.*`
- Vitest gate: cannot complete because `better-sqlite3` is currently built for Electron ABI 130 while the system Node runtime requires ABI 137
- Production dependency audit: 6 advisories, including 4 high severity
- Full dependency audit: 32 advisories, including 2 critical and 22 high; most are build/development dependencies
- Electron: 33.4.11, end-of-support since 2025-04-29
- Installer signing: disabled; v2.5.47 reports `NotSigned`
- CI/CD: no `.github/workflows` directory
- Local release artifacts: 322 files, 127 installers, approximately 11.38 GiB
- Runtime: four Electron processes, approximately 364 MiB working set and 714 MiB private bytes at the audit snapshot
- Database: approximately 165 MiB main DB plus WAL
- Metrics: 1,976,953 rows, including approximately 18,714 rows in the last 24 hours
- PCDoctor logs: 413 files / approximately 76 MiB since 2026-04-22

## Architecture map

```text
Windows Task Scheduler ──> Run-AutopilotScheduled.ps1 ──> action scripts
          │                          │
          │                          └──> JSONL activity log
          │                                      │
          └──> daily/weekly scanners              v
                                         Autopilot log ingestor

Electron main process
  ├── main.ts: lifecycle, timers, updater, Telegram, task migration
  ├── ipc.ts: 86 request handlers and most renderer capability boundaries
  ├── pcdoctorBridge.ts: latest.json cache/mapping and metric writes
  ├── dataStore.ts: schema, SQLite access, history, settings, incidents/actions
  ├── autopilotEngine.ts: threshold rules and automatic dispatch
  ├── actionRunner.ts: parameter validation, rollback preparation, PS execution
  └── preload.ts ──> sandboxed React renderer

PowerShell
  ├── Invoke-PCDoctor.ps1: broad point-in-time scanner
  ├── action scripts: diagnostics, cleanup, repair, mutation
  └── task registration/dispatch
```

## Prioritized findings

### Critical — automatic execution does not enforce the action safety classification

`ActionDefinition` records `confirm_level`, rollback tier, admin need, timeout, and reboot requirement. Renderer and Telegram paths sometimes consult those fields, but `actionRunner.runAction()` does not reject a destructive/risky action merely because `triggered_by` is `scheduled`, and the Windows task dispatcher invokes PowerShell scripts directly.

Current examples:

- monthly Tier-1 `Shrink Component Store` runs irreversible DISM `/StartComponentCleanup /ResetBase`;
- weekly Tier-1 `Empty All Recycle Bins` permanently deletes local recycle-bin contents;
- low-disk threshold can run destructive feature-update-leftover deletion;
- high-RAM threshold can rewrite `.wslconfig` and execute `wsl --shutdown`;
- rollback preparation failure currently logs a warning and proceeds with the action.

The scheduler tier therefore describes notification behavior, not a hard safety boundary. A mistaken rule-to-action mapping can silently execute an action whose own catalog entry says destructive.

The split is deeper than execution: the Autopilot UI changes only the SQLite rule's `enabled` or `suppressed_until` fields, while scheduled rules are independent Windows tasks that never consult those fields. Disabling or snoozing a schedule rule in the Autopilot page therefore does not disable or snooze the task that performs it.

**Required correction:** add centrally enforced automation metadata to every action (`never`, `safe`, or `conditional`) and fail closed inside both the TypeScript runner and Scheduled Task dispatcher. Destructive, reboot-requiring, user-data-deleting, session-terminating, or failed-rollback actions must never run automatically unless an explicit machine-specific policy is present and its preconditions pass. A rule tier alone is insufficient.

### Critical — the metric history is not a history of real observations

The one-minute background refresh reads the same `latest.json` report and `getStatusInner()` calls `recordStatusSnapshot()` each time. Temperature data is also added through the same status-refresh path. The resulting timestamps are new, but most values came from an older scan.

Measured state:

- 1,976,953 metric rows;
- 1,005,844 disk rows;
- 169,079 rows each for CPU load, RAM use, system-event count, and application-event count;
- application-event count has only one distinct value across all 169,079 rows;
- approximately 18,714 rows were added in the last day.

These rows feed charts, forecasts, and the Autopilot sustained-threshold helper. They can create false confidence and false automatic decisions.

**Required correction:** renderer/status reads become side-effect-free; a dedicated collector records only capture-time observations. Existing replayed history should be marked legacy or cleaned in a backed-up, one-time migration. Retention and indexes must be explicit.

### High — updater integrity is not established

The updater points at public GitHub Releases and correctly disables automatic download, downgrade, and silent immediate installation. However:

- signing is commented out in `electron-builder.yml`;
- no PFX exists at the configured local path;
- the v2.5.47 installer is not Authenticode-signed;
- `docs/SIGNING.md` states signing is in use even though the build config says it is only a scaffold;
- an account compromise could replace the installer and matching `latest.yml` hashes.

**Required correction:** establish a signing identity and protected release pipeline before the next published updater release. The first signed transition must be planned carefully because existing unsigned installs cannot retroactively enforce a publisher identity.

### High — Electron and runtime dependencies need a controlled upgrade

Electron 33.4.11 is end-of-support. The official Electron policy supports only the latest three stable majors. Current npm data reports Electron 43.2.0 as latest. Runtime audit findings include:

- `adm-zip` high-severity allocation denial of service;
- `electron-updater`/`builder-util-runtime` credential leakage on cross-origin redirects (the current public GitHub feed does not use a private token in-app, reducing but not removing upgrade urgency);
- `js-yaml` complexity denial of service;
- React Router open-redirect/XSS advisories.

Most of the 32 full-tree advisories are developer/build-chain exposures, but those still matter on the machine that produces trusted installers.

**Required correction:** upgrade in tested cohorts, not with an unreviewed `npm audit fix --force`. Start with non-breaking patches, then Electron/build tooling, then Router/build-stack majors with focused compatibility tests.

### High — quality gates are present on paper but not reproducible

- `npm run typecheck` passes.
- `npm run lint` is broken because ESLint 9 requires a flat config and none exists.
- Database tests fail after packaging because packaging rebuilds `better-sqlite3` for Electron in the shared `node_modules`; system Node then expects a different native ABI.
- Some tests catch a native-load failure and pass/skip instead of failing, which can conceal a missing database test environment.
- Migration tests copy a local implementation rather than importing the production migration function. The copied test sorts migrations; production currently iterates the array as written.
- Vitest has no coverage thresholds.
- No CI workflow runs the gates or creates release artifacts.

**Required correction:** make the test/build environments deterministic, test the production migration implementation, make skipped native tests visible/failing in CI, restore lint, add coverage thresholds for safety-critical modules, and run all release gates in CI.

### High — scheduled maintenance is collision-prone and can be heavier than the problem

The current source schedules multiple jobs at identical times:

- 03:00 can combine rollback pruning, recycle cleanup, browser cleanup, Malwarebytes, and NAS recycle-size refresh depending on the day;
- 04:00 can combine AdwCleaner, Safety Scanner, component-store cleanup, tool-update checks, and hosts updates depending on the calendar;
- 06:00 runs the daily security posture collector and Defender definition update together.

The machine audit independently found morning updater/task collisions during the worst paging interval.

**Required correction:** assign workload weights, use a single-run lock, stagger heavy work, skip or defer under measured memory/commit pressure, and cap daily maintenance runtime. Diagnostics must not compete with each other on a 32-GB always-on system.

### High — fresh-install task registration is incomplete and duplicated

The installer calls `Register-All-Tasks.ps1`, but that file does not create `PCDoctor-Daily-Quick`, `PCDoctor-Weekly`, or `PCDoctor-Monthly-Deep`. The Dashboard's `Scan Now` path expects `PCDoctor-Daily-Quick`. Those tasks are defined in the older `Register-PCDoctorTask.ps1`, which depends on a missing `Run-PCDoctorWeekly.ps1` and is not invoked by the installer. An upgraded machine can retain the old tasks and hide this fresh-install defect.

Task identity is duplicated among registration PowerShell, the IPC `MANAGED_TASKS` allowlist, Autopilot defaults, migration verification, report export, uninstall code, and tests. Existing drift includes a registered weekly tool-update task missing from the UI allowlist and three UI-managed diagnostic tasks missing from current installation.

**Required correction:** define one declarative task manifest and generate registration, UI/IPC allowlists, verification, uninstall cleanup, rule metadata, and tests from it.

### High — scheduled console flashes have a confirmed source

Interactive user-context tasks launch `powershell.exe` without `-WindowStyle Hidden`, and their task XML uses an interactive token. They can display short console windows. The uninstaller removes only the five base tasks plus Workbench autostart, leaving Autopilot and tool-update tasks behind after uninstall.

**Required correction:** use a hidden, non-shell-concatenated launch path for all noninteractive jobs, preserve only intentionally interactive tasks, and generate complete uninstall cleanup from the task manifest.

### High — elevated-worker trust is based only on a user-writable queue

For roughly ten minutes after UAC approval, the elevated worker polls a queue beneath `%LOCALAPPDATA%`. Any process running as the same user can submit an allowlisted privileged command. The allowlist limits scope, but there is no per-session authentication, command provenance, strict creation/expiry proof, or confirmation at the elevated boundary.

**Required correction:** add an unguessable per-session capability, authenticated command envelopes, short expirations, replay protection, restrictive ACL verification, and a second policy check inside the elevated worker. High-impact actions still require explicit approval.

### High — installer Defender-exclusion cleanup is not guaranteed

The installer temporarily adds a broad Defender exclusion for `C:\ProgramData\PCDoctor`, suppresses errors, then suppresses errors again while attempting removal. An interrupted install or removal failure can leave the exclusion active.

**Required correction:** avoid the exclusion where possible. Otherwise verify its exact pre-state, scope it narrowly and briefly, remove it in guaranteed cleanup, verify removal, and surface failure.

### Medium — core modules have become change-risk hotspots

Largest files include:

- `src/main/ipc.ts`: 1,883 lines and 86 handlers;
- `powershell/Invoke-PCDoctor.ps1`: 1,115 lines;
- `src/renderer/pages/Dashboard.tsx`: 1,013 lines;
- `src/main/main.ts`: approximately 1,000 lines;
- `src/main/dataStore.ts`: 962 lines;
- `src/main/pcdoctorBridge.ts`: 804 lines;
- `src/shared/actions.ts`: 792 lines.

These modules mix unrelated responsibilities. A broad rewrite would be risky; new work should extract bounded modules along existing seams: Sentinel, maintenance policies, incident store, report writer, per-domain IPC registrars, and lifecycle engines.

### Medium — schema evolution and retention are underdeveloped

The schema is mostly a single large `CREATE TABLE IF NOT EXISTS` string. The migrations array is empty. Existing tests validate an inlined migration concept rather than the production function. There is no metric deletion, `PRAGMA optimize`, database size policy, or checkpoint/compaction policy.

Daily perf logs also have no retention. Current log volume is modest, but both DB and logs grow indefinitely on a PC intended to run for years.

**Required correction:** use real versioned migrations, retention tables/policies, bounded raw payloads, scheduled pruning, and opportunistic database optimization that never runs during other heavy maintenance.

### Medium — the full scanner has known sampling and classification blind spots

- `Invoke-PCDoctor.ps1` is a point-in-time scanner, not a sustained monitor.
- It assigns `free_pct = 0` to a volume whose reported size is zero, then can classify a fixed zero-size/non-ready mount as critically full.
- System and Application errors are capped at 500 each, so the stored number is a capped sample rather than a seven-day total.
- Current RAM/CPU values are snapshots; replaying them does not turn them into a time series.
- Broad event scans become costly and can miss the most useful incremental context in a noisy log.

**Required correction:** keep the scanner for periodic breadth, while Sentinel handles small repeated samples and cursor-based event collection.

### Medium — collector failures can be presented as healthy

The bridge's overall-state mapper defaults unknown strings to `good`, and many PowerShell scanner sections catch errors without emitting a durable per-collector quality state. Missing data can therefore look green. The services KPI also uses a loose `/run/i` match, so text such as `NOT RUNNING` can count as running even though the detailed service mapper uses a correct anchored status check.

**Required correction:** every collector emits success/partial/failure, capture time, and reason; unknown or stale data renders as `unknown/degraded`, never healthy.

### Medium — opening the Dashboard performs heavy parallel collection

The Dashboard security hook starts four PowerShell security scans in parallel, with individual timeouts as high as 120 seconds. This perturbs the system being measured, increases cold-start pressure, and duplicates scheduled security collection.

**Required correction:** display persisted scheduled results first and refresh only when stale or explicitly requested, with one-flight orchestration and a resource budget.

### Medium — process attribution is insufficient for slowdown diagnosis

The current all-process collector exposes mainly PID, name, and working set; CPU can be null and broad ownership is inferred by name. It lacks interval CPU, private/commit bytes, I/O deltas, handles, faults, start time, parent tree, executable identity/publisher, session/owner, GPU, and workload grouping.

**Required correction:** Sentinel captures a privacy-bounded subset with interval deltas and stable process identity, then aggregates known workload groups without storing command lines or user content.

### Medium — timers and long-running work lack one lifecycle model

Some engines have in-flight guards, while renderer polling, process polling, auth-event polling, Telegram polling, updater timers, and digest timers use different ownership/cancellation patterns. Anonymous intervals are difficult to stop and a slow run can overlap the next tick.

**Required correction:** use owned scheduler objects, recursive timeouts after completion, cancellation, deadlines, jitter, one-flight guards, and explicit app-shutdown cleanup.

### Medium — downloaded tools are not publisher-verified

The tool downloader checks transport and file size but does not pin redirect hosts or verify the downloaded executable's expected Authenticode publisher. Today the direct download is Microsoft Safety Scanner, but transport alone is not a sufficient execution trust boundary.

**Required correction:** download to a temporary file, enforce host/size bounds, verify the expected signer and signature status, then atomically promote the file.

### Medium — some scheduled features are placeholders or misleading

The scheduled forecast PowerShell returns only a ping and has no consumer. Weekly review describes historical analysis but primarily reads the latest point-in-time report, leaves forecast output empty, and embeds a machine-specific Obsidian path.

**Required correction:** remove dead schedules or connect them to durable data and portable configuration; UI labels must describe what is actually computed.

### Medium — release and documentation state can drift

The repository has no automated release workflow, local artifacts total over 11 GiB, signing documentation contradicts the actual build, and recent GitHub Releases were manually assembled. Manual release remains possible and currently works, but it is easy to publish the wrong artifact, omit a gate, or retain stale build output.

**Required correction:** generate artifacts in a clean CI workspace; verify hashes, signature, updater metadata, bundle sync, native ABI, and installed smoke tests; retain only selected local releases.

## Strengths to preserve

- Electron renderer uses `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- CSP blocks arbitrary scripts and objects.
- IPC/action parameter names and types are explicitly validated.
- PowerShell runs use array arguments rather than unquoted shell concatenation in core paths.
- Existing task, worker, action, IPC allowlist, renderer, notification-dedup, and rollback tests provide a substantial regression base.
- Updater requires a user-initiated download and install choice.
- Repair actions are cataloged with user-facing risk and rollback metadata.
- Autopilot produces durable activity records and has alert deduplication.
- Existing EaseUS idle/restart scripts already have unusually strong preflight and evidence validation and can be adapted behind a policy gate.

## Recommended automation design

Health Sentinel remains observational. A separate Maintenance Orchestrator consumes durable incidents and is the only component allowed to request automatic work.

```text
real sample -> sustained rule -> durable incident -> policy lookup
    -> maintenance-window/load/idle/preflight gates
    -> dry run -> one allowlisted action -> postcondition check
    -> success/rollback/failure record -> cooldown or circuit breaker
```

Every automatic policy requires:

- stable incident and action IDs;
- explicit action automation classification;
- minimum evidence/sample window;
- maintenance window and workload/load gates;
- dry-run/preflight support;
- one-run lock and maximum duration;
- cooldown and maximum attempts per day/week;
- postcondition verification;
- fail-closed rollback rules;
- notification on mutation, failure, escalation, or circuit-breaker trip;
- immutable `reboot_policy = never` for this machine unless Greg directly changes it for a specific operation.

## Machine-specific maintenance matrix

### Safe automatic after the safety foundation exists

- keep Defender definitions current;
- run read-only SMART and security posture checks on staggered schedules;
- prune bounded PCDoctor metric/log/report history;
- generate daily/weekly coverage and incident reports;
- repair the false-history pipeline and compact the legacy database once after a verified backup;
- defer heavy maintenance when commit pressure, paging, or another heavy task is active.

### Conditional automatic after repeated proof and strict preflight

- restart the EaseUS Agent only when a handle-leak incident is sustained, the validated idle gate passes, no backup operation is active, a cooldown is clear, and post-restart handle identity/counts verify recovery;
- optionally restart Wave Link during a configured quiet window only after a sustained same-process handle slope, no active audio session/recording, and an explicit opt-in policy; upgrading to Wave Link 3.1 remains the proper fix;
- reapply the narrowly scoped SPP ACL repair only if the exact known Event 16385 pattern and exact permission drift recur, then verify licensing and event cessation;
- gracefully stop explicitly allowlisted development workloads during a configured overnight window; never infer that a Next.js, WSL, Docker, VM, Homebridge, Plex, or media workload is unused;
- enforce the enlarged System event-log setting only if it drifts and the current channel identity matches expectations.

### Notify-only / manual workflow

- Wave Link 2.0.5 to 3.1 migration and before/after audio-route verification;
- EaseUS product upgrade and account/session rotation;
- Google Drive/Dokan mapping migration;
- AWCC/OCControl/SupportAssist/Nahimic update or repair;
- HVCI, Credential Guard, Defender Offline, firmware, BIOS, and any reboot-dependent operation;
- deletion of user data, recycle-bin contents, Windows rollback payloads, or restore points;
- process termination without an explicit per-process policy;
- any action whose preflight or rollback preparation fails.

## Delivery and updater path

The existing delivery path is usable after hardening:

1. implement and test in source;
2. typecheck, lint, unit/integration tests, PowerShell 5.1 syntax/contract tests, bundle-sync checks, native ABI verification, package, and installed smoke test;
3. bump version and write release notes;
4. produce installer, blockmap, and `latest.yml` in a clean environment;
5. verify signature and hashes;
6. publish a GitHub Release through an authorized, protected workflow;
7. PCDoctor checks GitHub every six hours and offers download/install, or the approved installer can be installed locally;
8. verify installed version, migration, Sentinel coverage, incidents, scheduled policy state, and rollback.

Publishing the release and installing it remain separate explicit gates because they change external and installed state.

## Recommended implementation order

1. Restore deterministic lint/test/build/CI and define signed-release transition.
2. Enforce automation policy in the central runner and Scheduled Task dispatcher; demote or explicitly grandfather existing destructive schedules.
3. Implement Health Sentinel and remove status-read metric writes.
4. Migrate/prune legacy telemetry after backup and verification.
5. Implement the Maintenance Orchestrator and the EaseUS guarded-reset policy first.
6. Add load-aware schedule staggering and PCDoctor self-retention.
7. Add optional Wave Link and development-workload policies only after their individual preflight tests are proven.
8. Split large modules incrementally when touched; avoid a big-bang rewrite.
