# PCDoctor Phase 1 Health Sentinel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace replayed scan history with real five-minute observations, durable incidents, incremental event evidence, and truthful reports.

**Architecture:** A one-shot PowerShell 5.1 collector emits versioned JSON without mutation. An owned recursive scheduler persists each run and normalized metrics transactionally, then pure TypeScript rules compute incident transitions. Reporting and retention are separate bounded modules; status reads remain side-effect-free.

**Tech Stack:** TypeScript, PowerShell 5.1, `better-sqlite3`, Vitest fake timers, Electron main lifecycle, React Dashboard.

## Global Constraints

- Sentinel performs no repair, termination, reconfiguration, update, cleanup, or reboot.
- A valid sustained sequence is three real samples spanning at least ten minutes with no adjacent gap over 7.5 minutes.
- Capture timestamps come from the collector and are never replaced by renderer/read timestamps.
- Missing data is `null` plus a warning; it is never converted to zero or healthy.
- Process slope identity is normalized executable path, PID, and start time.
- Raw command lines, environment variables, document names, URLs, and file contents are never collected.
- `maintenance_global_enabled` remains `0`.

---

## File structure

- Create `src/shared/sentinelTypes.ts`: collector/run/incident/report/summary contracts.
- Create `powershell/Get-HealthSentinelSample.ps1`: bounded five-minute sample collector.
- Create `powershell/Get-HealthSentinelEvents.ps1`: cursor-based allowlisted event collector.
- Create `src/main/sentinelStore.ts`: Sentinel persistence and retention.
- Create `src/main/healthSentinelRules.ts`: pure rules and transitions.
- Create `src/main/healthSentinel.ts`: scheduler/lifecycle and collection orchestration.
- Create `src/main/sentinelReports.ts`: atomic JSON/Markdown reports.
- Create `src/main/sentinelIpc.ts`: bounded Sentinel IPC registrar.
- Create `src/renderer/components/dashboard/HealthSentinelPanel.tsx`: compact status/evidence surface.
- Create `scripts/repair-legacy-metrics.ps1`: backup, classify, bounded cleanup, verification.
- Modify `src/main/dataStore.ts`, `src/main/pcdoctorBridge.ts`, `src/main/main.ts`, `src/main/ipc.ts`, `src/preload/preload.ts`, `src/shared/types.ts`, and Dashboard composition.

### Task 1: Versioned sample contract and read-only PowerShell collector

**Files:**
- Create: `src/shared/sentinelTypes.ts`
- Create: `powershell/Get-HealthSentinelSample.ps1`
- Create: `tests/main/healthSentinelSample.contract.test.ts`
- Create: `scripts/test-health-sentinel-sample.ps1`
- Modify: `scripts/test-ps51-syntax.ps1`

**Interfaces:**
- Produces: `SentinelSampleV1` with `schema_version: 1`, `capture_id`, `captured_start_utc`, `captured_end_utc`, `duration_ms`, `host`, `memory`, `cpu`, `volumes`, `processes`, `workload_groups`, and `warnings`.

- [ ] **Step 1: Write schema and privacy tests**

Parse a fixture through `parseSentinelSample(raw: unknown)` and assert unsupported version, missing capture time, negative byte count, duplicate process identity, and sensitive fields are rejected. Assert zero-capacity/non-ready volumes are excluded.

```ts
expect(() => parseSentinelSample({ schema_version: 2 })).toThrow(/unsupported schema/i);
expect(valid.memory.available_bytes).toBeGreaterThanOrEqual(0);
expect(JSON.stringify(valid)).not.toMatch(/command_line|environment|document|browser_url/i);
```

- [ ] **Step 2: Run contract tests and verify RED**

Run: `npx vitest run tests/main/healthSentinelSample.contract.test.ts`

- [ ] **Step 3: Implement exact shared types and parser**

Use nullable numeric fields and explicit warnings:

```ts
export interface SentinelProcessV1 {
  name: string;
  executable_path: string | null;
  pid: number;
  start_time_utc: string;
  working_set_bytes: number | null;
  private_bytes: number | null;
  cpu_100ns: number | null;
  handle_count: number | null;
  io_bytes: number | null;
}
```

