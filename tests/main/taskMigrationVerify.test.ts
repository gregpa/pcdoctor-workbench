// @vitest-environment node
//
// v2.4.46 (B45-4): tests for the migration-verification predicate that
// gates `last_task_migration_version` flag writes. The predicate is
// extracted from main.ts so the migration block's self-healing
// "retry-until-verified" property is testable without dragging in
// Electron app + better-sqlite3 + IPC startup.
//
// v2.4.48 (B48-MIG-1b): full-set semantics. Pre-2.4.48 the predicate
// used `rows.some(...)` — one passing autopilot row was enough. The new
// predicate requires EVERY name in EXPECTED_AUTOPILOT_TASK_NAMES to be
// registered + dispatcher-backed. Tests below use the canonical 11-row
// set (or a subset that explicitly covers a missing/failed/no-dispatcher
// case) so the assertions match the production predicate.

import { describe, it, expect } from 'vitest';
import {
  verifyAutopilotMigration,
  EXPECTED_AUTOPILOT_TASK_NAMES,
} from '../../src/main/taskMigrationVerify.js';

const DISPATCHER_CMD =
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\ProgramData\\PCDoctor\\Run-AutopilotScheduled.ps1" -RuleId "rule" -Tier 1 -ActionScript "C:\\ProgramData\\PCDoctor\\actions\\Foo.ps1"';

/**
 * Build a result whose `results` field contains every expected autopilot
 * task name as a `registered` + dispatcher-wrapped row. Optional `extras`
 * are appended after the autopilot rows. Optional `mutator` is called per
 * row so tests can flip a single row to `failed` or strip its dispatcher.
 */
function buildFullSetResult(
  extras: Array<Record<string, unknown>> = [],
  mutator?: (row: Record<string, unknown>, idx: number) => void,
) {
  const rows = EXPECTED_AUTOPILOT_TASK_NAMES.map((name, idx) => {
    const row: Record<string, unknown> = {
      name,
      status: 'registered',
      command: DISPATCHER_CMD,
      output: 'SUCCESS',
    };
    if (mutator) mutator(row, idx);
    return row;
  });
  return { results: [...rows, ...extras] };
}

describe('verifyAutopilotMigration (B45-4 + B48-MIG-1b full-set)', () => {
  it('returns true when ALL 11 expected autopilot rows are registered with the dispatcher in `command`', () => {
    expect(verifyAutopilotMigration(buildFullSetResult())).toBe(true);
  });

  it('returns true when dispatcher reference is in `output` only (defense-in-depth fallback)', () => {
    const result = buildFullSetResult([], (row) => {
      // Strip command, leave only output with dispatcher needle.
      delete row.command;
      row.output = 'SUCCESS: Run-AutopilotScheduled.ps1 wrapped task created';
    });
    expect(verifyAutopilotMigration(result)).toBe(true);
  });

  it('returns false when one expected autopilot row references the legacy direct script (no dispatcher)', () => {
    const result = buildFullSetResult([], (row, idx) => {
      if (idx === 0) {
        row.command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\ProgramData\\PCDoctor\\actions\\Empty-RecycleBins.ps1" -JsonOutput';
        row.output = 'SUCCESS';
      }
    });
    expect(verifyAutopilotMigration(result)).toBe(false);
  });

  it('returns false when one expected autopilot row is status=failed (the v2.4.45 silent-fail mode)', () => {
    const result = buildFullSetResult([], (row, idx) => {
      if (idx === 0) {
        row.status = 'failed';
        row.output = 'ERROR: The filename or extension is too long.';
      }
    });
    expect(verifyAutopilotMigration(result)).toBe(false);
  });

  it('returns false when only non-autopilot rows are present (no expected names found)', () => {
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

  it('returns false when one expected autopilot row is status=skipped (e.g. dispatcher missing)', () => {
    const result = buildFullSetResult([], (row, idx) => {
      if (idx === 0) {
        row.status = 'skipped';
        row.output = 'Dispatcher missing: C:\\ProgramData\\PCDoctor\\Run-AutopilotScheduled.ps1';
      }
    });
    expect(verifyAutopilotMigration(result)).toBe(false);
  });
});
