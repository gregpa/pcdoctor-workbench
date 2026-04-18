# Output Validation — PCDoctor Workbench v2.1.0

**Date:** 2026-04-18
**Validator:** output-validator sub-agent (Sonnet)
**Scope:** Post-release sweep of v2.1.0 build artifacts, scripts, tests, schema, regressions

## TL;DR

**Overall: PASS** — 1 minor non-blocker (noted under "New issues").

| Category | Status | Notes |
|---|---|---|
| Build artifacts | PASS | Installer 82.4 MB, main 365 KB, preload 3.67 KB, renderer 600 KB |
| PowerShell DryRun (59 scripts) | PASS | All return `{"dry_run":true,"success":true}` |
| TypeScript compile (main + renderer) | PASS | Both tsconfigs: 0 errors |
| Vitest (11 files / 79 tests) | PASS | All green |
| SQLite schema | PASS (prospective) | 10/11 expected tables present; `tool_results` auto-created on next app start |
| Live `Invoke-PCDoctor.ps1` | PASS | Valid `latest.json` with all expected top-level keys |
| Regression spot-checks | PASS | KPI mapper, forecast engine, tool count (20), action count (47) all OK |

No critical regressions introduced by v2.1.0.

---

## 1. Build artifacts

| File | Expected | Actual | Status |
|---|---|---|---|
| `release/PCDoctor Workbench-Setup-2.1.0.exe` | exists, ~80 MB | 86,397,988 B (82.4 MB) | PASS |
| `release/PCDoctor Workbench-Setup-2.1.0.exe.blockmap` | exists | 90,116 B | PASS |
| `release/latest.yml` | exists | 364 B | PASS |
| `release/win-unpacked/` | dir | dir | PASS |
| `dist-electron/main/main.cjs` | bundled main | 365,507 B | PASS |
| `dist-electron/preload/preload.cjs` | bundled preload | 3,665 B | PASS |
| `dist-electron/package.json` | `{"type":"commonjs"}` | 25 B (present) | PASS |
| `dist/index.html` | bundled renderer entry | 538 B | PASS |
| `dist/assets/index-*.js` | one JS bundle | 599,927 B (599 KB) | PASS |
| `dist/assets/index-*.css` | one CSS bundle | 21,510 B | PASS |
| Unexpected files in `dist-electron/` | none | none | PASS |

All artifacts match shape expectations. Installer timestamp 2026-04-18 11:13 — consistent with the 2.1.0 build.

---

## 2. PowerShell scripts

Ran every script in `powershell/actions/*.ps1` (46) and `powershell/security/*.ps1` (13) with `-DryRun`. All 59 scripts:

- Exited 0
- Emitted a single JSON object
- Had `dry_run == true` AND `success == true`

**Sample output shape:**
```json
{ "success": true, "dry_run": true, "action": "<name>", ... }
```

**Per-script result:** 59/59 PASS. No failures, no unparseable output, no runtime errors.

### Catalog integrity

`src/shared/actions.ts` ACTIONS catalog:
- Total entries: **47**
- All 47 `ps_script` paths resolve to files under `powershell/` — **no missing scripts**.

Note: 47 ACTIONS entries reference 46 unique `actions/*.ps1` scripts (one script — `Install-WindowsUpdates.ps1` — is referenced by both `install_windows_updates` and `install_drivers` actions, which is intentional). Security scripts in `powershell/security/*.ps1` are not invoked via ACTIONS — they are run by `Invoke-PCDoctor.ps1` / dedicated security routes.

### Live `Invoke-PCDoctor.ps1`

Ran `pwsh Invoke-PCDoctor.ps1 -Mode Report`. Exit 0. Output `C:\ProgramData\PCDoctor\reports\latest.json` parsed successfully:

| Top-level key | Present | Sample value |
|---|---|---|
| `timestamp` | yes | ISO8601 string |
| `hostname` | yes | `ALIENWARE-R11` |
| `findings` | yes | array (6 items) |
| `metrics` | yes | object (startup_count, ram_used_pct, services, cpu_load_pct, …) |
| `summary` | yes | `{ overall: "ATTENTION", ... }` |
| `mode` | yes (bonus) | `Report` |
| `actions` | yes (bonus) | array |

All required top-level fields present.

---

## 3. TypeScript + tests

| Check | Result |
|---|---|
| `npx tsc -p tsconfig.main.json --noEmit` | PASS (exit 0, 0 errors) |
| `npx tsc -p tsconfig.renderer.json --noEmit` | PASS (exit 0, 0 errors) |
| `npx vitest run` | PASS (11 files / 79 tests) |
| `npm run build` | PASS (vite renderer + main + preload) |

### Vitest suite breakdown