The parser validates RFC3339 UTC timestamps, end after start, nonnegative counters, and a 30-second maximum capture duration.

- [ ] **Step 4: Implement the read-only collector**

Use CIM/performance counters only. Enumerate `Win32_OperatingSystem`, `Win32_PerfFormattedData_PerfOS_Memory`, `Win32_PerfFormattedData_PerfOS_Processor`, ready fixed volumes with positive capacity, and selected processes. Hash no content and read no command lines. Catch per-domain failures into `warnings`; fail the entire process only when timestamps/host/memory cannot be produced.

Return UTF-8 JSON on stdout and diagnostics on stderr. Accept only `-JsonOutput`; no path or command parameters.

- [ ] **Step 5: Prove the collector contract and non-mutation**

`scripts/test-health-sentinel-sample.ps1` runs under Windows PowerShell 5.1, times execution, parses JSON, checks the schema, and scans the collector AST for mutating cmdlets including `Set-*`, `Remove-*`, `Restart-*`, `Stop-*`, `Start-Service`, `Invoke-Expression`, `schtasks`, `wevtutil sl`, `DISM`, and `shutdown`.

Run: `powershell.exe -ExecutionPolicy Bypass -File scripts/test-health-sentinel-sample.ps1`

Expected: PASS in under 30 seconds.

- [ ] **Step 6: Commit**

```powershell
git add src/shared/sentinelTypes.ts powershell/Get-HealthSentinelSample.ps1 tests/main/healthSentinelSample.contract.test.ts scripts/test-health-sentinel-sample.ps1 scripts/test-ps51-syntax.ps1
git commit -m "feat: add read-only sentinel sample collector"
```

### Task 2: Transactional Sentinel schema and repository

**Files:**
- Modify: `src/main/dataStore.ts`
- Create: `src/main/sentinelStore.ts`
- Create: `tests/main/sentinelStore.test.ts`
- Modify: `tests/main/dataStoreMigrations.test.ts`

**Interfaces:**
- Produces: `insertSentinelRun(input): { runId: string; transitions: IncidentTransition[] }`.
- Produces: `loadRecentSamples(sinceMs)`, `loadOpenIncidents()`, `saveReport()`, `pruneSentinelData(nowMs)`.

- [ ] **Step 1: Write new/existing-database migration tests**

Assert creation of `sentinel_runs`, `sentinel_incidents`, `sentinel_reports`, and `sentinel_event_cursors`; foreign keys/indexes; duplicate capture prevention; and atomic rollback when metric insertion fails.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/main/sentinelStore.test.ts tests/main/dataStoreMigrations.test.ts`

- [ ] **Step 3: Add migration version 1**

Create tables with bounded state checks. `sentinel_runs.capture_id` is unique. Add `metrics.source TEXT NOT NULL DEFAULT 'legacy'` and `metrics.capture_id TEXT NULL`, plus an index on `(source, ts)` and a unique partial index on `(capture_id, category, metric, COALESCE(label,''))` for non-null capture IDs.

- [ ] **Step 4: Implement repository transactions**

On a valid run, insert the run and its normalized metrics using the collector capture time in one transaction. Store only bounded payload JSON. Apply incident transitions in that same transaction. Expose queries that return typed rows rather than raw `any`.

- [ ] **Step 5: Implement retention**

Delete at most 5,000 eligible rows per invocation. Preserve evidence referenced by open incidents. Retain raw samples 90 days, incident evidence 180 days, incidents/daily reports 400 days, and weekly reports three years.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run tests/main/sentinelStore.test.ts tests/main/dataStoreMigrations.test.ts`

```powershell
git add src/main/dataStore.ts src/main/sentinelStore.ts tests/main/sentinelStore.test.ts tests/main/dataStoreMigrations.test.ts
git commit -m "feat: persist sentinel runs and incidents"
```

### Task 3: Remove read-side metric writes and repair legacy history safely

