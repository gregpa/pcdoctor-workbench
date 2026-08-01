# Task 4 Report: Authenticate and Constrain the Elevated Worker Boundary

## Status

IMPLEMENTED AND VERIFIED, WITH DELIBERATE FAIL-CLOSED INSTALLER DEPENDENCIES

Base commit: `b44f363 security: authenticate elevated worker commands`

Controller remediation subject: `security: harden elevated worker queue boundary`

The formal controller rejected the queue design in `b44f363` because its per-user
parent and FullControl leaf could be renamed or replaced with a junction after a
path-based ACL check. This remediation replaces that architecture. Task 4 code is
complete and the safe verification matrix passes, but the current machine still
fails closed before UAC because neither required production boundary is installed:

- `C:\ProgramData\PCDoctorWorkerQueue` does not exist;
- the current `C:\ProgramData\PCDoctor` Tier-A code layout remains mutable.

Task 5 and the Phase 0 exit gate must provision both the administrator-owned queue
root and privileged worker/action payload. Manual worker actions remain deliberately
unavailable until that installer work is complete and independently verified.

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
4. Require a fixed Administrators-owned queue root, create the random session leaf only
   after elevation, and give the medium user no directory replacement authority.
   Verify: exact root/leaf/ancestor proofs, four-ACE model tests, and pre-UAC failure.
5. Execute only fixed ProgramData worker/action code that is protected from
   untrusted replacement.
   Verify: owner, DACL, reparse, path, file-set, and ancestor replacement proofs.
6. Replace generic action forwarding with an exact fixed map and trusted absolute
   executables.
   Verify: nine action-map cases and pure absolute `sc.exe` resolution.
7. Bound all reads and enumeration, publish commands, heartbeats, and results
   atomically, and prevent rejected traffic from keeping the elevated worker alive.
   Verify: oversized, partial, concurrent heartbeat, replay, and 2,500-file backlog tests.
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

The production queue root is the fixed literal
`C:\ProgramData\PCDoctorWorkerQueue`, separate from the mutable `PCDOCTOR_ROOT`.
Electron never creates the session directory. Before any UAC launch, a fixed encoded
read-only verifier requires the root to exist, be owned exactly by
BUILTIN\Administrators, have a
protected DACL, contain no reparse point in its ancestor chain, and be structurally
non-replaceable by untrusted principals. A missing or insecure root returns
`E_QUEUE_ROOT_TRUST` before `spawn` can run.

The root proof reports its resolved owner SID as part of its exact shape, and
Electron independently requires `S-1-5-32-544`. SYSTEM and TrustedInstaller remain
valid owners for ancestors only. Task 5 must explicitly set the queue root owner to
BUILTIN\Administrators even when installation runs as SYSTEM.

The elevated Windows PowerShell 5.1 worker validates the same fixed root, derives the
leaf as exactly `Join-Path $ProductionQueueRoot $SessionId`, rejects an existing leaf,
and creates the leaf with `Directory.CreateDirectory(path, DirectorySecurity)`. The
owner and DACL are applied at creation. There is no create-then-`Set-Acl` fallback.
The exact protected leaf descriptor is:

- owner: BUILTIN\Administrators;
- BUILTIN\Administrators: FullControl, ContainerInherit and ObjectInherit;
- SYSTEM: FullControl, ContainerInherit and ObjectInherit;
- current user: direct ReadAndExecute plus CreateFiles, with no inheritance;
- current user: Modify on child files only, ObjectInherit plus InheritOnly.

The direct user rule has no CreateDirectories, DeleteChild, Delete, WriteAttributes,
WriteExtendedAttributes, ChangePermissions, or TakeOwnership. The file-only rule
allows a Node-created temporary file to be read, renamed, and deleted without giving
the user any authority to create a subdirectory or reparse directory node. Explicit
Administrators ownership prevents the medium user from acquiring implicit WRITE_DAC
authority through ownership.

After elevation, Electron marks the queue ready only after the exact leaf proof and
an authenticated heartbeat both succeed. It repeats the leaf proof immediately
before command publication. The worker repeats the root, leaf, owner, DACL, and
no-reparse proof before every heartbeat or result publication and before queue-file
deletion.

