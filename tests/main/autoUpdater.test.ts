// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * v2.3.2: `autoUpdater.ts` now gates checkForUpdates / downloadUpdate on
 * feedUrlIsUsable(). feedUrlIsUsable returns true only when
 * autoUpdater.getFeedURL() returns a string matching /^https?:\/\//i,
 * and false if it throws, returns null/empty, or returns a non-http
 * scheme (file://, unc paths, etc.). When unusable, checkForUpdates
 * short-circuits to `{ state: 'idle', message: '...needs http/https
 * feed URL' }` without ever calling autoUpdater.checkForUpdates().
 */

// vi.mock factories are hoisted above top-level `let`/`const`, so we stash
// the mutable pieces on a hoisted object via vi.hoisted(). Tests rewrite
// hoisted.feedUrlBehavior per-case.
const hoisted = vi.hoisted(() => {
  return {
    feedUrlBehavior: (() => null) as () => string | null | undefined,
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
        getFeedURL: () => hoisted.feedUrlBehavior(),
        checkForUpdates: hoisted.checkSpy,
        downloadUpdate: hoisted.downloadSpy,
        quitAndInstall: viLocal.fn(),
        on: viLocal.fn(),
      },
    },
  };
});

vi.mock('electron', () => ({
  app: { getVersion: () => '2.3.2' },
  BrowserWindow: class {},
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  Notification: class {
    static isSupported() { return false; }
    constructor(_opts: any) {}
    show() {}
  },
}));

// Import the module under test AFTER the mocks are registered.
import { checkForUpdates, downloadUpdate, getStatus } from '../../src/main/autoUpdater.js';

describe('autoUpdater.feedUrlIsUsable gating (via public API)', () => {
  beforeEach(() => {
    hoisted.checkSpy.mockClear();
    hoisted.downloadSpy.mockClear();
  });

  it('checkForUpdates short-circuits to idle when getFeedURL() returns undefined', async () => {
    hoisted.feedUrlBehavior = () => undefined;
    await checkForUpdates();
    const s = getStatus();
    expect(s.state).toBe('idle');
    expect(s.message).toMatch(/needs http\/https feed URL/i);
    expect(hoisted.checkSpy).not.toHaveBeenCalled();
  });

  it('checkForUpdates short-circuits to idle when getFeedURL() returns an empty string', async () => {
    hoisted.feedUrlBehavior = () => '';
    await checkForUpdates();
    expect(getStatus().state).toBe('idle');
    expect(hoisted.checkSpy).not.toHaveBeenCalled();
  });

  it('checkForUpdates short-circuits when getFeedURL() returns a file:// URL', async () => {
    hoisted.feedUrlBehavior = () => 'file://\\\\nas\\share\\releases\\latest.yml';
    await checkForUpdates();
    expect(getStatus().state).toBe('idle');
    expect(getStatus().message).toMatch(/needs http\/https feed URL/i);
    expect(hoisted.checkSpy).not.toHaveBeenCalled();
  });

  it('checkForUpdates short-circuits when getFeedURL() throws', async () => {
    hoisted.feedUrlBehavior = () => { throw new Error('feed URL not configured'); };
    await checkForUpdates();
    expect(getStatus().state).toBe('idle');
    expect(hoisted.checkSpy).not.toHaveBeenCalled();
  });

  it('checkForUpdates invokes the real checker when getFeedURL() returns an https URL', async () => {
    hoisted.feedUrlBehavior = () => 'https://releases.example.com/latest.yml';
    await checkForUpdates();
    expect(hoisted.checkSpy).toHaveBeenCalledOnce();
  });

  it('checkForUpdates invokes the real checker when getFeedURL() returns an http URL (case-insensitive)', async () => {
    hoisted.feedUrlBehavior = () => 'HTTP://releases.example.com/latest.yml';
    await checkForUpdates();
    expect(hoisted.checkSpy).toHaveBeenCalledOnce();
  });

  it('downloadUpdate short-circuits when feed URL is unusable', async () => {
    hoisted.feedUrlBehavior = () => 'file://nope';
    await downloadUpdate();
    expect(hoisted.downloadSpy).not.toHaveBeenCalled();
    expect(getStatus().state).toBe('idle');
  });

  it('downloadUpdate invokes electron-updater when feed URL is https', async () => {
    hoisted.feedUrlBehavior = () => 'https://releases.example.com/latest.yml';
    await downloadUpdate();
    expect(hoisted.downloadSpy).toHaveBeenCalledOnce();
  });

  it('sets state=error (not idle) when electron-updater throws during an otherwise-valid check', async () => {
    hoisted.feedUrlBehavior = () => 'https://releases.example.com/latest.yml';
    hoisted.checkSpy.mockRejectedValueOnce(new Error('boom'));
    await checkForUpdates();
    const s = getStatus();
    expect(s.state).toBe('error');
    expect(s.message).toBe('boom');
  });
});