**Files:**
- Modify: `src/main/pcdoctorBridge.ts`
- Modify: `src/main/dataStore.ts`
- Modify: `tests/main/pcdoctorBridge.test.ts`
- Create: `tests/main/statusReadsArePure.test.ts`
- Create: `scripts/repair-legacy-metrics.ps1`
- Create: `scripts/test-legacy-metric-repair.ps1`

**Interfaces:**
- Produces: side-effect-free `getStatus()` and `refreshStatusCache()`.
- Produces: one-time repair result JSON containing input DB hash/size, backup hash/size, row counts by source/time range, deleted batches, and final integrity result.

- [ ] **Step 1: Write the purity regression test**

Call status retrieval 100 times against a fixed `latest.json`; compare `SELECT COUNT(*) FROM metrics` before and after. Expected delta is exactly zero.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/main/statusReadsArePure.test.ts`

Expected: FAIL because `pcdoctorBridge` calls `recordStatusSnapshot()`.

- [ ] **Step 3: Remove both status-path snapshot writes**

Remove the import and calls at the current `pcdoctorBridge.ts` snapshot locations. Temperature observations become part of real Sentinel samples or remain display-only until collected; renderer refresh never persists them.

- [ ] **Step 4: Build the offline repair script**

The script requires PCDoctor to be closed, resolves the exact database, checkpoints WAL, runs `PRAGMA integrity_check`, copies DB/WAL/SHM into a timestamped backup directory, hashes and reopens the copy, then marks all existing rows `source='legacy-replayed'`. It deletes only rows whose replay provenance is proven, in 5,000-row transactions, and writes an atomic result file. Any hash/integrity/count mismatch stops before deletion.

- [ ] **Step 5: Test only against a synthetic database**

Run: `powershell.exe -ExecutionPolicy Bypass -File scripts/test-legacy-metric-repair.ps1`

Expected: valid rows preserved, replay rows removed, backup reopens, source database integrity passes. Do not run the repair against the live database during implementation.

- [ ] **Step 6: Verify and commit**

```powershell
npx vitest run tests/main/statusReadsArePure.test.ts tests/main/pcdoctorBridge*.test.ts
git add src/main/pcdoctorBridge.ts src/main/dataStore.ts tests/main/statusReadsArePure.test.ts tests/main/pcdoctorBridge.test.ts scripts/repair-legacy-metrics.ps1 scripts/test-legacy-metric-repair.ps1
git commit -m "fix: make status reads telemetry-pure"
```

### Task 3A: Correct legacy scanner data-quality classifications

**Files:**
- Modify: `powershell/Invoke-PCDoctor.ps1`
- Modify: `src/main/pcdoctorBridge.ts`
- Modify: `src/shared/types.ts`
- Create: `scripts/test-scanner-quality.ps1`
- Create: `tests/main/pcdoctorBridge.quality.test.ts`

**Interfaces:**
- Produces per-collector `quality: success|partial|failure`, capture time, warnings, and event-count `truncated` flags.
- Zero-capacity/non-ready volume objects are omitted or rendered unknown, never critically full.

- [ ] **Step 1: Write scanner fixture tests**

Use fixtures for B:/H: zero-size fixed objects, an inaccessible volume, 499/500/>500 event results, a failed collector, `NOT RUNNING` service text, and an unknown overall state. Assert no false critical storage, capped counts disclose truncation, service counts use anchored status, and unknown/failure maps to degraded/unknown rather than good.

- [ ] **Step 2: Verify RED**

Run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/test-scanner-quality.ps1
npx vitest run tests/main/pcdoctorBridge.quality.test.ts
```

- [ ] **Step 3: Fix PowerShell output semantics**

Filter volumes unless capacity is positive and readiness is proven. For capped event queries, emit `{ count, limit: 500, truncated: count -eq 500 }` rather than representing the value as a complete seven-day total. Add per-section quality/warnings/capture time in the JSON report.

- [ ] **Step 4: Fix TypeScript classification**

Map missing/unknown/failed data to `unknown` or warning/degraded. Anchor service-running checks to the structured status value instead of `/run/i`. Preserve backward compatibility for old reports but label their collector quality unknown.

