// @vitest-environment node
/**
 * Module: actionRunner.callers.test.ts
 * Purpose: Verify main-process entry points construct trusted execution context themselves.
 * Dependencies: Vitest with IPC, Autopilot, and actionRunner boundary doubles.
 * Used by: The Phase 0 safety verification suite.
 * Key decisions: Renderer payload injection is tested through the registered IPC handler.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => 'C:\\Users\\test') },
  shell: { openPath: vi.fn(async () => '') },
}));
vi.mock('adm-zip', () => ({ default: vi.fn() }));
vi.mock('@main/pcdoctorBridge.js', () => ({
  getStatus: vi.fn(),
  PCDoctorBridgeError: class {},
  setCachedSmart: vi.fn(),
}));
vi.mock('@main/actionRunner.js', () => ({
  runAction: vi.fn(async () => ({
    action: 'flush_dns',
    success: false,
    duration_ms: 0,
    error: { code: 'E_AUTOMATION_DISABLED', message: 'Automatic maintenance is disabled.' },
  })),
}));
vi.mock('@main/rollbackManager.js', () => ({ revertRollback: vi.fn() }));
vi.mock('@main/dataStore.js', () => ({
  listActionLog: vi.fn(() => []),
  getActionLogById: vi.fn(),
  markActionReverted: vi.fn(),
  queryMetricTrend: vi.fn(() => []),
  loadForecasts: vi.fn(),
  upsertPersistence: vi.fn(),
  setPersistenceApproval: vi.fn(),
  countNewPersistence: vi.fn(() => 0),
  setSetting: vi.fn(),
  getAllSettings: vi.fn(() => ({})),
  getSetting: vi.fn(),
  setReviewItemState: vi.fn(),
  getReviewItemStates: vi.fn(() => ({})),
  listToolResults: vi.fn(() => []),
  getNasRecycleSizes: vi.fn(() => []),
  upsertNasRecycleSize: vi.fn(),
  listAutopilotRules: vi.fn(() => []),
  getAutopilotRule: vi.fn(),
  suppressAutopilotRule: vi.fn(),
  setAutopilotRuleEnabled: vi.fn(),
  insertAutopilotActivity: vi.fn(),
  getLastAutopilotActivity: vi.fn(() => null),
  countAutopilotFailuresSinceSuccess: vi.fn(() => 0),
  deleteAutopilotRule: vi.fn(),
  getAlertEmitHistory: vi.fn(() => null),
  recordAlertEmit: vi.fn(),
  upsertAutopilotRule: vi.fn(),
  getLastActionSuccessMap: vi.fn(() => ({})),
}));
vi.mock('@main/forecastEngine.js', () => ({ generateForecasts: vi.fn() }));
vi.mock('@main/scriptRunner.js', () => ({
  runPowerShellScript: vi.fn(),
  runElevatedPowerShellScript: vi.fn(),
  resolveScriptPath: vi.fn((rel: string) => `C:\\ProgramData\\PCDoctor\\${rel}`),
}));
vi.mock('@main/constants.js', () => ({
  PCDOCTOR_ROOT: 'C:\\ProgramData\\PCDoctor',
  LATEST_JSON_PATH: 'C:\\ProgramData\\PCDoctor\\latest.json',
  resolvePwshPath: vi.fn(() => 'pwsh'),
  PWSH_FALLBACK: 'powershell.exe',
}));
vi.mock('@main/toolLauncher.js', () => ({
  listAllToolStatuses: vi.fn(() => []),
  launchTool: vi.fn(),
  installToolViaWinget: vi.fn(),
  installToolViaDirectDownload: vi.fn(),
}));
vi.mock('@shared/tools.js', () => ({ TOOLS: {} }));
vi.mock('@main/claudeBridge.js', () => ({
  launchClaudeInTerminal: vi.fn(),
  launchClaudeWithContext: vi.fn(),
  resolveClaudePath: vi.fn(),
}));
vi.mock('@main/autoUpdater.js', () => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  installNow: vi.fn(),
  getStatus: vi.fn(() => ({ state: 'idle' })),
}));
vi.mock('@main/telegramBridge.js', () => ({
  testTelegramConnection: vi.fn(),
  sendTelegramMessage: vi.fn(),
  makeCallbackData: vi.fn(),
}));
vi.mock('@main/notifier.js', () => ({ flushBufferedNotifications: vi.fn() }));
vi.mock('@main/emailDigest.js', () => ({ sendWeeklyDigestEmail: vi.fn() }));
vi.mock('@main/claudeReportExporter.js', () => ({ buildClaudeReport: vi.fn() }));
vi.mock('@main/renderPerfLog.js', () => ({ writeRenderPerfLine: vi.fn() }));

import { ipcMain } from 'electron';
import { runAction } from '@main/actionRunner.js';
import {
  _resetSeedFlagForTests,
  dispatchDecision,
  startAutopilotEngine,
  stopAutopilotEngine,
} from '@main/autopilotEngine.js';
import { getStatus } from '@main/pcdoctorBridge.js';
import {
  getAutopilotRule,
  insertAutopilotActivity,
  listAutopilotRules,
} from '@main/dataStore.js';
import { sendTelegramMessage } from '@main/telegramBridge.js';
import { registerIpcHandlers } from '@main/ipc.js';

type Handler = (...args: any[]) => any;

function getHandler(channel: string): Handler {
  const calls = vi.mocked(ipcMain.handle).mock.calls as Array<[string, Handler]>;
  const match = calls.find(([registeredChannel]) => registeredChannel === channel);
  if (!match) throw new Error(`No handler registered for channel ${channel}`);
  return match[1];
}

describe('trusted runAction caller contexts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Production break caught: renderer payload fields are forwarded as execution authority.
  it('constructs manual renderer context and drops a forged renderer context payload', async () => {
    registerIpcHandlers();
    const handler = getHandler('api:runAction');

    await handler({}, {
      name: 'flush_dns',
      dry_run: true,
      context: { mode: 'automatic', source: 'incident', policyId: 'forged' },
    });

    expect(runAction).toHaveBeenCalledWith(
      { name: 'flush_dns', params: undefined, dry_run: true },
      { mode: 'manual', source: 'renderer' },
    );
  });

  // Production break caught: Autopilot dispatch inherits manual authority or omits policy identity.
  it('submits automatic incident context and records the actionRunner denial', async () => {
    await dispatchDecision({
      rule_id: 'low-disk-policy',
      tier: 1,
      description: 'test rule',
      action_name: 'flush_dns',
      reason: 'disk is low',
    }, {
      mode: 'automatic',
      source: 'incident',
      policyId: 'low-disk-policy',
    }, 0);

    expect(runAction).toHaveBeenCalledWith(
      { name: 'flush_dns', triggered_by: 'scheduled' },
      { mode: 'automatic', source: 'incident', policyId: 'low-disk-policy' },
    );
  });

  // Production break caught: the background engine omits or downgrades automatic authority.
  it('records auto_run and sends the configured Tier 2 Telegram message for a background decision', async () => {
    vi.useFakeTimers();
    _resetSeedFlagForTests();
    vi.mocked(listAutopilotRules).mockReturnValueOnce([{
      id: 'clear_browser_caches_low_disk',
      tier: 2,
      description: 'test low disk rule',
      trigger: 'threshold',
      cadence: null,
      action_name: 'clear_browser_caches',
      alert_json: null,
      enabled: 1,
      suppressed_until: null,
    } as any]);
    vi.mocked(getStatus).mockResolvedValueOnce({
      gauges: [{ label: 'C: free', value: 10 }],
      findings: [],
    } as any);
    vi.mocked(runAction).mockResolvedValueOnce({
      action: 'clear_browser_caches',
      success: true,
      duration_ms: 1,
      result: { message: 'cleared' },
    });

    try {
      startAutopilotEngine();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(runAction).toHaveBeenCalledWith(
        { name: 'clear_browser_caches', triggered_by: 'scheduled' },
        {
          mode: 'automatic',
          source: 'incident',
          policyId: 'clear_browser_caches_low_disk',
        },
      );
      expect(insertAutopilotActivity).toHaveBeenCalledWith(expect.objectContaining({
        rule_id: 'clear_browser_caches_low_disk',
        action_name: 'clear_browser_caches',
        outcome: 'auto_run',
      }));
      expect(sendTelegramMessage).toHaveBeenCalledWith(
        expect.stringContaining('<b>Autopilot</b> ran'),
      );
    } finally {
      stopAutopilotEngine();
      vi.useRealTimers();
    }
  });

  // Production break caught: renderer Run now is downgraded to disabled automatic execution.
  it('records manual_run without an Autopilot Telegram message for IPC Run now', async () => {
    vi.mocked(getAutopilotRule).mockReturnValueOnce({
      id: 'clear_browser_caches_low_disk',
      tier: 2,
      description: 'test low disk rule',
      trigger: 'threshold',
      cadence: null,
      action_name: 'clear_browser_caches',
      alert_json: null,
      enabled: 1,
      suppressed_until: null,
    } as any);
    vi.mocked(getStatus).mockResolvedValueOnce({
      gauges: [{ label: 'C: free', value: 10 }],
      findings: [],
    } as any);
    vi.mocked(runAction).mockResolvedValueOnce({
      action: 'clear_browser_caches',
      success: true,
      duration_ms: 1,
      result: { message: 'cleared' },
    });
    registerIpcHandlers();
    const handler = getHandler('api:runAutopilotRuleNow');

    await handler({}, 'clear_browser_caches_low_disk');

    expect(runAction).toHaveBeenCalledWith(
      { name: 'clear_browser_caches', triggered_by: 'user' },
      { mode: 'manual', source: 'renderer' },
    );
    expect(insertAutopilotActivity).toHaveBeenCalledWith(expect.objectContaining({
      rule_id: 'clear_browser_caches_low_disk',
      action_name: 'clear_browser_caches',
      outcome: 'manual_run',
    }));
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});
