# Task 4 Report: Authenticate and Constrain the Elevated Worker Boundary

## Status

IMPLEMENTED AND VERIFIED, WITH A DELIBERATE FAIL-CLOSED DEPLOYMENT DEPENDENCY

Commit subject: `security: authenticate elevated worker commands`

Task 4 code is complete and the safe verification matrix passes. The current
`C:\ProgramData\PCDoctor` Tier-A layout is intentionally rejected by the new
code-trust proof because its owner and effective ACL permit untrusted replacement.
Phase 0 is not releasable until a later installer task provisions the fixed worker
and action payload beneath an administrator-protected immutable boundary. Manual
worker actions must be restored through that installer change before Phase 0 exit.

## Success criteria

1. Create a per-session 32-byte capability and keep it out of commands, arguments,
   logs, and the parent environment.
   Verify: boundary tests inspect the exact child environment and launch command.
2. Sign and authenticate exact V2 commands, heartbeats, and results using canonical
   UTF-8 JSON and HMAC-SHA256.
   Verify: literal cross-language fixtures and both-shell smoke tests.
3. Reject wrong sessions, expired or future envelopes, excessive lifetimes, replay,
   malformed schemas, unknown actions or parameters, automatic authority, and all
   reboot or shutdown actions.
   Verify: Node boundary cases plus independent PowerShell validation.
4. Restrict the queue to the current user, Administrators, and SYSTEM with a
   protected exact DACL, and fail closed if the proof changes.
   Verify: queue proof tests and independent worker ACL checks.
5. Execute only fixed ProgramData worker/action code that is protected from
   untrusted replacement.
   Verify: owner, DACL, reparse, path, file-set, and ancestor replacement proofs.
6. Replace generic action forwarding with an exact fixed map and trusted absolute
   executables.
   Verify: nine action-map cases and pure absolute `sc.exe` resolution.
7. Bound all reads, publish commands, heartbeats, and results atomically, and prevent
   rejected traffic from keeping the elevated worker alive.
   Verify: oversized, partial, concurrent heartbeat, replay, and backlog tests.
8. Exercise the worker without UAC or machine mutation.
   Verify: `-TestMode` accepts only a generated temp-only `test-echo` action.

## Implemented boundary

### Protocol module

`src/main/elevatedWorkerProtocol.ts` is a side-effect-free protocol boundary. It:

- snapshots JSON without invoking accessors or proxies;
- rejects cycles, symbols, sparse or extended arrays, non-plain objects, undefined,
  unsafe integers, negative zero, and lone UTF-16 surrogates;
- canonicalizes recursive object keys with ordinal UTF-16 ordering while preserving
  array order;
- signs UTF-8 canonical bytes with a 32-byte HMAC-SHA256 capability;
- validates exact command, heartbeat, and result shapes;
- consumes replay nonces only after every prior check succeeds;
- caps queue artifacts at 1 MiB and successful result data at 512 KiB.

The exact manual command shape is:

```text
version, session_id, id, action, params, issued_at, expires_at, nonce, hmac_sha256
```

`policy_id` and `intent_id` must appear together for automatic authority. Every
current worker action is compiled as `automation: never`, `rebootPolicy: never`,
and `manualAllowed: true`, so every automatic request is denied.

The heartbeat shape is:

```text
version, session_id, worker_pid, issued_at, expires_at, nonce, hmac_sha256
```

The result is an exact discriminated union:

```text
version, session_id, id, action, success, duration_ms,
data | error, issued_at, nonce, hmac_sha256
```

### Capability, launch, and session lifecycle

- Electron creates a random 16-byte session ID and a random 32-byte capability.
- The capability appears only in a strict minimal child environment. It is never in
  command JSON, command-line arguments, logs, or the global parent environment.
- ACL proof, code-trust proof, and UAC launcher children receive allowlisted system
  variables only. Parent `COR_*`, `COMPLUS_*`, `NODE_OPTIONS`, user PATH, and user
  module paths are excluded.
- The launcher and elevated action host use absolute PowerShell paths.
- The UAC launcher receives one correctly prequoted native `ArgumentList` string,
  including paths containing spaces, apostrophes, quotes, and trailing slashes.
- Readiness is an authenticated heartbeat, not a successful launcher exit.
- Launcher `error` and premature nonzero `exit` events fail closed.
- One transient invalid heartbeat does not rotate the session. Two failed probes do.
- Retired sessions retain capability bytes while a dispatch is in flight, then zero
  the bytes when the final reference is released.

### Queue and code trust

The random session queue is created with inheritance disabled and exactly three
FullControl entries:

- current user SID;
- BUILTIN\Administrators;
- SYSTEM.

Electron verifies that exact effective ACL before launch and again immediately
before command publication. The elevated worker repeats the ACL proof before every
command.

Worker and action coordinates are fixed under `C:\ProgramData\PCDoctor`. There is
no per-user bundle fallback. A fixed inline non-elevated verifier checks:

- the exact worker and nine action files exist;
- the root, worker, actions, and files are not reparse points;
- owners are SYSTEM, Administrators, or TrustedInstaller;
- the code root has a protected DACL;
- no untrusted effective ACE can write, delete, change permissions, or take ownership
  of the protected code nodes;
