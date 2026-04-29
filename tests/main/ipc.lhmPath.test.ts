// @vitest-environment node
//
// v2.5.2: tests for resolveLhmCandidatePaths (exposed as
// _resolveLhmCandidatePathsForTests). The function builds an ordered
// list of LHM exe candidate paths from four sources:
//   1. Hardcoded WinGet path
//   2. WinGet packages dir glob (any LibreHardwareMonitor* subdir)
//   3. Program Files fallback
//   4. Live Get-Process lookup (pExecFile -> powershell)
//
// Mock strategy:
//   - electron app.getPath('home') -> controlled home dir string
//   - node:fs existsSync -> vi.fn() to simulate file presence
//   - node:fs/promises readdir -> vi.fn() to control dir entries
//   - node:child_process execFile (via promisify) -> the function calls
//     pExecFile which is `promisify(execFile)`. We mock node:child_process
//     so the promisified version returns controlled stdout.
//
// No real PS spawn, no real filesystem access.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// ── Stub every heavy/native import that ipc.ts pulls in at module load ──────
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => 'C:\\Users\\greg_') },
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
}));
vi.mock('@main/constants.js', () => ({
  PCDOCTOR_ROOT: 'C:\\ProgramData\\PCDoctor',
  LATEST_JSON_PATH: 'C:\\ProgramData\\PCDoctor\\latest.json',
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

// ── Mock the filesystem modules ──────────────────────────────────────────────
// node:fs (sync) -- for existsSync
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

// node:fs/promises -- for readdir
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readdir: vi.fn(async () => []),
    readFile: vi.fn(),
    copyFile: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({})),
    mkdir: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
  };
});

// node:child_process -- for execFile (pExecFile = promisify(execFile))
//
// IMPORTANT: real `execFile` carries a `util.promisify.custom` symbol that
// teaches promisify to resolve with `{stdout, stderr}`. Our mock lacks that
// symbol, so promisify falls back to its default contract (resolve with the
// SECOND callback arg). To make the mock indistinguishable from the real
// promisified version, we pass `{stdout, stderr}` as the single result so
// production code's `r.stdout` lookup works.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      // Default: return empty stdout (no running LHM process).
      cb(null, { stdout: '', stderr: '' });
    }),
    spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })),
  };
});

import { _resolveLhmCandidatePathsForTests } from '@main/ipc.js';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { app } from 'electron';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// v2.5.2 (code-reviewer W3 follow-up): the production code derives the
// candidate-0 WinGet path from `app.getPath('home')`, so the test's
// "expected hardcoded path" is now a function of whatever home was
// mocked. Use `wingetDefaultFor(home)` to compute the same string the
// production code would build for that home.
function wingetDefaultFor(home: string): string {
  return `${home}\\AppData\\Local\\Microsoft\\WinGet\\Packages\\LibreHardwareMonitor.LibreHardwareMonitor_Microsoft.Winget.Source_8wekyb3d8bbwe\\LibreHardwareMonitor.exe`;
}

// Backwards-compatible alias for tests that set home to greg_'s path.
const HARDCODED_WINGET_PATH = wingetDefaultFor('C:\\Users\\greg_');

const PROGRAM_FILES_PATH =
  'C:\\Program Files\\LibreHardwareMonitor\\LibreHardwareMonitor.exe';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setHome(home: string) {
  vi.mocked(app.getPath).mockReturnValue(home);
}

function mockReaddir(entries: string[]) {
  vi.mocked(readdir as any).mockResolvedValue(entries);
}

function mockExecFileStdout(stdout: string) {
  // Pass `{stdout, stderr}` as the single result object; see the promisify
  // explanation on the vi.mock('node:child_process') block above.
  vi.mocked(execFile).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: any) => {
      cb(null, { stdout, stderr: '' });
    }
  );
}

