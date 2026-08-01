# PCDoctor Health Sentinel Design

**Date:** 2026-08-01

**Status:** Approved concept; written specification awaiting final review

**Scope:** Read-only, continuous health monitoring inside PCDoctor Workbench

## Purpose

PCDoctor Workbench currently combines interactive diagnostics, scheduled scans, historical metrics, notifications, and guarded repair actions. Its existing history path repeatedly records values from the most recent static scan whenever the renderer asks for status, so the resulting time series does not reliably represent observations made at those timestamps.

Health Sentinel will add trustworthy low-overhead monitoring for a PC that normally runs continuously. It will collect a small sample every five minutes while PCDoctor Workbench is running, evaluate sustained-risk rules, persist incident evidence, generate daily and weekly reports, and notify only on meaningful state transitions. It will not repair, terminate, reconfigure, update, or reboot anything.

## Success criteria

1. A successful five-minute sample is a real observation taken at its stored timestamp, not a replay of a prior scan.
2. Only one collection can be in flight, collection is time-bounded, and an individual failure does not stop future sampling.
3. Sustained alerts require three valid samples spanning at least ten minutes, with no adjacent gap over 7.5 minutes.
4. Alerts open, escalate, and resolve deterministically; repeated samples do not produce notification spam.
5. Process growth is calculated only across observations of the same process identity: executable identity, PID, and start time.
6. Reports are written atomically and explicitly disclose missing monitoring coverage.
7. Existing daily, weekly, monthly, security, media, network, and repair workflows remain unchanged.
8. Unit, integration, PowerShell-contract, performance, and synthetic end-to-end tests pass before packaging.

## Non-goals

- No Windows service, additional Scheduled Task, kernel driver, always-elevated helper, or hidden background executable.
- No automatic remediation or action buttons in Sentinel notifications.
- No replacement of the existing daily, weekly, monthly, Defender, or deep-scan workflows.
- No attempt to solve the motherboard's 32 GB RAM limitation or revisit the resolved CPU thermal-paste work.
- No full event-log scan every five minutes.
- No remote telemetry, cloud database, or upload of health samples.
- No public release, installation, or updater publication as part of the implementation approval. Those are separate release decisions.

## Runtime architecture

### Ownership and lifecycle

The Electron main process owns Sentinel because PCDoctor Workbench already runs in the system tray and starts with Windows. Sentinel starts after the main process has initialized its database, notification manager, and tray lifecycle. It stops during application shutdown.

The runtime is divided into these modules:

- `powershell/Get-HealthSentinelSample.ps1`: one-shot, read-only Windows collector that emits one versioned JSON document.
- `src/main/healthSentinel.ts`: lifecycle, scheduling, timeouts, collection orchestration, persistence, rule evaluation, retention, and report triggers.
- `src/main/healthSentinelRules.ts`: pure functions that convert ordered samples and prior incident state into deterministic transitions.
- `src/main/dataStore.ts`: transactional sample, normalized metric, incident, report, retention, and query operations.
- Existing notification code: delivers deduplicated open and escalation notices, respecting configured quiet hours and optional Telegram delivery.
- Existing IPC/preload/type layers and Dashboard: expose only a compact status summary and an explicit manual `sample now` request.

Closing PCDoctor Workbench stops collection. The next startup records the resulting interval as a coverage gap; it does not fabricate samples. Sentinel will not create another persistence mechanism merely to conceal that gap.

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

## Incident and notification behavior

Transitions are `open`, `update`, `escalate`, and `resolve`. Notifications are sent for `open` and `escalate` only. Routine `update` and `resolve` events are recorded and shown in reports but do not create repeated pop-ups by default.

Notification event keys are stable across restarts and include the rule, subject identity, transition class, and severity. The existing notification log and quiet-hour behavior provide a second deduplication layer. Optional Telegram delivery uses the same event key. Notices contain observations and suggested manual investigation only; there are no repair or process-termination buttons.

## Reports and retention

Reports are written beneath `C:\ProgramData\PCDoctor\reports\sentinel` as paired JSON and Markdown files. A temporary file is written, flushed, and atomically renamed so an interrupted write cannot leave a plausible but truncated report.

Daily reports summarize sample coverage, failed runs, min/max/average selected metrics, incident transitions, significant event evidence, and monitoring gaps. Weekly reports summarize trends and daily coverage without inventing missing data.

On startup, Sentinel generates a missing previous-day or previous-week report only when the database contains relevant real observations and no matching report hash. Gaps are disclosed. Catch-up is bounded; it does not generate an unlimited historical backlog.

Default retention is:

- raw sample payloads: 90 days;
- referenced incident evidence: 180 days;
- incident records and daily reports: 400 days;
- weekly reports: three years.

Pruning is transactional, bounded, and never removes evidence still needed by a retained open incident.

## Dashboard and IPC

The Dashboard receives a compact, read-only Sentinel summary:

- running/stopped state and next scheduled attempt;
- last successful sample and last attempt result;
- coverage over the last 24 hours;
- number and severity of open incidents;
- links or commands to view the latest reports;
- an explicit `Sample now` control.

IPC handlers validate inputs and return typed results. The renderer cannot provide arbitrary scripts, commands, paths, SQL, rule expressions, or PowerShell arguments. No remediation control is added.

## Error handling and observability

- Collector timeout: terminate the owned collector process, save a timeout run, continue scheduling.
- Invalid JSON or unsupported schema: save a schema error without persisting fabricated metrics.
- Partial sample: retain valid fields and warnings; rules needing missing fields do not evaluate true.
- Database transaction failure: do not notify; log a bounded local error and retry only on a later normal run.
- Report-write failure: keep database state, record failure, and retry idempotently.
- Notification failure: retain incident state and event key so delivery can be retried without reopening the incident.
- Clock or sleep gap: record coverage loss and reset sustained windows.
- Shutdown: stop new scheduling and terminate only a collector process owned by Sentinel after a short grace period.

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

### Database integration tests

- migrations on a new and representative existing database;
- atomic insertion of a run, normalized metrics, and transitions;
- duplicate prevention, restart recovery, queries, report idempotency, and retention;
- proof that status reads no longer increase the metrics row count.

### PowerShell tests

- schema and type contract on Windows PowerShell 5.1;
- explicit null/partial behavior;
- exclusion of zero-capacity volumes and sensitive data;
- execution-time budget;
- static rejection of mutating cmdlets in the collector.

### End-to-end synthetic test

A deterministic fixture drives normal samples, threshold breach, incident opening, escalation, recovery, resolution, deduplicated notification attempts, daily report creation, and gap disclosure. Production Windows state is not modified by this test.

## Security and privacy

Sentinel runs with the same standard-user context as the tray application and does not request elevation. It launches only the bundled collector by a resolved application path with fixed arguments. PowerShell execution is non-interactive and time-limited.

Database and report files remain local under existing PCDoctor-controlled data locations. Stored process data excludes command lines and user content. Error and notification text is sanitized and bounded. Existing repair actions and their elevation boundaries are untouched.

## Packaging and release boundary

Implementation completion means the source changes, tests, type checks, PowerShell 5.1 checks, production build, package validation, and installer creation all pass. It does not mean the installer is automatically installed or published.

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

Sentinel can be disabled at application startup without deleting its data. A rollback build ignores the added tables safely. Rollback does not attempt to reverse already-created reports or discard incident history. No repair or machine configuration requires reversal because collection is read-only.
