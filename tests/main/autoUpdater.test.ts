// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * v2.3.6+: autoUpdater.ts dropped the pre-check feedUrlIsUsable() gate. It
 * now always calls into electron-updater, catches the exception, and
 * classifies benign error messages (app-update.yml missing, ENOENT, "unable
 * to find latest version", ClientRequest http/https protocol) as
 * state:'idle' "Auto-update not configured". Genuine errors surface as
 * state:'error'. This test verifies that dispatch.
 */

const hoisted = vi.hoisted(() => {
  return {
    checkSpy: null as any,
    downloadSpy: null as any,
  };
});

vi.mock('electron-updater', async () => {
  const { vi: viLocal } = await import('vitest');
  hoisted.checkSpy = viLocal.fn(async () => {});
  hoisted.downloadSpy = viLocal.fn(async () => {});
  return {
    default: {
      autoUpdater: {
        autoDownload: false,
        autoInstallOnAppQuit: true,
        allowDowngrade: false,
        checkForUpdates: hoisted.checkSpy,
        downloadUpdate: hoisted.downloadSpy,
        quitAndInstall: viLocal.fn(),
        on: viLocal.fn(),
      },
    },
  };
});

vi.mock('electron', () => ({
  app: { getVersion: () => '2.3.13' },
  BrowserWindow: class {},
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  Notification: class {
    static isSupported() { return false; }
    constructor(_opts: any) {}
    show() {}
  },
}));

import { checkForUpdates, downloadUpdate, getStatus } from '../../src/main/autoUpdater.js';

describe('autoUpdater error classification', () => {
  beforeEach(() => {
    hoisted.checkSpy.mockReset().mockResolvedValue(undefined);
    hoisted.downloadSpy.mockReset().mockResolvedValue(undefined);
  });

  it('"app-update.yml" missing errors classify as idle/not_configured', async () => {
    hoisted.checkSpy.mockRejectedValueOnce(new Error('Cannot find app-update.yml in resources'));
    await checkForUpdates();
    expect(getStatus().state).toBe('idle');
    expect(getStatus().message).toMatch(/not configured/i);
  });

  it('ENOENT errors classify as idle', async () => {
    hoisted.checkSpy.mockRejectedValueOnce(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));
    await checkForUpdates();
    expect(getStatus().state).toBe('idle');
  });

  it('"ClientRequest only supports http: and https:" classifies as idle (stale file:// feed)', async () => {
    hoisted.checkSpy.mockRejectedValueOnce(new Error('ClientRequest only supports http: and https: protocols'));
    await checkForUpdates();
    expect(getStatus().state).toBe('idle');
  });

  it('"Unable to find latest version" classifies as idle', async () => {
    hoisted.checkSpy.mockRejectedValueOnce(new Error('Unable to find latest version on GitHub'));
    await checkForUpdates();
    expect(getStatus().state).toBe('idle');
  });

  it('other errors surface as state:error', async () => {
    hoisted.checkSpy.mockRejectedValueOnce(new Error('boom'));
    await checkForUpdates();
    expect(getStatus().state).toBe('error');
    expect(getStatus().message).toBe('boom');
  });

  it('no error -> electron-updater was actually called', async () => {
    await checkForUpdates();
    expect(hoisted.checkSpy).toHaveBeenCalled();
  });

  it('downloadUpdate applies the same classification on benign errors', async () => {
    hoisted.downloadSpy.mockRejectedValueOnce(new Error('Cannot find app-update.yml'));
    await downloadUpdate();
    expect(getStatus().state).toBe('idle');
  });

  it('downloadUpdate surfaces real failures as state:error', async () => {
    hoisted.downloadSpy.mockRejectedValueOnce(new Error('Disk full'));
    await downloadUpdate();
    expect(getStatus().state).toBe('error');
    expect(getStatus().message).toBe('Disk full');
  });
});
