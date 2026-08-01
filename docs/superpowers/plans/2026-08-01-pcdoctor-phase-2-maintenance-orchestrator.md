# PCDoctor Phase 2 Maintenance Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, fail-closed maintenance intents and enable only the safe PCDoctor-owned maintenance cohort.

**Architecture:** Fixed-ID schedule or incident triggers create durable intents. The Orchestrator evaluates compiled policy and live machine gates, obtains durable leases, performs a dry run, dispatches through the already-hardened action runner, verifies a fresh exact postcondition, and records success, rollback, or an open circuit. Windows tasks can launch only the Workbench executable with a known intent ID; they never invoke mutating PowerShell directly.

**Tech Stack:** TypeScript, SQLite, Electron single-instance argv routing, PowerShell 5.1, Vitest, React, Windows Task Scheduler manifest.

## Global Constraints

- Automatic execution requires `maintenance_global_enabled=1` and an enabled known policy.
- Reboot, destructive confirmation level, user-data deletion, session termination, unproven rollback, unknown action, unknown intent, and caller-supplied arguments are always denied.
- The first enabled cohort is limited to Defender definitions, read-only scheduled checks, PCDoctor-owned retention, report generation, and schedule staggering.
- Every conditional machine policy remains disabled.
- One failed postcondition permits at most one proven rollback, then opens the policy circuit.
- No release publish or install occurs in this phase.

---

## File structure

- Create `src/shared/maintenanceTypes.ts`: intent/policy/run/lock/summary contracts.
- Create `src/main/maintenanceStore.ts`: transactional policy/intent/run/lease/circuit persistence.
- Create `src/main/maintenanceGates.ts`: pure and injected live-gate evaluation.
- Create `src/main/maintenanceActions.ts`: compiled preflight/dry-run/postcondition/rollback registry.
- Create `src/main/maintenanceOrchestrator.ts`: lifecycle and one-flight execution pipeline.
- Create `src/main/maintenanceIpc.ts`: typed policy/evidence controls.
- Create `src/renderer/components/dashboard/MaintenancePanel.tsx`: policy and run evidence.
- Create `powershell/Invoke-PCDoctorRetention.ps1`: PCDoctor-owned bounded retention.
- Modify automation catalog/policy, data migrations, task manifest, main lifecycle/argv routing, preload/types, Dashboard, and notification integration.

### Task 1: Maintenance schema and exact shared contracts

**Files:**
- Create: `src/shared/maintenanceTypes.ts`
- Create: `src/main/maintenanceStore.ts`
- Modify: `src/main/dataStore.ts`
- Create: `tests/main/maintenanceStore.test.ts`
- Modify: `tests/main/dataStoreMigrations.test.ts`

**Interfaces:**
- Produces: `MaintenancePolicy`, `MaintenanceIntent`, `MaintenanceRun`, `MaintenanceLease`, `MaintenanceSummary`.
- Produces: `createIntent`, `claimNextIntent`, `startRun`, `finishRun`, `acquireLeases`, `releaseLeases`, `openCircuit`, `closeCircuit`.

- [ ] **Step 1: Write migration and state-machine tests**

Test a fresh/existing DB, duplicate intent signature, disabled/snoozed policy, atomic claim, concurrent lease refusal, expired lease with live/dead owner, terminal-state immutability, circuit persistence, and crash recovery.

```ts
expect(store.createIntent(fixed)).toMatchObject({ state: 'pending' });
expect(store.createIntent(fixed)).toMatchObject({ deduplicated: true });
expect(store.transitionRun(id, 'succeeded')).toBe(true);
expect(() => store.transitionRun(id, 'running')).toThrow(/terminal/i);
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/main/maintenanceStore.test.ts`

- [ ] **Step 3: Add migration version 2**

Create `maintenance_policies`, `maintenance_intents`, `maintenance_runs`, `maintenance_gate_results`, `maintenance_locks`, and `maintenance_circuits`. Use CHECK constraints for fixed states and foreign keys between policy/intent/run. Add unique dedup signature and indexes on eligibility/state/policy/action/timestamps.

- [ ] **Step 4: Implement atomic repository methods**

`claimNextIntent(nowMs)` uses one transaction to select the oldest eligible pending intent and mark it running. Lease acquisition inserts all requested resources or none. Crash recovery changes abandoned `running` intents to `failed` with `E_INTERRUPTED_UNKNOWN`, opens the circuit, and never assumes success.

