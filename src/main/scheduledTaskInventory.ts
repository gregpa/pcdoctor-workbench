import { taskManifest, type TaskState } from '../shared/taskManifest.js';
import type { ScheduledTaskInfo } from '../shared/types.js';

export type ManifestTaskState = TaskState | 'legacy';
export type ScheduledTaskInventoryRow = ScheduledTaskInfo & Readonly<{
  manifest_state: ManifestTaskState;
  expected_present: boolean;
}>;

/** Merge observed Task Scheduler rows with the canonical expected inventory. */
export function buildScheduledTaskInventory(
  observed: readonly ScheduledTaskInfo[],
): ScheduledTaskInventoryRow[] {
  const observedByName = new Map(observed.map(task => [task.name.toLowerCase(), task]));
  const knownNames = new Set(taskManifest.tasks.map(task => task.name.toLowerCase()));
  const rows: ScheduledTaskInventoryRow[] = taskManifest.tasks.map(task => {
    const actual = observedByName.get(task.name.toLowerCase());
    return {
      name: task.name,
      status: actual?.status ?? (task.state === 'active' ? 'Missing' : 'Not registered'),
      next_run: actual?.next_run ?? null,
      last_run: actual?.last_run ?? null,
      last_result: actual?.last_result ?? null,
      manifest_state: task.state,
      expected_present: task.state === 'active',
    };
  });
  const legacyRows = observed
    .filter(task => !knownNames.has(task.name.toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(task => ({ ...task, manifest_state: 'legacy' as const, expected_present: false }));
  return [...rows, ...legacyRows];
}
