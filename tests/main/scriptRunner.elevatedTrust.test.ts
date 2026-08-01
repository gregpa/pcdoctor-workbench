// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const TRUSTED_ROOT = 'C:\\Program Files\\PCDoctor Workbench\\resources';

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: vi.fn(() => 'C:\\unused') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })),
}));

import { resolveElevatedScriptPath } from '../../src/main/scriptRunner.js';

describe('elevated script bundle trust anchor', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: TRUSTED_ROOT,
      configurable: true,
    });
  });

  it('resolves an elevated action only beneath the fixed Program Files bundle', () => {
    expect(resolveElevatedScriptPath('actions/Flush-DNS.ps1')).toBe(
      'C:\\Program Files\\PCDoctor Workbench\\resources\\powershell\\actions\\Flush-DNS.ps1',
    );
  });

  it('rejects a packaged bundle copied to a user-writable location', () => {
    Object.defineProperty(process, 'resourcesPath', {
      value: 'C:\\Users\\greg_\\AppData\\Local\\Copied-PCDoctor\\resources',
      configurable: true,
    });
    expect(() => resolveElevatedScriptPath('actions/Flush-DNS.ps1')).toThrowError(
      expect.objectContaining({ code: 'E_ELEVATED_SOURCE_UNTRUSTED' }),
    );
  });

  it('rejects path traversal outside the trusted bundle', () => {
    expect(() => resolveElevatedScriptPath('..\\outside.ps1')).toThrow(/escapes its fixed root/i);
  });
});