- [ ] **Step 5: Verify and commit**

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/test-scanner-quality.ps1
npx vitest run tests/main/pcdoctorBridge.quality.test.ts tests/main/pcdoctorBridge*.test.ts
git add powershell/Invoke-PCDoctor.ps1 src/main/pcdoctorBridge.ts src/shared/types.ts scripts/test-scanner-quality.ps1 tests/main/pcdoctorBridge.quality.test.ts
git commit -m "fix: expose scanner data quality accurately"
```

### Task 4: Pure sustained rules and deterministic incident transitions

**Files:**
- Create: `src/main/healthSentinelRules.ts`
- Create: `tests/main/healthSentinelRules.test.ts`
- Create: `tests/main/fixtures/sentinelSamples.ts`

**Interfaces:**
- Produces: `evaluateSentinelRules(input: RuleEvaluationInput): IncidentTransition[]`.
- Produces: stable keys `ruleId:subjectIdentity` and transitions `open|update|escalate|resolve`.

- [ ] **Step 1: Write boundary-first tests**

Cover exactly 9:59 versus 10:00 span, 7:30 versus 7:31 adjacent gap, missing sample values, sleep gap, duplicate/out-of-order time, PID reuse, executable change, process restart, negative counter delta, memory recovery hysteresis, zero-capacity volumes, and deduplicated event keys.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/main/healthSentinelRules.test.ts`

- [ ] **Step 3: Implement pure sequence helpers**

Implement `selectValidWindow`, `sameProcessIdentity`, `perHourSlope`, and `transitionIncident` without database/time/global imports. Inject `nowMs` through the input.

- [ ] **Step 4: Implement initial rules**

