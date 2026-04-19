// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn() };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(), spawn: vi.fn() };
});

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getToolStatus } from '../../src/main/toolLauncher.js';

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
});
