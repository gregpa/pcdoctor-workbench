# PCDoctor Phase 3 Machine-Specific Policies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independently testable, disabled-by-default policies for the confirmed EaseUS, Wave Link, SPP, System event-log, and explicit workload findings on Greg's PC.

**Architecture:** Each policy is a compiled lifecycle with fixed identity, fresh Sentinel evidence, action-specific idle/preflight checks, no caller parameters, exact postcondition, one recovery/rollback path, cooldown, and circuit breaker. Proven evidence scripts from the audit are imported as source material, refactored to emit reusable JSON contracts, and tested without repeating their live repairs.

**Tech Stack:** TypeScript policy registry, PowerShell 5.1, Windows service/CIM/event/ACL/Core Audio APIs, Vitest fixtures, authenticated elevated worker.

## Global Constraints

- Every policy in this phase defaults disabled, including on upgrades and rollback.
- Do not run the live EaseUS restart, SPP ACL repair, System-log resize, or Wave Link restart while implementing or testing.
- Do not copy EaseUS diagnostic authentication material into source, tests, logs, reports, or notes.
- No process/service identity is inferred from display name alone; require path, signer, PID/start time, and expected service relationship.
- Wave Link upgrade/migration remains manual and preferred over repeated restart.
- Workload stop has an intentionally empty default allowlist.
- Any preflight/postcondition/rollback ambiguity denies and opens the circuit; no reboot.

---

## File structure

- Create `src/shared/machinePolicyCatalog.ts`: fixed machine policy IDs/identity/window/cooldown defaults.
- Create `powershell/policies/easeus/*`: imported and hardened EaseUS idle/restart contracts.
- Create `powershell/policies/wavelink/*`: read-only audio/process gate and graceful restart/relaunch.
- Create `powershell/policies/spp/*`: exact recurrence/preflight/ACL/postcondition/rollback.
- Create `powershell/policies/eventlog/*`: exact System channel drift repair/rollback.
- Create `powershell/policies/workloads/*`: compiled empty-default graceful-stop framework.
- Modify Sentinel process/event observations, automation catalog, maintenance registry, worker allowlist/schema, and policy Dashboard copy.

### Task 1: Machine policy catalog and common evidence contract

**Files:**
- Create: `src/shared/machinePolicyCatalog.ts`
- Create: `src/shared/machinePolicyTypes.ts`
- Create: `tests/shared/machinePolicyCatalog.test.ts`
- Modify: `src/shared/automationCatalog.ts`

**Interfaces:**
- Produces: `MACHINE_POLICIES satisfies Record<MachinePolicyId, MachinePolicyDefinition>`.
- Produces IDs: `easeus_agent_leak_restart`, `wavelink_handle_leak_restart`, `spp_acl_recurrence`, `system_log_capacity_drift`.
- Produces: `WORKLOAD_POLICIES: readonly WorkloadPolicyDefinition[] = []` by default.

- [ ] **Step 1: Write default-safety tests**

Assert all four policies are conditional, disabled, `rebootPolicy: never`, have non-empty locks/cooldowns/max attempts, and cannot accept runtime action parameters. Assert workload allowlist is empty.

- [ ] **Step 2: Define the catalog**

Use fixed defaults:

| Policy | Window | Cooldown | Attempts | Locks |
|---|---:|---:|---:|---|
| EaseUS | 00:30-05:30 local | 7 days | 1/7 days | `easeus`, `backup`, `heavy-maintenance` |
| Wave Link | 02:00-05:00 local | 24 hours | 1/day | `audio`, `interactive-app` |
| SPP ACL | any quiet period after exact recurrence | 30 days | 1/30 days | `licensing`, `scheduled-tasks` |
| System log | 00:30-05:30 local | 30 days | 1/30 days | `eventlog`, `system-config` |

Store identity rules, not secrets. EaseUS expects service `EaseUS Agent`, root `C:\Program Files (x86)\EaseUS\Todo Backup\bin`, valid Authenticode, and the exact process cohort. SPP expects channel/provider/event and task directory names. System log expects channel `System` and 536,870,912 bytes.

- [ ] **Step 3: Verify and commit**

