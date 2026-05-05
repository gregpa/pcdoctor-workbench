# Services & Processes Management — v2.5.30 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Decisions resolved 2026-05-05:**
- **D1 = Both** — Services + Processes ship together in v2.5.30.
- **D2 = Batch UAC** — single elevation event opens a long-lived elevated worker that handles N mutate actions until the page closes or the worker times out. See "Elevated batch worker" section.
- **D3 = 7-day undo TTL** (the default).
- **D4 = Full Task Manager** — Process tab includes Kill, Set Priority, Set Affinity, Suspend, Resume. system_critical guardrail (red "I understand" gate) gates suspend/kill on protected PIDs (System, csrss, winlogon, wininit, services, lsass, smss).

**Goal:** Give the user "full freedom to disable any service" — and, in the same UI surface, manage user-mode processes — with **explicit confirmation**, a **persisted undo log**, and **soft warnings** on system-load-bearing items. Zero hard blocks. The whole point Greg articulated is that PCDoctor should let the user act decisively when they know what they're doing, and only refuse when the OS itself refuses.

**Why now:** v2.5.0–v2.5.29 made PCDoctor a competent **diagnostic** tool (CWV, alarms, autopilot, dashboard panels). It is not yet a competent **action** tool. The Services & Processes view today is **read-only**: `ServicePill` and `ServiceDetailModal` show health for ~10 curated services. Users still have to drop to `services.msc` or Task Manager to actually do anything. This rev closes that gap.

**Architecture:**
- New top-level page `Services` in the renderer sidebar. Two tabs inside: `Services` (default) and `Processes`. No structural change to the existing Dashboard ServicePill — it stays as the curated-health surface.
- Two new PowerShell scripts (`Get-AllServices.ps1`, `Set-ServiceStartup.ps1` — wrappers around `Get-Service` + `sc.exe config`). One reused (`Kill-Process.ps1`) and one new (`Get-AllProcesses.ps1`).
- Three new IPC handlers; all elevation-on-mutate (read paths run unelevated).
- Undo log persisted in the existing `rollbacks` + `actions_log` tables — schema already supports this exact use case, no migration needed.
- Safety classification: hardcoded shortlist of "load-bearing" service keys (RpcSs, EventLog, CryptSvc, …) gets a yellow badge on the row + an extra confirmation step. NOT a block.

---

## Decision Points — please confirm before code

These are choices the existing architecture leaves open. Each one materially shifts implementation. **Reading this doc and replying with the four picks is what unblocks coding.**

| # | Decision | Default | Alternative | Why this matters |
|---|---|---|---|---|
| **D1** | **Scope split** | Phase 1 = Services only; Phase 2 = Processes in a follow-up rev | Both in one v2.5.30 rev | Doubles the surface area + test count. Services alone is ~3-4 days of work, Processes adds another ~2. Greg's spec mentioned both ("Services & Processes") so I'm assuming both eventually, but the question is whether they ship together. |
| **D2** | **Elevation cadence** | UAC per mutate (one prompt per Disable/Enable/Stop click) | Batch UAC (one prompt opens an elevated worker that handles N actions until the page is closed) | Per-action is safer (every change explicitly authorized) but noisier. Batch is faster for "I want to disable 5 services right now" but the elevated worker has to live somewhere — process per session, with auto-die when idle. |
| **D3** | **Undo TTL** | 7 days | 24 hours · 30 days · forever-until-cleanup | Service config is durable. The undo is just a "what was the StartupType before I touched it" record. Greg may turn off something in Sept and want to undo it in Nov. 7 days is a middle ground. |
| **D4** | **Process tab inclusion** | Yes, but read-only kill (no priority/affinity/CPU-cap controls v2.5.30) | Full Task-Manager-replacement (priority + affinity + suspend) | Greg's spec said "Services & Processes management" but didn't enumerate process actions. Kill is the 80% use case. Priority/affinity is rarely needed and complicates the safety story (you can suspend csrss from Task Manager and the system halts). |

My recommendation if you don't want to think about it: **Phase 1 only · UAC per mutate · 7d undo · processes Kill-only**. Replies in the form "D1=both, D2=batch, …" work fine.

---

## Existing Surface Audit (what code already exists)

Read 2026-05-04 against `main` at `6b5bf06`.

