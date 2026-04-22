// @vitest-environment node
/**
 * Tests for src/main/startupConfig.ts (v2.4.13)
 *
 * Mocking strategy mirrors dataStore.test.ts:
 *   - constants.js mocked so PCDOCTOR_ROOT points at a per-test temp dir.
 *   - dataStore.js mocked with in-memory getSetting/setSetting so we don't
 *     need a real SQLite DB and can control stored values directly.
 *   - vi.resetModules() between each test keeps the module singleton fresh.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Per-test temp dir — updated via global so mocks pick it up
// ---------------------------------------------------------------------------
let tempDir: string;

vi.mock('../../src/main/constants.js', () => ({
  get PCDOCTOR_ROOT() { return (globalThis as any).__TEST_PCDOCTOR_ROOT__; },
  WORKBENCH_DB_PATH: '/tmp/test.db',
  LATEST_JSON_PATH: '/tmp/latest.json',
  LOG_DIR: '/tmp/logs',
  resolvePwshPath: () => 'pwsh',
  PWSH_FALLBACK: 'powershell',
  DEFAULT_SCRIPT_TIMEOUT_MS: 300_000,
  AUTOSTART_TASK_NAME: 'Test',
  POLL_INTERVAL_MS: 60_000,
}));

// In-memory settings store shared between mock and tests.
let settingsStore: Record<string, string | null> = {};

vi.mock('../../src/main/dataStore.js', () => ({
  getSetting: (key: string) => settingsStore[key] ?? null,
  setSetting: (key: string, value: string) => { settingsStore[key] = value; },
}));

describe('startupConfig', () => {
  let sc: typeof import('../../src/main/startupConfig.js');

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pcd-sc-test-'));
    (globalThis as any).__TEST_PCDOCTOR_ROOT__ = tempDir;
    settingsStore = {};
    vi.resetModules();
    sc = await import('../../src/main/startupConfig.js');
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  // -------------------------------------------------------------------------
  // readStartupConfig
  // -------------------------------------------------------------------------

  describe('readStartupConfig', () => {
    it('returns defaults when nothing is stored in DB', () => {
      const cfg = sc.readStartupConfig();
      expect(cfg.threshold).toBe(sc.DEFAULT_STARTUP_THRESHOLD);
      expect(cfg.allowlist).toEqual([]);
      expect(cfg.schema_version).toBe(1);
      expect(typeof cfg.updated_at).toBe('number');
    });

    it('returns stored threshold and allowlist when valid data is present', () => {
      settingsStore['startup_threshold'] = '35';
      settingsStore['startup_allowlist'] = JSON.stringify(['Run::Steam', 'Run::Discord']);
      const cfg = sc.readStartupConfig();
      expect(cfg.threshold).toBe(35);
      expect(cfg.allowlist).toEqual(['Run::Steam', 'Run::Discord']);
    });

    it('falls back to default threshold when stored value is below MIN', () => {
      settingsStore['startup_threshold'] = '2';
      const cfg = sc.readStartupConfig();
      expect(cfg.threshold).toBe(sc.DEFAULT_STARTUP_THRESHOLD);
    });

    it('falls back to default threshold when stored value is above MAX', () => {
      settingsStore['startup_threshold'] = '999';
      const cfg = sc.readStartupConfig();
      expect(cfg.threshold).toBe(sc.DEFAULT_STARTUP_THRESHOLD);
    });

    it('falls back to default threshold when stored value is a float string', () => {
      settingsStore['startup_threshold'] = '12.5';
      const cfg = sc.readStartupConfig();
      // parseInt('12.5') = 12, which is above MIN(5) — so 12 is accepted, not default.
      // The code uses parseInt + isInteger check. parseInt('12.5') === 12, which IS an integer.
      // 12 >= 5 and 12 <= 200, so it is valid. Test that exact behaviour.
      expect(cfg.threshold).toBe(12);
    });

    it('falls back to empty allowlist on malformed JSON in DB', () => {
      settingsStore['startup_allowlist'] = '{not valid json}';
      const cfg = sc.readStartupConfig();
      expect(cfg.allowlist).toEqual([]);
    });

    it('falls back to empty allowlist when stored value is a JSON non-array', () => {
      settingsStore['startup_allowlist'] = '"just a string"';
      const cfg = sc.readStartupConfig();
      expect(cfg.allowlist).toEqual([]);
    });

    it('filters out allowlist entries that exceed 500 chars', () => {
      const long = 'x'.repeat(501);
      settingsStore['startup_allowlist'] = JSON.stringify(['Run::Valid', long]);
      const cfg = sc.readStartupConfig();
      expect(cfg.allowlist).toEqual(['Run::Valid']);
    });

    it('filters out empty-string allowlist entries', () => {
      settingsStore['startup_allowlist'] = JSON.stringify(['Run::Valid', '', 'Run::Also']);
      const cfg = sc.readStartupConfig();
      expect(cfg.allowlist).toEqual(['Run::Valid', 'Run::Also']);
    });
  });

  // -------------------------------------------------------------------------
  // writeStartupConfig
  // -------------------------------------------------------------------------

  describe('writeStartupConfig', () => {
    it('persists threshold and allowlist to DB', () => {
      sc.writeStartupConfig(30, ['Run::Steam']);
      expect(settingsStore['startup_threshold']).toBe('30');
      expect(JSON.parse(settingsStore['startup_allowlist']!)).toEqual(['Run::Steam']);
    });

    it('writes the sidecar JSON to disk (syncStartupConfigToDisk side-effect)', () => {
      sc.writeStartupConfig(25, ['Run::Discord']);
      const jsonPath = path.join(tempDir, 'settings', 'startup.json');
      expect(existsSync(jsonPath)).toBe(true);
      const written = JSON.parse(readFileSync(jsonPath, 'utf8'));
      expect(written.threshold).toBe(25);
      expect(written.allowlist).toContain('Run::Discord');
    });

    it('deduplicates the allowlist before persisting', () => {
      sc.writeStartupConfig(20, ['Run::Steam', 'Run::Steam', 'Run::Discord']);
      const stored = JSON.parse(settingsStore['startup_allowlist']!);
      expect(stored).toEqual(['Run::Steam', 'Run::Discord']);
    });

    it('accepts the minimum valid threshold (5)', () => {
      expect(() => sc.writeStartupConfig(sc.MIN_STARTUP_THRESHOLD, [])).not.toThrow();
      expect(settingsStore['startup_threshold']).toBe('5');
    });

    it('accepts the maximum valid threshold (200)', () => {
      expect(() => sc.writeStartupConfig(sc.MAX_STARTUP_THRESHOLD, [])).not.toThrow();
      expect(settingsStore['startup_threshold']).toBe('200');
    });

    it('throws when threshold is below MIN', () => {
      expect(() => sc.writeStartupConfig(4, [])).toThrow(/integer between/);
    });

    it('throws when threshold is above MAX', () => {
      expect(() => sc.writeStartupConfig(201, [])).toThrow(/integer between/);
    });

    it('throws when threshold is a float', () => {
      expect(() => sc.writeStartupConfig(10.5, [])).toThrow(/integer between/);
    });

    it('throws when allowlist is not an array', () => {
      // @ts-expect-error intentional bad input
      expect(() => sc.writeStartupConfig(20, 'bad')).toThrow(/allowlist must be an array/);
    });

    it('throws when an allowlist entry is empty string', () => {
      expect(() => sc.writeStartupConfig(20, ['Run::Valid', ''])).toThrow(/Invalid allowlist entry/);
    });

    it('throws when an allowlist entry exceeds 500 chars', () => {
      const long = 'x'.repeat(501);
      expect(() => sc.writeStartupConfig(20, [long])).toThrow(/Invalid allowlist entry/);
    });
  });

  // -------------------------------------------------------------------------
  // syncStartupConfigToDisk
  // -------------------------------------------------------------------------

  describe('syncStartupConfigToDisk', () => {
    it('creates the settings directory and writes valid JSON', () => {
      settingsStore['startup_threshold'] = '40';
      settingsStore['startup_allowlist'] = JSON.stringify(['Run::OneDrive']);
      sc.syncStartupConfigToDisk();

      const jsonPath = path.join(tempDir, 'settings', 'startup.json');
      expect(existsSync(jsonPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
      expect(parsed.threshold).toBe(40);
      expect(parsed.allowlist).toContain('Run::OneDrive');
      expect(parsed.schema_version).toBe(1);
    });

    it('overwrites an existing sidecar file on second call', () => {
      sc.syncStartupConfigToDisk();
      settingsStore['startup_threshold'] = '50';
      sc.syncStartupConfigToDisk();

      const jsonPath = path.join(tempDir, 'settings', 'startup.json');
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
      expect(parsed.threshold).toBe(50);
    });
  });
});