- [ ] **Step 5: Verify and commit**

```powershell
npx vitest run tests/main/maintenanceStore.test.ts tests/main/dataStoreMigrations.test.ts
git add src/shared/maintenanceTypes.ts src/main/maintenanceStore.ts src/main/dataStore.ts tests/main/maintenanceStore.test.ts tests/main/dataStoreMigrations.test.ts
git commit -m "feat: persist maintenance execution state"
```

### Task 2: Compiled gates and action lifecycle registry

**Files:**
- Create: `src/main/maintenanceGates.ts`
- Create: `src/main/maintenanceActions.ts`
- Create: `tests/main/maintenanceGates.test.ts`
- Create: `tests/main/maintenanceActions.test.ts`
- Modify: `src/main/automationPolicy.ts`
- Modify: `src/shared/automationCatalog.ts`

**Interfaces:**
- Produces: `evaluateMaintenanceGates(input): GateResult[]`.
- Produces: `MAINTENANCE_ACTIONS: Record<MaintenanceActionId, MaintenanceActionLifecycle>`.

- [ ] **Step 1: Write every denial-boundary test**

Cover stale/missing incident evidence, outside window, active user, high commit, low available RAM, heavy task active, audio active, backup active, cooldown, attempt limit, open circuit, missing postcondition, rollback required/unavailable, and reboot result.

- [ ] **Step 2: Define the lifecycle interface**

```ts
export interface MaintenanceActionLifecycle {
  id: MaintenanceActionId;
  execution:
    | { kind: 'catalog'; actionName: ActionName }
    | { kind: 'internal'; operation: 'sentinel_daily_report' | 'sentinel_weekly_report' | 'readonly_security' };
  preflight(ctx: GateContext): Promise<GateResult>;
  dryRun(ctx: GateContext): Promise<MaintenancePlan>;
  postcondition(ctx: GateContext, result: ActionResult): Promise<GateResult>;
  rollback: null | ((ctx: GateContext, run: MaintenanceRun) => Promise<GateResult>);
}
```

`MaintenancePlan` contains only compiled action ID, immutable params hash, expected duration, required locks, and expected postcondition ID.

- [ ] **Step 3: Implement gates in deterministic order**

Evaluate immutable safety, global switch, policy state, evidence, time window, machine pressure, action-specific activity, locks, cooldown/attempts, preflight, dry-run identity, and rollback readiness. Persist each result with observed values and bounded reason; stop at first denial.

- [ ] **Step 4: Make registry/catalog completeness compile-time checked**

Every `safe` or `conditional` automation catalog entry must reference one lifecycle registry entry. Every registry entry with `execution.kind === 'catalog'` must reference an action whose automation class is not `never`. Internal operations are a closed string union dispatched by an exhaustive switch; they cannot accept code or arguments. Tests compare the catalog and registry key sets and exercise every internal operation.

- [ ] **Step 5: Verify and commit**

```powershell
npx vitest run tests/main/maintenanceGates.test.ts tests/main/maintenanceActions.test.ts tests/main/automationPolicy.test.ts
npm run typecheck
git add src/main/maintenanceGates.ts src/main/maintenanceActions.ts src/main/automationPolicy.ts src/shared/automationCatalog.ts tests/main
git commit -m "feat: compile maintenance gates and lifecycles"
```

### Task 3: One-flight Orchestrator with postcondition and circuit breaker

**Files:**
- Create: `src/main/maintenanceOrchestrator.ts`
- Create: `tests/main/maintenanceOrchestrator.test.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/actionRunner.ts`
- Modify: `src/main/notifier.ts`

**Interfaces:**
- Produces: `startMaintenanceOrchestrator(deps?)`, `stopMaintenanceOrchestrator()`, `submitMaintenanceIntent(id, trigger)`, `getMaintenanceSummary()`.

- [ ] **Step 1: Write the orchestration story tests**

