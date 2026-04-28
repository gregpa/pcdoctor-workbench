// @vitest-environment node
//
// v2.4.51 (B51-DB-1): saveForecasts wraps DELETE+INSERT in a transaction so
// a crash / SQLITE_BUSY between DELETE and the first INSERT cannot leave
// the table empty for 24h until the next forecast cycle. This test forces
// a mid-loop INSERT failure and asserts the DELETE was rolled back.

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

const proj = (overrides: Record<string, unknown> = {}) => ({
  metric: 'disk.C.free_pct',
  metric_label: 'C: drive free %',
  algorithm: 'linear_regression',
  current_value: 50,
  slope_per_day: -0.5,
  r_squared: 0.9,
  threshold_warn: 20,
  threshold_critical: 10,
  projected_warn_date: '2026-06-01',
  projected_critical_date: '2026-07-01',
  days_until_critical: 65,
  confidence: 'HIGH',
  confidence_score: 0.9,
  severity: 'important',
  ...overrides,
});

describe('saveForecasts transaction wrap (v2.4.51 B51-DB-1)', () => {
  let ds: typeof import('../../src/main/dataStore.js');

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pcd-saveforecasts-test-'));
    tempDbPath = path.join(tempDir, 'workbench.db');
    (globalThis as any).__TEST_DB_PATH__ = tempDbPath;
    vi.resetModules();
    ds = await import('../../src/main/dataStore.js');
  });

  afterEach(() => {
    try { ds.closeDb(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('case 1: happy path — replaces previous set', () => {
    ds.saveForecasts({ generated_at: 1700000000, projections: [proj({ metric: 'm1' }), proj({ metric: 'm2' })] });
    let loaded = ds.loadForecasts();
    expect(loaded?.projections.length).toBe(2);

    ds.saveForecasts({ generated_at: 1700100000, projections: [proj({ metric: 'm3' })] });
    loaded = ds.loadForecasts();
    expect(loaded?.projections.length).toBe(1);
    expect(loaded?.projections[0].metric).toBe('m3');
  });

  it('case 2: an INSERT mid-loop throwing rolls back the DELETE — prior rows remain', () => {
    // Seed two rows.
    ds.saveForecasts({ generated_at: 1700000000, projections: [proj({ metric: 'old1' }), proj({ metric: 'old2' })] });
    expect(ds.loadForecasts()?.projections.length).toBe(2);

    // Inject a bad projection that throws inside JSON.stringify (circular ref).
    const bad: any = { metric: 'bad', preventive_action: { action_name: 'flush_dns' } };
    bad.self = bad; // circular
    expect(() => ds.saveForecasts({ generated_at: 1700050000, projections: [proj({ metric: 'goodA' }), bad] })).toThrow();

    // Pre-2.4.51: DELETE ran, first INSERT succeeded, second INSERT threw,
    // and forecasts table was left with only 'goodA'. With the transaction
    // wrap, the DELETE rolls back and the original two rows are still there.
    const loaded = ds.loadForecasts();
    expect(loaded?.projections.length).toBe(2);
    const metrics = loaded!.projections.map(p => p.metric).sort();
    expect(metrics).toEqual(['old1', 'old2']);
  });
});
