// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';

/**
 * v2.5.22: scriptRunner now falls back to the bundled `resources/powershell/`
 * tree when `C:\ProgramData\PCDoctor\<rel>` doesn't exist on disk.
 *
 * Pre-2.5.22 a fresh install where customInstall's Copy-Item silently missed
 * a script (Defender / 3rd-party AV / Controlled Folder Access / NSIS path
 * quirk) hard-failed with PowerShell error 4294770688 ("file not found")
 * on every wizard step. Greg's main box hid the bug because years of prior
 * installs had populated ProgramData. The first true clean-PC install
 * (second-PC test, 2026-05-01) surfaced 5 wizard errors + an empty
 * Dashboard cache.
 *
 * These tests lock the resolution contract: ProgramData wins when present,
 * bundle fills the gap when ProgramData is missing the file, and the final
 * fallback (when neither has it) preserves the canonical ProgramData path
 * so the surfaced "file not found" error message stays unchanged for
 * genuinely missing scripts.
 */

const PCDOCTOR_ROOT = 'C:\\ProgramData\\PCDoctor';
const FAKE_RESOURCES_PATH = 'C:\\fake\\resources';
const FAKE_APP_PATH = 'C:\\fake\\app';

// existsSync is the lever the resolver pulls. Each test sets a per-path map
// before importing scriptRunner so the resolver sees a deterministic disk.
const existsMap = new Map<string, boolean>();
vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: string) => existsMap.get(p) ?? false),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })),
}));

// Default to packaged so `process.resourcesPath` is the bundle root.
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: vi.fn(() => FAKE_APP_PATH),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

// process.resourcesPath only exists in Electron at runtime; stub it for the
// packaged-mode branch of resolveScriptPath.
Object.defineProperty(process, 'resourcesPath', {
  value: FAKE_RESOURCES_PATH,
  configurable: true,
});

import { spawn } from 'node:child_process';
import { runPowerShellScript } from '../../src/main/scriptRunner.js';

function fakeChild(stdout: string, exitCode = 0): any {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('exit', exitCode);
  }, 5);
  return child;
}

describe('scriptRunner script-path resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsMap.clear();
    // pwsh.exe must look present so spawn doesn't pick the legacy fallback.
    existsMap.set('C:\\Program Files\\PowerShell\\7\\pwsh.exe', true);
  });

  it('uses ProgramData path when the script exists there (canonical case)', async () => {
    const programDataPath = path.join(PCDOCTOR_ROOT, 'Get-SystemProfile.ps1');
    existsMap.set(programDataPath, true);
    (spawn as any).mockReturnValue(fakeChild('{"ok":true}'));

    await runPowerShellScript('Get-SystemProfile.ps1', []);

    const callArgs = (spawn as any).mock.calls[0];
    const spawnArgs = callArgs[1] as string[];
    const fileIdx = spawnArgs.indexOf('-File');
    expect(spawnArgs[fileIdx + 1]).toBe(programDataPath);
  });

  it('falls back to bundle path when ProgramData copy is missing (fresh-install case)', async () => {
    // ProgramData empty for this script; bundled copy present.
    const bundlePath = path.join(FAKE_RESOURCES_PATH, 'powershell', 'Get-SystemProfile.ps1');
    existsMap.set(bundlePath, true);
    (spawn as any).mockReturnValue(fakeChild('{"ok":true}'));

    await runPowerShellScript('Get-SystemProfile.ps1', []);

    const callArgs = (spawn as any).mock.calls[0];
    const spawnArgs = callArgs[1] as string[];
    const fileIdx = spawnArgs.indexOf('-File');
    expect(spawnArgs[fileIdx + 1]).toBe(bundlePath);
  });

  it('handles forward-slash subdirectory paths (security/Get-SecurityPosture.ps1) via bundle fallback', async () => {
    const rel = 'security/Get-SecurityPosture.ps1';
    const bundlePath = path.join(FAKE_RESOURCES_PATH, 'powershell', 'security\\Get-SecurityPosture.ps1');
    existsMap.set(bundlePath, true);
    (spawn as any).mockReturnValue(fakeChild('{"ok":true}'));

    await runPowerShellScript(rel, []);

    const callArgs = (spawn as any).mock.calls[0];
    const spawnArgs = callArgs[1] as string[];
    const fileIdx = spawnArgs.indexOf('-File');
    expect(spawnArgs[fileIdx + 1]).toBe(bundlePath);
  });

  it('returns ProgramData path when neither location has the script (preserves error message)', async () => {
    const programDataPath = path.join(PCDOCTOR_ROOT, 'Does-Not-Exist.ps1');
    // Neither path set in existsMap → both existsSync calls return false.
    (spawn as any).mockReturnValue(fakeChild('garbage', 1));

    await expect(runPowerShellScript('Does-Not-Exist.ps1', [])).rejects.toMatchObject({
      code: 'E_PS_NONZERO_EXIT',
    });

    const callArgs = (spawn as any).mock.calls[0];
    const spawnArgs = callArgs[1] as string[];
    const fileIdx = spawnArgs.indexOf('-File');
    // The original error path stays referenced — important so toast text
    // points at the canonical runtime location, not the read-only bundle.
    expect(spawnArgs[fileIdx + 1]).toBe(programDataPath);
  });

  it('prefers ProgramData over bundle when both exist (no regression once Sync completes)', async () => {
    const programDataPath = path.join(PCDOCTOR_ROOT, 'Get-NasDrives.ps1');
    const bundlePath = path.join(FAKE_RESOURCES_PATH, 'powershell', 'Get-NasDrives.ps1');
    existsMap.set(programDataPath, true);
    existsMap.set(bundlePath, true);
    (spawn as any).mockReturnValue(fakeChild('{"drives":[]}'));

    await runPowerShellScript('Get-NasDrives.ps1', []);

    const callArgs = (spawn as any).mock.calls[0];
    const spawnArgs = callArgs[1] as string[];
    const fileIdx = spawnArgs.indexOf('-File');
    expect(spawnArgs[fileIdx + 1]).toBe(programDataPath);
  });
});
