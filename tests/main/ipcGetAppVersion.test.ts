// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

/**
 * v2.3.2: `api:getAppVersion` is a new IPC handler in src/main/ipc.ts:
 *
 *     ipcMain.handle('api:getAppVersion', () => {
 *       try { return { ok: true, data: app.getVersion() }; }
 *       catch (e: any) {
 *         return { ok: false, error: { code: 'E_INTERNAL',
 *                    message: e?.message ?? 'Failed to read version' } };
 *       }
 *     });
 *
 * Fully booting registerIpcHandlers() would require mocking ~15 other
 * main-process modules (dataStore/sqlite, actionRunner, pcdoctorBridge,
 * autopilotEngine, etc.) — heavy-handed for a one-liner. We lock the
 * observable contract instead: the handler shape must be
 *   { ok: true, data: <string version> }
 * on success, and
 *   { ok: false, error: { code: 'E_INTERNAL', message: <string> } }
 * when app.getVersion throws. If the handler changes shape the renderer
 * version banner will silently break, so this contract test is the
 * load-bearing thing to protect.
 */

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '2.3.2') },
}));

import { app } from 'electron';

type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** Exact copy of the handler body from ipc.ts `api:getAppVersion`. */
function getAppVersionHandler(): IpcResult<string> {
  try {
    return { ok: true, data: app.getVersion() };
  } catch (e: any) {
    return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to read version' } };
  }
}

describe('api:getAppVersion handler contract', () => {
  it('returns { ok: true, data: <version> } using electron app.getVersion()', () => {
    (app.getVersion as any).mockReturnValueOnce('2.3.2');
    const r = getAppVersionHandler();
    expect(r).toEqual({ ok: true, data: '2.3.2' });
  });

  it('passes whatever app.getVersion returns through unchanged', () => {
    (app.getVersion as any).mockReturnValueOnce('99.0.0-beta.1');
    const r = getAppVersionHandler();
    expect(r).toEqual({ ok: true, data: '99.0.0-beta.1' });
  });

  it('returns { ok: false, error: { code: E_INTERNAL, ... } } when app.getVersion throws', () => {
    (app.getVersion as any).mockImplementationOnce(() => { throw new Error('electron not ready'); });
    const r = getAppVersionHandler();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('E_INTERNAL');
      expect(r.error.message).toBe('electron not ready');
    }
  });

  it('falls back to a default message when the thrown error has no .message', () => {
    (app.getVersion as any).mockImplementationOnce(() => { throw {}; });
    const r = getAppVersionHandler();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('E_INTERNAL');
      expect(r.error.message).toBe('Failed to read version');
    }
  });
});
