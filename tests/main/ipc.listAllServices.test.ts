// @vitest-environment node
//
// v2.5.30: tests for the api:listAllServices IPC handler.
//
// Handler is a thin pass-through: spawn Get-AllServices.ps1, unwrap the
// { services, count } envelope, return the services array as IpcResult.
// Test surface is small but worth locking:
//   1. success path — PS returns { success, services, count } -> handler
//      returns { ok: true, data: ServiceRow[] }.
//   2. failure path — PS throws -> handler returns { ok: false, error }
//      with a recognizable code.
//   3. shape preservation — load_bearing flag and dependency arrays make
//      it through unmolested.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Heavy-mock harness mirrored from tests/main/ipc.lhmPath.test.ts ────────
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
import type { ServiceRow, IpcResult } from '@shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (...args: any[]) => any;

function getHandler(channel: string): Handler {
  // ipcMain.handle is a vi.fn; pull the latest registered handler.
  const calls = (ipcMain.handle as any).mock.calls as Array<[string, Handler]>;
  const match = calls.find((c) => c[0] === channel);
  if (!match) throw new Error(`No handler registered for channel ${channel}`);
  return match[1];
}

// PS payload shape returned by Get-AllServices.ps1.
function makePsPayload(services: ServiceRow[]) {
  return { success: true, services, count: services.length, duration_ms: 600 };
}

const sampleServices: ServiceRow[] = [
  {
    key: 'Spooler',
    display: 'Print Spooler',
    status: 'Running',
    start_type: 'Automatic',
    binary_path: 'C:\\WINDOWS\\System32\\spoolsv.exe',
    description: 'This service spools print jobs.',
    depends_on: ['RPCSS', 'http'],
    dependents: ['Fax'],
    load_bearing: false,
    load_bearing_reason: null,
  },
  {
    key: 'RpcSs',
    display: 'Remote Procedure Call (RPC)',
    status: 'Running',
    start_type: 'Automatic',
    binary_path: 'C:\\WINDOWS\\system32\\svchost.exe',
    description: 'The RPCSS service is the Service Control Manager for COM/DCOM servers.',
    depends_on: ['DcomLaunch', 'RpcEptMapper'],
    dependents: ['Spooler', 'Themes'],
    load_bearing: true,
    load_bearing_reason: 'Remote Procedure Call (RPC) — disabling halts virtually every other service.',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('api:listAllServices (v2.5.30)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerIpcHandlers();
  });

  it('returns ok=true with the services array on PS success', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce(makePsPayload(sampleServices));
    const handler = getHandler('api:listAllServices');

    const result = (await handler({})) as IpcResult<ServiceRow[]>;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0].key).toBe('Spooler');
      expect(result.data[1].key).toBe('RpcSs');
    }
  });

  it('preserves load_bearing flag and reason text through the handler', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce(makePsPayload(sampleServices));
    const handler = getHandler('api:listAllServices');

    const result = (await handler({})) as IpcResult<ServiceRow[]>;
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rpc = result.data.find((s) => s.key === 'RpcSs');
      expect(rpc?.load_bearing).toBe(true);
      expect(rpc?.load_bearing_reason).toContain('halts virtually every other service');
      const spooler = result.data.find((s) => s.key === 'Spooler');
      expect(spooler?.load_bearing).toBe(false);
      expect(spooler?.load_bearing_reason).toBeNull();
    }
  });

  it('preserves dependency arrays', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce(makePsPayload(sampleServices));
    const handler = getHandler('api:listAllServices');

    const result = (await handler({})) as IpcResult<ServiceRow[]>;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].depends_on).toEqual(['RPCSS', 'http']);
      expect(result.data[1].dependents).toEqual(['Spooler', 'Themes']);
    }
  });

  it('returns ok=false with E_LIST_SERVICES code on PS throw', async () => {
    vi.mocked(runPowerShellScript).mockRejectedValueOnce(new Error('PowerShell exited with code 1'));
    const handler = getHandler('api:listAllServices');

    const result = (await handler({})) as IpcResult<ServiceRow[]>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('E_LIST_SERVICES');
      expect(result.error.message).toContain('PowerShell');
    }
  });

  it('preserves the original error code when PS throws with a code property', async () => {
    const err = Object.assign(new Error('script not found'), { code: 'E_SCRIPT_NOT_FOUND' });
    vi.mocked(runPowerShellScript).mockRejectedValueOnce(err);
    const handler = getHandler('api:listAllServices');

    const result = (await handler({})) as IpcResult<ServiceRow[]>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('E_SCRIPT_NOT_FOUND');
    }
  });

  it('returns an empty array when PS reports zero services (edge case)', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce(makePsPayload([]));
    const handler = getHandler('api:listAllServices');

    const result = (await handler({})) as IpcResult<ServiceRow[]>;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
  });

  it('calls Get-AllServices.ps1 with -JsonOutput', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce(makePsPayload(sampleServices));
    const handler = getHandler('api:listAllServices');

    await handler({});
    expect(runPowerShellScript).toHaveBeenCalledWith(
      'Get-AllServices.ps1',
      ['-JsonOutput'],
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });
});