- Memory: committed at least 90% and available below 1 GiB for the valid three-sample window.
- Wave Link: same-process handle slope at least 5,000/hour over a valid window.
- EaseUS: same-process growth plus a 10,000-handle high-water condition.
- Storage: ready fixed positive-capacity volumes only.
- Reliability: stable allowlisted event provider/channel/event/record identity.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/main/healthSentinelRules.test.ts`

```powershell
git add src/main/healthSentinelRules.ts tests/main/healthSentinelRules.test.ts tests/main/fixtures/sentinelSamples.ts
git commit -m "feat: evaluate sustained sentinel incidents"
```

### Task 5: Owned scheduler, event cursors, reports, and lifecycle

**Files:**
- Create: `src/main/healthSentinel.ts`
- Create: `src/main/sentinelReports.ts`
- Create: `powershell/Get-HealthSentinelEvents.ps1`
- Create: `tests/main/healthSentinel.scheduler.test.ts`
- Create: `tests/main/sentinelReports.test.ts`
- Create: `scripts/test-health-sentinel-events.ps1`
- Modify: `src/main/main.ts`
- Modify: `src/shared/task-manifest.json`
- Modify: `powershell/Invoke-WeeklyReview.ps1`

**Interfaces:**
- Produces: `startHealthSentinel(deps?)`, `stopHealthSentinel()`, `requestSentinelSample(trigger)`, `getSentinelSummary()`.

- [ ] **Step 1: Write fake-timer scheduler tests**

Assert recursive scheduling after completion, one in-flight sample, 30-second timeout, failure recovery, startup stale/fresh behavior, manual coalescing, shutdown-owned-process termination, and coverage-gap recording.

- [ ] **Step 2: Implement owned lifecycle**

Use one recursive `setTimeout`; schedule the next five-minute delay after the attempt settles. Inject clock, collector, store, notifier, and report writer for tests. Track only the collector process Sentinel owns.

- [ ] **Step 3: Add the 30-minute event cursor probe**

The script accepts only a fixed bundled allowlist and typed cursor JSON, queries after the stored record ID, caps results, returns `truncated`, and detects cleared/wrapped logs. It never requests full XML by default.

- [ ] **Step 4: Implement atomic reports**

Write paired JSON/Markdown under `C:\ProgramData\PCDoctor\reports\sentinel` via temporary file, flush, rename. Daily and weekly reports include successful/failed samples, coverage percentage, gaps, incident transitions, event truncation, and maintenance-disabled state.

Replace `Invoke-WeeklyReview.ps1` with a compatibility reader/launcher for the durable Sentinel weekly report; it must not claim historical analysis from only `latest.json`. Activate the coverage-aware weekly report in the task manifest only after its idempotency test passes.

- [ ] **Step 5: Wire startup/shutdown**

Start after DB/notifier/tray initialization and stop/await before `closeDb()` or app quit. Replace anonymous Sentinel timers with owned stop methods.

- [ ] **Step 6: Verify and commit**

```powershell
npx vitest run tests/main/healthSentinel.scheduler.test.ts tests/main/sentinelReports.test.ts
powershell.exe -ExecutionPolicy Bypass -File scripts/test-health-sentinel-events.ps1
node scripts/generate-task-manifest.mjs
node scripts/generate-task-manifest.mjs --check
npm run typecheck
git add src/main/healthSentinel.ts src/main/sentinelReports.ts powershell/Get-HealthSentinelEvents.ps1 powershell/Invoke-WeeklyReview.ps1 src/shared/task-manifest.json powershell/task-manifest.json tests/main scripts/test-health-sentinel-events.ps1 src/main/main.ts
git commit -m "feat: run sentinel lifecycle and reports"
```

### Task 6: Typed IPC and compact Dashboard panel

**Files:**
- Create: `src/main/sentinelIpc.ts`
- Create: `src/renderer/components/dashboard/HealthSentinelPanel.tsx`
- Create: `tests/renderer/HealthSentinelPanel.test.tsx`
- Create: `tests/main/sentinelIpc.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/pages/Dashboard.tsx`

**Interfaces:**
- Produces IPC: `api:getSentinelSummary`, `api:sampleSentinelNow`, `api:openSentinelReport`.
- Renderer may request only `scheduled|manual`; it cannot submit samples, paths, rules, or scripts.

- [ ] **Step 1: Write IPC input and panel-state tests**

Cover running/stopped, no sample, partial sample, stale sample, gap, open incident severities, report link, sample coalesced, and invalid report ID/path refusal.

- [ ] **Step 2: Implement bounded IPC registrar**

Keep handlers out of the 1,800-line `ipc.ts`; call `registerSentinelIpc()` from it. Resolve report IDs through the database and open only paths beneath the fixed Sentinel report root.

- [ ] **Step 3: Implement the panel**

Show last real capture, next attempt, 24-hour coverage, open incident count/severity, latest report, and `Sample now`. Label stale/unknown data as such. Do not add a repair/action button.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/main/sentinelIpc.test.ts tests/renderer/HealthSentinelPanel.test.tsx
npm run typecheck
git add src/main/sentinelIpc.ts src/renderer/components/dashboard/HealthSentinelPanel.tsx tests/main/sentinelIpc.test.ts tests/renderer/HealthSentinelPanel.test.tsx src/shared/types.ts src/main/ipc.ts src/preload/preload.ts src/renderer/pages/Dashboard.tsx
git commit -m "feat: surface sentinel health evidence"
```

### Task 7: Phase 1 synthetic exit gate

**Files:**
- Create: `tests/main/healthSentinel.e2e.test.ts`
- Create: `docs/superpowers/reports/phase-1-validation.md`

- [ ] **Step 1: Drive the complete synthetic story**

Fixture order: normal samples, missing sample, valid threshold breach, incident open, update without duplicate notification, escalation, sleep gap, recovery, resolve, daily report, weekly report, and retention. Assert no action runner or mutation script is called.

- [ ] **Step 2: Run full gates**

```powershell
npx vitest run tests/main/healthSentinel.e2e.test.ts
npm run verify:source
```

- [ ] **Step 3: Record evidence and commit**

Record test output, collector duration, schema version, migration version, synthetic metrics delta from 100 status reads (`0`), and `maintenance_global_enabled=0`.

```powershell
git add tests/main/healthSentinel.e2e.test.ts docs/superpowers/reports/phase-1-validation.md
git commit -m "test: validate trusted sentinel pipeline"
```
