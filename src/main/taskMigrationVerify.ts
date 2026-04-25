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

export interface RegisterAllTasksResultRow {
  name?: string;
  status?: string;
  command?: string;
  output?: string;
}

export interface RegisterAllTasksResult {
  results?: RegisterAllTasksResultRow[];
}

const DISPATCHER_NEEDLE = 'Run-AutopilotScheduled.ps1';

export function verifyAutopilotMigration(result: RegisterAllTasksResult | null | undefined): boolean {
  const rows = result?.results ?? [];
  return rows.some(r =>
    typeof r?.name === 'string'
    && r.name.startsWith('PCDoctor-Autopilot-')
    && r.status === 'registered'
    && (
      (typeof r.command === 'string' && r.command.includes(DISPATCHER_NEEDLE))
      || (typeof r.output === 'string' && r.output.includes(DISPATCHER_NEEDLE))
    ),
  );
}
