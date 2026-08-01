# PCDoctor Health Sentinel and Maintenance Orchestrator Design

**Date:** 2026-08-01

**Status:** Revised concept approved; written specification awaiting final review

**Scope:** Trustworthy continuous health monitoring plus centrally gated, evidence-driven scheduled maintenance

## Purpose

PCDoctor Workbench currently combines interactive diagnostics, scheduled scans, historical metrics, notifications, and guarded repair actions. Its existing history path repeatedly records values from the most recent static scan whenever the renderer asks for status, so the resulting time series does not reliably represent observations made at those timestamps. Its scheduled and adaptive Autopilot paths also form two separate control planes: scheduled tasks can invoke remediation scripts without consulting database rule state or the central action catalog's confirmation and rollback metadata.

Health Sentinel will add trustworthy low-overhead monitoring for a PC that normally runs continuously. It will collect a small sample every five minutes while PCDoctor Workbench is running, evaluate sustained-risk rules, persist incident evidence, generate daily and weekly reports, and notify only on meaningful state transitions. Sentinel itself remains read-only.

A separate Maintenance Orchestrator will consume durable, confirmed incidents and scheduled policy intents. It may request only explicitly allowlisted actions after central automation policy, maintenance-window, load, idle, cooldown, rollback, and preflight gates pass. It will verify the exact postcondition, record every mutation, and trip a circuit breaker rather than repeatedly retrying. This machine's reboot policy is immutable `never` unless Greg directly authorizes a specific reboot operation.

## Success criteria

1. A successful five-minute sample is a real observation taken at its stored timestamp, not a replay of a prior scan.
2. Only one collection can be in flight, collection is time-bounded, and an individual failure does not stop future sampling.
3. Sustained alerts require three valid samples spanning at least ten minutes, with no adjacent gap over 7.5 minutes.
4. Alerts open, escalate, and resolve deterministically; repeated samples do not produce notification spam.
5. Process growth is calculated only across observations of the same process identity: executable identity, PID, and start time.
6. Reports are written atomically and explicitly disclose missing monitoring coverage.
7. Every scheduled or adaptive mutation passes one central default-deny automation policy; direct Scheduled Task execution cannot bypass it.
8. Disabling or snoozing a policy stops its corresponding scheduled and adaptive execution.
9. Destructive, rebooting, user-data-deleting, session-terminating, or rollback-unproven actions cannot run automatically.
10. Automatic actions require preflight, one-flight/resource locks, cooldown, bounded retries, exact postcondition verification, and durable evidence.
11. Existing useful diagnostic and security workflows are preserved through a single task manifest, while unsafe or orphaned schedules are explicitly migrated.
12. User-context background tasks do not flash visible console windows.
13. Lint, typecheck, unit/integration tests, PowerShell-contract tests, packaging, native ABI checks, and installed smoke tests pass before release packaging is accepted.

## Non-goals

- No Windows service, additional Scheduled Task, kernel driver, always-elevated helper, or hidden background executable.
- No remediation directly from Sentinel rules or notifications; only the Maintenance Orchestrator may request an action.
- No general-purpose self-healing, arbitrary script execution, policy expressions, or AI-selected mutations.
- No replacement of the existing daily, weekly, monthly, Defender, or deep-scan workflows.
- No attempt to solve the motherboard's 32 GB RAM limitation or revisit the resolved CPU thermal-paste work.
- No full event-log scan every five minutes.
- No remote telemetry, cloud database, or upload of health samples.
- No automatic Wave Link/EaseUS product upgrade, Google Drive/Dokan migration, OEM audio/fan utility repair, driver/firmware update, threat deletion, recycle-bin deletion, DISM `/ResetBase`, or reboot-dependent security change.
- No inferred termination of Next.js, WSL, Docker, VM, Homebridge, Plex, media, or other workloads; graceful stopping requires an explicit per-workload allowlist.
- No public release, installation, or updater publication as part of the implementation approval. Those are separate release decisions.

## Runtime architecture

### Ownership and lifecycle

