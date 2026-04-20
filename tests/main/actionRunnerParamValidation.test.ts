// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the new param allow-list behavior in runAction (v2.3.13,
 * actionRunner.ts:54-108). The new rules are:
 *   - unknown key -> E_UNKNOWN_PARAM
 *   - missing required -> E_MISSING_PARAM
 *   - key charset [a-z_][a-z0-9_]*  -> E_INVALID_PARAM_NAME on violation
 *   - value declared number but not /^-?\d+(\.\d+)?$/ -> E_INVALID_PARAM
 * Unknown action (not in ACTIONS) still returns E_ACTION_UNKNOWN.
 *
 * We stub out every side-effectful dep (scriptRunner, dataStore,
 * rollbackManager, notifier) so runAction is reduced to pure validation
 * plumbing. That way, tests don't touch disk, powershell, or sqlite.
 */

vi.mock('../../src/main/scriptRunner.js', () => ({
  runPowerShellScript: vi.fn(async () => ({ success: true, message: 'ok' })),
  runElevatedPowerShellScript: vi.fn(async () => ({ success: true, message: 'ok' })),
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

describe('runAction param allow-list (v2.3.13)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns E_ACTION_UNKNOWN when action name is not in ACTIONS', async () => {
    const r = await runAction({ name: 'not_a_real_action' as any });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('E_ACTION_UNKNOWN');
    // Script must never be invoked for unknown actions.
    expect(runPowerShellScript).not.toHaveBeenCalled();
    expect(runElevatedPowerShellScript).not.toHaveBeenCalled();
  });

  it('rejects an unknown param with E_UNKNOWN_PARAM (the smuggle-flag bypass fix)', async () => {
    // update_hosts_stevenblack has NO params_schema, so any key is unknown.
    // This is the exact scenario called out in the actionRunner comment:
    // renderer sending -SourceUrl to redirect the hosts merge URL.
    const r = await runAction({
      name: 'update_hosts_stevenblack',
      params: { SourceUrl: 'http://attacker.example/evil-hosts' } as any,
    });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('E_UNKNOWN_PARAM');
    // Neither PS runner should fire on validation failure.
    expect(runPowerShellScript).not.toHaveBeenCalled();
    expect(runElevatedPowerShellScript).not.toHaveBeenCalled();
  });

  it('rejects a required missing param with E_MISSING_PARAM', async () => {
    // block_ip requires { ip: required }
    const r = await runAction({ name: 'block_ip', params: {} });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('E_MISSING_PARAM');
    expect(runElevatedPowerShellScript).not.toHaveBeenCalled();
  });

  it('treats empty-string required param as missing', async () => {
    const r = await runAction({ name: 'block_ip', params: { ip: '' } });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('E_MISSING_PARAM');
  });

  it('rejects a param name with shell metacharacters via E_INVALID_PARAM_NAME or E_UNKNOWN_PARAM', async () => {
    // 'ip;rm' isn't in the schema, so it trips E_UNKNOWN_PARAM *first*
    // (the unknown-key check runs before the name-charset check for
    // already-known keys). Either way, validation must stop before spawn.
    const r = await runAction({ name: 'block_ip', params: { 'ip;rm': '1.2.3.4' } as any });
    expect(r.success).toBe(false);
    expect(['E_UNKNOWN_PARAM', 'E_INVALID_PARAM_NAME']).toContain(r.error?.code);
    expect(runElevatedPowerShellScript).not.toHaveBeenCalled();
  });

  it('rejects non-numeric value when schema type is number with E_INVALID_PARAM', async () => {
    // run_hwinfo_log has duration: { type: number, required: false }
    const r = await runAction({ name: 'run_hwinfo_log', params: { duration: 'abc' } as any });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('E_INVALID_PARAM');
  });

  it('accepts a numeric value for a number-typed param (validation passes)', async () => {
    const r = await runAction({ name: 'run_hwinfo_log', params: { duration: 60 } });
    // scriptRunner mock returns success
    expect(r.success).toBe(true);
    expect(runPowerShellScript).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid ip for block_ip and routes to elevated runner (needs_admin)', async () => {
    const r = await runAction({
      name: 'block_ip',
      params: { ip: '203.0.113.5', reason: 'Auto-block: RDP brute-force' },
      triggered_by: 'alert',
    });
    expect(r.success).toBe(true);
    // block_ip is needs_admin: true -> elevated path.
    expect(runElevatedPowerShellScript).toHaveBeenCalledTimes(1);
    expect(runPowerShellScript).not.toHaveBeenCalled();
    // Verify the script got -Ip + -Reason flags (PascalCased by actionRunner).
    const callArgs = (runElevatedPowerShellScript as any).mock.calls[0];
    const scriptArgs = callArgs[1] as string[];
    expect(scriptArgs).toContain('-Ip');
    expect(scriptArgs).toContain('203.0.113.5');
    expect(scriptArgs).toContain('-Reason');
  });

  it('accepts optional params being omitted', async () => {
    // disable_startup_item has a required item_name; unblock_ip has required ip
    // We use block_ip with only the required 'ip' param; reason is optional.
    const r = await runAction({ name: 'block_ip', params: { ip: '198.51.100.9' } });
    expect(r.success).toBe(true);
  });

  it('no params at all for action with optional-only schema is OK (analyze_minidump, dump_path optional)', async () => {
    const r = await runAction({ name: 'analyze_minidump' });
    expect(r.success).toBe(true);
  });
});
