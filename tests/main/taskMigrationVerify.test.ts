// @vitest-environment node
//
// v2.4.46 (B45-4): tests for the migration-verification predicate that
// gates `last_task_migration_version` flag writes. The predicate is
// extracted from main.ts so the migration block's self-healing
// "retry-until-verified" property is testable without dragging in
// Electron app + better-sqlite3 + IPC startup. Three scenarios mirror
// the migration IIFE's branches:
//
//   (a) script returns dispatcher-wrapped result -> verified -> flag
//       SHOULD be written by the caller.
//   (b) script returns only legacy / non-wrapped results -> NOT verified
//       -> flag SHOULD stay unwritten so next launch retries.
//   (c) script throws or returns null/undefined -> NOT verified.

import { describe, it, expect } from 'vitest';
import { verifyAutopilotMigration } from '../../src/main/taskMigrationVerify.js';

describe('verifyAutopilotMigration (B45-4)', () => {
  it('returns true when at least one autopilot row is registered with the dispatcher in `command`', () => {
    const result = {
      results: [
        { name: 'PCDoctor-Weekly-Review', status: 'registered', output: 'SUCCESS', command: 'powershell.exe -File Invoke-WeeklyReview.ps1' },
        { name: 'PCDoctor-Autopilot-EmptyRecycleBins', status: 'registered',
          command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\ProgramData\\PCDoctor\\Run-AutopilotScheduled.ps1" -RuleId "empty_recycle_bins_weekly" -Tier 1 -ActionScript "C:\\ProgramData\\PCDoctor\\actions\\Empty-RecycleBins.ps1"',
          output: 'SUCCESS' },
      ],
    };
    expect(verifyAutopilotMigration(result)).toBe(true);
  });

  it('returns true when dispatcher reference is in `output` (defense-in-depth fallback)', () => {
    const result = {
      results: [
        { name: 'PCDoctor-Autopilot-SmartCheck', status: 'registered',
          output: 'SUCCESS: Run-AutopilotScheduled.ps1 wrapped task created' },
      ],
    };
    expect(verifyAutopilotMigration(result)).toBe(true);
  });

  it('returns false when all autopilot rows reference the legacy direct script (no dispatcher)', () => {
    const result = {
      results: [
        { name: 'PCDoctor-Autopilot-EmptyRecycleBins', status: 'registered',
          command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\ProgramData\\PCDoctor\\actions\\Empty-RecycleBins.ps1" -JsonOutput',
          output: 'SUCCESS' },
        { name: 'PCDoctor-Autopilot-SmartCheck', status: 'registered',
          command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\ProgramData\\PCDoctor\\actions\\Run-SmartCheck.ps1" -JsonOutput',
          output: 'SUCCESS' },
      ],
    };
    expect(verifyAutopilotMigration(result)).toBe(false);
  });

  it('returns false when all autopilot rows are status=failed (the v2.4.45 silent-fail mode)', () => {
    const result = {
      results: [
        { name: 'PCDoctor-Autopilot-EmptyRecycleBins', status: 'failed',
          command: 'powershell.exe ... Run-AutopilotScheduled.ps1 ...',
          output: 'ERROR: The filename or extension is too long.' },
      ],
    };
    expect(verifyAutopilotMigration(result)).toBe(false);
  });

  it('returns false when only non-autopilot rows are present', () => {
    const result = {
      results: [
        { name: 'PCDoctor-Weekly-Review', status: 'registered', command: '...Run-AutopilotScheduled.ps1...' },
        { name: 'PCDoctor-Workbench-Autostart', status: 'registered', output: 'SUCCESS' },
      ],
    };
    expect(verifyAutopilotMigration(result)).toBe(false);
  });

  it('returns false for null / undefined / missing results array', () => {
    expect(verifyAutopilotMigration(null)).toBe(false);
    expect(verifyAutopilotMigration(undefined)).toBe(false);
    expect(verifyAutopilotMigration({})).toBe(false);
    expect(verifyAutopilotMigration({ results: [] })).toBe(false);
  });

  it('returns false when row name is autopilot but status is skipped (e.g. dispatcher missing)', () => {
    const result = {
      results: [
        { name: 'PCDoctor-Autopilot-EmptyRecycleBins', status: 'skipped',
          command: 'powershell.exe ... Run-AutopilotScheduled.ps1 ...',
          output: 'Dispatcher missing: C:\\ProgramData\\PCDoctor\\Run-AutopilotScheduled.ps1' },
      ],
    };
    expect(verifyAutopilotMigration(result)).toBe(false);
  });
});
