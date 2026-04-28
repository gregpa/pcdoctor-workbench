// @vitest-environment node
//
// v2.4.47 (B46-1): tests for the elevated-autopilot-sync gating predicate
// and the new size-mismatch arm of verifyAutopilotMigration.
//
// Predicates extracted from main.ts so the migration block's "fire elevated
// Sync only when (a) upgrading, (b) bundle probe needs elevation, AND
// (c) an autopilot script is in the mismatch list" three-way gate is testable
// without dragging in Electron app + better-sqlite3 + IPC startup.
//
// B46-1 root cause: v2.4.46's migration block awaited bundleSyncPromise but
// did NOT trigger its own elevated Sync — it relied on the ACL IIFE's
// elevated path, which short-circuited via `last_acl_repair_version` because
// the v2.4.45 install had already repaired ACLs at that version. Net result:
// every v2.4.46 install ran Register-All-Tasks against the still-deployed
// v2.4.45 autopilot scripts, producing a no-op migration.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  verifyAutopilotMigration,
  shouldFireElevatedAutopilotSync,
  autopilotScriptsAreStale,
  AUTOPILOT_SCRIPT_NAMES,
  EXPECTED_AUTOPILOT_TASK_NAMES,
} from '../../src/main/taskMigrationVerify.js';

describe('AUTOPILOT_SCRIPT_NAMES (B46-1 invariant)', () => {
  it('contains both Register-All-Tasks.ps1 and Run-AutopilotScheduled.ps1', () => {
    expect(AUTOPILOT_SCRIPT_NAMES).toContain('Register-All-Tasks.ps1');
    expect(AUTOPILOT_SCRIPT_NAMES).toContain('Run-AutopilotScheduled.ps1');
  });
});

describe('autopilotScriptsAreStale (B46-1)', () => {
  it('returns true when Register-All-Tasks.ps1 is on the mismatch list (root)', () => {
    expect(autopilotScriptsAreStale(['Register-All-Tasks.ps1'])).toBe(true);
  });

  it('returns true when Run-AutopilotScheduled.ps1 is on the mismatch list (root)', () => {
    expect(autopilotScriptsAreStale(['Run-AutopilotScheduled.ps1'])).toBe(true);
  });

  it('returns true when both are on the mismatch list', () => {
    expect(autopilotScriptsAreStale(['Register-All-Tasks.ps1', 'Run-AutopilotScheduled.ps1'])).toBe(true);
  });

  it('returns true when path uses Windows backslash separator (subdir, hypothetical)', () => {
    expect(autopilotScriptsAreStale(['scripts\\Register-All-Tasks.ps1'])).toBe(true);
  });

  it('returns true when path uses POSIX forward-slash separator (Get-ChildItem on a UNC mount)', () => {
    expect(autopilotScriptsAreStale(['scripts/Register-All-Tasks.ps1'])).toBe(true);
  });

  it('returns false when only non-autopilot scripts are stale', () => {
    expect(autopilotScriptsAreStale(['actions\\Empty-RecycleBins.ps1', 'Get-Forecast.ps1'])).toBe(false);
  });

  it('returns false on an empty mismatch list (steady state)', () => {
    expect(autopilotScriptsAreStale([])).toBe(false);
  });

  it('does NOT match a substring (e.g. "MyRegister-All-Tasks.ps1" is unrelated)', () => {
    expect(autopilotScriptsAreStale(['MyRegister-All-Tasks.ps1'])).toBe(false);
  });
});

describe('shouldFireElevatedAutopilotSync (B46-1)', () => {
  it('fires when upgrading, elevation needed, and an autopilot script is stale', () => {
    expect(shouldFireElevatedAutopilotSync({
      isUpgrade: true,
      bundleNeedsElevatedCopy: true,
      bundleMismatches: ['Register-All-Tasks.ps1'],
    })).toBe(true);
  });

  it('does NOT fire when not upgrading (steady-state launch, no version bump)', () => {
    expect(shouldFireElevatedAutopilotSync({
      isUpgrade: false,
      bundleNeedsElevatedCopy: true,
      bundleMismatches: ['Register-All-Tasks.ps1'],
    })).toBe(false);
  });

  it('does NOT fire when bundleNeedsElevatedCopy is false (probe says no elevation needed)', () => {
    expect(shouldFireElevatedAutopilotSync({
      isUpgrade: true,
      bundleNeedsElevatedCopy: false,
      bundleMismatches: ['Register-All-Tasks.ps1'],
    })).toBe(false);
  });

  it('does NOT fire when only non-autopilot scripts are stale (avoid spurious UAC)', () => {
    expect(shouldFireElevatedAutopilotSync({
      isUpgrade: true,
      bundleNeedsElevatedCopy: true,
      bundleMismatches: ['actions\\Empty-RecycleBins.ps1'],
    })).toBe(false);
  });

  it('does NOT fire on empty mismatch list', () => {
    expect(shouldFireElevatedAutopilotSync({
      isUpgrade: true,
      bundleNeedsElevatedCopy: true,
      bundleMismatches: [],
    })).toBe(false);
  });
});

