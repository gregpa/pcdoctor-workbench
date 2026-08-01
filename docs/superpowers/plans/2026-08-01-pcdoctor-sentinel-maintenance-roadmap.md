# PCDoctor Sentinel and Maintenance Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver trustworthy continuous monitoring and centrally gated maintenance without automatic reboot, destructive cleanup, or direct Scheduled Task mutation.

**Architecture:** Health Sentinel remains read-only and creates durable incidents from real capture-time observations. A separate Maintenance Orchestrator consumes fixed-ID intents and can dispatch only compiled, default-deny actions after evidence, window, idle/load, lock, cooldown, dry-run, postcondition, rollback, and circuit-breaker gates pass. The work is split into five independently reviewable phases so no machine-specific automation is enabled before its safety foundation exists.

**Tech Stack:** Electron 33/Node, TypeScript 5.6, React 18, SQLite via `better-sqlite3`, PowerShell 5.1, Vitest 2, Windows Task Scheduler, NSIS/Electron Builder.

## Global Constraints

- Reboot policy is immutable `never`; do not invoke, schedule, request, or imply a reboot.
- Preserve the motherboard-enforced 32 GB RAM limit and the completed CPU thermal-paste repair as non-issues.
- Do not repeat completed Defender recovery/full scan, malware remediation, SPP repair, RAMMap capture, EaseUS reset, network/media recovery, or prior scheduled-task changes.
- Sentinel is read-only; only the Maintenance Orchestrator may request automatic mutation.
- Every non-manual execution defaults to deny and must use a compiled action ID and compiled policy ID.
- No arbitrary scripts, commands, paths, SQL, action arguments, rule expressions, or PowerShell arguments cross renderer or task boundaries.
- Destructive, rebooting, user-data-deleting, session-terminating, threat-deleting, recycle-bin, DISM `/ResetBase`, firmware, BIOS, driver, HVCI, Credential Guard, and Defender Offline actions remain manual/notify-only.
- Conditional policies ship disabled and may be enabled only after their individual evidence, identity, idle/load, postcondition, rollback, and synthetic tests pass.
- Preserve the untracked `.claude/` directory; never stage it.
- Publishing, updater release creation, and installation are separate authorization gates after all phases pass.

---

## Plan set and execution order

| Order | Plan | Independent deliverable | Exit gate |
|---|---|---|---|
| 0 | `2026-08-01-pcdoctor-phase-0-safety-foundation.md` | Reproducible gates, central default-deny policy, authenticated elevation, one task manifest, unsafe schedule removal | Automatic mutations globally disabled; direct scheduled mutation impossible |
| 1 | `2026-08-01-pcdoctor-phase-1-health-sentinel.md` | Real five-minute observations, pure incidents, reports, retention, backed-up legacy metric repair | Status reads add zero metrics; synthetic incident/report test passes |
| 2 | `2026-08-01-pcdoctor-phase-2-maintenance-orchestrator.md` | Durable intents/runs/locks/circuits plus safe PCDoctor-owned maintenance | Safe policies pass end-to-end; reboot and destructive actions denied |
| 3 | `2026-08-01-pcdoctor-phase-3-machine-policies.md` | Disabled-by-default EaseUS, Wave Link, SPP, System-log, and workload policies | Each policy has independent fixtures and exact postcondition/rollback evidence |
| 4 | `2026-08-01-pcdoctor-phase-4-release-hardening.md` | Supported dependencies, signer verification, clean package and installed smoke validation | Artifacts validated; stop before publish/install |

## Cross-plan interface map