The Electron main process owns Sentinel and the Maintenance Orchestrator because PCDoctor Workbench already runs in the system tray and starts with Windows. Sentinel starts after the main process has initialized its database, notification manager, and tray lifecycle. The Orchestrator starts only after Sentinel, policy storage, and action safety enforcement are ready. Both stop during application shutdown.

The runtime is divided into these modules:

- `powershell/Get-HealthSentinelSample.ps1`: one-shot, read-only Windows collector that emits one versioned JSON document.
- `src/main/healthSentinel.ts`: lifecycle, scheduling, timeouts, collection orchestration, persistence, rule evaluation, retention, and report triggers.
- `src/main/healthSentinelRules.ts`: pure functions that convert ordered samples and prior incident state into deterministic transitions.
- `src/main/maintenanceOrchestrator.ts`: policy-intent lifecycle, resource locks, preflight, dry run, action dispatch, postcondition verification, cooldowns, and circuit breakers.
- `src/main/automationPolicy.ts`: pure default-deny policy evaluation for action classification, incident evidence, authorization, machine state, and reboot prohibition.
- `src/main/dataStore.ts`: transactional sample, normalized metric, incident, report, retention, and query operations.
- `src/shared/taskManifest.ts` plus a generated PowerShell representation: the single source for task identity, cadence, workload weight, execution context, visibility, and uninstall behavior.
- Existing notification code: delivers deduplicated open and escalation notices, respecting configured quiet hours and optional Telegram delivery.
- Existing action runner and elevated worker: enforce the same automation policy again at execution/elevation boundaries.
- Existing IPC/preload/type layers and Dashboard: expose a compact status summary, an explicit manual `sample now` request, policy state, execution evidence, and circuit-breaker status.

Closing PCDoctor Workbench stops collection. The next startup records the resulting interval as a coverage gap; it does not fabricate samples. Sentinel will not create another persistence mechanism merely to conceal that gap.

Adaptive maintenance pauses when Workbench is closed. Calendar-based read-only diagnostics may remain in Windows Task Scheduler for resilience. Scheduled mutations are migrated away from direct script invocation: they create a fixed-ID maintenance intent or are owned by the tray-resident Orchestrator. No Scheduled Task accepts an arbitrary script path.

### Scheduler behavior

The scheduler uses a recursive `setTimeout`, not `setInterval`, so a slow collection cannot overlap the next one. The next five-minute delay begins only after the current collection attempt has completed. At most one collection is in flight.

Each collection has a default 30-second hard timeout. A timeout or malformed payload produces a failed run record with sanitized diagnostic detail, after which normal scheduling continues. Failure backoff is bounded so the scheduler continues attempting recovery without entering a tight loop.

At startup, Sentinel reads the latest successful sample. If none exists or the newest sample is stale, it attempts one immediate sample. Otherwise it schedules the next sample relative to the newest valid observation. A user-triggered `sample now` request coalesces with an in-flight run and never creates concurrent PowerShell processes.

## Collector contract

The PowerShell collector returns UTF-8 JSON on stdout and diagnostic text only on stderr. Its schema includes:

- schema version, capture start/end UTC timestamps, duration, hostname, and collector version;
- physical memory totals, available bytes, committed bytes, commit limit, and derived percentages;
- CPU utilization and load data available from supported Windows counters;
- fixed local volume capacity, free bytes, and free percentage, excluding zero-capacity and non-ready volumes;
- selected process observations: name, normalized executable path when accessible, PID, start time, working set, private bytes, CPU time, and handle count;
- aggregate observations for configured workload groups;
- explicit partial-data warnings when permissions or transient Windows state prevent collection.

The payload is versioned so TypeScript can reject unsupported schemas instead of silently misreading them. Values that cannot be obtained are `null` with a warning; they are not converted to zero. Secrets, command lines, environment variables, document names, browser URLs, and file contents are excluded.

The collector performs no writes and invokes no repair cmdlets. A static test rejects known mutating cmdlets and a runtime contract test verifies that a sample completes within its budget on the supported Windows/PowerShell 5.1 environment.

## Event-log collection

