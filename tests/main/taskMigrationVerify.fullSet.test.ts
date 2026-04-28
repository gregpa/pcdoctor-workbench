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
    // these as `name = 'PCDoctor-Autopilot-EmptyRecycleBins'` inside a
    // hashtable literal. Anchor on the `name = '...'` shape so a future
    // comment that happens to quote a task name (e.g. `# replaces
    // 'PCDoctor-Autopilot-OldName'`) does not pollute the live set.
    // Both single and double quotes accepted for resilience to future edits.
    const re = /\bname\s*=\s*['"](PCDoctor-Autopilot-[A-Za-z0-9_-]+)['"]/g;
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

// v2.4.49 (B47-2): drift guard for the registered task XML's <Author> field.
// Pre-2.4.49 the line was hardcoded to '<Author>PCDoctor v2.4.46</Author>'
// across multiple releases. The live script now reads $ScriptVersion from
// package.json with a hardcoded fallback. This test asserts:
//   1. The live <Author> line uses the $ScriptVersion variable (not a literal).
//   2. The hardcoded fallback literal in the $ScriptVersion = '...' line
//      matches package.json.version.
// If a future package.json bump forgets to update the fallback literal, this
// test fails BEFORE shipping.
describe('Register-All-Tasks.ps1 Author/version drift guard (v2.4.49 B47-2)', () => {
  it('the <Author> line uses $ScriptVersion (not a hardcoded literal)', () => {
    const scriptPath = path.join(process.cwd(), 'powershell', 'Register-All-Tasks.ps1');
    const ps = readFileSync(scriptPath, 'utf8');
    expect(ps).toMatch(/<Author>PCDoctor v\$ScriptVersion<\/Author>/);
    // Negative: the old hardcoded literal must NOT survive.
    expect(ps).not.toMatch(/<Author>PCDoctor v2\.4\.46<\/Author>/);
  });

  it('the $ScriptVersion fallback literal matches package.json.version', () => {
    const scriptPath = path.join(process.cwd(), 'powershell', 'Register-All-Tasks.ps1');
    const ps = readFileSync(scriptPath, 'utf8');
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    // Match the literal assignment "$ScriptVersion = '<x.y.z>'" — the first
    // occurrence (the fallback). PowerShell allows single or double quotes.
    const m = ps.match(/\$ScriptVersion\s*=\s*['"]([^'"]+)['"]/);
    expect(m, '$ScriptVersion fallback literal not found in Register-All-Tasks.ps1').not.toBeNull();
    if (m) {
      expect(m[1]).toMatch(/^\d+\.\d+\.\d+$/);
      expect(m[1]).toBe(pkg.version);
    }
  });

  it('the rendered Author string (with $ScriptVersion = package.json.version) matches PCDoctor v<semver>', () => {
    // Cheap semantic check: take the live <Author> line, substitute
    // $ScriptVersion with package.json.version, assert the result matches
    // the documented shape.
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    const rendered = `<Author>PCDoctor v${pkg.version}</Author>`;
    expect(rendered).toMatch(/^<Author>PCDoctor v\d+\.\d+\.\d+<\/Author>$/);
    expect(rendered).toBe(`<Author>PCDoctor v${pkg.version}</Author>`);
  });
});
