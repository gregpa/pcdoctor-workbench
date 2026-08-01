# PCDoctor Phase 0 Safety Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PCDoctor's tests reproducible and make every automatic execution pass one authenticated, default-deny policy and one declarative task manifest.

**Architecture:** Add pure automation types/policy evaluation ahead of `actionRunner`, then enforce the decision again in the elevated worker. Replace duplicated task catalogs with a generated JSON manifest consumed by registration, IPC, verification, and uninstall. All automatic mutations remain globally disabled throughout this phase.

**Tech Stack:** TypeScript, Vitest, ESLint 9 flat config, PowerShell 5.1, `better-sqlite3`, GitHub Actions Windows runners, Windows Task Scheduler XML, NSIS.

## Global Constraints

- `maintenance_global_enabled` remains `0` for the entire phase.
- `rebootPolicy` is always `never` for automatic execution.
- Existing renderer/manual actions remain available through their current confirmation UX.
- A missing execution context, policy, action metadata field, rollback prerequisite, or authenticated envelope denies automatic execution.
- The Scheduled Task migration removes/deactivates direct mutating tasks; it does not execute any maintenance action.
- Do not install or publish an artifact.
- Do not stage `.claude/`.

---

## File structure

- Create `eslint.config.js`: ESLint 9 flat configuration.
- Create `.github/workflows/ci.yml`: clean Windows source-gate workflow.
- Create `src/shared/automation.ts`: automation types and fixed denial codes.
- Create `src/shared/automationCatalog.ts`: exhaustive metadata keyed by `ActionName`.
- Create `src/main/automationPolicy.ts`: pure policy evaluator.
- Create `src/shared/task-manifest.json`: authoritative task definitions.
- Create `src/shared/taskManifest.ts`: typed loader and validator for the authoritative JSON.
- Create `scripts/generate-task-manifest.mjs`: deterministic JSON generator.
- Create `powershell/task-manifest.json`: generated PowerShell/installer input.
- Create `powershell/Unregister-All-Tasks.ps1`: manifest-driven cleanup.
- Modify `src/main/actionRunner.ts`: require trusted execution context and fail closed.
- Modify `src/main/elevatedWorker.ts` and `powershell/worker/Elevated-Worker.ps1`: authenticated, expiring envelopes and second policy check.
- Modify `src/main/autopilotEngine.ts`: submit automatic context; observe denial while global maintenance is disabled.
- Modify `src/main/ipc.ts`, `src/preload/preload.ts`, `src/main/taskMigrationVerify.ts`, `powershell/Register-All-Tasks.ps1`, `scripts/installer.nsh`, `package.json`, and migration tests.
- Add focused tests under `tests/shared`, `tests/main`, and `scripts`.

### Task 1: Reproducible lint, migration, and native-test gates

**Files:**
- Create: `eslint.config.js`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `src/main/dataStore.ts`
- Modify: `tests/main/dataStoreMigrations.test.ts`
- Modify: native-database tests that currently catch/skip module-load failure

**Interfaces:**
- Produces: `runMigrations(db: Database.Database, migrations?: readonly Migration[]): void`
- Produces: `npm run verify:source`
- Consumes: existing Vitest and PowerShell test scripts.

- [ ] **Step 1: Replace the copied migration test with a production-import test**

Use a temp SQLite database and import the real function:

```ts
import { runMigrations, type Migration } from '../../src/main/dataStore.js';

it('sorts production migrations and rolls back a failed migration', () => {
  const order: number[] = [];
  const migrations: Migration[] = [
    { version: 2, name: 'two', up: (db) => { order.push(2); db.exec('CREATE TABLE two(id INT)'); } },
    { version: 1, name: 'one', up: (db) => { order.push(1); db.exec('CREATE TABLE one(id INT)'); } },
  ];
  runMigrations(db, migrations);
  expect(order).toEqual([1, 2]);
  expect(db.pragma('user_version', { simple: true })).toBe(2);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm rebuild better-sqlite3 && npx vitest run tests/main/dataStoreMigrations.test.ts`

Expected: FAIL because `Migration` and `runMigrations` are not exported or production order is not sorted.

- [ ] **Step 3: Export and harden the production migration runner**

In `dataStore.ts`, make the type and function public and sort a copied array:

```ts
export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

export function runMigrations(
  database: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const current = Number(database.pragma('user_version', { simple: true }) ?? 0);
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  if (new Set(ordered.map((m) => m.version)).size !== ordered.length) {
    throw new Error('Duplicate migration version');
  }
  for (const migration of ordered) {
    if (migration.version <= current) continue;
    database.transaction(() => {
      migration.up(database);
      database.pragma(`user_version = ${migration.version}`);
    })();
  }
}
```

- [ ] **Step 4: Add ESLint flat config and deterministic scripts**

