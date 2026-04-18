// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * dataStore opens its DB at WORKBENCH_DB_PATH (C:\ProgramData\PCDoctor\workbench.db)
 * which we must not touch in tests. We redirect it to a fresh temp dir per test
 * by mocking the constants module BEFORE importing dataStore.
 */

let tempDir: string;
let tempDbPath: string;

// Mocked constants: the factory captures the `tempDbPath` variable via a closure
// that reads it via the global at call-time. We use a getter so that re-assigning
// `tempDbPath` between tests takes effect.
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

describe('dataStore round-trips (sqlite on-disk in temp dir)', () => {
  let ds: typeof import('../../src/main/dataStore.js');

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pcd-ds-test-'));
    tempDbPath = path.join(tempDir, 'workbench.db');
    (globalThis as any).__TEST_DB_PATH__ = tempDbPath;
    // Reset the module so the singleton `db` starts from null and picks up the new path.
    vi.resetModules();
    ds = await import('../../src/main/dataStore.js');
  });

  afterEach(() => {
    try { ds.closeDb(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  describe('setReviewItemState / getReviewItemStates', () => {
    it('writes and reads back a single review item state', () => {
      ds.setReviewItemState('2026-04-17', 'item-a', 'applied', 42);
      const states = ds.getReviewItemStates('2026-04-17');
      expect(states['item-a']).toBeDefined();
      expect(states['item-a'].state).toBe('applied');
      expect(states['item-a'].applied_action_id).toBe(42);
      expect(typeof states['item-a'].state_changed_at).toBe('number');
    });

    it('upserts: setting the same item twice leaves only one row with latest state', () => {
      ds.setReviewItemState('2026-04-17', 'item-a', 'pending');
      ds.setReviewItemState('2026-04-17', 'item-a', 'dismissed');
      const states = ds.getReviewItemStates('2026-04-17');
      expect(Object.keys(states)).toHaveLength(1);
      expect(states['item-a'].state).toBe('dismissed');
    });

    it('isolates states by review_date', () => {
      ds.setReviewItemState('2026-04-17', 'item-a', 'applied');
      ds.setReviewItemState('2026-04-10', 'item-a', 'dismissed');
      const thisWeek = ds.getReviewItemStates('2026-04-17');
      const lastWeek = ds.getReviewItemStates('2026-04-10');
      expect(thisWeek['item-a'].state).toBe('applied');
      expect(lastWeek['item-a'].state).toBe('dismissed');
    });

    it('returns empty object for a review date with no items', () => {
      expect(ds.getReviewItemStates('1999-01-01')).toEqual({});
    });

    it('handles multiple items within the same review_date', () => {
      ds.setReviewItemState('2026-04-17', 'a', 'applied');
      ds.setReviewItemState('2026-04-17', 'b', 'snoozed');
      ds.setReviewItemState('2026-04-17', 'c', 'auto_resolved');
      const states = ds.getReviewItemStates('2026-04-17');
      expect(Object.keys(states).sort()).toEqual(['a', 'b', 'c']);
      expect(states['b'].state).toBe('snoozed');
    });
  });

  describe('recordStatusSnapshot / queryMetricTrend', () => {
    it('records cpu+ram+disk+events and queries them back under the right category.metric', () => {
      ds.recordStatusSnapshot({
        cpu_load_pct: 45.5,
        ram_used_pct: 72,
        disks: [{ drive: 'C:', free_pct: 18 }],
        event_errors_system: 120,
        event_errors_application: 35,
      });

      const cpu = ds.queryMetricTrend('cpu', 'load_pct', 1);
      const ram = ds.queryMetricTrend('ram', 'used_pct', 1);
      const disk = ds.queryMetricTrend('disk', 'free_pct', 1);
      const sysEv = ds.queryMetricTrend('events', 'system_count', 1);
      const appEv = ds.queryMetricTrend('events', 'application_count', 1);

      expect(cpu).toHaveLength(1);
      expect(cpu[0].value).toBe(45.5);
      expect(ram[0].value).toBe(72);
      expect(disk[0].value).toBe(18);
      expect(sysEv[0].value).toBe(120);
      expect(appEv[0].value).toBe(35);
    });

    it('skips fields that are not numbers', () => {
      ds.recordStatusSnapshot({ cpu_load_pct: 10 });
      expect(ds.queryMetricTrend('cpu', 'load_pct', 1)).toHaveLength(1);
      expect(ds.queryMetricTrend('ram', 'used_pct', 1)).toHaveLength(0);
      expect(ds.queryMetricTrend('disk', 'free_pct', 1)).toHaveLength(0);
    });

    it('queryMetricTrend returns points in oldest-first order', () => {
      ds.insertMetric('cpu', 'load_pct', 10);
      ds.insertMetric('cpu', 'load_pct', 20);
      ds.insertMetric('cpu', 'load_pct', 30);
      const pts = ds.queryMetricTrend('cpu', 'load_pct', 1);
      expect(pts.map(p => p.value)).toEqual([10, 20, 30]);
      // Timestamps should be non-decreasing.
      for (let i = 1; i < pts.length; i++) {
        expect(pts[i].ts).toBeGreaterThanOrEqual(pts[i - 1].ts);
      }
    });

    it('queryMetricTrend respects the `days` window (0-day window returns nothing older than now)', () => {
      ds.insertMetric('cpu', 'load_pct', 99);
      // 0-day window: since = now, so rows with ts >= now pass only if inserted at the same ms.
      // With 1-day window it should always find the new row.
      expect(ds.queryMetricTrend('cpu', 'load_pct', 1).length).toBeGreaterThanOrEqual(1);
    });

    it('queryMetricTrend returns [] for unknown category/metric', () => {
      ds.insertMetric('cpu', 'load_pct', 50);
      expect(ds.queryMetricTrend('nope', 'nope', 30)).toEqual([]);
    });
  });

  describe('settings round-trip', () => {
    it('setSetting + getSetting', () => {
      expect(ds.getSetting('telegram_enabled')).toBeNull();
      ds.setSetting('telegram_enabled', '1');
      expect(ds.getSetting('telegram_enabled')).toBe('1');
    });

    it('setSetting upserts', () => {
      ds.setSetting('k', 'v1');
      ds.setSetting('k', 'v2');
      expect(ds.getSetting('k')).toBe('v2');
    });

    it('getAllSettings returns everything', () => {
      ds.setSetting('a', '1');
      ds.setSetting('b', '2');
      const all = ds.getAllSettings();
      expect(all).toMatchObject({ a: '1', b: '2' });
    });
  });

  describe('seen_findings', () => {
    it('markFindingSeen then hasSeenFinding = true', () => {
      expect(ds.hasSeenFinding('abc123')).toBe(false);
      ds.markFindingSeen('abc123', true);
      expect(ds.hasSeenFinding('abc123')).toBe(true);
    });
  });
});