Expensive Windows event inspection is decoupled from the five-minute sample. An incremental event probe runs approximately every 30 minutes and stores a per-channel record-ID cursor.

Only a strict allowlist of relevant providers and event IDs is queried, covering resource exhaustion, WHEA hardware errors, storage/controller faults, and unexpected application or system crashes. Query results are capped per run. If a log is cleared, wrapped, or replaced, the cursor is reset safely and the condition is recorded. Sentinel never rereads hundreds of megabytes merely because a cursor is invalid.

Event evidence uses timestamps, provider, event ID, channel, record ID, level, and a short sanitized summary. Full raw event XML is not retained by default.

## Persistence model

Database changes use the repository's migration mechanism and are transactional.

### `sentinel_runs`

Stores every scheduled or manual attempt:

- unique run ID and requested/captured UTC timestamps;
- trigger (`startup`, `scheduled`, or `manual`);
- result (`success`, `partial`, `timeout`, `collector_error`, or `schema_error`);
- duration and supported schema version;
- sanitized payload for successful or partial samples;
- bounded sanitized error metadata for failures.

A unique capture identity prevents duplicate insertion when the same result is retried.

### Normalized metrics

On a successful or partial valid run, supported numeric observations are added to the existing `metrics` history in the same database transaction as `sentinel_runs`. The metric timestamp is the collector's capture time. Renderer reads never create metrics.

The existing `recordStatusSnapshot()` side effect is removed from `pcdoctorBridge.getStatusInner`. Status retrieval remains read-only. Existing scanner output can still be displayed, but it is not relabeled as a fresh time-series observation.

### `sentinel_incidents`

Stores durable incident state:

- stable incident and rule keys;
- subject identity and current severity;
- opened, last-observed, escalated, resolved, and last-notified timestamps;
- peak values and compact evidence references;
- transition count and notification signature;
- current state (`open` or `resolved`).

Only one open incident exists for a stable rule/subject key. State transitions and sample persistence occur in one transaction so application failure cannot notify about an incident that was not saved.

### `sentinel_reports`

Stores report period, generated timestamp, coverage summary, file paths, content hash, and generation result. It makes catch-up generation idempotent.

### `maintenance_policies`

Stores the centrally enforced, versioned policy for each known automation:

- stable policy and action IDs plus an optional incident rule/subject match;
- automation classification (`never`, `safe`, or `conditional`) and enabled/snoozed state;
- maintenance window, idle/load requirements, cooldown, attempt limit, and resource locks;
- versioned preflight and postcondition gate IDs, rollback requirement, and fixed `rebootPolicy: never`;
- creator/updater identity and timestamps.

Policy records contain references to compiled, allowlisted gates and actions. They never contain executable code, arbitrary PowerShell, SQL, command arguments, or user-authored expressions. A missing, unknown, malformed, or stale policy is denied.

### `maintenance_intents` and `maintenance_runs`

An intent is a fixed-ID request produced by a confirmed incident, the task manifest, or an explicit manual operation. It stores the trigger, incident/policy/action references, request time, deduplication signature, and eligibility state.

A run stores requested, eligible, started, and completed timestamps; every gate result; dry-run and dispatch results; exact postcondition evidence; rollback evidence; and the terminal state (`skipped`, `succeeded`, `failed`, `rolled_back`, or `circuit_open`). `pending` and `running` are transient states recovered deterministically after a crash.

### `maintenance_locks`

Durable leases prevent overlapping actions globally and by named resource, such as `defender`, `storage-maintenance`, `easeus`, `audio`, or `scheduled-scan`. Leases record owner, acquisition, expiry, and heartbeat. Startup may expire an abandoned lease only after proving its owner process is gone and its grace period has elapsed.

## Rule engine

Rules are pure and accept ordered valid samples, incremental event evidence, configuration, and current incident state. They return transitions and evidence; they do not write to the database or send notifications.

### Sustained memory pressure

Open an incident when committed memory is at least 90% of the commit limit and physical available memory is below 1 GiB for three valid samples spanning at least ten minutes. Missing values break the sustained sequence. Severity may escalate when configured higher thresholds or continued duration are met. Resolution also requires a stable recovery window, preventing single-sample flapping.