- every ancestor owner is trusted;
- no effective ancestor ACE grants DeleteChild, Delete, ChangePermissions, or
  TakeOwnership over the existing path chain;
- InheritOnly ACEs do not count at the node where they do not apply.

CreateDirectories on an ancestor is not treated as replacement authority when the
existing protected child cannot be deleted. This preserves a viable later installer
path while still rejecting the current mutable Tier-A root.

### PowerShell independent validation and execution

`Elevated-Worker.ps1` independently implements strict JSON parsing, canonical JSON,
HMAC validation, session/time/replay checks, automatic and reboot denial, exact
parameter schemas, and action mapping. It does not trust TypeScript validation.

| Action | Exact required parameters | Script arguments |
|---|---|---|
| `set-service-startup` | `service`, `startup_type` | `-Service`, `-StartupType` |
| `stop-service` | `service` | `-Service` |
| `start-service` | `service` | `-Service` |
| `restart-service` | `service` | `-ServiceName` |
| `kill-process` | `target` string | `-Target` |
| `set-process-priority` | `target`, `class` | `-Target`, `-Class` |
| `set-process-affinity` | `target`, `mask` | `-Target`, `-Mask` |
| `suspend-process` | `target` | `-Target` |
| `resume-process` | `target` | `-Target` |

Every production action optionally accepts only `dry_run`. The worker adds only the
fixed `-DryRun` and `-JsonOutput` switches. Validated values travel through bounded
UTF-8 base64 environment slots to a constant encoded wrapper. No attacker-controlled
value enters a command-line program string.

The action host is the absolute Windows PowerShell executable. Search-related child
environment variables are reduced to Windows-owned paths. `Set-ServiceStartup.ps1`
now resolves fallback `sc.exe` as the absolute
`$env:SystemRoot\System32\sc.exe`; its test extracts and invokes only that pure helper.
No service query or action is part of the smoke gate.

### Atomic artifacts, live heartbeat, and idle deadline

- Node command files use a same-directory temporary file and atomic rename.
- PowerShell result files use a same-directory temporary file and atomic move.
- Heartbeats use a same-directory temporary file and atomic replacement, including a
  unique backup path required by Windows PowerShell 5.1.
- Node and PowerShell reads are bounded before parsing.
- Heartbeats remain signed and fresh while a synchronous action child runs.
- Strict UTF-8 readers handle BOMless artifacts identically on PowerShell 5.1 and 7.
- Only a fully authenticated envelope with an accepted nonce refreshes activity.
- The idle deadline is checked inside every captured command snapshot, so malformed
  or unauthenticated backlogs cannot extend worker lifetime.

## Literal cross-language baselines

Capability bytes are the literal sequence `00` through `1f`.

Command canonical JSON:

```json
{"action":"set-service-startup","expires_at":1770000025000,"id":"ffeeddccbbaa99887766554433221100","issued_at":1770000000000,"nonce":"0123456789abcdeffedcba9876543210","params":{"service":"Spooler","startup_type":"Disabled"},"session_id":"00112233445566778899aabbccddeeff","version":2}
```

Command HMAC:

```text
d10c2b6eec700463d16d59144aaa075962db31d1826422ad9007e9c670af2e8f
```

Heartbeat canonical JSON:

```json
{"expires_at":1770000020000,"issued_at":1770000000000,"nonce":"11111111111111111111111111111111","session_id":"00112233445566778899aabbccddeeff","version":2,"worker_pid":4242}
```

Heartbeat HMAC:

```text
7bfa511655f923bed47397d90e1ddad811f92269a26aa0904b74ce174c3a8a19
```

Result canonical JSON:

```json
{"action":"stop-service","data":{"after":"Stopped"},"duration_ms":17,"id":"ffeeddccbbaa99887766554433221100","issued_at":1770000000000,"nonce":"22222222222222222222222222222222","session_id":"00112233445566778899aabbccddeeff","success":true,"version":2}
```

Result HMAC:

```text
30890000fa5c3ed73d5c85a67d664de54ddcd78903eca692276395be61f83417
```

The additional raw non-ASCII fixture, containing cafe-accent, rocket, and Chinese
characters, matches Node, PowerShell 7, and PowerShell 5.1:

```text
2054cbe979c250195262d4e124095a5d2a815b858768bb68336394e6b53669c4
```

## TDD evidence

### Initial RED

The first focused run, before V2 implementation, produced:

```text
56 tests collected
52 failed, 4 passed
```

The original smoke failed on both PowerShell runtimes because the worker did not
accept a session ID or authenticated V2 input.

### Implementation RED and GREEN cycles

- UAC timing coverage proved commands were issued before consent completed. Params
  are now snapshotted before consent and signed only after authenticated readiness.
- Authenticated heartbeat/result tests initially produced 28 failures. Exact signed
  artifacts and validation made them pass.
- Three bounded-read and atomic-command tests failed before bounded file-descriptor
  reads and same-directory publication were implemented.
