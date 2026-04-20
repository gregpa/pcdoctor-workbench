import { describe, it, expect } from 'vitest';
import { ACTIONS } from '../../src/shared/actions.js';
import type { ActionName } from '../../src/shared/types.js';

// Tool-runner actions introduced in v2.2.0.
const V220_ACTIONS: ReadonlyArray<{ name: ActionName; script: string; category: string }> = [
  { name: 'run_smart_check',       script: 'actions/Run-SmartCheck.ps1',       category: 'diagnostic' },
  { name: 'run_malwarebytes_cli',  script: 'actions/Run-MalwarebytesCli.ps1',  category: 'security' },
  { name: 'run_adwcleaner_scan',   script: 'actions/Run-AdwCleanerScan.ps1',   category: 'security' },
  { name: 'run_safety_scanner',    script: 'actions/Run-SafetyScanner.ps1',    category: 'security' },
  { name: 'run_hwinfo_log',        script: 'actions/Run-HwinfoLog.ps1',        category: 'diagnostic' },
  { name: 'parse_hwinfo_delta',    script: 'actions/Parse-HwinfoDelta.ps1',    category: 'diagnostic' },
];

describe('v2.2.0 actions registry', () => {
  for (const { name, script, category } of V220_ACTIONS) {
    it(`${name} is registered with the correct ps_script path and category`, () => {
      const def = ACTIONS[name];
      expect(def, `${name} must be registered in ACTIONS`).toBeDefined();
      expect(def.name).toBe(name);
      expect(def.ps_script).toBe(script);
      expect(def.category).toBe(category);
    });
  }

  it('v2.2.0 tool-runner actions are all non-destructive (report / read-only)', () => {
    // By design these are diagnostic/detection-only. Destructive scans would violate spec.
    for (const { name } of V220_ACTIONS) {
      expect(ACTIONS[name].confirm_level).not.toBe('destructive');
    }
  });

  it('run_hwinfo_log declares a duration param in its schema', () => {
    const schema = ACTIONS.run_hwinfo_log.params_schema;
    expect(schema).toBeDefined();
    expect(schema?.duration).toBeDefined();
    expect(schema?.duration.type).toBe('number');
  });
});