```text
Phase 0
  src/shared/automation.ts
    ActionAutomationDefinition, TrustedExecutionContext, PolicyDecision
  src/shared/taskManifest.ts
    TASK_MANIFEST, TaskDefinition, MaintenanceIntentId
  src/main/automationPolicy.ts
    evaluateAutomationPolicy(input): PolicyDecision

Phase 1
  src/shared/sentinelTypes.ts
    SentinelSampleV1, SentinelIncident, SentinelSummary
  src/main/healthSentinelRules.ts
    evaluateSentinelRules(input): IncidentTransition[]
  src/main/healthSentinel.ts
    startHealthSentinel(), stopHealthSentinel(), requestSentinelSample()

Phase 2
  src/shared/maintenanceTypes.ts
    MaintenanceIntent, MaintenanceRun, MaintenanceSummary
  src/main/maintenanceOrchestrator.ts
    startMaintenanceOrchestrator(), submitMaintenanceIntent(), stopMaintenanceOrchestrator()

Phase 3
  powershell/policies/*
    fixed preflight, execute, postcondition, and rollback contracts

Phase 4
  npm run verify:release-candidate
    one command proving source, native ABI, package, task, signer, and installed gates
```

## Specification coverage review

| Approved specification requirement | Implemented by |
|---|---|
| Real capture-time five-minute observations, one-flight timeout/recovery | Phase 1 Tasks 1, 5 |
| Three samples/ten minutes/7.5-minute maximum gap | Phase 1 Task 4 |
| Stable process identity and handle slopes | Phase 1 Tasks 1, 4 |
| Incremental allowlisted event cursors and truncation disclosure | Phase 1 Tasks 3A, 5 |
| Transactional runs, metrics, incidents, reports, and retention | Phase 1 Tasks 2, 5, 7 |
| Status reads create no telemetry; backed-up legacy repair | Phase 1 Task 3 |
| Atomic daily/weekly reports with coverage gaps | Phase 1 Tasks 5, 7 |
| Central default-deny metadata and runner enforcement | Phase 0 Tasks 2, 3 |
| Authenticated elevated boundary and immutable parameters | Phase 0 Task 4 |
| One manifest for registration/UI/verification/uninstall; no console flash | Phase 0 Task 5 |
| Durable intents/runs/locks/gates/cooldowns/circuits | Phase 2 Tasks 1-3 |
| Unattended privileged work uses one protected demand-start broker, not direct SYSTEM mutation tasks | Phase 2 Task 3A |
| Scheduled mutations become fixed Workbench intent IDs | Phase 2 Task 4 |
| Safe PCDoctor-owned automatic cohort | Phase 2 Task 5 |
| Conditional EaseUS/Wave Link/SPP/System-log/workload policies disabled by default | Phase 3 Tasks 1-6 |
| No reboot/destructive/user-data/session automatic action | Phase 0 Tasks 2-3 and Phase 2 Task 7 |
| Typed Dashboard controls without arbitrary code/arguments | Phase 1 Task 6 and Phase 2 Task 6 |
| Reproducible lint/native tests/CI and no hidden skips | Phase 0 Task 1 |
| Supported dependencies, verified downloads, no lingering Defender exclusion | Phase 4 Tasks 1, 3, 4 |
| Signing state, package hashes/SBOM, installed/publish separation | Phase 4 Tasks 5-6 |
| Separate kill switches and rollback-safe history | Phase 2 Tasks 1-3, 6 |

## Phase transition rules

- [ ] Complete every task and commit in the current phase before starting the next phase.
- [ ] Run the phase's focused tests after each RED/GREEN cycle and the full source suite at its exit gate.
- [ ] Treat any failed safety assertion, rollback uncertainty, native-module skip, or policy bypass as a release blocker.
- [ ] Keep `maintenance_global_enabled=0` through Phases 0 and 1.
- [ ] In Phase 2, enable only the safe PCDoctor-owned policy cohort after its installed smoke test.
- [ ] In Phase 3, keep every conditional policy disabled in defaults and on migration.
- [ ] At the end of Phase 4, produce hashes and evidence but do not publish or install.

## Final verification

Run from `C:\dev\pcdoctor-workbench`:

```powershell
npm ci
npm run verify:source
npm run package
npm run verify:abi
npm run verify:package
npm run test:smoke
git status --short
```

Expected:

- every command exits `0`;
- no safety-critical test is skipped;
- no task launches a mutating PowerShell script directly;
- all background user-context task actions include hidden-window behavior;
- installer/uninstaller task identities match the generated manifest;
- the installed smoke fixture reports `reboot_policy=never` and no reboot request;
- `git status --short` shows only the pre-existing untracked `.claude/` directory;
- no release has been published and no installer has been applied.