```powershell
npx vitest run tests/shared/machinePolicyCatalog.test.ts
npm run typecheck
git add src/shared/machinePolicyCatalog.ts src/shared/machinePolicyTypes.ts src/shared/automationCatalog.ts tests/shared/machinePolicyCatalog.test.ts
git commit -m "feat: define disabled machine policy catalog"
```

### Task 2: EaseUS leak-reset policy from proven audit evidence

**Files:**
- Create: `powershell/policies/easeus/EaseUSAgentIdleGate.ps1`
- Create: `powershell/policies/easeus/Test-EaseUSAgentIdleGate.ps1`
- Create: `powershell/policies/easeus/Invoke-EaseUSAgentRestart.ps1`
- Create: `scripts/test-easeus-policy.ps1`
- Create: `tests/main/easeusPolicy.test.ts`
- Modify: `src/main/maintenanceActions.ts`
- Modify: worker action/parameter maps

**Interfaces:**
- Adds lifecycle action `easeus_agent_restart` with no renderer/caller params.
- Preflight/result JSON includes `idle_gate`, `immediate_recheck`, `service_before`, `restart_cohort`, `service_after`, `handle_recovery`, and `reboot_required: false`.

- [ ] **Step 1: Import the exact evidence baseline and verify source hashes**

Use these read-only source baselines from the audit evidence directory:

- `EaseUSAgentIdleGate.ps1`: `B459D68DE5A1E3BEBC3B912487BE13F7B47AD1FDA02F79DE69D8E1634775A481`
- `Restart-EaseUSAgentForLeakTest.ps1`: `59A45C45C1A4A1793B459E64274CE4F05DCFB8A4981FB0D4E8BAB4B72E61166D`
- `Test-EaseUSAgentIdleGate.ps1`: `152FBDB3E4657C3C31C7EF245FF287729C4461FC423F63DBBEF6D660D4B6E7BF`

Copy with `Copy-Item`, verify hashes before editing, then preserve the imported hash list in the test header. Do not copy result logs containing authentication material.

- [ ] **Step 2: Write policy regression tests before refactoring**

Retain fixtures for valid idle, backup worker present, VSS active, recent/changed marker, established TCP, path/signer mismatch, helper I/O, PID/cohort change, stale parent, survivor PID, and failed service recovery. Add Sentinel evidence tests requiring one incident with same Agent identity, at least 10,000 handles, and sustained growth.

- [ ] **Step 3: Refactor to reusable dry-run/execute contract**

`Invoke-EaseUSAgentRestart.ps1` accepts only `-Mode Preflight|Execute|Postcondition|Recovery` and a fixed orchestrator evidence directory. Preflight performs the 15-second idle sample plus 2-second immediate recheck. Execute repeats the immediate gate immediately before `Restart-Service`. It never terminates survivor processes.

Postcondition requires a new Agent PID/start time, service Running/Auto, valid signed cohort, old Agent exit, and at least 30 seconds of low new handle growth. The known stale `TodoBackupService.exe` survivor condition is a failure, not success. Recovery only starts the same service if execution left it stopped; it cannot kill processes or alter startup mode.

- [ ] **Step 4: Register the disabled lifecycle**

Require Sentinel incident `process_handle_growth:EaseUS Agent`, evidence age under 15 minutes, commit/load gates, no VSS/backup activity, one attempt/seven days, and `easeus`/`backup` locks. Successful postcondition resolves the incident; any cohort failure opens the circuit.

