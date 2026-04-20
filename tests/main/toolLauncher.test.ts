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

import { existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
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
    (spawn as any).mockReturnValue(child);

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

    // All FS checks return true so isMsixInstalled fast-paths to installed
    (existsSync as any).mockReturnValue(true);
    const child = makeFakeChild(5555);
    (spawn as any).mockReturnValue(child);

    const result = await launchTool(msixTool.id, msixTool.launch_modes[0].id);

    expect(result.ok).toBe(true);
    const spawnCall = (spawn as any).mock.calls[0];
    expect(spawnCall[0]).toBe('explorer.exe');
    expect(spawnCall[1][0]).toContain('shell:AppsFolder\\');
  });

  it('returns ok=false and error message when spawn throws', async () => {
    (existsSync as any).mockImplementation((p: string) =>
      p === 'C:\\ProgramData\\PCDoctor\\tools\\OCCT\\OCCT.exe'
    );
    (spawn as any).mockImplementation(() => { throw new Error('EACCES: permission denied'); });

    const result = await launchTool('occt', 'default');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/EACCES/);
  });
});
