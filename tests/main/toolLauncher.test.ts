// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn() };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(), spawn: vi.fn() };
});
// v2.4.36: mock electron.shell.openPath for the async EACCES fallback tests.
vi.mock('electron', () => ({
  shell: { openPath: vi.fn() },
}));

import { existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { shell } from 'electron';
import { getToolStatus, launchTool } from '../../src/main/toolLauncher.js';
import { TOOLS } from '../../src/shared/tools.js';

describe('getToolStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns installed=false for an unknown tool id', () => {
    const status = getToolStatus('does-not-exist');
    expect(status).toEqual({ id: 'does-not-exist', installed: false, resolved_path: null });
    // No FS or winget probe should happen for unknown tools.
    expect(existsSync as any).not.toHaveBeenCalled();
    expect(spawnSync as any).not.toHaveBeenCalled();
  });

  it('fast-path: first detect_path that exists → installed=true, winget is never called', () => {
    // occt: first candidate is C:\ProgramData\PCDoctor\tools\OCCT\OCCT.exe
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe'
    );
    const status = getToolStatus('occt');
    expect(status.installed).toBe(true);
    expect(status.resolved_path).toBe('C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe');
    expect(spawnSync as any).not.toHaveBeenCalled();
  });

  it('fast-path: later detect_path that exists → returns that path', () => {
    // gpu-z has two detect_paths
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\Program Files (x86)\\TechPowerUp\\GPU-Z\\GPU-Z.exe'
    );
    const status = getToolStatus('gpu-z');
    expect(status.installed).toBe(true);
    expect(status.resolved_path).toBe('C:\\Program Files (x86)\\TechPowerUp\\GPU-Z\\GPU-Z.exe');
    expect(spawnSync as any).not.toHaveBeenCalled();
  });

  it('winget fallback: no detect_path exists but winget reports installed → installed=true w/ null path', () => {
    (existsSync as any).mockReturnValue(false);
    (spawnSync as any).mockReturnValue({
      status: 0,
      stdout: 'Name    Id              Version\nGPU-Z   TechPowerUp.GPU-Z 2.55.0\n',
      stderr: '',
    });
    const status = getToolStatus('gpu-z');
    expect(status.installed).toBe(true);
    expect(status.resolved_path).toBeNull();
    expect(spawnSync as any).toHaveBeenCalledOnce();
    const call = (spawnSync as any).mock.calls[0];
    expect(call[0]).toBe('winget');
    expect(call[1]).toContain('TechPowerUp.GPU-Z');
  });

  it('winget fallback: winget status 0 but stdout does not mention id → not installed', () => {
    (existsSync as any).mockReturnValue(false);
    (spawnSync as any).mockReturnValue({
      status: 0,
      stdout: 'No installed package found matching input criteria.\n',
      stderr: '',
    });
    const status = getToolStatus('gpu-z');
    expect(status.installed).toBe(false);
    expect(status.resolved_path).toBeNull();
  });

  it('winget fallback: winget exits nonzero → not installed', () => {
    (existsSync as any).mockReturnValue(false);
    (spawnSync as any).mockReturnValue({ status: 1, stdout: '', stderr: 'no packages' });
    const status = getToolStatus('gpu-z');
    expect(status.installed).toBe(false);
  });

  it('no detect_path and no winget_id → installed=false, winget never invoked', () => {
    // `mss` has no winget_id (download-only)
    (existsSync as any).mockReturnValue(false);
    const status = getToolStatus('mss');
    expect(status.installed).toBe(false);
    expect(status.resolved_path).toBeNull();
    expect(spawnSync as any).not.toHaveBeenCalled();
  });

  it('spawnSync throwing is caught and treated as not-installed', () => {
    (existsSync as any).mockReturnValue(false);
    (spawnSync as any).mockImplementation(() => { throw new Error('ENOENT: winget'); });
    const status = getToolStatus('gpu-z');
    expect(status.installed).toBe(false);
  });

  it('MSIX path: package family dir exists → installed=true with shell:AppsFolder path', () => {
    // The WindowsSandbox tool (or any msix tool) uses msix_package_family
    // We verify the resolved_path format when isMsixInstalled returns true.
    // Mock existsSync so the MSIX Packages dir returns true for any call.
    (existsSync as any).mockImplementation((_p: string) => true);
    // Any tool with msix_app_id defined — use first one found, else skip
    const msixTool = Object.values(TOOLS).find((t: any) => t.msix_app_id) as any;
    if (!msixTool) return; // skip if no MSIX tools in catalog
    const status = getToolStatus(msixTool.id);
    expect(status.installed).toBe(true);
    expect(status.resolved_path).toMatch(/shell:AppsFolder\\/);
  });
});

