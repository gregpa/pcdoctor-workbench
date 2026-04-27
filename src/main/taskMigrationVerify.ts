// v2.4.46: pure-predicate extracted from main.ts so the migration
// verification logic is unit-testable without dragging in Electron app
// side effects. Used by the task-migration IIFE in main.ts to decide
// whether to persist `last_task_migration_version`.
//
// Returns true if the parsed Register-All-Tasks.ps1 result contains at
// least one row that:
//   - has `name` starting with "PCDoctor-Autopilot-"
//   - has `status === 'registered'`
//   - has either `command` or `output` referencing the dispatcher script
//     `Run-AutopilotScheduled.ps1`.
//
// If false, the migration block deliberately leaves the version flag
// unwritten so the next launch retries with -ForceRecreate.
//
// v2.4.47 (B46-1 belt-and-braces): add an optional `sizes` argument.
// When both `deployedSize` and `bundledSize` are provided and they
// differ, verification fails regardless of dispatcher-string content.
// This catches the exact B46-1 failure mode where the schtasks call
// "succeeded" against a STALE deployed copy of Register-All-Tasks.ps1
// (the bundle-sync hadn't actually run elevated, so the v2.4.46 install
// kept the v2.4.45 dispatcher-less script and emitted a JSON shape that
// happened to satisfy the dispatcher-string predicate by accident).

export interface RegisterAllTasksResultRow {
  name?: string;
  status?: string;
  command?: string;
  output?: string;
}

export interface RegisterAllTasksResult {
  results?: RegisterAllTasksResultRow[];
}

export interface MigrationVerifySizes {
  /** Byte length of the deployed C:\ProgramData\PCDoctor\Register-All-Tasks.ps1 */
  deployedSize?: number;
  /** Byte length of the bundled resources/powershell/Register-All-Tasks.ps1 */
  bundledSize?: number;
}

const DISPATCHER_NEEDLE = 'Run-AutopilotScheduled.ps1';

/**
 * v2.4.47 (B46-1): the autopilot scripts whose stale-on-disk state is the
 * root cause we are guarding against. Kept as `as const` so the array can be
 * shared with main.ts via re-export and the test suite without drift.
 */
export const AUTOPILOT_SCRIPT_NAMES = [
  'Register-All-Tasks.ps1',
  'Run-AutopilotScheduled.ps1',
] as const;

/**
 * v2.4.48 (B48-MIG-1b): canonical 11-row set of autopilot scheduled-task
 * names sourced verbatim from `Register-All-Tasks.ps1` (lines 59-66, 75,
 * 77, 80). Drives the full-set verification predicate in
 * `verifyAutopilotMigration`: the migration flag is only flipped when EVERY
 * one of these 11 tasks comes back `registered` AND dispatcher-backed.
 *
 * Pre-2.4.48 the verifier used `rows.some(...)` — i.e. ONE registered +
 * dispatcher-wrapped autopilot row was enough to declare success. That is
 * the v2.4.45 silent-failure mode: schtasks happens to register the first
 * task on the list, the next 10 fail with /TR overflow, the verifier sees
 * one passing row, flips the flag, and the install never retries.
 *
 * Drift guard: if Register-All-Tasks.ps1 grows or shrinks an autopilot row,
 * `tests/main/taskMigrationVerify.fullSet.test.ts` regex-extracts the live
 * list and asserts setEqual against this constant. Update both in lockstep.
 */
export const EXPECTED_AUTOPILOT_TASK_NAMES = [
  'PCDoctor-Autopilot-EmptyRecycleBins',
  'PCDoctor-Autopilot-ClearBrowserCaches',
  'PCDoctor-Autopilot-DefenderQuickScan',
  'PCDoctor-Autopilot-UpdateDefenderDefs',
  'PCDoctor-Autopilot-MalwarebytesCli',
  'PCDoctor-Autopilot-AdwCleanerScan',
  'PCDoctor-Autopilot-HwinfoLog',
  'PCDoctor-Autopilot-SafetyScanner',
  'PCDoctor-Autopilot-ShrinkComponentStore',
  'PCDoctor-Autopilot-SmartCheck',
  'PCDoctor-Autopilot-UpdateHostsStevenBlack',
] as const;

