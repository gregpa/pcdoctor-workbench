// @vitest-environment node
//
// v2.4.48 (B48-MIG-1b): full-set verification tests.
//
// Pre-2.4.48 verifyAutopilotMigration used `rows.some(...)` — one passing
// autopilot row was enough to flip `last_task_migration_version`. The new
// predicate requires every name in EXPECTED_AUTOPILOT_TASK_NAMES (the 11
// canonical autopilot tasks) to be both `registered` and dispatcher-backed.
//
// Cases mirror plan §3 (tests/main/taskMigrationVerify.fullSet.test.ts):
//   1. All 11 expected names present, registered, dispatcher-backed → true
//   2. One expected name missing → false
//   3. One expected name present but status:'failed' → false
//   4. One expected name registered but no dispatcher reference → false
//   5. Extra non-autopilot rows do not affect the verdict
//   6. Size-mismatch case (B46-1) still fails
//
// Plus a drift-guard: load Register-All-Tasks.ps1, regex-extract the live
// PCDoctor-Autopilot-* names, assert setEqual to EXPECTED_AUTOPILOT_TASK_NAMES.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  verifyAutopilotMigration,
  EXPECTED_AUTOPILOT_TASK_NAMES,
} from '../../src/main/taskMigrationVerify.js';

const DISPATCHER_CMD =
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\ProgramData\\PCDoctor\\Run-AutopilotScheduled.ps1" -RuleId "rule" -Tier 1 -ActionScript "C:\\ProgramData\\PCDoctor\\actions\\Foo.ps1"';

function fullSetRows(): Array<Record<string, unknown>> {
  return EXPECTED_AUTOPILOT_TASK_NAMES.map(name => ({
    name,
    status: 'registered',
    command: DISPATCHER_CMD,
    output: 'SUCCESS',
  }));
}

describe('verifyAutopilotMigration — full-set predicate (B48-MIG-1b)', () => {
  it('case 1: all 11 expected names present, registered, dispatcher-backed → true', () => {
    expect(verifyAutopilotMigration({ results: fullSetRows() })).toBe(true);
  });

  it('case 2: one expected name missing → false', () => {
    const rows = fullSetRows();
    rows.pop(); // drop UpdateHostsStevenBlack (last in list)
    expect(verifyAutopilotMigration({ results: rows })).toBe(false);
  });

  it('case 3: one expected name present but status=failed → false', () => {
    const rows = fullSetRows();
    rows[0] = { ...rows[0], status: 'failed', output: 'ERROR: registration failed' };
    expect(verifyAutopilotMigration({ results: rows })).toBe(false);
  });

  it('case 4: one expected name registered but no dispatcher reference in command or output → false', () => {
    const rows = fullSetRows();
    rows[0] = {
      ...rows[0],
      command: 'powershell.exe -File "C:\\ProgramData\\PCDoctor\\actions\\Empty-RecycleBins.ps1" -JsonOutput',
      output: 'SUCCESS',
    };
    expect(verifyAutopilotMigration({ results: rows })).toBe(false);
  });

  it('case 5: extra non-autopilot rows do not affect the verdict', () => {
    const rows: Array<Record<string, unknown>> = [
      ...fullSetRows(),
      { name: 'PCDoctor-Workbench-Autostart', status: 'registered', output: 'SUCCESS' },
      { name: 'PCDoctor-Weekly-Review', status: 'registered', command: 'powershell.exe -File X.ps1' },
      { name: 'PCDoctor-Forecast', status: 'registered', command: 'powershell.exe -File Y.ps1' },
    ];
    expect(verifyAutopilotMigration({ results: rows })).toBe(true);
  });

  it('case 6: size-mismatch (B46-1) still fails even with a passing full set', () => {
    const rows = fullSetRows();
    expect(verifyAutopilotMigration({ results: rows }, { deployedSize: 9000, bundledSize: 12345 })).toBe(false);
  });
});

describe('EXPECTED_AUTOPILOT_TASK_NAMES drift guard (B48-MIG-1b §7 risk row)', () => {
  it('matches the live PCDoctor-Autopilot-* names defined in Register-All-Tasks.ps1', () => {
    // Load the bundled script. Test runs from repo root so this path is stable.
    const scriptPath = path.join(process.cwd(), 'powershell', 'Register-All-Tasks.ps1');
    const ps = readFileSync(scriptPath, 'utf8');

    // Pull every literal PCDoctor-Autopilot-<word> name. The script writes
    // these as e.g. `name = 'PCDoctor-Autopilot-EmptyRecycleBins'`. We allow
    // both single and double quotes for resilience to future edits.
    const re = /['"](PCDoctor-Autopilot-[A-Za-z0-9_-]+)['"]/g;
    const live = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(ps)) !== null) {
      live.add(m[1]);
    }

    const expected = new Set<string>(EXPECTED_AUTOPILOT_TASK_NAMES);

    // Every live name must be in the TS export...
    for (const name of live) {
      expect(expected.has(name), `Register-All-Tasks.ps1 has '${name}' but EXPECTED_AUTOPILOT_TASK_NAMES does not`).toBe(true);
    }
    // ...and every TS-exported name must appear in the script.
    for (const name of expected) {
      expect(live.has(name), `EXPECTED_AUTOPILOT_TASK_NAMES has '${name}' but Register-All-Tasks.ps1 does not`).toBe(true);
    }
  });
});