// ---------------------------------------------------------------------------
// launchTool
// ---------------------------------------------------------------------------

function makeFakeChild(pid = 9999) {
  const child: any = new EventEmitter();
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

describe('launchTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok=false for unknown tool', async () => {
    const result = await launchTool('does-not-exist', 'default');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown tool/i);
  });

  it('returns ok=false when tool is not installed', async () => {
    // All existsSync → false, spawnSync → not installed
    (existsSync as any).mockReturnValue(false);
    (spawnSync as any).mockReturnValue({ status: 1, stdout: '', stderr: '' });
    const result = await launchTool('occt', 'default');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not installed/i);
  });

  it('spawns executable directly when tool has a resolved path', async () => {
    // Make existsSync return true for the first occt path only
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe'
    );
    const child = makeFakeChild(1234);
    // v2.4.36: launchTool now awaits the child's 'spawn' event. Emit it
    // on next tick so the wrapping Promise settles to ok=true.
    (spawn as any).mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    const result = await launchTool('occt', 'default');

    expect(result.ok).toBe(true);
    expect(result.pid).toBe(1234);
    const spawnCall = (spawn as any).mock.calls[0];
    expect(spawnCall[0]).toBe('C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe');
    expect(child.unref).toHaveBeenCalled();
  });

  it('spawns via explorer.exe shell:AppsFolder for MSIX tools', async () => {
    const msixTool = Object.values(TOOLS).find((t: any) => t.msix_app_id) as any;
    if (!msixTool) return; // skip if catalog has no MSIX tools

    // All FS checks return true so isMsixInstalled fast-paths to installed.
    // The MSIX branch still uses the pre-v2.4.36 sync spawn+unref pattern
    // (not the new Promise path), so mockReturnValue still works for it.
    (existsSync as any).mockReturnValue(true);
    const child = makeFakeChild(5555);
    (spawn as any).mockReturnValue(child);

    const result = await launchTool(msixTool.id, msixTool.launch_modes[0].id);

    expect(result.ok).toBe(true);
    const spawnCall = (spawn as any).mock.calls[0];
    expect(spawnCall[0]).toBe('explorer.exe');
    expect(spawnCall[1][0]).toContain('shell:AppsFolder\\');
  });

  it('returns ok=false and error message when spawn throws synchronously', async () => {
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe'
    );
    (spawn as any).mockImplementation(() => { throw new Error('EACCES: permission denied'); });

    const result = await launchTool('occt', 'default');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/EACCES/);
  });
});

// ---------------------------------------------------------------------------
// v2.4.36 (B44) regression guard: async spawn EACCES + shell.openPath fallback
// ---------------------------------------------------------------------------

