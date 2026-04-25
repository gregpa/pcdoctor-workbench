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
import {
  verifyAutopilotMigration,
  shouldFireElevatedAutopilotSync,
  autopilotScriptsAreStale,
  AUTOPILOT_SCRIPT_NAMES,
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
  const validResult = {
    results: [
      {
        name: 'PCDoctor-Autopilot-EmptyRecycleBins',
        status: 'registered',
        command: 'powershell.exe -File "C:\\ProgramData\\PCDoctor\\Run-AutopilotScheduled.ps1" -RuleId "x"',
        output: 'SUCCESS',
      },
    ],
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
    const noDispatcher = {
      results: [
        { name: 'PCDoctor-Autopilot-X', status: 'registered',
          command: 'powershell.exe -File "C:\\actions\\X.ps1"', output: 'SUCCESS' },
      ],
    };
    expect(verifyAutopilotMigration(noDispatcher, { deployedSize: 12345, bundledSize: 12345 })).toBe(false);
  });
});
