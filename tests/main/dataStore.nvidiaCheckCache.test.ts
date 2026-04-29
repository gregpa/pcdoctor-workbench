// @vitest-environment node
// Tests for v2.5.9 (B4): nvidia_check_cache key in workbench_settings.
// Verifies setSetting/getAllSettings round-trip and that the key is present
// in getAllSettings output (i.e. no silent drop). The W1 bug -- key absent
// from RENDERER_SAFE_KEYS -- was caught by code review; this test catches a
// regression where the key is removed from the allowlist or the persistence
// layer silently drops it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/main/constants.js', () => ({
  get WORKBENCH_DB_PATH() { return (globalThis as any).__TEST_DB_PATH__; },
  PCDOCTOR_ROOT: 'C:\\ProgramData\\PCDoctor',
  LATEST_JSON_PATH: 'C:\\ProgramData\\PCDoctor\\reports\\latest.json',
  LOG_DIR: 'C:\\ProgramData\\PCDoctor\\logs',
  resolvePwshPath: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  PWSH_FALLBACK: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  DEFAULT_SCRIPT_TIMEOUT_MS: 300_000,
  AUTOSTART_TASK_NAME: 'PCDoctor-Workbench-Autostart',
  POLL_INTERVAL_MS: 60_000,
}));

describe('nvidia_check_cache settings round-trip (v2.5.9 B4)', () => {
  let ds: typeof import('../../src/main/dataStore.js');
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pcd-nv-cache-test-'));
    (globalThis as any).__TEST_DB_PATH__ = path.join(tempDir, 'workbench.db');
    vi.resetModules();
    ds = await import('../../src/main/dataStore.js');
  });

  afterEach(() => {
    try { ds.closeDb(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('setSetting nvidia_check_cache then getSetting returns the value', () => {
    const payload = JSON.stringify({ installed: '560.94', latest: '572.83', ts: 1714000000000 });
    ds.setSetting('nvidia_check_cache', payload);
    expect(ds.getSetting('nvidia_check_cache')).toBe(payload);
  });

  it('nvidia_check_cache appears in getAllSettings after being written', () => {
    const payload = JSON.stringify({ installed: '560.94', latest: '572.83', ts: 1714000000000 });
    ds.setSetting('nvidia_check_cache', payload);
    const all = ds.getAllSettings();
    expect(all['nvidia_check_cache']).toBe(payload);
  });

  it('upsert: writing nvidia_check_cache twice keeps only the latest value', () => {
    ds.setSetting('nvidia_check_cache', 'first');
    ds.setSetting('nvidia_check_cache', 'second');
    expect(ds.getSetting('nvidia_check_cache')).toBe('second');
    const all = ds.getAllSettings();
    const nvidiaEntries = Object.keys(all).filter(k => k === 'nvidia_check_cache');
    expect(nvidiaEntries).toHaveLength(1);
  });

  it('nvidia_check_cache does not bleed into other settings keys', () => {
    ds.setSetting('nvidia_check_cache', 'nv-value');
    ds.setSetting('telegram_enabled', '1');
    const all = ds.getAllSettings();
    expect(all['nvidia_check_cache']).toBe('nv-value');
    expect(all['telegram_enabled']).toBe('1');
    expect(Object.keys(all)).toHaveLength(2);
  });
});