### Process handle growth

Calculate slopes only for the same normalized executable identity, PID, and process start time. A PID reuse or restart begins a new series. Initial monitored subjects include Wave Link and EaseUS processes because the machine audit identified relevant historical behavior.

Rules distinguish a high current count from rapid growth. Wave Link growth above approximately 5,000 handles per hour across a valid observation window is alertable. EaseUS processes use both growth and an approximately 10,000-handle high-water signal. Exact thresholds are centralized, named, and unit-tested.

### Storage, reliability, and workload persistence

- Fixed-volume free-space rules ignore non-ready and zero-capacity entries and use separate warning/critical thresholds.
- Incremental allowlisted resource-exhaustion, WHEA, disk/controller, and crash events create or update incidents using stable event keys.
- Configured workload groups can flag abnormal overnight persistence or sustained unexpected resource use. A process's mere existence is not treated as proof of a problem.

### Timing validity

A sustained rule requires three valid samples spanning at least ten minutes with no adjacent gap above 7.5 minutes. Sleep, hibernation, app closure, timeout, malformed data, and missing required fields break continuity. Wall-clock discontinuities do not create artificial slopes.

## Maintenance Orchestrator

The Orchestrator is the only component allowed to request an automatic mutation. Sentinel rules remain read-only and can only create or update incidents.

The execution flow is:

1. A confirmed incident, manifest schedule, or explicit manual request creates a fixed-ID intent.
2. The central policy evaluator resolves the compiled action metadata and defaults to deny.
3. It evaluates enabled/snoozed state, evidence quality, maintenance window, machine idle/load state, cooldown, attempt budget, resource locks, reboot prohibition, and action-specific preflight.
4. The action's dry run must return a valid bounded plan matching the allowlisted action.
5. The existing action runner dispatches it, and the elevated worker independently revalidates the signed/capability-bound request when elevation is required.
6. The Orchestrator verifies the exact postcondition from a fresh observation, records the evidence, and resolves or annotates the incident.
7. Failure invokes at most one proven rollback. An unverified rollback, failed postcondition, repeated failure, or unexpected result opens the policy circuit breaker and requires manual review.

Every catalog action declares `automation`, `requiresRollback`, `resourceLocks`, `rebootPolicy`, preflight ID, postcondition ID, timeout, cooldown, and attempt limit. `automation: never` is the default. The evaluator and action runner reject old callers that omit this metadata. The elevated boundary enforces action ID and immutable arguments rather than trusting a user-writable script or queue payload.

No Windows Scheduled Task may directly invoke a mutating maintenance script. The single task manifest either runs a read-only diagnostic or submits a known intent ID through the authenticated application boundary. Database policy state controls both scheduled and incident-triggered paths, so disabling or snoozing a policy has immediate effect everywhere.

Task workload weights and resource locks stagger expensive jobs. Defender scans, DISM read-only health checks, PCDoctor deep scans, reporting, and maintenance never begin concurrently merely because calendar triggers align. Load, active-user, audio, backup, and other action-specific gates defer rather than force execution.

Existing tasks are migrated explicitly. Recycle-bin emptying, DISM `/ResetBase`, orphan feature tasks, WSL shutdown, broad process termination, and other actions without trusted telemetry or reversible postconditions are removed from automatic schedules or classified `never`. Interactive user-context tasks are registered with hidden-window execution. The same manifest drives registration, Dashboard state, repair, tests, and uninstall, including removal of legacy aliases.

## Machine-specific maintenance policies

The initial policy set reflects the confirmed findings on this PC and does not generalize them into broad system-cleanup authority.

### Safe automatic actions

- update Microsoft Defender definitions and run already-approved read-only Defender, SMART, reliability, and security checks;
- enforce PCDoctor's own database, report, log, and artifact retention after a backup/checkpoint and bounded dry run;
- stagger PCDoctor-owned scheduled work and defer heavy jobs while the machine is busy;
- generate daily/weekly reports and notify on failed or missing maintenance.

### Conditional automatic actions

