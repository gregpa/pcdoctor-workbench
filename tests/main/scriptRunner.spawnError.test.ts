// @vitest-environment node
//
// v2.4.48 (B48-AS-4): tests for the spawn-error rejection branch in
// runPowerShellScript.
//
// Pre-2.4.48 the await of `child.on('exit', ...)` had no `'error'` wire,
// so a failed spawn (ENOENT, EACCES, EMFILE, EPERM, etc.) hung the
// promise forever. The safety timer would eventually kill a process
// that was never alive in the first place ~5 minutes later.
//
// New contract: if child_process.spawn emits 'error' before 'exit',
// runPowerShellScript rejects with PCDoctorScriptError code='E_SPAWN_FAILED'
// and the safety timer is cleared via try/finally.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({
  spawnFn: vi.fn(),
  existsSyncFn: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '2.4.48-test', isPackaged: false, getAppPath: () => '.' },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: vi.fn() },
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawnFn,
  spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })),
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSyncFn,
  readFileSync: vi.fn(() => ''),
  unlinkSync: vi.fn(),
  openSync: vi.fn(() => 99),
  closeSync: vi.fn(),
  constants: { O_CREAT: 0, O_EXCL: 0, O_WRONLY: 0 },
}));

import { runPowerShellScript } from '../../src/main/scriptRunner.js';

function makeChildEmitter() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('runPowerShellScript spawn error (B48-AS-4)', () => {
  beforeEach(() => {
    mocks.spawnFn.mockReset();
    mocks.existsSyncFn.mockReturnValue(true);
  });

  it('safety timer is cleared after spawn error so child.kill is not called when the timeout expires (fake timers)', async () => {
    // The prior proxy test (child.kill not called immediately) does not prove
    // clearTimeout ran -- the 5-minute timer simply hasn't fired yet. This
    // test uses fake timers to advance past the full DEFAULT_SCRIPT_TIMEOUT_MS
    // (5 min) and asserts child.kill is still not called. If the try/finally
    // clearTimeout were removed from scriptRunner.ts, child.kill WOULD be
    // called at the advanced tick, and this test would fail.
    vi.useFakeTimers();
    const child = makeChildEmitter();
    mocks.spawnFn.mockReturnValue(child);

    // Schedule the error event in real-timer terms -- vitest fake timers
    // still process microtasks, but setImmediate / nextTick variants work.
    // We emit the error directly after the promise is awaiting.
    const scriptPromise = runPowerShellScript('FakeScript.ps1', []);

    // Advance a tiny slice so the listeners are registered, then fire error.
    await vi.advanceTimersByTimeAsync(1);
    const err: NodeJS.ErrnoException = new Error('spawn pwsh ENOENT');
    err.code = 'ENOENT';
    child.emit('error', err);

    await expect(scriptPromise).rejects.toMatchObject({ code: 'E_SPAWN_FAILED' });

    // Now advance past DEFAULT_SCRIPT_TIMEOUT_MS (5 * 60 * 1000 = 300_000 ms).
    // If clearTimeout did NOT run, the safety timer fires here and calls child.kill.
    await vi.advanceTimersByTimeAsync(310_000);
    expect(child.kill).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('rejects with E_SPAWN_FAILED when child emits ENOENT', async () => {
    const child = makeChildEmitter();
    mocks.spawnFn.mockReturnValue(child);
    setTimeout(() => {
      const err: NodeJS.ErrnoException = new Error('spawn pwsh ENOENT');
      err.code = 'ENOENT';
      err.errno = -4058;
      err.syscall = 'spawn pwsh';
      err.path = 'pwsh';
      child.emit('error', err);
    }, 5);

    await expect(runPowerShellScript('FakeScript.ps1', [])).rejects.toMatchObject({
      code: 'E_SPAWN_FAILED',
    });
  });

  it('error message includes the underlying errno code', async () => {
    const child = makeChildEmitter();
    mocks.spawnFn.mockReturnValue(child);
    setTimeout(() => {
      const err: NodeJS.ErrnoException = new Error('spawn pwsh EACCES');
      err.code = 'EACCES';
      child.emit('error', err);
    }, 5);

    try {
      await runPowerShellScript('FakeScript.ps1', []);
      throw new Error('should have rejected');
    } catch (e: any) {
      expect(e.code).toBe('E_SPAWN_FAILED');
      expect(e.message).toContain('EACCES');
    }
  });

  it('error before exit does not leave the safety timer dangling (clearTimeout called)', async () => {
    // Without the try/finally clearTimeout the test process would still
    // have the safety timer scheduled. This is hard to assert directly
    // from the test (Node's timer queue is not introspectable here)
    // without depending on internals. As a proxy: verify that after the
    // rejected promise settles, no further ticks see child.kill being
    // called -- the safety-net timer schedules child.kill on timeout.
    const child = makeChildEmitter();
    mocks.spawnFn.mockReturnValue(child);
    setTimeout(() => {
      const err: NodeJS.ErrnoException = new Error('spawn pwsh ENOENT');
      err.code = 'ENOENT';
      child.emit('error', err);
    }, 5);

    await expect(runPowerShellScript('FakeScript.ps1', [])).rejects.toMatchObject({ code: 'E_SPAWN_FAILED' });
    // child.kill should never have been called: error fired before timeout.
    expect(child.kill).not.toHaveBeenCalled();
  });
});
