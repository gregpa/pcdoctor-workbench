// @vitest-environment node
//
// v2.4.46 (B45-3): regression tests for the idempotent `cueUacForeground`
// restore() and its 60s safety-net timer. The function is module-private so
// we exercise it indirectly through `runElevatedPowerShellScript` and inspect
// the spy calls on the BrowserWindow stub. Three scenarios:
//
//  1. exit-only path:  exit fires once -> setAlwaysOnTop(false) called once.
//  2. error-only path: error fires once (no exit) -> still restores once.
//  3. both fire:       restore is idempotent -- no double-decrement of pin.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// vi.hoisted because vi.mock() factories are hoisted above non-vi imports.
// Anything we want to share between the mock factory and the test bodies
// must come from a hoisted block.
const mocks = vi.hoisted(() => {
  return {
    setAlwaysOnTopSpy: vi.fn(),
    flashFrameSpy: vi.fn(),
    focusSpy: vi.fn(),
    spawnFn: vi.fn(),
    spawnSyncFn: vi.fn(() => ({ stdout: 'EnableLUA    REG_DWORD    0x1', stderr: '', status: 0 })),
    existsSyncFn: vi.fn(() => true),
    readFileSyncFn: vi.fn(() => '{"success":true}'),
    unlinkSyncFn: vi.fn(),
    openSyncFn: vi.fn(() => 99),
    closeSyncFn: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: { getVersion: () => '2.4.46-test', isPackaged: false, getAppPath: () => '.' },
  BrowserWindow: {
    getAllWindows: () => [{
      setAlwaysOnTop: mocks.setAlwaysOnTopSpy,
      flashFrame: mocks.flashFrameSpy,
      focus: mocks.focusSpy,
    }],
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawnFn,
  spawnSync: mocks.spawnSyncFn,
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSyncFn,
  readFileSync: mocks.readFileSyncFn,
  unlinkSync: mocks.unlinkSyncFn,
  openSync: mocks.openSyncFn,
  closeSync: mocks.closeSyncFn,
  constants: { O_CREAT: 0, O_EXCL: 0, O_WRONLY: 0 },
}));

vi.mock('node:crypto', () => ({
  randomBytes: () => ({ toString: () => 'deadbeefdeadbeefdeadbeefdeadbeef' }),
}));

import { runElevatedPowerShellScript } from '../../src/main/scriptRunner.js';

function makeChildEmitter() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('cueUacForeground (B45-3)', () => {
  beforeEach(() => {
    mocks.setAlwaysOnTopSpy.mockClear();
    mocks.flashFrameSpy.mockClear();
    mocks.focusSpy.mockClear();
    mocks.spawnFn.mockReset();
    mocks.existsSyncFn.mockReturnValue(true);
    mocks.readFileSyncFn.mockReturnValue('{"success":true}');
  });

  it('exit fires restore exactly once', async () => {
    const child = makeChildEmitter();
    mocks.spawnFn.mockReturnValue(child);
    setTimeout(() => child.emit('exit', 0), 5);
    await runElevatedPowerShellScript('actions/Flush-DNS.ps1', []);
    const restoreCalls = mocks.setAlwaysOnTopSpy.mock.calls.filter(c => c[0] === false);
    expect(restoreCalls.length).toBe(1);
    const flashRestoreCalls = mocks.flashFrameSpy.mock.calls.filter(c => c[0] === false);
    expect(flashRestoreCalls.length).toBe(1);
  });

  it('error fires restore exactly once (no exit event)', async () => {
    const child = makeChildEmitter();
    mocks.spawnFn.mockReturnValue(child);
    setTimeout(() => child.emit('error', new Error('ENOENT: spawn failed')), 5);
    await expect(runElevatedPowerShellScript('actions/Flush-DNS.ps1', [])).rejects.toMatchObject({
      code: 'E_ELEVATION_FAILED',
    });
    const restoreCalls = mocks.setAlwaysOnTopSpy.mock.calls.filter(c => c[0] === false);
    expect(restoreCalls.length).toBe(1);
    const flashRestoreCalls = mocks.flashFrameSpy.mock.calls.filter(c => c[0] === false);
    expect(flashRestoreCalls.length).toBe(1);
  });

  it('error then exit: restore stays idempotent (called at most once)', async () => {
    const child = makeChildEmitter();
    mocks.spawnFn.mockReturnValue(child);
    setTimeout(() => {
      child.emit('error', new Error('weird-double-fire'));
      child.emit('exit', 0);
    }, 5);
    await expect(runElevatedPowerShellScript('actions/Flush-DNS.ps1', [])).rejects.toMatchObject({
      code: 'E_ELEVATION_FAILED',
    });
    const restoreCalls = mocks.setAlwaysOnTopSpy.mock.calls.filter(c => c[0] === false);
    expect(restoreCalls.length).toBe(1);
    const flashRestoreCalls = mocks.flashFrameSpy.mock.calls.filter(c => c[0] === false);
    expect(flashRestoreCalls.length).toBe(1);
  });
});