describe('launchTool async EACCES handling (v2.4.36)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to shell.openPath when spawn emits async EACCES (args empty)', async () => {
    // OCCT's default mode has args: [] -- eligible for the fallback.
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe'
    );
    const child = makeFakeChild(1234);
    (spawn as any).mockImplementation(() => {
      queueMicrotask(() => {
        const err: any = new Error('spawn EACCES');
        err.code = 'EACCES';
        child.emit('error', err);
      });
      return child;
    });
    (shell.openPath as any).mockResolvedValueOnce(''); // '' = success

    const result = await launchTool('occt', 'default');
    expect(result.ok).toBe(true);
    expect(shell.openPath).toHaveBeenCalledWith('C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe');
  });

  it('falls back to shell.openPath on async UNKNOWN error (args empty)', async () => {
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe'
    );
    const child = makeFakeChild(1234);
    (spawn as any).mockImplementation(() => {
      queueMicrotask(() => {
        const err: any = new Error('spawn UNKNOWN');
        err.code = 'UNKNOWN';
        child.emit('error', err);
      });
      return child;
    });
    (shell.openPath as any).mockResolvedValueOnce('');

    const result = await launchTool('occt', 'default');
    expect(result.ok).toBe(true);
  });

  it('returns ok=false when spawn emits async error with non-EACCES code', async () => {
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe'
    );
    const child = makeFakeChild(1234);
    (spawn as any).mockImplementation(() => {
      queueMicrotask(() => {
        const err: any = new Error('ENOENT');
        err.code = 'ENOENT';
        child.emit('error', err);
      });
      return child;
    });

    const result = await launchTool('occt', 'default');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENOENT/);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('does NOT fall back to shell.openPath when launch mode has CLI args', async () => {
    // hwinfo64's default mode has args: ['-so'] -- shell.openPath can't
    // pass args so we must surface the error instead of dropping them.
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\Program Files\\HWiNFO64\\HWiNFO64.exe'
    );
    const child = makeFakeChild(1234);
    (spawn as any).mockImplementation(() => {
      queueMicrotask(() => {
        const err: any = new Error('spawn EACCES');
        err.code = 'EACCES';
        child.emit('error', err);
      });
      return child;
    });

    const result = await launchTool('hwinfo64', 'gui');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/EACCES/);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('surfaces shell.openPath failure message when fallback itself fails', async () => {
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe'
    );
    const child = makeFakeChild(1234);
    (spawn as any).mockImplementation(() => {
      queueMicrotask(() => {
        const err: any = new Error('spawn EACCES');
        err.code = 'EACCES';
        child.emit('error', err);
      });
      return child;
    });
    (shell.openPath as any).mockResolvedValueOnce('Access is denied.');

    const result = await launchTool('occt', 'default');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/shell\.openPath failed: Access is denied/);
  });

  it('sync-throw EACCES with code falls back to shell.openPath', async () => {
    // Pre-spawn sync throw (rare but possible) with code=EACCES should
    // engage the same fallback as the async path.
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe'
    );
    (spawn as any).mockImplementation(() => {
      const err: any = new Error('spawn EACCES');
      err.code = 'EACCES';
      throw err;
    });
    (shell.openPath as any).mockResolvedValueOnce('');

    const result = await launchTool('occt', 'default');
    expect(result.ok).toBe(true);
    expect(shell.openPath).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// v2.4.36 (C) regression guards: async spawn timeout with pid === undefined
// and double-resolve prevention via the `settled` guard.
// ---------------------------------------------------------------------------

describe('launchTool async edge cases (v2.4.36)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * BUG (documented, not yet fixed): when spawn() returns a child whose pid
   * is undefined AND neither 'spawn' nor 'error' fires within 500ms, the
   * timeout branch runs `settle({ ok: true, pid: child.pid })` where
   * child.pid is undefined. The caller receives ok=true with no pid,
   * which is indistinguishable from a successful launch but the process
   * never actually started.
   *
   * DESIRED behavior: ok=false, error='Process started but PID unavailable'.
   * This test documents the desired fixed behavior. It will FAIL against the
   * current production code (ok=true, pid=undefined) -- that failure is
   * intentional and tracks the open bug for the fix PR.
   */
  it('EXPECTED FAIL (bug): timeout path with pid=undefined returns ok=false (desired fixed behavior)', async () => {
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe'
    );
    // Return a child with no pid; emit neither 'spawn' nor 'error' so
    // the 500ms safety-net setTimeout fires.
    const child = new EventEmitter() as any;
    child.pid = undefined;
    child.unref = vi.fn();
    (spawn as any).mockReturnValue(child);

    // Advance fake timers past the 500ms gate.
    vi.useFakeTimers();
    const resultPromise = launchTool('occt', 'default');
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();

    const result = await resultPromise;
    // DESIRED (fixed) behavior:
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/PID unavailable/i);
    // Current (broken) behavior would be: result.ok === true, result.pid === undefined
    // If this assertion fails, the production bug is still open.
  }, 10_000);

  /**
   * Guard: when both 'spawn' and 'error' fire (in that order), only the
   * first settlement is honoured. The `settled` flag must prevent the
   * 'error' handler from overwriting the ok=true result.
   */
  it('settled guard prevents double-resolve when spawn then error both fire', async () => {
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe'
    );
    const child = makeFakeChild(7777);
    (spawn as any).mockImplementation(() => {
      // Fire 'spawn' first, then 'error' on the next microtask tick.
      queueMicrotask(() => {
        child.emit('spawn');
        queueMicrotask(() => {
          const err: any = new Error('ENOENT late error');
          err.code = 'ENOENT';
          child.emit('error', err);
        });
      });
      return child;
    });

    const result = await launchTool('occt', 'default');
    // 'spawn' fired first: result must be ok=true with the correct pid.
    // If the settled guard is broken, the subsequent 'error' would overwrite
    // this and return ok=false.
    expect(result.ok).toBe(true);
    expect(result.pid).toBe(7777);
  });
});