Use `eslint.config.js`:

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-electron/**', 'release/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
```

Add `typescript-eslint` to dev dependencies and these scripts:

```json
{
  "rebuild:node": "npm rebuild better-sqlite3",
  "test:node": "npm run rebuild:node && vitest run",
  "verify:source": "npm run lint && npm run typecheck && npm run test:node && npm run test:ps51 && npm run test:tasks && npm run test:bundle-sync"
}
```

Remove native-load catches that turn database test failure into a pass or skip. A `better-sqlite3` load error must fail the suite.

- [ ] **Step 5: Add clean Windows CI**

Create `.github/workflows/ci.yml` with `windows-latest`, Node 22, `npm ci`, `npm run verify:source`, and `npm run build`. Cache only npm's download cache, not `node_modules`.

- [ ] **Step 6: Verify GREEN and commit**

Run: `npm run verify:source`

Expected: all commands exit `0`; no database safety test is skipped.

Commit:

```powershell
git add eslint.config.js .github/workflows/ci.yml package.json package-lock.json src/main/dataStore.ts tests/main
git commit -m "build: restore deterministic source gates"
```

### Task 2: Exhaustive automation metadata and pure default-deny policy

**Files:**
- Create: `src/shared/automation.ts`
- Create: `src/shared/automationCatalog.ts`
- Create: `src/main/automationPolicy.ts`
- Create: `tests/main/automationPolicy.test.ts`
- Modify: `src/shared/actions.ts`

**Interfaces:**
- Produces: `ActionAutomationDefinition`, `TrustedExecutionContext`, `AutomationPolicyInput`, `PolicyDecision`.
- Produces: `ACTION_AUTOMATION satisfies Record<ActionName, ActionAutomationDefinition>`.
- Produces: `evaluateAutomationPolicy(input: AutomationPolicyInput): PolicyDecision`.

- [ ] **Step 1: Write policy boundary tests**

Cover unknown/missing context, global disabled, `never`, reboot, destructive confirmation level, missing rollback, safe manual, and safe automatic:

```ts
expect(evaluateAutomationPolicy(base({ context: undefined }))).toMatchObject({ allowed: false, code: 'E_CONTEXT_REQUIRED' });
expect(evaluateAutomationPolicy(base({ globalEnabled: false }))).toMatchObject({ allowed: false, code: 'E_AUTOMATION_DISABLED' });
expect(evaluateAutomationPolicy(base({ automation: 'never' }))).toMatchObject({ allowed: false, code: 'E_AUTOMATION_NEVER' });
expect(evaluateAutomationPolicy(base({ rebootRequired: true }))).toMatchObject({ allowed: false, code: 'E_REBOOT_FORBIDDEN' });
expect(evaluateAutomationPolicy(base({ confirmLevel: 'destructive' }))).toMatchObject({ allowed: false, code: 'E_DESTRUCTIVE_FORBIDDEN' });
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/main/automationPolicy.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Define immutable policy types**

Use these core shapes in `src/shared/automation.ts`:

```ts
export type AutomationClass = 'never' | 'safe' | 'conditional';
export type RebootPolicy = 'never';
export type ExecutionMode = 'manual' | 'automatic';

export interface TrustedExecutionContext {
  mode: ExecutionMode;
  source: 'renderer' | 'telegram-approved' | 'incident' | 'schedule' | 'maintenance';
  intentId?: string;
  policyId?: string;
}

export interface ActionAutomationDefinition {
  automation: AutomationClass;
  rebootPolicy: RebootPolicy;
  requiresRollback: boolean;
  resourceLocks: readonly string[];
  preflightId: string | null;
  postconditionId: string | null;
  cooldownMs: number;
  maxAttempts: number;
}
```

Define fixed denial codes as a string union so callers cannot invent policy outcomes.

- [ ] **Step 4: Build the exhaustive catalog**

Create helpers `neverAutomatic()` and `safeAutomatic()`; add one keyed entry for every current `ActionName`. Every existing cleanup, repair, service, process, updater, reboot-related, and user-data action starts with `neverAutomatic()`. Only `update_defender_defs`, read-only SMART/security actions, report generation, and PCDoctor-owned retention may receive `safe` later; Phase 0 still has global automation disabled.

Use `satisfies Record<ActionName, ActionAutomationDefinition>` so a new `ActionName` fails typecheck until metadata is added.

- [ ] **Step 5: Implement the pure evaluator in fixed order**

The evaluator checks context, global kill switch, metadata, action risk/reboot, policy enabled/snoozed, evidence freshness, maintenance window, load/idle, locks, cooldown, attempt budget, preflight, and rollback readiness. It returns the first fixed denial code and never throws for expected denial.

- [ ] **Step 6: Verify GREEN and commit**

Run: `npx vitest run tests/main/automationPolicy.test.ts && npm run typecheck`

Commit:

```powershell
git add src/shared/automation.ts src/shared/automationCatalog.ts src/main/automationPolicy.ts src/shared/actions.ts tests/main/automationPolicy.test.ts
git commit -m "feat: add default-deny automation policy"
```

### Task 3: Enforce policy and fail-closed rollback in `actionRunner`

**Files:**
- Modify: `src/main/actionRunner.ts`
- Modify: every main-process caller of `runAction`
- Create: `tests/main/actionRunner.automationPolicy.test.ts`
- Modify: existing action-runner tests

**Interfaces:**
- Consumes: `TrustedExecutionContext` and `evaluateAutomationPolicy`.
- Produces: `runAction(input: RunActionInput, context: TrustedExecutionContext): Promise<ActionResult>`.

- [ ] **Step 1: Write bypass and rollback tests**

Assert that an automatic recycle-bin action, `/ResetBase` action, reboot action, missing policy context, and rollback-preparation failure never invoke either script runner. Assert an approved renderer/manual action keeps its existing behavior.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/main/actionRunner.automationPolicy.test.ts`

Expected: FAIL because `runAction` does not require trusted context and currently proceeds after rollback failure.

- [ ] **Step 3: Make trusted context mandatory and renderer-proof**

Change the signature to require a second main-process-only argument. The IPC handler constructs `{ mode: 'manual', source: 'renderer' }`; it never accepts this object from `RunActionRequest`. Telegram uses `telegram-approved` only after its existing explicit callback approval. Autopilot uses `{ mode: 'automatic', source: 'incident', policyId }` and is denied while the global flag is off.

- [ ] **Step 4: Evaluate before dispatch and fail closed**

For automatic mode, load the compiled catalog and stored switch, evaluate policy, log the denial, and return without creating rollback or invoking PowerShell. If `requiresRollback` is true and `prepareRollback` throws or returns `null`, return `E_ROLLBACK_UNAVAILABLE`; manual mode retains its current warning/confirmation semantics.

- [ ] **Step 5: Update callers and prove no legacy call remains**

Run: `rg -n "runAction\(" src tests`

Expected: every production caller passes an explicit trusted context; test mocks match the two-argument signature.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run tests/main/actionRunner*.test.ts tests/main/autopilotEngine*.test.ts && npm run typecheck`

Commit:

```powershell
git add src/main/actionRunner.ts src/main/autopilotEngine.ts src/main/ipc.ts src/main/main.ts tests/main
git commit -m "fix: enforce automation policy in action runner"
```

### Task 4: Authenticate and constrain the elevated worker boundary

**Files:**
- Modify: `src/main/elevatedWorker.ts`
- Modify: `powershell/worker/Elevated-Worker.ps1`
- Modify: `tests/main/elevatedWorker.test.ts`
- Modify: `scripts/test-worker-smoke.ps1`

**Interfaces:**
- Produces: authenticated `WorkerCommandEnvelopeV2` with `version`, `session_id`, `id`, `action`, immutable `params`, `issued_at`, `expires_at`, `nonce`, and `hmac_sha256`.
- Consumes: the compiled worker action/parameter allowlist and `rebootPolicy: never`.

- [ ] **Step 1: Add rejection tests**

Test malformed HMAC, wrong session, expired envelope, replayed nonce, unknown parameter, modified action, modified params, queue ACL failure, and automatic action lacking policy capability. Keep the valid manual service-action test.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/main/elevatedWorker.test.ts`

- [ ] **Step 3: Create a per-session capability without placing it in command JSON**

Generate 32 random bytes in Electron memory. Pass them to the short-lived launcher through a dedicated inherited environment variable, let the elevated worker read it once, and clear it immediately. Use canonical JSON over all envelope fields except `hmac_sha256`, then HMAC-SHA256. Bind an automatic envelope to the policy ID and intent ID.

- [ ] **Step 4: Restrict queue ACL and enforce replay/expiry**

At queue creation, disable inherited write access and grant only the current user, Administrators, and SYSTEM. Verify the resulting ACL before dispatch. In PowerShell, reject envelopes older than 30 seconds, more than 5 seconds in the future, from another session, with a reused nonce, or with a non-constant-time HMAC mismatch. Retain used nonces until the worker exits.

- [ ] **Step 5: Enforce action-specific parameter maps in PowerShell**

Replace generic property-to-argument forwarding with a fixed map for each worker action. Reject any property outside that map and independently reject reboot-related actions. Write result files through a temporary file plus atomic rename.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npx vitest run tests/main/elevatedWorker.test.ts
npm run test:ps51
powershell.exe -ExecutionPolicy Bypass -File scripts/test-worker-smoke.ps1
```

Commit:

```powershell
git add src/main/elevatedWorker.ts powershell/worker/Elevated-Worker.ps1 tests/main/elevatedWorker.test.ts scripts/test-worker-smoke.ps1
git commit -m "security: authenticate elevated worker commands"
```

### Task 5: Generate all scheduled-task behavior from one manifest

**Files:**
- Create: `src/shared/taskManifest.ts`
- Create: `src/shared/task-manifest.json`
- Create: `scripts/generate-task-manifest.mjs`
- Create: `powershell/task-manifest.json`
- Create: `powershell/Unregister-All-Tasks.ps1`
- Modify: `powershell/Register-All-Tasks.ps1`
- Modify: `src/main/ipc.ts`
- Modify: `src/main/taskMigrationVerify.ts`
- Modify: `scripts/installer.nsh`
- Replace: copied task lists in tests

**Interfaces:**
- Produces: `TASK_MANIFEST: readonly TaskDefinition[]` loaded from the canonical JSON.
- Produces: deterministic `powershell/task-manifest.json` with SHA-256 checked into source.
- Produces: task states `active`, `deferred`, and `remove`.

- [ ] **Step 1: Write manifest consistency tests**

Assert unique IDs/names, `PCDoctor-` naming, no arbitrary command, hidden window for user-context background work, no direct mutating script for active tasks, complete UI and uninstall coverage, and exact generation stability.

- [ ] **Step 2: Define the manifest state table**

Store these decisions once in `src/shared/task-manifest.json`; `taskManifest.ts` validates and freezes them:

| Task cohort | Phase 0 state |
|---|---|
| Workbench autostart, Daily Quick report, staggered security posture, tool-update check, SMART read-only check, NAS size refresh | `active` |
| Existing weekly review until Sentinel can generate a coverage-aware replacement | `deferred` |
| Defender scan/definitions, weekly maintenance, monthly deep scan, retention | `deferred` until Orchestrator |
| Demand-start protected maintenance broker | `deferred` until Phase 2 broker validation |
| recycle-bin cleanup, browser-cache cleanup, component-store `/ResetBase`, hosts rewrite, direct malware-tool action dispatch, legacy Autopilot dispatcher aliases | `remove` |
| Forecast ping-only task with no durable consumer | `remove` |

Every active PowerShell task uses `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File <fixed bundled path> <fixed args>`. Use staggered minutes so 01:00/03:00/04:00/06:00 collisions disappear.

- [ ] **Step 3: Generate JSON and consume it everywhere**

`generate-task-manifest.mjs` reads the canonical JSON, validates required keys/values, sorts by task name, writes UTF-8 JSON to a temporary file, and renames only when content changes. Registration reads generated JSON and synthesizes XML; IPC imports the same canonical JSON through `taskManifest.ts`; migration verification compares actual name/action/context; uninstall invokes `Unregister-All-Tasks.ps1 -IncludeLegacy`.

- [ ] **Step 4: Retire direct scheduled mutation**

`Run-AutopilotScheduled.ps1` becomes a compatibility refusal that records `E_DIRECT_SCHEDULED_MUTATION_DISABLED` and exits nonzero. No active task references it. Remove current unsafe tasks by exact name during manifest migration; do not execute them.

- [ ] **Step 5: Run static and live-safe tests**

Run:

```powershell
node scripts/generate-task-manifest.mjs --check
npm run test:tasks
npx vitest run tests/main/taskMigrationVerify*.test.ts tests/main/ipc.runSchtasksAllowlist.test.ts
npm run test:ps51
```

Expected: no active task references a mutating action script or visible console action.

- [ ] **Step 6: Commit**

```powershell
git add src/shared/task-manifest.json src/shared/taskManifest.ts scripts/generate-task-manifest.mjs powershell/task-manifest.json powershell/Register-All-Tasks.ps1 powershell/Unregister-All-Tasks.ps1 powershell/Run-AutopilotScheduled.ps1 src/main/ipc.ts src/main/taskMigrationVerify.ts scripts/installer.nsh tests scripts/test-task-registration.ps1 package.json
git commit -m "refactor: generate scheduled tasks from one manifest"
```

### Task 6: Phase 0 exit gate

**Files:**
- Create: `docs/superpowers/reports/phase-0-validation.md`

- [ ] **Step 1: Run the complete source gate**

Run: `npm run verify:source`

- [ ] **Step 2: Prove policy bypasses are absent**

Run:

```powershell
rg -n "Run-AutopilotScheduled|Empty-RecycleBins|Shrink-ComponentStore|ResetBase" powershell/task-manifest.json
rg -n "runAction\([^,]+\)" src/main
```

Expected: first command finds no active task action; second finds no one-argument production call.

- [ ] **Step 3: Record evidence and commit**

Document command, timestamp, exit code, manifest hash, global switch value `0`, and proof that no reboot/install/publish occurred.

```powershell
git add docs/superpowers/reports/phase-0-validation.md
git commit -m "docs: record phase 0 safety validation"
```
