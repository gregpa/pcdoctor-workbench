// @vitest-environment node
//
// v2.4.48 (B48-AS-1): tests for the silent-success guard in actionRunner.
//
// Pre-2.4.48 the runner recorded `status:'success'` whenever the wrapped
// PowerShell script exited 0 + emitted valid JSON. Four scripts (Run-DISM,
// Cleanup-WinSxS, Reset-Firewall, Reset-WinSock) emit
// `{"success":false,"message":"..."}` + exit 0 on logical failure; the
// audit log lied, History showed green, and no warning toast fired.
//
// The new guard checks `result.success === false` (not `!== true`) so
// actions whose JSON intentionally omits the `success` key keep the
// legacy success path.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/main/scriptRunner.js', () => ({
  runPowerShellScript: vi.fn(),
  runElevatedPowerShellScript: vi.fn(),
  isUacEnabled: vi.fn(() => true),
  PCDoctorScriptError: class extends Error {
    code: string;
    details?: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
}));

vi.mock('../../src/main/dataStore.js', () => ({
  startActionLog: vi.fn(() => 1),
  finishActionLog: vi.fn(),
  insertToolResult: vi.fn(),
  updateActionLogRollbackId: vi.fn(),
}));

vi.mock('../../src/main/rollbackManager.js', () => ({
  prepareRollback: vi.fn(async () => null),
}));

vi.mock('../../src/main/notifier.js', () => ({
  notify: vi.fn(async () => {}),
}));

import { runAction } from '../../src/main/actionRunner.js';
import { runPowerShellScript, runElevatedPowerShellScript } from '../../src/main/scriptRunner.js';
import { finishActionLog } from '../../src/main/dataStore.js';
import { notify } from '../../src/main/notifier.js';

describe('runAction silent-success guard (B48-AS-1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns E_ACTION_REPORTED_FAILURE when script JSON has success=false', async () => {
    // Run-DISM is needs_admin, routes to elevated runner.
    (runElevatedPowerShellScript as any).mockResolvedValueOnce({ success: false, message: 'DISM /RestoreHealth failed: 0x800f081f' });
    const r = await runAction({ name: 'run_dism' });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('E_ACTION_REPORTED_FAILURE');
    expect(r.error?.message).toContain('0x800f081f');
    // triggered_by defaults to 'user' when omitted — notify must fire so
    // the implicit-default path doesn't silently regress to scheduled-style
    // suppression. (Code-reviewer W6.)
    expect((notify as any).mock.calls.length).toBe(1);
  });

  it('writes status:error to the audit log when success=false', async () => {
    (runElevatedPowerShellScript as any).mockResolvedValueOnce({ success: false, message: 'failed' });
    await runAction({ name: 'run_dism' });
    const calls = (finishActionLog as any).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][1].status).toBe('error');
    expect(calls[0][1].error_message).toBe('failed');
  });

  it('fires a warning notification on user-triggered failure', async () => {
    (runElevatedPowerShellScript as any).mockResolvedValueOnce({ success: false, message: 'failed' });
    await runAction({ name: 'run_dism', triggered_by: 'user' });
    expect((notify as any).mock.calls.length).toBe(1);
    expect((notify as any).mock.calls[0][0]).toMatchObject({
      severity: 'warning',
      eventKey: 'action_failed',
    });
  });

  it('does NOT notify on scheduled-triggered failure (silent log only)', async () => {
    (runElevatedPowerShellScript as any).mockResolvedValueOnce({ success: false, message: 'failed' });
    await runAction({ name: 'run_dism', triggered_by: 'scheduled' });
    expect((notify as any).mock.calls.length).toBe(0);
  });

  it('falls through default-success ("success" key omitted) — preserves legacy behaviour', async () => {
    // analyze_minidump: optional dump_path. No needs_admin → non-elevated runner.
    // No `success` key in the result at all → guard MUST NOT trip.
    (runPowerShellScript as any).mockResolvedValueOnce({ message: 'Analyzed 0 dumps', count: 0 });
    const r = await runAction({ name: 'analyze_minidump' });
    expect(r.success).toBe(true);
  });

  it('treats success=true as success', async () => {
    (runPowerShellScript as any).mockResolvedValueOnce({ success: true, message: 'ok' });
    const r = await runAction({ name: 'analyze_minidump' });
    expect(r.success).toBe(true);
  });

  it('uses the default error message when the script omits `message` on success=false', async () => {
    (runElevatedPowerShellScript as any).mockResolvedValueOnce({ success: false });
    const r = await runAction({ name: 'run_dism' });
    expect(r.success).toBe(false);
    expect(r.error?.message).toBe('Action reported success=false');
  });
});