```
tests/main/rollbackManager.test.ts    2 tests
tests/main/forecastEngine.test.ts    11 tests
tests/main/toolLauncher.test.ts       8 tests
tests/main/notifier.test.ts           7 tests
tests/main/pcdoctorBridge.test.ts     4 tests
tests/main/scriptRunner.test.ts       5 tests
tests/main/dataStore.test.ts         14 tests
tests/renderer/thresholds.test.ts     9 tests
tests/renderer/Gauge.test.tsx         4 tests
tests/shared/actions.test.ts          6 tests
tests/shared/tools.test.ts            9 tests
                                  -------
                                     79 tests passed
```

### Build warnings (non-errors)

Three warnings during `npm run build`, all pre-existing and not new in v2.1.0:

1. Renderer chunk size: `dist/assets/index-*.js` is 599 KB (>500 KB warn threshold). Gzipped 161 KB.
2. Vite dynamic-import-mixed-with-static-import advisory for:
   - `src/main/dataStore.ts`
   - `src/main/telegramBridge.ts`
   - `src/main/scriptRunner.ts`
   These files are imported both statically and dynamically; Vite warns the dynamic import will not move the module to its own chunk. This is cosmetic only — behavior is correct.

No new warnings introduced by v2.1.0.

---

## 4. SQLite schema

DB: `C:\ProgramData\PCDoctor\workbench.db` (1.56 MB, mtime 2026-04-18 10:41, which predates the 2.1.0 rebuild at 11:12).

| Expected table | Present |
|---|---|
| metrics | YES |
| actions_log | YES |
| rollbacks | YES |
| forecasts | YES |
| weekly_review_states | YES |
| persistence_baseline | YES |
| security_scans | YES |
| notification_log | YES |
| seen_findings | YES |
| workbench_settings | YES |
| tool_results | **NO — but schema defined with `CREATE TABLE IF NOT EXISTS` in `dataStore.ts`; will be created on next app launch** |

Plus `sqlite_sequence` (auto-managed by SQLite).

No unexpected tables. No schema errors.

**Action needed:** launch the packaged v2.1.0 app once (or run any IPC path that opens `dataStore`). The table will materialize automatically — `dataStore.ts` lines 117–126 define it with `CREATE TABLE IF NOT EXISTS tool_results (...)` plus `idx_tool_results_ts`. This is expected-first-run behavior, not a regression.

---

## 5. Regressions

**None detected.**

Spot-checks that passed:

- **Dashboard KPI mapper** — `tests/main/pcdoctorBridge.test.ts` (4 tests) exercises the fixture at `tests/fixtures/latest.sample.json`. All pass.
- **Forecast engine with empty metric history** — `tests/main/forecastEngine.test.ts` (11 tests) covers empty/minimal history paths. All pass.
- **Tool catalog count** — `src/shared/tools.ts` has exactly **20** top-level tools: `occt, hwinfo64, gpu-z, cpu-z, treesize, crystaldiskinfo, crystaldiskmark, mbam, adwcleaner, mss, autoruns, procexp, procmon, tcpview, rufus, bluescreenview, msinfo32, perfmon, eventvwr, resmon`.
- **Actions catalog count** — `src/shared/actions.ts` has **47** entries (exceeds the implied minimum; all map to real scripts).
- **Invoke-PCDoctor identical in repo and ProgramData** — `diff -q` reports no difference.

---

## 6. New issues

### (Low) `tool_results` table not yet materialized in deployed DB

- Severity: low (will self-heal on next v2.1.0 launch)
- Impact: none until first tool-import action runs; dataStore.getToolResults would return empty rather than throw
- Mitigation: none required — `CREATE TABLE IF NOT EXISTS` in `initDb()` handles this on first connection from v2.1.0. Recommend launching the app once before declaring the release "live" to surface any first-boot migration issues.

### (Informational) Renderer bundle at 599 KB

- Exceeds 500 KB soft warning
- Not a regression (pre-existing)
- Optional follow-up: `manualChunks` split or dynamic imports of heavy pages (Forecast, Security) for faster first paint

---

## 7. Baseline notes (expected-output capture for future runs)

Record these as v2.1.0 baselines to detect future drift:

| Metric | Baseline |
|---|---|
| Installer size | 82.4 MB (±5%) |
| Main bundle | 365 KB (±10%) |
| Preload bundle | 3.67 KB |
| Renderer JS bundle | 600 KB (±5%) |
| Renderer CSS bundle | 21.5 KB |
| Total test count | 79 |
| Test file count | 11 |
| ACTIONS catalog size | 47 |
| TOOLS catalog size | 20 |
| PowerShell action scripts | 46 files |
| PowerShell security scripts | 13 files |
| Expected DB tables | 11 (metrics, actions_log, rollbacks, forecasts, weekly_review_states, persistence_baseline, security_scans, notification_log, seen_findings, workbench_settings, tool_results) |
| `latest.json` top-level keys | timestamp, mode, hostname, findings, metrics, actions, summary |

If a future release trips any of these without a corresponding changelog entry, treat as a regression until proven otherwise.

---

## Verdict

**v2.1.0 ships clean.** No critical regressions, no broken scripts, no compile failures, no test failures. One cosmetic item (renderer bundle size) and one expected first-run artifact (tool_results table auto-creation) — neither blocks release.