PowerShell 5.1 does not provide a suitable retained open-directory, no-follow,
handle-relative API for the current script. The safety argument is therefore
structural: an untrusted medium process cannot delete, rename, re-ACL, re-own, or
replace the trusted root or leaf; cannot create child directories in the root or
leaf; and every path node is proven non-reparse before I/O. A privileged process can
still race this boundary and is outside this specific trust claim. A protected broker
remains the stronger long-term architecture.

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

Every service string and `kill-process` target is independently constrained in both
TypeScript and PowerShell to `[A-Za-z0-9._-]{1,128}`. Stars, question marks, bracket
patterns, slashes, backslashes, whitespace, non-ASCII text, and values longer than
128 characters are rejected before UAC in Electron and before action mapping in the
worker. This prevents PowerShell wildcard expansion from widening one signed request
to multiple services or processes.

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
- Node and PowerShell use throwing UTF-8 decoders before JSON parsing. Neither
  runtime can replacement-decode an authenticated artifact. Node preserves a BOM
  as U+FEFF so BOM-prefixed JSON remains noncanonical and rejected.
- Heartbeats remain signed and fresh while a synchronous action child runs.
- Strict UTF-8 readers handle BOMless artifacts identically on Node, PowerShell 5.1,
  and PowerShell 7.
- Only a fully authenticated envelope with an accepted nonce refreshes activity.
- Command files are obtained with lazy `Directory.EnumerateFiles`; there is no global
  `Get-ChildItem` materialization or `Sort-Object` pass.
- At most 64 command paths are handled per iteration, and the idle deadline is
  checked before and after each enumerator step. A 2,500-file malformed backlog on
  both PowerShell runtimes proves enumeration cannot defer worker shutdown.

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
- A 1,200-file unauthenticated snapshot kept the first implementation busy beyond
  60 seconds. The controller later showed that its 200-file regression still
  materialized and sorted the directory before the deadline check. The remediation
  now uses lazy capped enumeration and a 2,500-file both-runtime regression.
- Full regression found two constants mocks missing the new absolute PowerShell
  fallback export. The two suites failed at module load, then passed 31 of 31 after
  the test-only mock contract correction.
- The pre-controller test-writer validation added 32 adversarial cases. That
  historical focused checkpoint was 116 of 116 with no production bug demonstrated.

### Formal controller remediation RED and GREEN

The controller rejected `b44f363` for a replaceable per-user queue, wildcard-capable
service/process strings, materialized backlog enumeration, and an undocumented
same-user capability limitation. New tests were added before remediation code.

The focused RED run reported:

```text
139 tests collected
24 failed, 115 passed
```

The failures proved that 13 unsafe service/kill names were accepted, the queue still
resolved beneath LocalAppData, the narrow ACL model did not exist, missing root trust
returned the old error, and the launcher still accepted `-QueueDir`. Four dispatch
tests timed out because unsafe names passed validation and reached worker readiness.

The independent PowerShell RED stopped immediately with:

```text
[FAIL] set-service-startup accepted unsafe service name: *
```

GREEN proceeded in small slices:

- the exact safe-name domain passed at lengths 1 and 128 and rejected wildcard,
  slash, whitespace, bracket, and length-129 cases in TypeScript and PowerShell;
- fixed-root derivation, pre-UAC root failure, exact 13-field root/leaf proofs, and
  the four-ACE ACL model reached 150 of 150 focused tests;
- a first PS7 smoke run exposed TestMode proof overhead and insufficient harness
  timeout; proof placement was simplified without weakening pre-write production
  checks, and the isolated harness timeout was adjusted;
- a proposed PS7 create-then-ACL fallback was rejected before acceptance because the
  creator would temporarily own WRITE_DAC. Production was pinned to Windows
  PowerShell 5.1 atomic descriptor creation, and a static regression test now forbids
  the fallback;
- the final 2,500-file smoke passed authenticated worker, action-host heartbeat,
  rejected-traffic idle, and bounded-backlog checks on PowerShell 7 and 5.1.
- independent review found that a leaf-proof exception could escape the post-spawn
  poll without retiring its session. A RED assertion reproduced the retained
  session, and one lifecycle cleanup path now deactivates the launcher and retires
  the current session for every proof, spawn, poll, launch, or timeout error;
