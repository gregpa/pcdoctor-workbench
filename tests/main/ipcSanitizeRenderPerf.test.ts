// @vitest-environment node
/**
 * Tests for the sanitizeRenderPerfInput() pure function extracted from
 * src/main/ipc.ts `api:logRenderPerf` handler (v2.4.38).
 *
 * Full registerIpcHandlers() is not called here -- that would require mocking
 * ~15 heavy main-process modules. We test only the validation logic.
 *
 * Mock strategy: mock every module imported at the top of ipc.ts that would
 * fail to load in a node test environment (electron, native modules, etc.).
 * sanitizeRenderPerfInput is a pure function so it only touches its argument.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Stub every heavy/native import that ipc.ts pulls in ───────────────────
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
}));
vi.mock('adm-zip', () => ({ default: vi.fn() }));
vi.mock('@main/pcdoctorBridge.js', () => ({ getStatus: vi.fn(), PCDoctorBridgeError: class {}, setCachedSmart: vi.fn() }));
vi.mock('@main/actionRunner.js', () => ({ runAction: vi.fn() }));
vi.mock('@main/rollbackManager.js', () => ({ revertRollback: vi.fn() }));
vi.mock('@main/dataStore.js', () => ({
  listActionLog: vi.fn(() => []), getActionLogById: vi.fn(), markActionReverted: vi.fn(),
  queryMetricTrend: vi.fn(() => []), loadForecasts: vi.fn(), upsertPersistence: vi.fn(),
  setPersistenceApproval: vi.fn(), countNewPersistence: vi.fn(() => 0),
  setSetting: vi.fn(), getAllSettings: vi.fn(() => ({})), getSetting: vi.fn(),
  setReviewItemState: vi.fn(), getReviewItemStates: vi.fn(() => ({})),
  listToolResults: vi.fn(() => []),
  listAutopilotRules: vi.fn(() => []), getAutopilotRule: vi.fn(),
  suppressAutopilotRule: vi.fn(), setAutopilotRuleEnabled: vi.fn(),
  insertAutopilotActivity: vi.fn(), getLastActionSuccessMap: vi.fn(() => ({})),
}));
vi.mock('@main/forecastEngine.js', () => ({ generateForecasts: vi.fn() }));
vi.mock('@main/scriptRunner.js', () => ({ runPowerShellScript: vi.fn(), runElevatedPowerShellScript: vi.fn() }));
vi.mock('@main/constants.js', () => ({ PCDOCTOR_ROOT: '/tmp/pcdoctor' }));
vi.mock('@main/toolLauncher.js', () => ({ listAllToolStatuses: vi.fn(() => []), launchTool: vi.fn(), installToolViaWinget: vi.fn(), installToolViaDirectDownload: vi.fn() }));
vi.mock('@shared/tools.js', () => ({ TOOLS: {} }));
vi.mock('@main/claudeBridge.js', () => ({ launchClaudeInTerminal: vi.fn(), launchClaudeWithContext: vi.fn(), resolveClaudePath: vi.fn() }));
vi.mock('@main/autoUpdater.js', () => ({ checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), installNow: vi.fn(), getStatus: vi.fn(() => ({ state: 'idle' })) }));
vi.mock('@main/telegramBridge.js', () => ({ testTelegramConnection: vi.fn(), sendTelegramMessage: vi.fn(), makeCallbackData: vi.fn() }));
vi.mock('@main/notifier.js', () => ({ flushBufferedNotifications: vi.fn() }));
vi.mock('@main/emailDigest.js', () => ({ sendWeeklyDigestEmail: vi.fn() }));
vi.mock('@main/claudeReportExporter.js', () => ({ buildClaudeReport: vi.fn() }));
vi.mock('@main/autopilotEngine.js', () => ({ getAutopilotActivity: vi.fn(() => []), evaluateRule: vi.fn(), dispatchDecision: vi.fn() }));
vi.mock('@main/renderPerfLog.js', () => ({ writeRenderPerfLine: vi.fn() }));

import { sanitizeRenderPerfInput } from '@main/ipc.js';

// ── Phase field ────────────────────────────────────────────────────────────

describe('sanitizeRenderPerfInput: phase field', () => {
  it('passes through a normal string phase unchanged', () => {
    const r = sanitizeRenderPerfInput({ phase: 'render', duration_ms: 10 });
    expect(r?.phase).toBe('render');
  });

  it('clamps phase longer than 64 chars to exactly 64 chars', () => {
    const long = 'x'.repeat(100);
    const r = sanitizeRenderPerfInput({ phase: long, duration_ms: 10 });
    expect(r?.phase).toHaveLength(64);
    expect(r?.phase).toBe(long.slice(0, 64));
  });

  it('falls back to "unknown" when phase is a number', () => {
    const r = sanitizeRenderPerfInput({ phase: 42, duration_ms: 10 });
    expect(r?.phase).toBe('unknown');
  });

  it('falls back to "unknown" when phase is null', () => {
    const r = sanitizeRenderPerfInput({ phase: null, duration_ms: 10 });
    expect(r?.phase).toBe('unknown');
  });

  it('falls back to "unknown" when phase key is absent', () => {
    const r = sanitizeRenderPerfInput({ duration_ms: 10 });
    expect(r?.phase).toBe('unknown');
  });
});

// ── Duration field ─────────────────────────────────────────────────────────

describe('sanitizeRenderPerfInput: duration field', () => {
  it('passes through a finite number duration unchanged', () => {
    const r = sanitizeRenderPerfInput({ phase: 'p', duration_ms: 55.5 });
    expect(r?.duration).toBe(55.5);
  });

  it('coerces Infinity to 0', () => {
    const r = sanitizeRenderPerfInput({ phase: 'p', duration_ms: Infinity });
    expect(r?.duration).toBe(0);
  });

  it('coerces NaN to 0', () => {
    const r = sanitizeRenderPerfInput({ phase: 'p', duration_ms: NaN });
    expect(r?.duration).toBe(0);
  });

  it('coerces a string duration to 0', () => {
    const r = sanitizeRenderPerfInput({ phase: 'p', duration_ms: '123' });
    expect(r?.duration).toBe(0);
  });
});

// ── Extra field ────────────────────────────────────────────────────────────

describe('sanitizeRenderPerfInput: extra field', () => {
  it('returns extra as undefined when extra is absent', () => {
    const r = sanitizeRenderPerfInput({ phase: 'p', duration_ms: 1 });
    expect(r?.extra).toBeUndefined();
  });

  it('returns extra as undefined when extra is a string', () => {
    const r = sanitizeRenderPerfInput({ phase: 'p', duration_ms: 1, extra: 'oops' });
    expect(r?.extra).toBeUndefined();
  });

  it('returns extra as undefined when extra is an array (arrays are objects in JS)', () => {
    const r = sanitizeRenderPerfInput({ phase: 'p', duration_ms: 1, extra: ['a', 'b'] });
    expect(r?.extra).toBeUndefined();
  });

  it('passes through string, number, and boolean values from a valid extra object', () => {
    const r = sanitizeRenderPerfInput({
      phase: 'p', duration_ms: 1,
      extra: { label: 'dash', count: 7, active: false },
    });
    expect(r?.extra).toEqual({ label: 'dash', count: 7, active: false });
  });

  it('strips nested object values from extra', () => {
    const r = sanitizeRenderPerfInput({
      phase: 'p', duration_ms: 1,
      extra: { ok: 'yes', nested: { deep: true } },
    });
    expect(r?.extra).toEqual({ ok: 'yes' });
    expect((r?.extra as any)?.nested).toBeUndefined();
  });

  it('strips nested array values from extra', () => {
    const r = sanitizeRenderPerfInput({
      phase: 'p', duration_ms: 1,
      extra: { ok: 1, bad: [1, 2, 3] },
    });
    expect(r?.extra).toEqual({ ok: 1 });
  });

  it('clamps extra string values to 256 chars', () => {
    const long = 'z'.repeat(300);
    const r = sanitizeRenderPerfInput({
      phase: 'p', duration_ms: 1,
      extra: { msg: long },
    });
    expect((r?.extra as any)?.msg).toHaveLength(256);
  });
});

// ── Null / non-object raw payload ──────────────────────────────────────────

describe('sanitizeRenderPerfInput: non-object raw input returns null', () => {
  it('returns null for null input', () => {
    expect(sanitizeRenderPerfInput(null)).toBeNull();
  });

  it('returns null for string input', () => {
    expect(sanitizeRenderPerfInput('bad')).toBeNull();
  });

  it('returns null for number input', () => {
    expect(sanitizeRenderPerfInput(42)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(sanitizeRenderPerfInput(undefined)).toBeNull();
  });
});