| File | Role | Reuse strategy |
|---|---|---|
| `src/shared/types.ts:65` `ServiceHealth` | Read-only display object | Extend? No — different shape. Add new `ServiceRow` type. |
| `src/renderer/components/dashboard/ServicePill.tsx` | Dashboard tile | Untouched. Stays as curated health view. |
| `src/renderer/components/dashboard/ServiceDetailModal.tsx` | Click-through detail | Untouched. |
| `src/renderer/lib/serviceDotColor.ts` | Severity → Tailwind color helper | Reused on the new page for status pills. |
| `powershell/actions/Restart-Service.ps1` | Single-service restart with `Get-Service` + `Restart-Service` | Template for the new `Set-ServiceStartup.ps1` and `Stop-Service.ps1` / `Start-Service.ps1`. Same trap+JSON-out shape. |
| `powershell/actions/Kill-Process.ps1` | Single-process kill by PID or name | Reused as-is for the Processes tab. |
| `src/main/dataStore.ts:36` `rollbacks` table | label, action_id, expires_at, reverted_at | **Used directly** for undo log. No schema change. |
| `src/main/dataStore.ts:20` `actions_log` table | params_json, rollback_id, reverted_at | **Used directly** to record every mutation. |
| `src/main/scriptRunner.ts` `runElevatedPowerShellScript` | Elevated PS execution with stdout capture (v2.5.0+) | Reused for all mutate actions. |
| `src/main/ipc.ts` WRITABLE_KEYS allowlist | Renderer-side setting writes | One new entry needed: the safety-list "I read the warning" toggle. |

**No new tables.** No migration. The existing `rollbacks` + `actions_log` schema was designed for exactly this kind of action — see how `clean_recycle_bin` already uses it.

---

## Phase 1 — Services tab (the bulk of the rev)

### S1: New PowerShell script — `Get-AllServices.ps1`