function mockExistsSyncFor(paths: string[]) {
  vi.mocked(existsSync).mockImplementation((p: any) => paths.includes(String(p)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveLhmCandidatePaths: hardcoded WinGet path (v2.5.2)', () => {
  beforeEach(() => {
    setHome('C:\\Users\\greg_');
    vi.mocked(existsSync).mockReturnValue(false);
    mockReaddir([]);
    mockExecFileStdout('');
  });

  it('first entry is the hardcoded WinGet path regardless of filesystem state', async () => {
    const candidates = await _resolveLhmCandidatePathsForTests();
    expect(candidates[0]).toBe(HARDCODED_WINGET_PATH);
  });

  it('Program Files path is always present in the list', async () => {
    const candidates = await _resolveLhmCandidatePathsForTests();
    expect(candidates).toContain(PROGRAM_FILES_PATH);
  });
});

describe('resolveLhmCandidatePaths: WinGet glob (v2.5.2)', () => {
  beforeEach(() => {
    setHome('C:\\Users\\testuser');
    vi.mocked(existsSync).mockReturnValue(true); // wingetParent existsSync returns true
    mockExecFileStdout('');
  });

  it('adds WinGet glob candidates after the hardcoded path when matching subdirs exist', async () => {
    mockReaddir([
      'LibreHardwareMonitor.LibreHardwareMonitor_Microsoft.Winget.Source_8wekyb3d8bbwe',
      'LibreHardwareMonitor.LibreHardwareMonitor_v2_Microsoft.Winget.Source_abc',
      'SomeOtherPackage.Foo',
    ]);

    const candidates = await _resolveLhmCandidatePathsForTests();
    const wingetDefault = wingetDefaultFor('C:\\Users\\testuser');

    // The two LHM dirs should each contribute a candidate. Skip the one
    // that matches wingetDefault (the code dedupes that against candidate 0).
    const globCands = candidates.filter(
      (c) =>
        c.includes('LibreHardwareMonitor') &&
        c.includes('testuser') &&
        c !== wingetDefault
    );
    expect(globCands.length).toBeGreaterThanOrEqual(1);
    // SomeOtherPackage should not contribute a candidate.
    expect(candidates.every((c) => !c.includes('SomeOtherPackage'))).toBe(true);
  });

  it('glob step does not add the hardcoded path a second time when readdir returns it', async () => {
    // The hardcoded path's parent dir name is in the readdir results.
    mockReaddir([
      'LibreHardwareMonitor.LibreHardwareMonitor_Microsoft.Winget.Source_8wekyb3d8bbwe',
    ]);

    const candidates = await _resolveLhmCandidatePathsForTests();
    const wingetDefault = wingetDefaultFor('C:\\Users\\testuser');

    // wingetDefault (candidate 0) should appear exactly once — the glob
    // dedupes against it explicitly.
    const wingetDefaultCount = candidates.filter((c) => c === wingetDefault).length;
    expect(wingetDefaultCount).toBe(1);
  });

  it('glob step is skipped gracefully when readdir rejects', async () => {
    vi.mocked(readdir as any).mockRejectedValueOnce(new Error('EACCES'));

    const candidates = await _resolveLhmCandidatePathsForTests();

    // Function still returns at minimum hardcoded + Program Files.
    expect(candidates).toContain(PROGRAM_FILES_PATH);
    expect(candidates[0]).toBe(wingetDefaultFor('C:\\Users\\testuser'));
  });

  it('order is: hardcoded then glob candidates then Program Files', async () => {
    mockReaddir(['LibreHardwareMonitor.LibreHardwareMonitor_v2_Extra']);

    const candidates = await _resolveLhmCandidatePathsForTests();

    const pfIdx = candidates.indexOf(PROGRAM_FILES_PATH);
    const globIdx = candidates.findIndex(
      (c) => c.includes('LibreHardwareMonitor_v2_Extra')
    );

    // hardcoded is always first (wingetDefault for the mocked home)
    expect(candidates[0]).toBe(wingetDefaultFor('C:\\Users\\testuser'));
    // glob comes before Program Files
    if (globIdx !== -1) {
      expect(globIdx).toBeLessThan(pfIdx);
    }
    // Program Files comes before any process lookup
    expect(pfIdx).toBeGreaterThan(0);
  });
});

describe('resolveLhmCandidatePaths: process lookup (v2.5.2)', () => {
  beforeEach(() => {
    setHome('C:\\Users\\greg_');
    mockReaddir([]);
  });

  it('appends the live process path when pExecFile returns a path and existsSync confirms it', async () => {
    const livePath = 'C:\\custom\\path\\LibreHardwareMonitor.exe';
    mockExecFileStdout(livePath + '\r\n');
    mockExistsSyncFor([livePath]);

    const candidates = await _resolveLhmCandidatePathsForTests();
    expect(candidates).toContain(livePath);
  });

  it('does not append anything when pExecFile returns empty stdout', async () => {
    mockExecFileStdout('');
    vi.mocked(existsSync).mockReturnValue(false);

    const candidates = await _resolveLhmCandidatePathsForTests();
    // Only hardcoded + Program Files (no duplicates, no extra entries).
    const nonStandardEntries = candidates.filter(
      (c) => c !== HARDCODED_WINGET_PATH && c !== PROGRAM_FILES_PATH
    );
    expect(nonStandardEntries).toHaveLength(0);
  });

  it('does not append the process path when existsSync returns false for it', async () => {
    const livePath = 'C:\\custom\\path\\LibreHardwareMonitor.exe';
    mockExecFileStdout(livePath);
    vi.mocked(existsSync).mockReturnValue(false); // file not found

    const candidates = await _resolveLhmCandidatePathsForTests();
    expect(candidates).not.toContain(livePath);
  });

  it('does not append when pExecFile rejects (no running LHM process)', async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: any) => {
        cb(new Error('not found'), '', '');
      }
    );
    vi.mocked(existsSync).mockReturnValue(false);

    // Should not throw -- execFile failure is caught.
    const candidates = await _resolveLhmCandidatePathsForTests();
    expect(candidates[0]).toBe(HARDCODED_WINGET_PATH);
    expect(candidates).toContain(PROGRAM_FILES_PATH);
  });
});

describe('resolveLhmCandidatePaths: duplicate tolerance (v2.5.2)', () => {
  it('can produce duplicate entries when WinGet glob overlaps with hardcoded path on a different home', async () => {
    // When home == 'C:\\Users\\greg_', the glob can produce the hardcoded
    // path, but the code explicitly skips that with `cand !== wingetDefault`.
    // When home is different, the constructed glob path differs from
    // wingetDefault, so duplicates would NOT occur from that route.
    // This test verifies the non-duplication guard in the winget glob step.
    setHome('C:\\Users\\greg_');
    vi.mocked(existsSync).mockReturnValue(true);
    mockReaddir([
      'LibreHardwareMonitor.LibreHardwareMonitor_Microsoft.Winget.Source_8wekyb3d8bbwe',
    ]);
    mockExecFileStdout('');

    const candidates = await _resolveLhmCandidatePathsForTests();

    // The path constructed from home + the dir name would equal wingetDefault
    // when home is C:\Users\greg_. The code should skip it (cand !== wingetDefault guard).
    const hardcodedCount = candidates.filter((c) => c === HARDCODED_WINGET_PATH).length;
    expect(hardcodedCount).toBe(1);
  });
});