- [ ] **Step 5: Run synthetic-only verification and commit**

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/test-easeus-policy.ps1 -SyntheticOnly
npx vitest run tests/main/easeusPolicy.test.ts
npm run test:ps51
git add powershell/policies/easeus scripts/test-easeus-policy.ps1 tests/main/easeusPolicy.test.ts src/main/maintenanceActions.ts src/main/elevatedWorker.ts powershell/worker/Elevated-Worker.ps1
git commit -m "feat: add disabled guarded EaseUS reset policy"
```

### Task 3: Wave Link leak policy with fail-closed audio gate

**Files:**
- Create: `powershell/policies/wavelink/Get-CoreAudioActivity.ps1`
- Create: `powershell/policies/wavelink/Invoke-WaveLinkRestart.ps1`
- Create: `scripts/test-wavelink-policy.ps1`
- Create: `tests/main/waveLinkPolicy.test.ts`
- Modify: `src/main/maintenanceActions.ts`
- Modify: worker action/parameter maps

**Interfaces:**
- Adds lifecycle action `wavelink_restart` with no caller params.
- Preflight JSON includes exact executable identity/signer, PID/start time, active render/capture sessions, configured quiet window, and Sentinel slope evidence.

- [ ] **Step 1: Write fail-closed fixture tests**

Cover slope below/at 5,000 handles/hour, changed PID/start time, path/signer mismatch, active render session, active capture/recording session, unavailable Core Audio enumeration, outside quiet window, no main window, graceful-close timeout, relaunch failure, and verified recovery.

- [ ] **Step 2: Implement a read-only Core Audio probe**

Use embedded C# COM interop for `IMMDeviceEnumerator`, `IAudioSessionManager2`, and `IAudioSessionControl2`. Return process IDs and active/inactive state only; do not store device names or application titles. If COM activation, endpoint enumeration, or PID attribution fails, return `gate_available=false` and deny restart.

- [ ] **Step 3: Implement graceful close/relaunch**

Resolve the running Wave Link process's exact path, start time, and valid expected publisher. Recheck audio immediately before closing. Use `CloseMainWindow()` and wait up to 20 seconds; never call `Stop-Process -Force`. Relaunch only the captured signed path, then verify a new PID/start time and handle slope below threshold over 30 seconds. Recovery may relaunch the same captured signed path if graceful close succeeded and launch failed.

- [ ] **Step 4: Register disabled policy and manual upgrade notice**

Require a valid sustained incident, fresh evidence, quiet window, zero active audio sessions, and 24-hour cooldown. Dashboard copy states that Wave Link 3.1 migration is the preferred manual fix; policy enable remains unavailable until the Core Audio probe passes on the installed machine.

- [ ] **Step 5: Verify and commit**

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/test-wavelink-policy.ps1 -SyntheticOnly
npx vitest run tests/main/waveLinkPolicy.test.ts
npm run test:ps51
git add powershell/policies/wavelink scripts/test-wavelink-policy.ps1 tests/main/waveLinkPolicy.test.ts src/main/maintenanceActions.ts src/main/elevatedWorker.ts powershell/worker/Elevated-Worker.ps1
git commit -m "feat: add disabled Wave Link recovery policy"
```

### Task 4: Exact SPP recurrence and System event-log drift policies

**Files:**
- Create: `powershell/policies/spp/Invoke-SppAclRepair.ps1`
- Create: `powershell/policies/eventlog/Invoke-SystemLogCapacity.ps1`
- Create: `scripts/test-spp-policy.ps1`
- Create: `scripts/test-eventlog-policy.ps1`
- Create: `tests/main/sppPolicy.test.ts`
- Create: `tests/main/systemLogPolicy.test.ts`
- Modify: `src/main/maintenanceActions.ts`
- Modify: worker action/parameter maps

**Interfaces:**
- Adds actions `spp_acl_repair` and `system_log_capacity_repair`, both no-parameter and disabled.

- [ ] **Step 1: Import and hash-verify audit baselines**

- SPP repair: `321EAA1940FDC170FCF4446574CFDB2BEB5E9E98D8ED09D226E31A782F4FF8C7`
- SPP restore: `8C77B0249BCEC6EE4FE25E87BA0C989EA69918120B88C8230EDE9AB042D19D22`
- System log capacity: `50225350A484B664C91D9D1CF9668D0133B3049391D30B77D3EF8194EDD57812`

Verify before refactoring; do not run live.

- [ ] **Step 2: Test exact SPP recurrence and rollback**

Require at least two Application log events from provider `Microsoft-Windows-Security-SPP`, ID 16385, in 180 seconds; task directory and three names; `sppsvc` Running as NetworkService; Windows Professional LicenseStatus 1; and missing expected NetworkService ACL. Back up current ACL SDDL and task hashes before mutation. Postcondition requires exact rule present, license unchanged, service/account unchanged, and zero recurrence for 180 seconds. Any failure restores all four SDDLs and verifies byte-for-byte SDDL equality.

- [ ] **Step 3: Test exact System-log drift and rollback**

