// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * v2.3.13 scriptRunner error classification - additional boundary cases
 * NOT already covered by scriptRunner.test.ts:
 *
 *  A. PCDOCTOR_ERROR sentinel takes PRECEDENCE over a non-zero exit code.
 *     If a PS script writes the sentinel AND exits 1, the caller must see
 *     the structured error from the sentinel (parsed code/message), not
 *     the generic E_PS_NONZERO_EXIT. (scriptRunner.ts:89-107)
 *
 *  B. Sentinel appears on a LATE line of stdout (not just the first line).
 *     The /PCDOCTOR_ERROR:(.+)$/m regex must scan all of stdout.
 *
 *  C. An unparseable sentinel body (e.g. "PCDOCTOR_ERROR:not-json")
 *     falls back to E_PS_UNHANDLED rather than throwing a SyntaxError.
 *
 *  D. Exit code 0 with empty stdout -> E_PS_INVALID_JSON
 *     (edge case distinct from non-zero exit).
 *
 *  E. Stderr is preserved in the thrown error's .details for debugging.
 */

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

describe('scriptRunner sentinel + error-classification edges', () => {
  beforeEach(() => vi.clearAllMocks());

  it('A. PCDOCTOR_ERROR sentinel wins over a non-zero exit code', async () => {
    const body = JSON.stringify({ code: 'E_CUSTOM_TIMEOUT', message: 'took too long' });
    (spawn as any).mockReturnValue(fakeChild({
      stdout: `Doing stuff...\nPCDOCTOR_ERROR:${body}\n`,
      exitCode: 1,   // non-zero - but sentinel must still win
    }));
    await expect(runPowerShellScript('actions/Flush-DNS.ps1', [])).rejects.toMatchObject({
      code: 'E_CUSTOM_TIMEOUT',
      message: 'took too long',
    });
  });

  it('B. finds sentinel on a late stdout line (multi-line output)', async () => {
    const body = JSON.stringify({ code: 'E_LATE', message: 'late error' });
    (spawn as any).mockReturnValue(fakeChild({
      stdout:
        'line1 info\n' +
        'line2 warning\n' +
        'line3 more\n' +
        `PCDOCTOR_ERROR:${body}\n`,
      exitCode: 1,
    }));
    await expect(runPowerShellScript('actions/Flush-DNS.ps1', [])).rejects.toMatchObject({
      code: 'E_LATE',
    });
  });

  it('C. unparseable sentinel body falls back to E_PS_UNHANDLED (no raw throw)', async () => {
    (spawn as any).mockReturnValue(fakeChild({
      stdout: 'PCDOCTOR_ERROR:this is not json\n',
      exitCode: 1,
    }));
    await expect(runPowerShellScript('actions/Flush-DNS.ps1', [])).rejects.toMatchObject({
      code: 'E_PS_UNHANDLED',
    });
  });

  it('D. exit 0 with empty stdout throws E_PS_INVALID_JSON (not E_PS_NONZERO_EXIT)', async () => {
    (spawn as any).mockReturnValue(fakeChild({ stdout: '', exitCode: 0 }));
    await expect(runPowerShellScript('actions/Flush-DNS.ps1', [])).rejects.toMatchObject({
      code: 'E_PS_INVALID_JSON',
    });
  });

  it('E. stderr is captured in details on E_PS_NONZERO_EXIT', async () => {
    (spawn as any).mockReturnValue(fakeChild({
      stdout: 'no json here',
      stderr: 'something went wrong in PS',
      exitCode: 2,
    }));
    try {
      await runPowerShellScript('actions/Flush-DNS.ps1', []);
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('E_PS_NONZERO_EXIT');
      expect(e.details?.stderr ?? '').toContain('something went wrong');
      expect(e.details?.exitCode).toBe(2);
    }
  });

  it('forwards onStdout/onStderr callbacks during normal run', async () => {
    const onStdout = vi.fn();
    const onStderr = vi.fn();
    (spawn as any).mockReturnValue(fakeChild({
      stdout: '{"ok":true}',
      stderr: 'warning: foo',
      exitCode: 0,
    }));
    await runPowerShellScript('actions/Flush-DNS.ps1', [], { onStdout, onStderr });
    expect(onStdout).toHaveBeenCalled();
    expect(onStderr).toHaveBeenCalled();
  });
});
