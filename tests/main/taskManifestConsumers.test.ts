// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIVE_TASK_NAMES, isManagedScheduledTaskName } from '../../src/main/scheduledTaskNames.js';
import { buildScheduledTaskInventory } from '../../src/main/scheduledTaskInventory.js';
import {
  TASK_MANIFEST_DEPLOYMENT_FILES,
  verifyTaskManifestMigration,
} from '../../src/main/taskMigrationVerify.js';
import { taskManifest } from '../../src/shared/taskManifest.js';

const read = (relativePath: string): string => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('manifest-backed TypeScript consumers', () => {
  it('allows only active manifest identities through renderer-controlled task operations', () => {
    const expected = taskManifest.tasks.filter(task => task.state === 'active').map(task => task.name);
    expect(ACTIVE_TASK_NAMES).toEqual(expected);
    for (const name of expected) expect(isManagedScheduledTaskName(name)).toBe(true);
    for (const task of taskManifest.tasks.filter(task => task.state !== 'active')) {
      expect(isManagedScheduledTaskName(task.name)).toBe(false);
    }
  });

  it('builds dashboard inventory from the complete manifest and surfaces legacy rows', () => {
    const inventory = buildScheduledTaskInventory([
      { name: 'PCDoctor-Daily-Quick', status: 'Ready', next_run: null, last_run: null, last_result: null },
      { name: 'PCDoctor-Autopilot-EmptyRecycleBins', status: 'Ready', next_run: null, last_run: null, last_result: null },
      { name: 'PCDoctor-Uncatalogued', status: 'Ready', next_run: null, last_run: null, last_result: null },
    ]);
    expect(inventory.find(task => task.name === 'PCDoctor-Daily-Quick')).toMatchObject({
      manifest_state: 'active', expected_present: true, status: 'Ready',
    });
    expect(inventory.find(task => task.name === 'PCDoctor-Autopilot-EmptyRecycleBins')).toMatchObject({
      manifest_state: 'remove', expected_present: false, status: 'Ready',
    });
    expect(inventory.find(task => task.name === 'PCDoctor-Uncatalogued')).toMatchObject({
      manifest_state: 'legacy', expected_present: false,
    });
  });

  it('verifies every manifest state instead of a copied Autopilot list', () => {
    const rows = taskManifest.tasks.map(task => ({
      id: task.id,
      name: task.name,
      state: task.state,
      status: task.state === 'active' ? 'registered' : 'absent',
    }));
    expect(verifyTaskManifestMigration({ success: true, source_sha256: 'a'.repeat(64), results: rows }))
      .toBe(true);
    expect(verifyTaskManifestMigration({
      success: true,
      source_sha256: 'a'.repeat(64),
      results: rows.filter(row => row.id !== 'daily-quick-report'),
    })).toBe(false);
    expect(TASK_MANIFEST_DEPLOYMENT_FILES).toEqual([
      'Register-All-Tasks.ps1',
      'Unregister-All-Tasks.ps1',
      'task-manifest.json',
    ]);
  });

  it('contains no copied task-name inventory in IPC, exporter, Dashboard, or useAction', () => {
    expect(read('src/main/ipc.ts')).not.toMatch(/const\s+MANAGED_TASKS\s*=\s*new Set\s*\(\s*\[/);
    expect(read('src/main/claudeReportExporter.ts')).not.toMatch(/const\s+MANAGED_TASKS\s*=\s*\[/);
    expect(read('src/renderer/pages/Dashboard.tsx')).not.toContain("'PCDoctor-Daily-Quick'");
    expect(read('src/renderer/hooks/useAction.ts')).not.toContain("'PCDoctor-Daily-Quick'");
  });
});

describe('manifest-backed PowerShell and installer consumers', () => {
  it('drives registration and uninstall from the generated manifest without copied task names', () => {
    const register = read('powershell/Register-All-Tasks.ps1');
    const unregister = read('powershell/Unregister-All-Tasks.ps1');
    expect(register).toContain('task-manifest.json');
    expect(unregister).toContain('task-manifest.json');
    expect(unregister).toContain('IncludeLegacy');
    expect(register).not.toMatch(/name\s*=\s*['"]PCDoctor-/i);
    expect(unregister).not.toMatch(/['"]PCDoctor-[A-Za-z0-9_-]+['"]/);
  });

  it('turns the legacy dispatcher into a durable fail-closed refusal', () => {
    const dispatcher = read('powershell/Run-AutopilotScheduled.ps1');
    expect(dispatcher).toContain('E_DIRECT_SCHEDULED_MUTATION_DISABLED');
    expect(dispatcher).toMatch(/exit\s+[1-9]/i);
    expect(dispatcher).not.toMatch(/&\s+powershell\.exe\s+@psArgs/i);
  });

  it('delegates installer registration and uninstall to the manifest scripts', () => {
    const installer = read('scripts/installer.nsh');
    expect(installer).toContain('Register-All-Tasks.ps1');
    expect(installer).toContain('Unregister-All-Tasks.ps1');
    expect(installer).toContain('-IncludeLegacy');
    expect(installer).not.toMatch(/schtasks\.exe\s+\/Delete\s+\/TN\s+"PCDoctor-/i);
    expect(installer).not.toMatch(/schtasks\.exe\s+\/Create\s+\/TN\s+"PCDoctor-/i);
  });
});