Require channel exactly `System`, enabled/circular, current maximum not 536,870,912 bytes, and no event-log maintenance lock. Store prior maximum. Execute only `wevtutil sl System /ms:536870912`. Postcondition verifies exact size and that the log was not cleared. Rollback restores only the captured prior maximum.

- [ ] **Step 4: Register disabled policies**

Use 30-day cooldown/one attempt, exact event/identity evidence, immutable arguments, and separate locks. A current already-correct state is a verified no-op, not a mutation.

- [ ] **Step 5: Verify and commit**

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/test-spp-policy.ps1 -SyntheticOnly
powershell.exe -ExecutionPolicy Bypass -File scripts/test-eventlog-policy.ps1 -SyntheticOnly
npx vitest run tests/main/sppPolicy.test.ts tests/main/systemLogPolicy.test.ts
npm run test:ps51
git add powershell/policies/spp powershell/policies/eventlog scripts/test-spp-policy.ps1 scripts/test-eventlog-policy.ps1 tests/main/sppPolicy.test.ts tests/main/systemLogPolicy.test.ts src/main/maintenanceActions.ts src/main/elevatedWorker.ts powershell/worker/Elevated-Worker.ps1
git commit -m "feat: add disabled exact-drift repair policies"
```

### Task 5: Explicit workload policy framework with empty default allowlist

**Files:**
- Create: `powershell/policies/workloads/Test-WorkloadIdle.ps1`
- Create: `powershell/policies/workloads/Stop-AllowlistedWorkload.ps1`
- Create: `scripts/test-workload-policy.ps1`
- Create: `tests/main/workloadPolicy.test.ts`
- Modify: `src/shared/machinePolicyCatalog.ts`
- Modify: `src/main/maintenanceActions.ts`

**Interfaces:**
- Consumes only compiled `WorkloadPolicyDefinition`; no renderer path/PID/command arguments.
- Default `WORKLOAD_POLICIES` remains an empty readonly array.

- [ ] **Step 1: Write denial tests**

Reject name-only matches, unknown PID, changed start time, path/hash/signer mismatch, child activity, active listener/connection, recent CPU/I/O, service dependencies, Homebridge/Plex/media identity, WSL/Docker/VM inference, and empty allowlist execution.

- [ ] **Step 2: Implement the generic fail-closed contract**

A compiled entry must define exact executable/service identity, signer/hash rule, allowed parent/children, idle sample duration/thresholds, stop method, postcondition, recovery command ID, window, and locks. Graceful stop only; no force kill. Without a compiled entry, return `E_WORKLOAD_NOT_ALLOWLISTED`.

- [ ] **Step 3: Keep production allowlist empty**

Tests use synthetic definitions injected into pure evaluators. Do not add Next.js, WSL, Docker, VM, Homebridge, Plex, media, AI client, browser, or OEM workload entries.

- [ ] **Step 4: Verify and commit**

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/test-workload-policy.ps1 -SyntheticOnly
npx vitest run tests/main/workloadPolicy.test.ts
npm run test:ps51
git add powershell/policies/workloads scripts/test-workload-policy.ps1 tests/main/workloadPolicy.test.ts src/shared/machinePolicyCatalog.ts src/main/maintenanceActions.ts
git commit -m "feat: add empty-default workload policy framework"
```

### Task 6: Phase 3 independent validation and disabled-state gate

**Files:**
- Create: `tests/main/machinePolicies.e2e.test.ts`
- Create: `docs/superpowers/reports/phase-3-validation.md`

- [ ] **Step 1: Run every synthetic policy story**

For each policy, drive one denial, one successful simulated lifecycle, one postcondition failure/rollback, one rollback failure/circuit, cooldown, and restart persistence. Assert no live PowerShell policy script is invoked.

- [ ] **Step 2: Prove migration/default state**

Open a fresh and upgraded temp DB and assert all four conditional policies `enabled=0`, no pending intents, workload allowlist empty, and global reboot policy `never`.

- [ ] **Step 3: Run full source gates**

Run: `npx vitest run tests/main/machinePolicies.e2e.test.ts && npm run verify:source`

- [ ] **Step 4: Record evidence and commit**

```powershell
git add tests/main/machinePolicies.e2e.test.ts docs/superpowers/reports/phase-3-validation.md
git commit -m "test: validate disabled machine policies"
```
