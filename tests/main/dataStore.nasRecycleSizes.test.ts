// @vitest-environment node
//
// v2.4.51 (B49-NAS-2): tests for the nas_recycle_sizes cache table and the
// getNasRecycleSizes / upsertNasRecycleSize helpers. Pattern mirrors
// dataStore.alertEmitHistory.test.ts: real in-memory SQLite via a temp
// path constant override.

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

describe('getNasRecycleSizes + upsertNasRecycleSize (v2.4.51 B49-NAS-2)', () => {
  let ds: typeof import('../../src/main/dataStore.js');

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pcd-nrs-test-'));
    tempDbPath = path.join(tempDir, 'workbench.db');
    (globalThis as any).__TEST_DB_PATH__ = tempDbPath;
    vi.resetModules();
    ds = await import('../../src/main/dataStore.js');
  });

  afterEach(() => {
    try { ds.closeDb(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('case 1: empty cache → getNasRecycleSizes returns empty Map', () => {
    const m = ds.getNasRecycleSizes();
    expect(m.size).toBe(0);
  });

  it('case 2: upsertNasRecycleSize inserts one row and getNasRecycleSizes returns it keyed on "M:"', () => {
    ds.upsertNasRecycleSize('M', 12345, 800);
    const m = ds.getNasRecycleSizes();
    expect(m.size).toBe(1);
    const row = m.get('M:');
    expect(row).toBeDefined();
    expect(row!.recycle_bytes).toBe(12345);
    expect(typeof row!.last_scanned_ts).toBe('number');
    expect(row!.last_scanned_ts).toBeGreaterThan(0);
  });

  it('case 3: a second upsert for the same letter UPSERTs (one row, updated values)', () => {
    ds.upsertNasRecycleSize('M', 12345, 800);
    ds.upsertNasRecycleSize('M', 99999, 1100);
    const m = ds.getNasRecycleSizes();
    expect(m.size).toBe(1);
    expect(m.get('M:')!.recycle_bytes).toBe(99999);
  });

  it('case 4: key normalization — lowercase, trailing colon, plain letter all collapse to "M:"', () => {
    ds.upsertNasRecycleSize('m', 100, null);
    const m1 = ds.getNasRecycleSizes();
    expect(m1.get('M:')!.recycle_bytes).toBe(100);

    ds.upsertNasRecycleSize('M:', 200, null);
    const m2 = ds.getNasRecycleSizes();
    expect(m2.size).toBe(1);
    expect(m2.get('M:')!.recycle_bytes).toBe(200);
  });

  it('case 5: multiple drives tracked independently', () => {
    ds.upsertNasRecycleSize('M', 1000, 50);
    ds.upsertNasRecycleSize('Z', 2000, 60);
    ds.upsertNasRecycleSize('K', 3000, null);
    const m = ds.getNasRecycleSizes();
    expect(m.size).toBe(3);
    expect(m.get('M:')!.recycle_bytes).toBe(1000);
    expect(m.get('Z:')!.recycle_bytes).toBe(2000);
    expect(m.get('K:')!.recycle_bytes).toBe(3000);
  });

  it('case 6: last_scanned_ts is the insert moment (≈ Date.now())', () => {
    const before = Date.now();
    ds.upsertNasRecycleSize('M', 42, 10);
    const after = Date.now();
    const row = ds.getNasRecycleSizes().get('M:')!;
    expect(row.last_scanned_ts).toBeGreaterThanOrEqual(before);
    expect(row.last_scanned_ts).toBeLessThanOrEqual(after);
  });
});