Test disabled global switch, dedup, defer, successful run, action-reported failure, timeout, postcondition failure with successful rollback, failed rollback, repeated failure, circuit opening, notification dedup, and stop while idle/running.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/main/maintenanceOrchestrator.test.ts`

- [ ] **Step 3: Implement one recursive owned loop**

At most one intent is active. Claim, evaluate/persist gates, acquire leases, dry-run, create trusted automatic context, dispatch catalog execution through `runAction` or a closed internal operation through an exhaustive switch, observe fresh postcondition, finish, release, and schedule the next poll. Defer uses a bounded next-eligible time; denial does not busy-loop.

- [ ] **Step 4: Implement fail-closed completion**

If the postcondition fails, perform one declared rollback only. Verify rollback from fresh state. Regardless of rollback outcome, open the circuit. If a result requests/requires reboot, record `E_REBOOT_FORBIDDEN`, open the circuit, and notify without rebooting.

- [ ] **Step 5: Add lifecycle startup/shutdown and notifications**

Start only after Sentinel/store/policy initialization. Shutdown stops new claims and awaits bounded in-flight bookkeeping without terminating an unknown Windows operation. Notify on mutation start, failure, rollback, and circuit-open; summarize success in Dashboard/report.

- [ ] **Step 6: Verify and commit**

```powershell
npx vitest run tests/main/maintenanceOrchestrator.test.ts tests/main/actionRunner*.test.ts tests/main/notifier*.test.ts
npm run typecheck
git add src/main/maintenanceOrchestrator.ts src/main/main.ts src/main/actionRunner.ts src/main/notifier.ts tests/main
git commit -m "feat: orchestrate guarded maintenance intents"
```

### Task 3A: Demand-start privileged maintenance broker

**Files:**
- Create: `resources/broker/Maintenance-Broker.ps1`
- Create: `src/main/maintenanceBroker.ts`
- Create: `scripts/install-maintenance-broker.ps1`
- Create: `scripts/test-maintenance-broker.ps1`
- Create: `tests/main/maintenanceBroker.test.ts`
- Modify: `src/shared/task-manifest.json`
- Modify: `powershell/Register-All-Tasks.ps1`
- Modify: `scripts/installer.nsh`
- Modify: `electron-builder.yml`

**Interfaces:**
- Produces manifest task `PCDoctor-Maintenance-Broker`, SYSTEM, highest privilege, hidden, demand-start only, `MultipleInstances=IgnoreNew`, and no calendar trigger.
- Produces `dispatchPrivilegedMaintenance(intent: BrokerIntent): Promise<BrokerResult>`.
- Broker accepts only fixed action/operation IDs compiled into its admin-protected script; it accepts no script path, executable path, command text, or caller-defined arguments.

- [ ] **Step 1: Write privilege-boundary tests**

Reject a broker file writable by standard users, a calendar-triggered broker task, non-SYSTEM task context, unknown action, extra argument, stale/replayed intent, mismatched policy grant, wrong server/client process SID/integrity/path/hash, and reboot/destructive action. Test timeout and one-flight behavior.

- [ ] **Step 2: Install the broker in an admin-protected location**

During elevated installation, copy only the broker and its fixed policy manifest to `%ProgramFiles%\PCDoctor Maintenance Broker`. Set owner to Administrators/SYSTEM, grant Users read/execute only, verify no standard-user write ACE, hash the files, and register the single demand-start task. This replaces the prior collection of direct SYSTEM mutation tasks; it is not a persistent service or always-running helper.

- [ ] **Step 3: Use an authenticated named-pipe rendezvous**

The Workbench opens a fixed per-user named pipe with an ACL limited to the current SID and SYSTEM, then starts the broker task. On connection, Workbench obtains and validates the client PID/token as SYSTEM and the exact protected broker command. The broker obtains and validates the server PID/token, exact Workbench executable identity, installed path, and allowed publisher/hash before accepting one short-lived fixed intent. Both sides bind version, intent ID, policy ID, nonce, issue/expiry time, and expected action ID; both reject replay.

- [ ] **Step 4: Require a protected policy grant for privileged automation**

The broker reads an admin-protected grant file containing only known policy IDs, enabled state, version, and `rebootPolicy: never`. Enabling or disabling a privileged automatic policy updates this grant through one explicit UAC operation and verifies it. The standard-user SQLite preference can make policy more restrictive but can never enable a broker action absent the protected grant. Thus disabling either layer denies execution.

- [ ] **Step 5: Re-run action-specific preflight inside the broker**

The broker independently rechecks exact machine identity, maintenance window, action-specific idle/activity state, protected grant, immutable action map, and reboot prohibition immediately before execution. It writes bounded result/postcondition evidence over the authenticated pipe; it does not poll a user-writable command directory.

- [ ] **Step 6: Verify and commit**

```powershell
npx vitest run tests/main/maintenanceBroker.test.ts
powershell.exe -ExecutionPolicy Bypass -File scripts/test-maintenance-broker.ps1 -SyntheticOnly
npm run test:ps51
node scripts/generate-task-manifest.mjs
node scripts/generate-task-manifest.mjs --check
git add resources/broker/Maintenance-Broker.ps1 src/main/maintenanceBroker.ts scripts/install-maintenance-broker.ps1 scripts/test-maintenance-broker.ps1 tests/main/maintenanceBroker.test.ts src/shared/task-manifest.json powershell/task-manifest.json powershell/Register-All-Tasks.ps1 scripts/installer.nsh electron-builder.yml
git commit -m "security: add demand-start maintenance broker"
```

### Task 4: Route schedules through fixed Workbench intent IDs

**Files:**
- Modify: `src/shared/taskManifest.ts`
- Modify: `src/shared/task-manifest.json`
- Modify: `scripts/generate-task-manifest.mjs`
- Modify: `src/main/main.ts`
- Create: `src/main/maintenanceIntentRouter.ts`
- Create: `tests/main/maintenanceIntentRouter.test.ts`
- Modify: `powershell/task-manifest.json`
- Modify: task registration tests

**Interfaces:**
- Produces argv: `PCDoctor Workbench.exe --hidden --maintenance-intent=<fixed-id>`.
- Produces: `routeMaintenanceIntentArgv(argv: readonly string[]): MaintenanceIntentId | null`.

- [ ] **Step 1: Write argv and second-instance tests**

Accept exactly one manifest-known ID. Reject duplicates, unknown values, extra action/param/script flags, path separators, shell metacharacters, and oversized argv. Test both first launch and Electron `second-instance` argv delivery.

- [ ] **Step 2: Implement the pure router**

Use exact string comparison against manifest intent IDs; no regex-derived script/path. The router returns only the ID. `main.ts` submits it after Orchestrator startup; the `second-instance` handler submits rather than showing the window for `--hidden` task launches.

- [ ] **Step 3: Activate only safe scheduled intents**

Generate scheduled intent tasks for Defender definitions, PCDoctor retention, daily/weekly reports, and approved read-only checks. Keep scans load-gated. Keep weekly maintenance/monthly deep scan deferred until their component actions have safe lifecycle definitions. Unsafe legacy tasks remain removed.

- [ ] **Step 4: Verify and commit**

```powershell
node scripts/generate-task-manifest.mjs
node scripts/generate-task-manifest.mjs --check
npx vitest run tests/main/maintenanceIntentRouter.test.ts tests/main/taskMigrationVerify*.test.ts
npm run test:tasks
git add src/shared/task-manifest.json src/shared/taskManifest.ts scripts/generate-task-manifest.mjs src/main/main.ts src/main/maintenanceIntentRouter.ts tests/main powershell/task-manifest.json
git commit -m "feat: route schedules through maintenance intents"
```

### Task 5: Safe automatic policy cohort

**Files:**
- Create: `powershell/Invoke-PCDoctorRetention.ps1`
- Create: `scripts/test-pcdoctor-retention.ps1`
- Modify: `powershell/actions/Update-DefenderDefs.ps1`
- Modify: safe read-only collector scripts as needed for fixed JSON contracts
- Modify: `src/main/maintenanceActions.ts`
- Modify: `src/shared/automationCatalog.ts`
- Modify: `src/shared/actions.ts`
- Modify: `src/shared/types.ts`
- Create: `tests/main/safeMaintenancePolicies.test.ts`

**Interfaces:**
- Adds maintenance lifecycle IDs: `pcdoctor_retention`, `update_defender_definitions`, `generate_sentinel_daily`, `generate_sentinel_weekly`, `run_readonly_smart`, `run_readonly_security`.
- Maps them respectively to catalog action `pcdoctor_retention`, existing catalog action `update_defender_defs`, internal daily report, internal weekly report, existing catalog action `run_smart_check`, and internal read-only security collection.

- [ ] **Step 1: Write action-specific pre/postcondition fixtures**

- Retention: dry-run row/file list matches actual bounded deletion; open-incident evidence preserved; backup/checkpoint valid.
- Defender definitions: preflight confirms Defender service/command availability; postcondition confirms signature timestamp/version did not regress and update result is successful/no-op.
- Reports: expected period/hash exists exactly once.
- Read-only checks: capture timestamp advances and no configuration/data-deletion field is present.

- [ ] **Step 2: Implement PCDoctor-owned retention**

The script accepts fixed retention days and `-DryRun`, operates only under `C:\ProgramData\PCDoctor` known DB/report/log roots, refuses reparse points or paths outside them, caps files/rows per run, and returns exact before/planned/after counts. It never touches user recycle bins, browser caches, Windows component store, restore points, or non-PCDoctor logs.

- [ ] **Step 3: Add dry-run and structured postcondition data to Defender definitions**

`-DryRun` reports current signature version/time and intended update command without starting it. Real execution returns before/after version/time, command result, `reboot_required=false`, and `no_op` when already current.

- [ ] **Step 4: Enable safe catalog entries only**

Set safe class, fixed locks, cooldown, max attempts, preflight/postcondition IDs, and `rebootPolicy: never`. Default policies are enabled only for this safe cohort after migration; every conditional policy remains disabled.

- [ ] **Step 5: Verify and commit**

```powershell
npx vitest run tests/main/safeMaintenancePolicies.test.ts
powershell.exe -ExecutionPolicy Bypass -File scripts/test-pcdoctor-retention.ps1
npm run test:ps51
git add powershell/Invoke-PCDoctorRetention.ps1 powershell/actions/Update-DefenderDefs.ps1 scripts/test-pcdoctor-retention.ps1 src/main/maintenanceActions.ts src/shared/automationCatalog.ts src/shared/actions.ts src/shared/types.ts tests/main/safeMaintenancePolicies.test.ts
git commit -m "feat: add safe automatic maintenance cohort"
```

### Task 6: Typed policy/evidence Dashboard controls

**Files:**
- Create: `src/main/maintenanceIpc.ts`
- Create: `src/renderer/components/dashboard/MaintenancePanel.tsx`
- Create: `tests/main/maintenanceIpc.test.ts`
- Create: `tests/renderer/MaintenancePanel.test.tsx`
- Modify: `src/preload/preload.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/renderer/pages/Dashboard.tsx`

**Interfaces:**
- IPC: get summary, list known policies, enable/disable/snooze known policy, close circuit after confirmation, submit known manual intent.
- Renderer cannot alter action mapping, gate code, arguments, scripts, windows, locks, reboot policy, or evidence.

- [ ] **Step 1: Write allowlist and UX tests**

Cover unknown policy/intent, conditional enable confirmation, snooze bounds, immutable reboot field, circuit evidence, last run gates, next eligibility, manifest drift, and automatic success/failure display.

- [ ] **Step 2: Implement bounded IPC**

Use exact known IDs. Snooze accepts integer hours `1..168`. Conditional enable requires the existing confirmation channel and records actor/time; it still fails if `validated_at` for that policy is absent.

- [ ] **Step 3: Implement compact evidence UI**

Show global switch, safe/conditional/manual class, enabled/snoozed, last result, denial gate, cooldown, circuit, and task drift. Do not expose editable expressions or arguments.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/main/maintenanceIpc.test.ts tests/renderer/MaintenancePanel.test.tsx
npm run typecheck
git add src/main/maintenanceIpc.ts src/renderer/components/dashboard/MaintenancePanel.tsx tests/main/maintenanceIpc.test.ts tests/renderer/MaintenancePanel.test.tsx src/preload/preload.ts src/shared/types.ts src/main/ipc.ts src/renderer/pages/Dashboard.tsx
git commit -m "feat: expose guarded maintenance evidence"
```

### Task 7: Phase 2 end-to-end exit gate

**Files:**
- Create: `tests/main/maintenanceOrchestrator.e2e.test.ts`
- Create: `docs/superpowers/reports/phase-2-validation.md`

- [ ] **Step 1: Drive deterministic full stories**

Drive one safe success; load deferral; disabled policy; snoozed policy; cooldown; duplicate schedule; postcondition failure; verified rollback; failed rollback/circuit; app restart recovery; destructive intent; reboot result; and unknown task ID.

- [ ] **Step 2: Run full gates**

```powershell
npx vitest run tests/main/maintenanceOrchestrator.e2e.test.ts
npm run verify:source
node scripts/generate-task-manifest.mjs --check
```

Expected: safe success passes; destructive/reboot/unknown paths perform zero mutation; conditional policies remain disabled.

- [ ] **Step 3: Record evidence and commit**

```powershell
git add tests/main/maintenanceOrchestrator.e2e.test.ts docs/superpowers/reports/phase-2-validation.md
git commit -m "test: validate guarded maintenance pipeline"
```
