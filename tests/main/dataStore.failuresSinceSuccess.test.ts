// @vitest-environment node
//
// v2.4.49 (B49-NOTIF-2): tests for countAutopilotFailuresSinceSuccess and
// the legacy countAutopilotFailuresInWindow.
//
// Pre-2.4.49 the alert_action_repeated_failures detector counted ALL errors
// in a 7-day window. Greg's box had three v2.4.45/46-era errors for
// run_smart_check_daily that long-since recovered (every subsequent run was
// auto_run/success), but the alert fired daily at 03:42 / 09:42 because the
// counter never reset. The new function counts only errors AFTER the most
// recent auto_run success, with the 7-day window preserved as a backstop.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tempDir: string;
let tempDbPath: string;

vi.mock('../../src/main/constants.js', () => {
  return {
    get WORKBENCH_DB_PATH() { return (globalThis as any).__TEST_DB_PATH__; },
    PCDOCTOR_ROOT: 'C:\\ProgramData\\PCDoctor',
    LATEST_JSON_PATH: 'C:\\ProgramData\\PCDoctor\\reports\\latest.json',
    LOG_DIR: 'C:\\ProgramData\\PCDoctor\\logs',
    resolvePwshPath: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    PWSH_FALLBACK: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    DEFAULT_SCRIPT_TIMEOUT_MS: 300_000,
    AUTOSTART_TASK_NAME: 'PCDoctor-Workbench-Autostart',
    POLL_INTERVAL_MS: 60_000,
  };
});

describe('countAutopilotFailuresSinceSuccess (v2.4.49 B49-NOTIF-2)', () => {
  let ds: typeof import('../../src/main/dataStore.js');
  const RULE = 'run_smart_check_daily';

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pcd-fss-test-'));
    tempDbPath = path.join(tempDir, 'workbench.db');
    (globalThis as any).__TEST_DB_PATH__ = tempDbPath;
    vi.resetModules();
    ds = await import('../../src/main/dataStore.js');
  });

  afterEach(() => {
    try { ds.closeDb(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('case 1: no prior activity → count 0', () => {
    expect(ds.countAutopilotFailuresSinceSuccess(RULE, 7)).toBe(0);
  });

  it('case 2: 3 errors, 0 successes → count 3', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      ds.insertAutopilotActivity({
        rule_id: RULE, tier: 1, outcome: 'error',
        message: `err ${i}`, ts: now - (3 - i) * 60_000,
      });
    }
    expect(ds.countAutopilotFailuresSinceSuccess(RULE, 7)).toBe(3);
  });

  it('case 3: 3 errors followed by 1 auto_run, then 0 errors → count 0', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      ds.insertAutopilotActivity({
        rule_id: RULE, tier: 1, outcome: 'error',
        ts: now - (10 - i) * 60_000,
      });
    }
    ds.insertAutopilotActivity({
      rule_id: RULE, tier: 1, outcome: 'auto_run',
      ts: now - 5 * 60_000,
    });
    expect(ds.countAutopilotFailuresSinceSuccess(RULE, 7)).toBe(0);
  });

  it('case 4: 3 errors → 1 auto_run → 2 errors → count 2', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      ds.insertAutopilotActivity({
        rule_id: RULE, tier: 1, outcome: 'error',
        ts: now - (20 - i) * 60_000,
      });
    }
    ds.insertAutopilotActivity({
      rule_id: RULE, tier: 1, outcome: 'auto_run',
      ts: now - 15 * 60_000,
    });
    ds.insertAutopilotActivity({
      rule_id: RULE, tier: 1, outcome: 'error',
      ts: now - 10 * 60_000,
    });
    ds.insertAutopilotActivity({
      rule_id: RULE, tier: 1, outcome: 'error',
      ts: now - 5 * 60_000,
    });
    expect(ds.countAutopilotFailuresSinceSuccess(RULE, 7)).toBe(2);
  });

  it('case 5: 5 errors all OUTSIDE the 7-day window, 0 inside → count 0 (window backstop)', () => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      ds.insertAutopilotActivity({
        rule_id: RULE, tier: 1, outcome: 'error',
        ts: eightDaysAgo - i * 60_000,
      });
    }
    expect(ds.countAutopilotFailuresSinceSuccess(RULE, 7)).toBe(0);
  });

  it('case 6: legacy countAutopilotFailuresInWindow returns 5 for the same dataset as case 5 (no window backstop on old name unless...wait, both use same window). Test the SEMANTIC difference: 3 errors + 1 success returns 0 from new fn, 3 from legacy', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      ds.insertAutopilotActivity({
        rule_id: RULE, tier: 1, outcome: 'error',
        ts: now - (10 - i) * 60_000,
      });
    }
    ds.insertAutopilotActivity({
      rule_id: RULE, tier: 1, outcome: 'auto_run',
      ts: now - 5 * 60_000,
    });
    // New: 0 (errors all predate the success).
    expect(ds.countAutopilotFailuresSinceSuccess(RULE, 7)).toBe(0);
    // Legacy: 3 (raw 7-day error count, no recovery semantic).
    expect(ds.countAutopilotFailuresInWindow(RULE, 7)).toBe(3);
  });

  it("case 7: Greg's-box reproducer — 3 errors at 4/24 18:13 / 4/24 18:14 / 4/25 01:21 followed by 5 auto_run rows in last 24h → count 0", () => {
    // Use real-ish offsets from "now" so the 7-day window matters but doesn't
    // dominate the assertion.
    const now = Date.now();
    const e1 = now - 3 * 24 * 60 * 60 * 1000 - 3 * 60 * 60 * 1000;       // ~3d3h ago
    const e2 = e1 + 60_000;                                                // 1 min later
    const e3 = now - 2.5 * 24 * 60 * 60 * 1000;                            // ~2.5d ago
    ds.insertAutopilotActivity({ rule_id: RULE, tier: 1, outcome: 'error', ts: e1 });
    ds.insertAutopilotActivity({ rule_id: RULE, tier: 1, outcome: 'error', ts: e2 });
    ds.insertAutopilotActivity({ rule_id: RULE, tier: 1, outcome: 'error', ts: e3 });
    // 5 successes in the last 24h.
    for (let i = 0; i < 5; i++) {
      ds.insertAutopilotActivity({
        rule_id: RULE, tier: 1, outcome: 'auto_run',
        ts: now - (5 - i) * 60 * 60 * 1000, // -5h, -4h, -3h, -2h, -1h
      });
    }
    expect(ds.countAutopilotFailuresSinceSuccess(RULE, 7)).toBe(0);
  });
});
