// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
}));

import { spawn } from 'node:child_process';
import { runPowerShellScript } from '../../src/main/scriptRunner.js';

function fakeChild(opts: { stdout?: string; stderr?: string; exitCode?: number; delayMs?: number }) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('exit', opts.exitCode ?? 0);
  }, opts.delayMs ?? 5);
  return child;
}

describe('runPowerShellScript', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses JSON stdout on exit 0', async () => {
    (spawn as any).mockReturnValue(fakeChild({ stdout: '{"success":true,"freed_bytes":12345}\n' }));
    const result = await runPowerShellScript('actions/Flush-DNS.ps1', []);
    expect(result).toEqual({ success: true, freed_bytes: 12345 });
  });

  it('throws with code E_PS_UNHANDLED when PCDOCTOR_ERROR sentinel present', async () => {
    const err = JSON.stringify({ code: 'E_CUSTOM', message: 'nope', script: 'Flush-DNS.ps1', line: 10 });
    (spawn as any).mockReturnValue(fakeChild({ stdout: `PCDOCTOR_ERROR:${err}\n`, exitCode: 1 }));
    await expect(runPowerShellScript('actions/Flush-DNS.ps1', [])).rejects.toMatchObject({
      code: 'E_CUSTOM',
      message: 'nope',
    });
  });

  it('throws E_PS_NONZERO_EXIT on nonzero exit without sentinel', async () => {
    (spawn as any).mockReturnValue(fakeChild({ stdout: 'garbage', exitCode: 2 }));
    await expect(runPowerShellScript('actions/Flush-DNS.ps1', [])).rejects.toMatchObject({
      code: 'E_PS_NONZERO_EXIT',
    });
  });

  it('throws E_PS_INVALID_JSON when exit 0 but stdout is not JSON', async () => {
    (spawn as any).mockReturnValue(fakeChild({ stdout: 'hello world' }));
    await expect(runPowerShellScript('actions/Flush-DNS.ps1', [])).rejects.toMatchObject({
      code: 'E_PS_INVALID_JSON',
    });
  });

  it('kills the child and throws E_TIMEOUT_KILLED when deadline exceeded', async () => {
    const child = fakeChild({ stdout: '{}', delayMs: 100 });
    (spawn as any).mockReturnValue(child);
    await expect(runPowerShellScript('actions/Flush-DNS.ps1', [], { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'E_TIMEOUT_KILLED',
    });
    expect(child.kill).toHaveBeenCalled();
  });
});