/**
 * v2.4.47 (B46-1): given the parsed Sync-ScriptsFromBundle.ps1 mismatch
 * list (each entry is a relative path string like 'Register-All-Tasks.ps1'
 * or 'actions\\Foo.ps1'), return true if any entry references one of the
 * autopilot dispatcher scripts.
 *
 * Used by the migration IIFE in main.ts to decide whether to fire its own
 * elevated Sync-ScriptsFromBundle.ps1 BEFORE Register-All-Tasks. Independent
 * of the ACL self-healer's `last_acl_repair_version` short-circuit.
 *
 * Matches both Windows (`\`) and POSIX (`/`) separators because the relative
 * paths returned by Get-ChildItem on the bundle directory carry the source
 * separator unchanged.
 */
export function autopilotScriptsAreStale(mismatches: readonly string[]): boolean {
  return mismatches.some(rel =>
    AUTOPILOT_SCRIPT_NAMES.some(name =>
      rel === name
      || rel.endsWith(`\\${name}`)
      || rel.endsWith(`/${name}`),
    ),
  );
}

/**
 * v2.4.47 (B46-1): combined predicate the migration IIFE evaluates BEFORE
 * spawning its elevated Sync-ScriptsFromBundle.ps1 call. Returns true if
 * (a) we are mid-upgrade, (b) the bundle-sync probe reported needs_elevation,
 * AND (c) at least one autopilot dispatcher script is on the mismatch list.
 * All three must hold to avoid spurious UAC prompts on steady-state launches
 * or when the only stale scripts are non-autopilot helpers.
 */
export function shouldFireElevatedAutopilotSync(opts: {
  isUpgrade: boolean;
  bundleNeedsElevatedCopy: boolean;
  bundleMismatches: readonly string[];
}): boolean {
  if (!opts.isUpgrade) return false;
  if (!opts.bundleNeedsElevatedCopy) return false;
  return autopilotScriptsAreStale(opts.bundleMismatches);
}

/**
 * v2.4.48 (B48-MIG-1b): full-set verification.
 *
 * Returns true ONLY when EVERY name in `EXPECTED_AUTOPILOT_TASK_NAMES`
 * appears in `result.results` with `status === 'registered'` AND a
 * `command` or `output` field that references the dispatcher. Pre-2.4.48
 * the predicate used `rows.some(...)` — one registered + dispatcher-wrapped
 * autopilot row was enough to flip the migration flag. That is the
 * v2.4.45 silent-failure mode root cause: 1 of 11 rows registers, the
 * other 10 fail (e.g. /TR overflow), `some()` reports success, flag is
 * persisted, install never retries.
 *
 * The size-mismatch belt-and-braces (B46-1) is preserved at the top: if
 * the caller provided both `deployedSize` and `bundledSize` and they
 * differ, we fail regardless of dispatcher content (catches the
 * stale-deployed-script-but-happens-to-emit-dispatcher-needle case).
 */
export function verifyAutopilotMigration(
  result: RegisterAllTasksResult | null | undefined,
  sizes?: MigrationVerifySizes,
): boolean {
  // v2.4.47: if both sizes were captured by the caller, demand they match.
  // Skip the check when either is missing (caller couldn't stat one of the
  // files; we don't want to falsely fail healthy migrations on a transient
  // fs.statSync error).
  if (
    sizes
    && typeof sizes.deployedSize === 'number'
    && typeof sizes.bundledSize === 'number'
    && sizes.deployedSize !== sizes.bundledSize
  ) {
    return false;
  }

  const rows = result?.results ?? [];

  // v2.4.48: Walk EXPECTED_AUTOPILOT_TASK_NAMES, demand each one is present
  // and dispatcher-backed. Extra rows (Workbench-Autostart, weekly review,
  // forecast, etc.) are ignored — they're not autopilot rows.
  for (const expectedName of EXPECTED_AUTOPILOT_TASK_NAMES) {
    const row = rows.find(r => r?.name === expectedName);
    if (!row) return false;
    if (row.status !== 'registered') return false;
    const cmdHasNeedle = typeof row.command === 'string' && row.command.includes(DISPATCHER_NEEDLE);
    const outHasNeedle = typeof row.output === 'string' && row.output.includes(DISPATCHER_NEEDLE);
    if (!cmdHasNeedle && !outHasNeedle) return false;
  }
  return true;
}
