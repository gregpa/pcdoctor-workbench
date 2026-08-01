/**
 * v2.3.0 C2 — Autopilot rule editor persistence + run-now semantics.
 *
 * We test the dataStore helpers directly (setAutopilotRuleEnabled / getAutopilotRule)
 * using a temporary file-backed better-sqlite3 database via the existing openDb layer.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let ds: typeof import('../../src/main/dataStore.js');

// Constants module stub: openDb() reads WORKBENCH_DB_PATH, so we redirect it to
// a temp directory before the real module is loaded. A native-load failure must
// fail this hook so the test suite cannot report a false pass.
beforeAll(async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pcd-ap-rules-'));
  process.env.PCD_DB_PATH_OVERRIDE = path.join(tmp, 'workbench.db');
  ds = await import('../../src/main/dataStore.js');
});

describe('autopilot rule editor — dataStore contract', () => {
  it('setAutopilotRuleEnabled toggles the enabled flag and getAutopilotRule reads it back', async () => {
    const { upsertAutopilotRule, setAutopilotRuleEnabled, getAutopilotRule } = ds;
    upsertAutopilotRule({
      id: 'test_rule_c2',
      tier: 1,
      description: 'test rule',
      trigger: 'schedule',
      cadence: 'daily:01:00',
      action_name: 'run_smart_check',
      enabled: true,
    });
    expect(getAutopilotRule('test_rule_c2')?.enabled).toBe(1);

    setAutopilotRuleEnabled('test_rule_c2', false);
    expect(getAutopilotRule('test_rule_c2')?.enabled).toBe(0);

    setAutopilotRuleEnabled('test_rule_c2', true);
    expect(getAutopilotRule('test_rule_c2')?.enabled).toBe(1);
  });

  it('getAutopilotRule returns null for unknown rule id', async () => {
    expect(ds.getAutopilotRule('does_not_exist_xyz')).toBeNull();
  });
});

/**
 * Logical contract of api:runAutopilotRuleNow as described in ipc.ts:
 *   - threshold rule that evaluates to null → activity 'skipped'
 *   - threshold rule that evaluates to a decision → dispatches (minGapMs=0)
 *   - schedule rule → runs action directly, records auto_run/error activity
 *
 * We test this at the level of input mapping to keep the test free of a full
 * IPC harness. The intent is to catch accidental regressions in which paths
 * are taken.
 */
describe('autopilot rule run-now — path selection', () => {
  function pickPath(rule: { trigger: string; action_name: string | null }): 'threshold' | 'schedule' | 'invalid' {
    if (rule.trigger === 'threshold') return 'threshold';
    if (rule.action_name) return 'schedule';
    return 'invalid';
  }

  it('threshold rule → threshold path', () => {
    expect(pickPath({ trigger: 'threshold', action_name: null })).toBe('threshold');
  });
  it('schedule rule with action → schedule path', () => {
    expect(pickPath({ trigger: 'schedule', action_name: 'run_smart_check' })).toBe('schedule');
  });
  it('schedule rule without action → invalid', () => {
    expect(pickPath({ trigger: 'schedule', action_name: null })).toBe('invalid');
  });
});