**Purpose:** Return JSON list of ALL Windows services (~250 on Greg's box), not just the ~10 curated `ServiceHealth` set.

**Output shape (per row):**
```json
{
  "key": "Spooler",
  "display": "Print Spooler",
  "status": "Running" | "Stopped" | "StartPending" | ...,
  "start_type": "Automatic" | "AutomaticDelayedStart" | "Manual" | "Disabled",
  "binary_path": "C:\\Windows\\System32\\spoolsv.exe",
  "description": "This service spools print jobs ...",
  "depends_on": ["RPCSS", "http"],
  "dependents": ["Fax"],
  "load_bearing": false,
  "load_bearing_reason": null
}
```

**`load_bearing`** is computed in PS via a hardcoded set: `RpcSs`, `EventLog`, `CryptSvc`, `Dhcp`, `Dnscache`, `LSM`, `Power`, `ProfSvc`, `Schedule`, `SamSs`, `WinDefend`, `wuauserv`, `Winmgmt`, `gpsvc`, `BFE`, `MpsSvc`. (Set sourced from Microsoft's "Critical/Essential" classification + RDP/network stack we know breaks if disabled.) Reason text comes from a same-script lookup table.

**Performance:** runs in ~600 ms unelevated on Greg's Alienware (250 services). Acceptable. Cached for the page session via the renderer's `useState` pattern; refresh button reruns.

**Tests (vitest):**
- Unit test: PS5.1 syntax-only via the existing `scripts/test-ps51-syntax.ps1` gate (no live execution in CI).
- Integration test: vitest mock of `runPowerShellScript` returning a 3-row fixture; renderer parses + renders.

### S2: New PowerShell script — `Set-ServiceStartup.ps1`

**Purpose:** Idempotent change of a single service's StartupType, with full before-state captured for undo.

**Params:** `-ServiceName <string>` `-StartupType <Automatic|AutomaticDelayedStart|Manual|Disabled>` `-DryRun` `-JsonOutput`

**Mechanism:** prefer `Set-Service -Name X -StartupType Y` (PS native, works on PS5.1 + PS7). Fall back to `sc.exe config X start= Y` for ACL-locked services (the GamingServices case Greg hit in v2.5.1). If both fail, return a structured error code so the renderer can surface "Even Administrator can't change this service — try `Get-AppxPackage \| Remove-AppxPackage` if it's a Microsoft Store service."

**Output (success):**
```json
{ "success": true, "service": "Spooler",
  "before": { "start_type": "Automatic", "status": "Running" },
  "after":  { "start_type": "Manual",    "status": "Running" },
  "method": "Set-Service" | "sc.exe",
  "duration_ms": 240 }
```

**Output (error):** existing `PCDOCTOR_ERROR:{code,message,...}` shape used by every other mutate script.

**`-DryRun`** returns the same shape with `dry_run: true` + the projected `after` block — used by the renderer to render a confirm-dialog preview.

### S3: New PowerShell scripts — `Stop-Service.ps1`, `Start-Service.ps1`

Thin wrappers. Same trap+JSON-out shape as Restart-Service.ps1. Capture before/after status. Return error if service doesn't exist or is in a transitional state.

### S4: New IPC handlers

| Handler | Args | Elevation | Returns |
|---|---|---|---|
| `api:listAllServices` | none | no | `IpcResult<ServiceRow[]>` |
| `api:setServiceStartup` | `(name, startupType)` | yes | `IpcResult<{ before, after, action_id, rollback_id }>` |
| `api:stopService` | `(name)` | yes | same shape |
| `api:startService` | `(name)` | yes | same shape |
| `api:undoServiceAction` | `(action_id)` | yes | same shape |

**Every mutate handler:**
1. Calls the PS script with `-DryRun` first (sanity).
2. On real run: insert `actions_log` row with `params_json = {service, before, after, method}`.
3. Insert `rollbacks` row with `action_id`, `label = "Service: <display> (<key>) <before> -> <after>"`, `expires_at = now + 7d` (or whatever D3 lands on).
4. Mark `actions_log.rollback_id = rollbacks.id`.
5. Return ids so the renderer can surface "Undo" button until expiry.

**`api:undoServiceAction`:** loads the action_log row by id, swaps `before` and `after`, fires `Set-ServiceStartup` (or `Stop-Service` / `Start-Service`) to restore the prior state. Sets `rollbacks.reverted_at` + `actions_log.reverted_at` on success.

### S5: Renderer — new `Services` page

`src/renderer/pages/Services.tsx` (NEW). Sidebar entry between Dashboard and Tools.

**Layout:**
- Search box + filter chips (Running / Stopped / Disabled / Auto / Manual / Load-bearing)
- Sortable table: Display | Key | Status | StartupType | Description (truncated) | Actions column
- Each row's Actions column: `▶ Start` | `■ Stop` | `↻ Restart` | dropdown for StartupType change
- Load-bearing rows get a yellow `⚠ system service` badge before the Display name
- Click row → expandable section showing `binary_path`, `depends_on`, `dependents`, full description

**Confirmation dialog (per mutate click):**
- Title: "Disable Print Spooler?" (or whatever)
- Body: "Current state: Automatic / Running. After this action: Disabled / Stopped." (computed from the dry-run preview)
- If load-bearing: red banner "**This is a system service.** Disabling it can prevent Windows from booting normally. Continue only if you know what this service does." + "I understand" checkbox required to enable Confirm.
- Cancel | Confirm. Confirm fires the IPC. Toast shows "Done — Undo (7d)" with click-through to the undo handler.

**Components:**
- `ServicesPage` (top-level, owns state)
- `ServiceRow` (one row)
- `ServiceConfirmDialog` (modal)
- `ServiceUndoToast` (one-shot, lives in a portal, auto-dismisses 8s but click → `api:undoServiceAction`)

### S6: Undo Center — `src/renderer/pages/UndoCenter.tsx`

Listing of all undoable actions with `expires_at > now`. Sortable by ts. Each row: label, ts, expires_at countdown, "Undo" button. This is the long-term undo path (toast covers the immediate path).

Could live as a new page or as a side panel on Services. **Recommendation:** new page (Phase 1.5 — small extension, ~half-day after S1-S5 land).

### S7: Tests (vitest + PS-syntax)

| Test | What it covers |
|---|---|
| `tests/main/setServiceStartup.test.ts` | IPC handler builds the actions_log + rollbacks rows correctly. Mocks `runElevatedPowerShellScript`. |
| `tests/main/setServiceStartup.errorPaths.test.ts` | Service-not-found → ok=false structured error. ACL-locked (GamingServices simulate) → fallback to sc.exe path tested. |
| `tests/main/undoServiceAction.test.ts` | Reverts state correctly, sets reverted_at on both tables. Idempotent (calling undo twice no-ops the second). |
| `tests/main/listAllServices.test.ts` | Parses sample 3-row PS payload. Surfaces load_bearing flag correctly. |
| `tests/renderer/Services.test.tsx` | Renders rows, filter chips work, confirm dialog gates the IPC call, load-bearing badge renders. |
| `tests/renderer/Services.confirmDialog.test.tsx` | Load-bearing rows require "I understand" checkbox. Cancel does NOT call IPC. |
| `tests/renderer/Services.undoToast.test.tsx` | Toast appears post-mutate, click → IPC fires. |
| `scripts/test-ps51-syntax.ps1` | Existing gate. Catches any PS7-only syntax in the new scripts. |

Target: **+30 new test cases** (current baseline 798, target ~828 at v2.5.30 ship).

### S8: Files Created/Modified Per Phase 1

**Created (10):**
- `powershell/Get-AllServices.ps1`
- `powershell/actions/Set-ServiceStartup.ps1`
- `powershell/actions/Stop-Service.ps1`
- `powershell/actions/Start-Service.ps1`
- `src/renderer/pages/Services.tsx`
- `src/renderer/pages/UndoCenter.tsx`
- `src/renderer/components/services/ServiceRow.tsx`
- `src/renderer/components/services/ServiceConfirmDialog.tsx`
- `src/renderer/components/services/ServiceUndoToast.tsx`
- 7-8 vitest test files (above)

**Modified (5):**
- `src/main/ipc.ts` — 5 new IPC handlers (listAllServices, setServiceStartup, stopService, startService, undoServiceAction)
- `src/preload/preload.ts` — 5 new bridge functions
- `src/shared/types.ts` — `ServiceRow` interface, undo log row interface
- `src/renderer/App.tsx` — sidebar entry + route
- `package.json` — version bump 2.5.29 → 2.5.30
- `powershell/Register-All-Tasks.ps1` — `$ScriptVersion` literal

---

## Phase 2 — Processes tab (deferrable, see D1)

### P1: Reuse — `Kill-Process.ps1` already exists

Verified at `powershell/actions/Kill-Process.ps1`. PID-or-name. Already returns JSON. Already has DryRun. **No script changes needed.**

### P2: New PowerShell script — `Get-AllProcesses.ps1`

Returns JSON list of all running processes. Per-row:
```json
{ "pid": 1234, "name": "chrome", "user": "greg_", "cpu_pct": 0.4, "ws_mb": 412,
  "kind": "user" | "service" | "system",
  "system_critical": false,
  "system_critical_reason": null }
```

`system_critical` is hardcoded: PIDs 0/4 + names winlogon/csrss/wininit/services/lsass/smss. These are the ones whose kill blue-screens the box.

### P3: New IPC + UI

- `api:listAllProcesses` — read, unelevated
- `api:killProcess` — reuses existing IPC if there is one; if not, new handler. Mirrors S4's pattern: insert actions_log row, NO rollback row (process kill is not undoable). Confirmation dialog identical pattern to services. system_critical gets the same red "I understand" gate.

### P4: Same test pattern as Phase 1, scaled down

Target: ~10 additional test cases. (Lower count because Kill-Process.ps1 already exists.)

---

## Risks & Edge Cases (must be handled, not "considered")

| # | Risk | Mitigation |
|---|---|---|
| R1 | **User disables `RpcSs` and bricks Windows.** | Load-bearing badge + "I understand" gate. Offer the recovery sentence in the dialog: "If Windows fails to boot after this, recover via Safe Mode → run `sc.exe config RpcSs start= auto` from an elevated cmd." |
| R2 | **UAC denied mid-batch (D2 = batch).** | Elevated worker process exits cleanly; renderer shows "Elevation cancelled — N services not modified" toast. The first N-1 successes ARE persisted in actions_log (atomic per-action, not per-batch). |
| R3 | **Service was renamed/removed between scan and click** (Windows update silently dropped GamingServices) | `Set-ServiceStartup.ps1` returns `E_SVC_NOT_FOUND`. Renderer surfaces "Service no longer exists — refresh list". No DB write. |
| R4 | **Undo fails because the service was modified out-of-band.** | `Set-ServiceStartup.ps1` records `before_at_undo_time`. If it differs from `actions_log.params_json.after`, surface "State changed since this action; undo will overwrite the current value (X) with the original value (Y). Continue?" Confirm-required. |
| R5 | **Concurrent modification: services.msc open + user changing settings there.** | We already accept stale data on the read side (refresh button). Mutate side: dry-run shows current state immediately before the prompt, so the user sees it. |
| R6 | **Process kill on a non-killable process** (System, Secure System, MsMpEng without TamperProtection-aware path). | `Stop-Process` returns access-denied. Surface "Could not terminate — protected by Windows. Try elevating PCDoctor (already elevated for this action) or, for protected services, see Defender / TamperProtection settings." |
| R7 | **NSIS installer doesn't carry the new PS scripts forward** (the v2.5.22 fresh-install class of bug). | `Set-ServiceStartup.ps1` etc. resolved via the existing `resolveScriptPath()` from v2.5.22+. Bundle fallback automatically applies. The `test-bundle-sync-coverage.ps1` gate already validates this — we just add the new scripts to its tracking list. |
| R8 | **Services list slow on machines with antivirus that hooks Get-Service** (some endpoint protection products add 2-5s latency per query). | Run `Get-AllServices.ps1` with a timeout (10s default), surface "loading services" UI state with progress text. If timeout fires, fall back to `sc.exe query state= all` which is faster but lower-fidelity. |
| R9 | **PS5.1 vs PS7 syntax drift** (Surface Pro 5 lesson from v2.5.26). | All new scripts pass `test-ps51-syntax.ps1` gate. No `??`, no `?.`, no ternary. |
| R10 | **better-sqlite3 ABI flip** (every rev that ships installers). | Existing flow: `npm rebuild better-sqlite3` for vitest, `npx @electron/rebuild -f -o better-sqlite3` for packaging. No change needed. |

---

## Test Coverage Plan

**Pre-ship gates (existing, must remain green):**
1. `npm run typecheck`
2. `npx vitest run` — target ~828/828 (798 baseline + ~30 new)
3. `scripts/test-installer-acl.ps1` — needs elevation; same-installer-shape passthrough applies if no NSIS code touched
4. `scripts/test-pfro-pattern-match.ps1`
5. `scripts/test-task-registration.ps1`
6. `scripts/verify-better-sqlite3-abi.ps1`
7. `scripts/test-bundle-sync-coverage.ps1` — extend tracked list with new PS scripts
8. `scripts/test-ps51-syntax.ps1`

**New tests (per S7 + P4):** ~40 cases total across both phases.

**Manual smoke after install:**
- Launch packaged v2.5.30 on Alienware
- Open Services page, confirm ~250 rows render
- Disable Print Spooler (Spooler) — confirm dialog appears, after Confirm the row updates to Disabled, undo toast appears
- Click Undo toast → row returns to Automatic
- Open UndoCenter — empty (already used)
- Disable Print Spooler again, wait 8s, toast disappears — open UndoCenter, see the entry, click Undo → reverts
- Try to disable RpcSs — confirm "I understand" gate appears (do NOT actually disable)

---

## Order of Implementation (suggested task graph)

```
S1 (Get-AllServices.ps1) → S2 (Set-ServiceStartup.ps1) → S3 (Stop/Start) → S4 (IPC) → S5 (Services page) → S6 (Undo Center) → S7 (tests) → S8 (version bump + ship)
   └─ unblocks S5 (renderer needs the data)
```

Phase 2 (Processes) layers on AFTER Phase 1 ships if D1 is split. Otherwise interleaves at S2/S3 with `Get-AllProcesses.ps1` and Kill-Process integration.

Each numbered S/P step is a checkbox a subagent-driven-development run can claim and finish independently.

---

## What this plan deliberately does NOT do

- **No service creation/deletion.** (`sc.exe create` / `sc.exe delete`.) Out of scope. Greg can use sc.exe directly.
- **No service binary path editing.** Different security posture (SYSTEM-level code execution).
- **No driver service management.** Drivers (start_type=Boot/System/Auto) need different handling and have boot-loop blast radius. Filter them out of the list.
- **No process priority / affinity / suspend** (per D4 default).
- **No remote service management.** (`sc.exe \\OTHERPC ...`)
- **No "schedule a service change to fire later".** This is action UI, not autopilot UI.

If any of those become wanted, separate rev.

---

## Prompt for Implementing Subagent

```
Implement the v2.5.30 Services & Processes plan at
docs/superpowers/plans/2026-05-04-services-processes.md.
Decisions resolved: D1=<>, D2=<>, D3=<>, D4=<>.
Use superpowers:subagent-driven-development to break the S1-S8 (and
P1-P4 if in scope) tasks into independent subagent runs. Each task is
a checkbox; finish + check + commit per task. After S8 / P4 finishes,
run all 8 pre-ship gates, package the installer, and report back —
DO NOT push or release without explicit "go ship" approval.
```
