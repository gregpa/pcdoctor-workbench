/** Pure verification for manifest-driven Scheduled Task migration. */

import { taskManifest, type TaskState } from '../shared/taskManifest.js';

export interface RegisterAllTasksResultRow {
  id?: string;
  name?: string;
  state?: TaskState;
  status?: string;
  command?: string;
  output?: string;
}

export interface RegisterAllTasksResult {
  success?: boolean;
  source_sha256?: string;
  results?: RegisterAllTasksResultRow[];
}

export const TASK_MANIFEST_DEPLOYMENT_FILES = Object.freeze([
  'Register-All-Tasks.ps1',
  'Unregister-All-Tasks.ps1',
  'task-manifest.json',
] as const);

function basename(relativePath: string): string {
  const parts = relativePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

export function taskManifestFilesAreStale(mismatches: readonly string[]): boolean {
  return mismatches.some(relativePath => (
    TASK_MANIFEST_DEPLOYMENT_FILES.includes(
      basename(relativePath) as (typeof TASK_MANIFEST_DEPLOYMENT_FILES)[number],
    )
  ));
}

export function shouldFireElevatedTaskManifestSync(opts: {
  isUpgrade: boolean;
  bundleNeedsElevatedCopy: boolean;
  bundleMismatches: readonly string[];
}): boolean {
  return opts.isUpgrade
    && opts.bundleNeedsElevatedCopy
    && taskManifestFilesAreStale(opts.bundleMismatches);
}

export function verifyTaskManifestMigration(
  result: RegisterAllTasksResult | null | undefined,
  expectedSourceSha256?: string,
): boolean {
  if (result?.success !== true || !Array.isArray(result.results)) return false;
  if (typeof result.source_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(result.source_sha256)) {
    return false;
  }
  if (expectedSourceSha256 !== undefined && result.source_sha256 !== expectedSourceSha256) {
    return false;
  }
  for (const expected of taskManifest.tasks) {
    const row = result.results.find(candidate => candidate.id === expected.id);
    if (!row || row.name !== expected.name || row.state !== expected.state) return false;
    if (expected.state === 'active') {
      if (row.status !== 'registered' && row.status !== 'already_registered') return false;
    } else if (row.status !== 'removed' && row.status !== 'absent') {
      return false;
    }
  }
  return result.results.length === taskManifest.tasks.length;
}
