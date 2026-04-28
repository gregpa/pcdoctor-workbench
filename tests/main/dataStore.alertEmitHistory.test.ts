// @vitest-environment node
//
// v2.4.49 (B49-NOTIF-1): tests for getAlertEmitHistory and recordAlertEmit
// against a real in-memory SQLite DB (same pattern as
// dataStore.failuresSinceSuccess.test.ts).
//
// The notifier.dedup.test.ts exercises the engine-layer dedup gate with a
// mock Map, but never touches the actual DB UPSERT. These tests verify:
//   1. getAlertEmitHistory returns null when no row exists.
//   2. recordAlertEmit inserts a new row that getAlertEmitHistory returns.
//   3. recordAlertEmit with a different ts + same key UPSERTS (replaces) the
//      row, not appends a second row.
//   4. recordAlertEmit with a different signature updates the signature column.
//   5. Two distinct (rule_id, event_key) pairs are tracked independently.
//
// This catches a broken UPSERT (e.g. INSERT OR REPLACE replaced the wrong
// columns, or the PRIMARY KEY constraint wasn't created by runMigrations).

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

describe('getAlertEmitHistory + recordAlertEmit (v2.4.49 B49-NOTIF-1 DB layer)', () => {
  let ds: typeof import('../../src/main/dataStore.js');
  const RULE = 'alert_action_repeated_failures';
  const KEY  = 'alert_action_repeated_failures';
  const SIG1 = 'abc123def456abc123def456'; // 24-char hex-like signature
  const SIG2 = 'ffffeeeedddcccbbbaaa9998'; // different signature

  beforeEach(async () => {
    tempDir    = mkdtempSync(path.join(os.tmpdir(), 'pcd-aeh-test-'));
    tempDbPath = path.join(tempDir, 'workbench.db');
    (globalThis as any).__TEST_DB_PATH__ = tempDbPath;
    vi.resetModules();
    ds = await import('../../src/main/dataStore.js');
  });

  afterEach(() => {
    try { ds.closeDb(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('case 1: getAlertEmitHistory returns null when no row exists', () => {
    expect(ds.getAlertEmitHistory(RULE, KEY)).toBeNull();
  });

  it('case 2: recordAlertEmit inserts a row; getAlertEmitHistory returns it with correct fields', () => {
    const ts = 1_700_000_000_000;
    ds.recordAlertEmit(RULE, KEY, ts, SIG1);
    const row = ds.getAlertEmitHistory(RULE, KEY);
    expect(row).not.toBeNull();
    expect(row!.rule_id).toBe(RULE);
    expect(row!.event_key).toBe(KEY);
    expect(row!.last_ts).toBe(ts);
    expect(row!.last_state_signature).toBe(SIG1);
  });

  it('case 3: second recordAlertEmit with newer ts replaces the row (UPSERT, not append)', () => {
    const ts1 = 1_700_000_000_000;
    const ts2 = 1_700_090_000_000; // 25h later
    ds.recordAlertEmit(RULE, KEY, ts1, SIG1);
    ds.recordAlertEmit(RULE, KEY, ts2, SIG1);
    const row = ds.getAlertEmitHistory(RULE, KEY);
    // Must be exactly one row (UPSERT replaced), not two.
    expect(row!.last_ts).toBe(ts2);
    expect(row!.last_state_signature).toBe(SIG1);
  });

  it('case 4: recordAlertEmit with a changed signature updates the signature column', () => {
    const ts = 1_700_000_000_000;
    ds.recordAlertEmit(RULE, KEY, ts, SIG1);
    ds.recordAlertEmit(RULE, KEY, ts + 1000, SIG2);
    const row = ds.getAlertEmitHistory(RULE, KEY);
    expect(row!.last_state_signature).toBe(SIG2);
  });

  it('case 5: two distinct (rule_id, event_key) pairs are tracked independently', () => {
    const RULE2 = 'alert_defs_stale';
    const ts1   = 1_700_000_000_000;
    const ts2   = 1_700_005_000_000;
    ds.recordAlertEmit(RULE,  KEY, ts1, SIG1);
    ds.recordAlertEmit(RULE2, KEY, ts2, SIG2);
    const r1 = ds.getAlertEmitHistory(RULE,  KEY);
    const r2 = ds.getAlertEmitHistory(RULE2, KEY);
    expect(r1!.last_ts).toBe(ts1);
    expect(r1!.last_state_signature).toBe(SIG1);
    expect(r2!.last_ts).toBe(ts2);
    expect(r2!.last_state_signature).toBe(SIG2);
    // RULE2 row doesn't clobber RULE row.
    expect(ds.getAlertEmitHistory(RULE, KEY)!.last_ts).toBe(ts1);
  });
});