- root ownership was tightened from a privileged-owner set to exact
  BUILTIN\Administrators. The proof now includes `owner_sid`; worker and Electron
  reject SYSTEM, TrustedInstaller, or a user SID at the root while retaining the
  privileged-owner set for ancestors;
- parser validation showed that .NET `$` accepts a final line feed. A valid signed
  command with line feed appended to its HMAC was accepted on both PowerShell
  runtimes before the fix. All attacker-reachable exact worker and embedded-proof
  formats now use the absolute `\z` anchor, including safe names, HMAC, ID, nonce,
  session ID, SID, reboot names, and wrapper tokens;
- parser validation also constructed malformed bytes `c3 28` that Node
  replacement-decoded to the same logical string as a signed result containing
  U+FFFD plus `(`. Node accepted it before the fix while both PowerShell runtimes
  rejected it. Node now uses a fatal `TextDecoder` before parsing heartbeat or
  result bytes, compatible with the declared Node 17.3 minimum.

## Final verification

All commands ran from
`C:\dev\pcdoctor-workbench\.worktrees\phase0-safety`.

| Check | Result |
|---|---|
| `npx vitest run tests/main/elevatedWorker.test.ts` | PASS, 168 of 168 |
| Exact PS5.1-hosted temp-only worker smoke | PASS on PowerShell 7 and 5.1 |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run test:node` | PASS, 90 files and 1,267 tests |
| `npm run test:ps51` | PASS, 126 scripts |
| `npm run test:bundle-sync` | PASS, 1 sidecar |
| `git diff --check` | PASS |
| Added-line em/en dash scan | PASS |

`npm run test:tasks` and `npm run verify:source` were intentionally not run. The
task-registration gate can create and delete a Windows Scheduled Task when elevated.
The parent explicitly required the equivalent safe legs to run separately instead.
No Scheduled Task state was read or changed by Task 4 verification.

## Independent validators

- Test-writer: PASS. Added post-spawn proof-shape, proof-environment, exact ACL-mask,
  and AST enumeration guards. Its pass was 158 of 158; later review-driven
  regressions raised final focused coverage to 168 of 168. No live integration ran.
- Code-reviewer: found and cleared the lifecycle cleanup warning and a declared
  Node 17.3 compatibility warning in the first strict decoder. The final decoder is
  fatal, BOM-preserving, and uses `node:util.TextDecoder`. No remaining code finding
  reached confidence 0.60.
- Output-validator: PASS on the requested architecture, cross-runtime smoke,
  regression suite, and threat-model disclosure. Its root-owner wording warning
  was resolved by tightening the implementation to exact BUILTIN\Administrators.
- Parser validator: found and reproduced final-LF regex drift and malformed UTF-8
  replacement decoding. Both were corrected with cross-runtime regressions.
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

- Capability scope is limited: HMAC authentication protects queue artifacts from
  tampering by processes that cannot inspect or inject into the trusted Electron or
  launcher process. Arbitrary code already running as the same Windows user can
  normally inspect or inject into those processes, recover the in-memory or
  launcher-environment capability, and forge otherwise valid manual envelopes. If
  hostile same-user code is in scope, this design is insufficient. Phase 0 must use
  a protected broker with OS-enforced process identity and mutual validation, or
  per-command elevation, before making that stronger claim.
- Current deployment is deliberately unavailable: the mutable Tier-A root returns
  `E_CODE_TRUST`, and the absent fixed queue root returns `E_QUEUE_ROOT_TRUST` before
  UAC. Installer hardening is a blocking Phase 0 integration dependency.
- Task 5 must provision the protected queue root with owner exactly
  BUILTIN\Administrators, provision the privileged code payload, define
  administrator-owned stale session-leaf cleanup, and adapt the live launcher smoke
  to the installed fixed-root contract before the Phase 0 exit gate.
- Live UAC consent, the real hardened ProgramData ACL, and real maintenance actions
  were not exercised. This is intentional safety scope, not evidence they work
  end-to-end in the current deployment.
- No UAC prompt, RunAs call, service query, service mutation, process mutation,
  `sc.exe` execution, production worker launch, registry change, Scheduled Task,
  install, publish, reboot, or shutdown occurred.
- The full suite emitted pre-existing React `act(...)`, PowerShell console-encoding,
  and Git line-ending warnings. All gates passed.