- restart the EaseUS service/process group only after sustained same-process leak evidence, validated idle state, proof that no backup or recovery operation is active, cooldown, bounded attempts, and verified handle/memory recovery;
- restart Wave Link only in a configured quiet window after sustained same-process handle growth and proof that no active audio session depends on it; upgrading Wave Link remains the preferred manual correction;
- reapply the exact known SPP ACL repair only when the identical recurrence is proven and the expected ACL and service postconditions can be verified;
- gracefully stop a workload only when its exact executable/service identity is explicitly allowlisted and its workload-specific idle proof succeeds;
- repair event-log size drift only for an exact known channel/configuration pair with before/after verification.

Conditional policies ship disabled until their telemetry, preflight, postcondition, rollback, and synthetic tests pass. Enabling one is an explicit local policy choice, not an implication of installing the feature.

### Manual or notify-only actions

- Wave Link 3.1 migration and audio validation;
- EaseUS upgrade or long-running session rotation outside the narrow conditional restart policy;
- Google Drive/Dokan, Alienware Command Center/OCControl, SupportAssist, Nahimic, driver, firmware, and BIOS work;
- HVCI, Credential Guard, Defender Offline, and any security change requiring restart;
- threat deletion, user-data deletion, recycle-bin emptying, DISM `/ResetBase`, unapproved process termination, or any reboot;
- any action whose preflight, postcondition, rollback, signer verification, evidence freshness, or identity check fails.

## Incident and notification behavior

Incident transitions are `open`, `update`, `escalate`, and `resolve`. Notifications are sent for `open` and `escalate` only. Routine `update` and `resolve` events are recorded and shown in reports but do not create repeated pop-ups by default.

Notification event keys are stable across restarts and include the rule, subject identity, transition class, and severity. The existing notification log and quiet-hour behavior provide a second deduplication layer. Optional Telegram delivery uses the same event key.

Maintenance start, success, failure, rollback, and circuit-open events use separate stable keys. Automatic success is summarized rather than repeatedly popped up; failure, unverified state, and a newly opened circuit always appear in the Dashboard and the next report. A notification never substitutes for durable execution evidence.

## Reports and retention

Reports are written beneath `C:\ProgramData\PCDoctor\reports\sentinel` as paired JSON and Markdown files. A temporary file is written, flushed, and atomically renamed so an interrupted write cannot leave a plausible but truncated report.

Daily reports summarize sample coverage, failed runs, min/max/average selected metrics, incident transitions, significant event evidence, and monitoring gaps. Weekly reports summarize trends and daily coverage without inventing missing data.

On startup, Sentinel generates a missing previous-day or previous-week report only when the database contains relevant real observations and no matching report hash. Gaps are disclosed. Catch-up is bounded; it does not generate an unlimited historical backlog.

Default retention is:

- raw sample payloads: 90 days;
- referenced incident evidence: 180 days;
- incident records and daily reports: 400 days;
- weekly reports: three years.
- completed maintenance intents and run evidence: 400 days, with failures and rollback evidence retained as long as their incident;
- bounded application and maintenance logs: 30 days unless referenced by retained failure evidence.

Pruning is transactional, bounded, and never removes evidence still needed by a retained open incident.

Before replacing the existing synthetic metrics history, the implementation creates a verified database backup, marks or migrates trustworthy rows when provenance can be proven, and prunes replayed/static snapshots in bounded transactions. It records counts, time ranges, and hashes so the cleanup is auditable and reversible from the backup.

## Dashboard and IPC

The Dashboard receives a compact Sentinel and maintenance summary:

- running/stopped state and next scheduled attempt;
- last successful sample and last attempt result;
- coverage over the last 24 hours;
- number and severity of open incidents;
- links or commands to view the latest reports;
- an explicit `Sample now` control.
- known policy enabled/snoozed state and classification;
- last action, gate evidence, next eligibility, cooldown, and circuit-breaker state;
- manifest task health, including missing, drifted, or legacy tasks.