- PowerShell smoke found `.Contains` incompatibility and canonical escape drift on
  both runtimes. Ordinal dictionaries and explicit escaping corrected them.
- Case-variant smoke failed before case-sensitive schema, actions, enums, IDs,
  sessions, nonces, and HMAC validation were enforced.
- Capability test hooks were callable outside tests before an `E_TEST_ONLY` gate.
- Initial trust/launch/session review added seven failing tests. Fixed ProgramData
  coordinates, code trust, native quoting, launcher events, two-probe health, and
  refcounted retirement produced 80 passing focused tests.
- Ancestor replacement and hostile parent environment coverage added four failures.
  Refined ancestor rights and strict child environments produced 83 passing tests.
- An untrusted ancestor owner proof then failed, and the owner-chain fix produced
  84 passing tests.
- Raw non-BMP input failed the strict PowerShell parser before surrogate-pair support.
- The first encoded action wrapper delivered a nested argument array and the delayed
  test action failed. A fixed named-parameter reconstruction corrected transport.
- The exact Windows PowerShell-hosted smoke exposed ANSI decoding of BOMless UTF-8
  results. Replacing every artifact `Get-Content` with a strict UTF-8 stream reader
  corrected the HMAC mismatch on both worker runtimes.
- A 1,200-file unauthenticated snapshot kept the unfixed worker busy beyond 60
  seconds. In-loop idle enforcement and a deterministic 200-file regression now
  prove the deadline cannot be deferred.
- Full regression found two constants mocks missing the new absolute PowerShell
  fallback export. The two suites failed at module load, then passed 31 of 31 after
  the test-only mock contract correction.
- Final test-writer validation added 32 adversarial cases. Focused coverage is now
  116 of 116 with no production bug demonstrated.

## Final verification

All commands ran from
`C:\dev\pcdoctor-workbench\.worktrees\phase0-safety`.

| Check | Result |
|---|---|
| `npx vitest run tests/main/elevatedWorker.test.ts` | PASS, 116 of 116 |
| Exact PS5.1-hosted temp-only worker smoke | PASS on PowerShell 7 and 5.1 |
| Repeated smoke plus parallel focused tests | PASS |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run test:node` | PASS, 90 files and 1,215 tests |
| `npm run test:ps51` | PASS, 126 scripts |
| `npm run test:bundle-sync` | PASS, 1 sidecar |
| Fixture and action filter | PASS, 12 of 12 |
| `git diff --check` | PASS |
| Added-line em/en dash scan | PASS |

`npm run test:tasks` and `npm run verify:source` were intentionally not run. The
task-registration gate can create and delete a Windows Scheduled Task when elevated.
The parent explicitly required the equivalent safe legs to run separately instead.
No Scheduled Task state was read or changed by Task 4 verification.

## Independent validators

- Test-writer: PASS. Added 32 focused cases; 116 of 116 passed. No production bug.
  Intentional gaps are live UAC/real ACL integration and real maintenance actions.
- Code-reviewer: clean, with no finding at confidence 0.60 or higher. Both previous
  Critical findings and all previous Warning findings were explicitly cleared.
- Output-validator: PASS. Full safe suite passed 90 files and 1,215 tests; all three
  primary HMAC fixtures were independently reproduced; no regression or baseline
  snapshot update is required.
- Parser validator: PASS. Strict JSON edge cases and the non-ASCII fixture matched
  Node, PowerShell 7, and PowerShell 5.1. No high or moderate parser finding.
  Engineering extraction domains were not applicable.

## Files changed

- `src/main/elevatedWorkerProtocol.ts`, created
- `src/main/elevatedWorker.ts`
- `powershell/worker/Elevated-Worker.ps1`
- `powershell/actions/Set-ServiceStartup.ps1`
- `scripts/test-worker-smoke.ps1`
- `tests/main/elevatedWorker.test.ts`
- `tests/main/ipc.lhmPath.test.ts`
- `tests/main/ipcSanitizeRenderPerf.test.ts`
- `.superpowers/sdd/2026-08-01-pcdoctor-phase-0-safety-foundation/task-4-report.md`, created

The production split is intentional. Protocol logic is isolated in the side-effect-free
TypeScript module. Extracting the inline trust verifier would add a new script that
must itself be trusted before the proof can run. Splitting the self-contained
PowerShell parser/canonicalizer would add another dot-sourced privileged code file
and TOCTOU surface.

## Safety and remaining concerns

- Current deployment is deliberately unavailable: the mutable Tier-A root returns
  `E_CODE_TRUST`. Installer hardening is a blocking Phase 0 integration dependency.
- Live UAC consent, the real hardened ProgramData ACL, and real maintenance actions
  were not exercised. This is intentional safety scope, not evidence they work
  end-to-end in the current deployment.
- No UAC prompt, RunAs call, service query, service mutation, process mutation,
  `sc.exe` execution, production worker launch, registry change, Scheduled Task,
  install, publish, reboot, or shutdown occurred.
- The full suite emitted pre-existing React `act(...)`, PowerShell console-encoding,
  and Git line-ending warnings. All gates passed.
