// @vitest-environment node
//
// v2.5.34: tests for the api:getProcessDetail IPC handler.
//
// Handler is a thin wrapper around Get-ProcessDetail.ps1: validate pid,
// spawn PS, return result. Test surface:
//   1. Bad pid (non-integer / negative) -> E_INVALID_PARAM, no PS call
//   2. Success path -> {ok:true, data: ProcessDetail}
//   3. PS throws E_PROC_NOT_FOUND -> {ok:false, error.code: E_PROC_NOT_FOUND}
//   4. PS called with -ProcessId <n> -JsonOutput

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same heavy-mock harness as ipc.listAllServices.test.ts
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => 'C:\\Users\\test') },
  shell: { openPath: vi.fn(async () => '') },
}));
vi.mock('adm-zip', () => ({ default: vi.fn() }));
vi.mock('@main/pcdoctorBridge.js', () => ({
  getStatus: vi.fn(),
  PCDoctorBridgeError: class {},
  setCachedSmart: vi.fn(),
}));
vi.mock('@main/actionRunner.js', () => ({ runAction: vi.fn() }));
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
vi.mock('@main/autopilotEngine.js', () => ({
  getAutopilotActivity: vi.fn(() => []),
  evaluateRule: vi.fn(),
  dispatchDecision: vi.fn(),
}));
vi.mock('@main/renderPerfLog.js', () => ({ writeRenderPerfLine: vi.fn() }));
vi.mock('@shared/actions.js', () => ({ ACTIONS: {} }));

import { ipcMain } from 'electron';
import { runPowerShellScript } from '@main/scriptRunner.js';
import { registerIpcHandlers } from '@main/ipc.js';
import type { ProcessDetail, IpcResult } from '@shared/types.js';

type Handler = (...args: any[]) => any;
function getHandler(channel: string): Handler {
  const calls = (ipcMain.handle as any).mock.calls as Array<[string, Handler]>;
  const match = calls.find((c) => c[0] === channel);
  if (!match) throw new Error(`No handler registered for channel ${channel}`);
  return match[1];
}

const sampleDetail: ProcessDetail = {
  pid: 4860,
  name: 'vmmemWSL',
  description: 'WSL2 memory backing process',
  path: 'C:\\Windows\\System32\\vmmemWSL.exe',
  command_line: '"C:\\Windows\\System32\\vmmemWSL.exe"',
  start_time: '2026-05-04T07:50:12.000Z',
  cpu_pct: null,
  ws_bytes: 644 * 1024 * 1024,
  pm_bytes: 600 * 1024 * 1024,
  thread_count: 8,
  handle_count: 142,
  parent_pid: 1024,
  parent_name: 'services',
  kind: 'user',
  system_critical: false,
  system_critical_reason: null,
  services_hosted: [],
};

describe('api:getProcessDetail (v2.5.34)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerIpcHandlers();
  });

  it('rejects non-integer pid with E_INVALID_PARAM and does not call PS', async () => {
    const handler = getHandler('api:getProcessDetail');
    const result = (await handler({}, 'not-a-number')) as IpcResult<ProcessDetail>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_INVALID_PARAM');
    expect(runPowerShellScript).not.toHaveBeenCalled();
  });

  it('rejects negative pid with E_INVALID_PARAM and does not call PS', async () => {
    const handler = getHandler('api:getProcessDetail');
    const result = (await handler({}, -1)) as IpcResult<ProcessDetail>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_INVALID_PARAM');
    expect(runPowerShellScript).not.toHaveBeenCalled();
  });

  it('returns ok=true with the detail object on PS success', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce(sampleDetail);
    const handler = getHandler('api:getProcessDetail');
    const result = (await handler({}, 4860)) as IpcResult<ProcessDetail>;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pid).toBe(4860);
      expect(result.data.name).toBe('vmmemWSL');
      expect(result.data.parent_name).toBe('services');
    }
  });

  it('preserves PS error code (e.g. E_PROC_NOT_FOUND) on rejection', async () => {
    const err = Object.assign(new Error('No process with PID 9999999'), { code: 'E_PROC_NOT_FOUND' });
    vi.mocked(runPowerShellScript).mockRejectedValueOnce(err);
    const handler = getHandler('api:getProcessDetail');
    const result = (await handler({}, 9999999)) as IpcResult<ProcessDetail>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('E_PROC_NOT_FOUND');
      expect(result.error.message).toContain('No process');
    }
  });

  it('uses default error code E_GET_PROCESS_DETAIL when PS throws without code', async () => {
    vi.mocked(runPowerShellScript).mockRejectedValueOnce(new Error('script crashed'));
    const handler = getHandler('api:getProcessDetail');
    const result = (await handler({}, 1234)) as IpcResult<ProcessDetail>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_GET_PROCESS_DETAIL');
  });

  it('calls Get-ProcessDetail.ps1 with -ProcessId <n> -JsonOutput', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce(sampleDetail);
    const handler = getHandler('api:getProcessDetail');
    await handler({}, 4860);
    expect(runPowerShellScript).toHaveBeenCalledTimes(1);
    const [scriptName, args] = vi.mocked(runPowerShellScript).mock.calls[0];
    expect(scriptName).toBe('Get-ProcessDetail.ps1');
    expect(args).toEqual(['-ProcessId', '4860', '-JsonOutput']);
  });
});