IPC handlers validate inputs and return typed results. The renderer cannot provide arbitrary scripts, commands, paths, SQL, rule expressions, action arguments, or PowerShell arguments. It may enable, disable, or snooze only a compiled known policy after the existing confirmation boundary. Manual execution uses a known action ID and existing confirmation/risk presentation; it does not expand automatic eligibility.

## Error handling and observability

- Collector timeout: terminate the owned collector process, save a timeout run, continue scheduling.
- Invalid JSON or unsupported schema: save a schema error without persisting fabricated metrics.
- Partial sample: retain valid fields and warnings; rules needing missing fields do not evaluate true.
- Database transaction failure: do not notify; log a bounded local error and retry only on a later normal run.
- Report-write failure: keep database state, record failure, and retry idempotently.
- Notification failure: retain incident state and event key so delivery can be retried without reopening the incident.
- Clock or sleep gap: record coverage loss and reset sustained windows.
- Shutdown: stop new scheduling and terminate only a collector process owned by Sentinel after a short grace period.
- Missing/stale/malformed policy or action metadata: deny the intent and record the exact gate failure.
- Failed preflight, idle/load proof, evidence freshness, dry run, or lock acquisition: skip or defer without mutation.
- Failed postcondition: attempt one rollback only when the action declares and proves a safe rollback, then open the circuit.
- Failed or unverified rollback: stop all further automatic attempts for that policy and require manual review.
- Application crash: recover transient intents and leases conservatively; never assume an interrupted mutation succeeded.
- Reboot request or reboot-required result: deny, open the circuit, and notify. The Orchestrator never schedules or initiates a reboot.

Logs must not contain full payloads, secret settings, Telegram tokens, environment variables, or user document data.

## Test strategy

Development follows strict test-driven development.

### TypeScript unit tests

- valid three-sample sustained windows and every boundary condition;
- missing values, duplicate timestamps, out-of-order data, stale data, sleep gaps, and clock discontinuities;
- PID reuse, process restart, executable identity changes, and handle-slope math;
- incident open/update/escalate/resolve behavior and stable notification signatures;
- storage exclusions and event cursor wrap/clear behavior;
- scheduler overlap prevention, timeout recovery, shutdown, startup catch-up, and manual-run coalescing.
- policy default-deny behavior and every `never`/`safe`/`conditional` boundary;
- immutable reboot denial, destructive/user-data/session action denial, evidence freshness, cooldown, attempt limits, and circuit breakers;
- resource locks, sleep/load/idle deferral, stale-lease recovery, and deterministic intent deduplication;
- action-specific fixtures for EaseUS, Wave Link, SPP ACL, event-log configuration, and allowlisted workloads.

### Database integration tests

- migrations on a new and representative existing database;
- atomic insertion of a run, normalized metrics, and transitions;
- duplicate prevention, restart recovery, queries, report idempotency, and retention;
- proof that status reads no longer increase the metrics row count.
- atomic policy, intent, run, lock, gate-evidence, rollback, and circuit-state persistence;
- proof that disabling or snoozing a policy blocks both scheduled and incident-triggered execution.

### PowerShell tests

- schema and type contract on Windows PowerShell 5.1;
- explicit null/partial behavior;
- exclusion of zero-capacity volumes and sensitive data;
- execution-time budget;
- static rejection of mutating cmdlets in the collector.
- task-manifest registration, repair, hidden-window settings, drift detection, and complete uninstall cleanup;
- rejection of scheduled mutation scripts and unknown intent IDs;
- exact preflight/postcondition contracts for each elevated conditional action.

### End-to-end synthetic test

A deterministic fixture drives normal samples, threshold breach, incident opening, escalation, recovery, resolution, deduplicated notification attempts, daily report creation, and gap disclosure. A second fixture drives policy gating, dry run, one successful action, postcondition failure, rollback, circuit opening, cooldown, and disabled-policy behavior. Production Windows state is not modified by these tests.

### Build, package, and installed tests

- ESLint uses a checked-in configuration compatible with the installed major version and passes with no ignored configuration error;
- tests run against the packaged Electron-compatible native ABI rather than silently skipping database failures;
- CI performs clean install, lint, typecheck, unit/integration/PowerShell tests, build, package inspection, and installer smoke tests;
- the installer creates every manifest task, the app observes their true state, user-context tasks remain hidden, and uninstall removes current and legacy task identities;
- no test may convert a native-module load failure into a passing or skipped safety assertion.