describe('verifyAutopilotMigration size-mismatch arm (B46-1 belt-and-braces)', () => {
  // v2.4.48: build a full 11-row result so the dispatcher-content predicate
  // passes by itself; size-mismatch arm is what we're isolating here.
  const validResult = {
    results: EXPECTED_AUTOPILOT_TASK_NAMES.map(name => ({
      name,
      status: 'registered',
      command: 'powershell.exe -File "C:\\ProgramData\\PCDoctor\\Run-AutopilotScheduled.ps1" -RuleId "x"',
      output: 'SUCCESS',
    })),
  };

  it('passes when sizes match (deployed Sync did happen)', () => {
    expect(verifyAutopilotMigration(validResult, { deployedSize: 12345, bundledSize: 12345 })).toBe(true);
  });

  it('fails when sizes mismatch (deployed Register is still v2.4.45-stale)', () => {
    expect(verifyAutopilotMigration(validResult, { deployedSize: 9000, bundledSize: 12345 })).toBe(false);
  });

  it('passes when sizes are not provided (caller could not stat one of the files)', () => {
    expect(verifyAutopilotMigration(validResult, undefined)).toBe(true);
    expect(verifyAutopilotMigration(validResult, {})).toBe(true);
    expect(verifyAutopilotMigration(validResult, { deployedSize: 12345 })).toBe(true);
    expect(verifyAutopilotMigration(validResult, { bundledSize: 12345 })).toBe(true);
  });

  it('still fails when the dispatcher predicate fails, regardless of sizes', () => {
    // Full 11-row set, but every row references the legacy direct script
    // (no dispatcher). Should fail on the per-row dispatcher check.
    const noDispatcher = {
      results: EXPECTED_AUTOPILOT_TASK_NAMES.map(name => ({
        name,
        status: 'registered',
        command: 'powershell.exe -File "C:\\actions\\X.ps1"',
        output: 'SUCCESS',
      })),
    };
    expect(verifyAutopilotMigration(noDispatcher, { deployedSize: 12345, bundledSize: 12345 })).toBe(false);
  });
});

describe('main.ts migration IIFE elevates on upgrade (B48-MIG-1a)', () => {
  // The migration logic lives inside `app.whenReady().then(...)` so we can't
  // unit-test the dispatch through normal mocks without booting Electron.
  // Instead we lock in the contract by source inspection: `Register-All-Tasks.ps1`
  // MUST be invoked via `runElevatedPowerShellScript` on the upgrade branch.
  // If a future edit silently regresses to `runPowerShellScript('Register-All-Tasks.ps1', ...)`
  // on the upgrade path, this test fails. The non-elevated steady-state call
  // is allowed and is what the test asserts must continue to coexist.
  const mainSource: string = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'main.ts'),
    'utf8',
  );

  it('contains an elevated Register-All-Tasks.ps1 invocation', () => {
    // Match the call across the line break between function name and arg.
    const re = /runElevatedPowerShellScript[\s\S]{0,80}'Register-All-Tasks\.ps1'/;
    expect(re.test(mainSource), 'main.ts is missing the elevated Register-All-Tasks invocation').toBe(true);
  });

  it('still contains the non-elevated Register-All-Tasks.ps1 fallback for steady-state launches', () => {
    const re = /runPowerShellScript<RegResult>\s*\(\s*\n?\s*'Register-All-Tasks\.ps1'/;
    expect(re.test(mainSource), 'main.ts dropped the non-elevated steady-state path').toBe(true);
  });

  it('passes -ForceRecreate when isUpgrade is true', () => {
    // Direct token check — the args.push happens before the elevated call.
    expect(mainSource).toContain("args.push('-ForceRecreate')");
  });

  it('logs a warning when both bundle-sync and migration would prompt for UAC (dual-prompt path)', () => {
    // v2.4.52 (B52-MIG-1): migrated from console.warn → log.warn with the
    // [migration] prefix as part of the electron-log instrumentation pass.
    // The dual-UAC warning still fires on the same code path; only the
    // sink + tag changed.
    expect(mainSource).toContain('[migration] dual UAC required (sync already attempted)');
  });
});