## Security and privacy

Sentinel runs with the same standard-user context as the tray application and does not request elevation. It launches only the bundled collector by a resolved application path with fixed arguments. PowerShell execution is non-interactive and time-limited.

Database and report files remain local under existing PCDoctor-controlled data locations. Stored process data excludes command lines and user content. Error and notification text is sanitized and bounded. Existing repair actions remain manually available where appropriate, but every execution path adopts the centralized policy metadata and hardened elevation boundary before automation is enabled.

The elevated worker is hardened before automatic mutation is enabled. Requests use per-session, short-lived capability material; authenticated envelopes bind action ID, immutable arguments, nonce, issue/expiry time, and requesting process/session. Queue ACLs restrict writers, replay is rejected, and the elevated boundary independently loads the compiled action policy. User-writable queue contents alone never authorize execution.

Bundled or downloaded tools require pinned hashes and expected publisher/signature verification before use. Release artifacts disclose signing state; an unsigned development build cannot silently become an automatic maintenance release.

## Implementation phases

### Phase 0: safety and release gates

Repair lint/test/native-ABI execution, add clean CI, create the single task manifest, migrate/remove unsafe legacy tasks, eliminate console flashes, centralize default-deny action metadata, and harden the elevated request boundary. Verify that no scheduled or adaptive caller can bypass policy before enabling any automatic mutation.

### Phase 1: trusted monitoring and data repair

Implement the one-shot collector, Sentinel runtime, pure rules, incident/report persistence, retention, event cursors, and Dashboard status. Remove read-side metric writes, back up the database, migrate/prune synthetic history, and prove real capture timestamps and coverage behavior.

### Phase 2: safe maintenance foundation

Implement intents, runs, locks, preflight/dry-run/postcondition/rollback handling, cooldowns, circuit breakers, notifications, and safe automatic policies for PCDoctor-owned retention, schedule staggering, reports, Defender definitions, and read-only checks.

### Phase 3: machine-specific conditional policies

Add EaseUS first, then optional Wave Link, exact SPP ACL, event-log configuration, and workload policies one at a time. Each remains disabled until its telemetry, identity, idle/load proof, postcondition, rollback, and fixtures pass. A failure stops that policy's rollout without blocking the safe foundation.

### Phase 4: release hardening

Run the full validation matrix, inspect the packaged installer and generated task manifest, perform a controlled installed smoke test, document signing and rollback, and stop at the separate publish/install authorization gate.

## Packaging and release boundary

Implementation completion means the source changes, lint, tests, type checks, PowerShell 5.1 checks, native ABI checks, clean CI, production build, package validation, and installer creation all pass. It does not mean the installer is automatically installed or published.

After implementation validation, release work is a separate explicit gate:

1. review the exact diff and validation results;
2. update version and release notes;
3. build the Windows installer and updater metadata using the existing Electron Builder pipeline;
4. validate artifacts and signing state;
5. publish a GitHub Release only when authorized;
6. let the installed app discover the release or install the approved artifact;
7. verify the installed version, process health, database migration, sampling, reports, and rollback path.

The existing untracked `.claude/` directory is outside scope and must not be included in commits or release artifacts.

## Rollback

Sentinel and the Orchestrator have separate global kill switches. Disabling the Orchestrator cancels pending intents, prevents new automatic dispatch, and leaves evidence intact; it does not interrupt an in-flight Windows operation unsafely. Conditional policies default disabled after a rollback or incompatible policy version.

Database migrations remain forward-compatible with the prior application, and a verified pre-migration backup is retained through installed validation. A rollback build ignores added tables safely. Reports and incident/maintenance history remain available for audit.

Every automatically eligible mutation has an action-specific reversal or a proven idempotent recovery path. If that cannot be proven, the action is `never` automatic. Rollback never schedules a reboot, deletes user data, restores arbitrary registry snapshots, or guesses at machine state.
