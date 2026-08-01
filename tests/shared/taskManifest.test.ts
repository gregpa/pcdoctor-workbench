// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TASKS,
  DAILY_QUICK_TASK_NAME,
  getTaskById,
  taskManifest,
  validateTaskManifest,
} from '../../src/shared/taskManifest.js';

const EXPECTED_IDS = {
  active: [
    'daily-quick-report',
    'nas-size-refresh',
    'security-posture-daily',
    'security-posture-weekly',
    'smart-readonly-daily',
    'tool-updates-weekly',
    'workbench-autostart',
  ],
  deferred: [
    'defender-definitions-daily',
    'defender-quick-scan-daily',
    'maintenance-broker',
    'monthly-deep-scan',
    'retention-daily',
    'weekly-maintenance',
    'weekly-review',
  ],
  remove: [
    'forecast-without-consumer',
    'legacy-autopilot-adwcleaner',
    'legacy-autopilot-browser-cache',
    'legacy-autopilot-defender-definitions',
    'legacy-autopilot-defender-quick-scan',
    'legacy-autopilot-hosts-rewrite',
    'legacy-autopilot-hwinfo',
    'legacy-autopilot-malwarebytes',
    'legacy-autopilot-nas-size-refresh',
    'legacy-autopilot-recycle-bins',
    'legacy-autopilot-safety-scanner',
    'legacy-autopilot-smart',
    'legacy-autopilot-winsxs-resetbase',
  ],
} as const;

function mutableManifest(): any {
  return structuredClone(taskManifest);
}

function expectInvalid(edit: (manifest: any) => void, message: RegExp): void {
  const candidate = mutableManifest();
  edit(candidate);
  expect(() => validateTaskManifest(candidate)).toThrow(message);
}

describe('canonical Phase 0 task manifest', () => {
  it('contains the exact active, deferred, and removal state sets', () => {
    for (const state of ['active', 'deferred', 'remove'] as const) {
      expect(taskManifest.tasks.filter(task => task.state === state).map(task => task.id))
        .toEqual(EXPECTED_IDS[state]);
    }
  });

  it('exports the active inventory and Daily Quick identity from the manifest', () => {
    expect(ACTIVE_TASKS.map(task => task.id)).toEqual(EXPECTED_IDS.active);
    expect(DAILY_QUICK_TASK_NAME).toBe('PCDoctor-Daily-Quick');
    expect(getTaskById('daily-quick-report').name).toBe(DAILY_QUICK_TASK_NAME);
  });

  it('is recursively frozen, including schedules, arguments, and metadata', () => {
    expect(Object.isFrozen(taskManifest)).toBe(true);
    expect(Object.isFrozen(taskManifest.tasks)).toBe(true);
    for (const task of taskManifest.tasks) {
      expect(Object.isFrozen(task)).toBe(true);
      expect(Object.isFrozen(task.arguments)).toBe(true);
      expect(Object.isFrozen(task.schedule)).toBe(true);
      expect(Object.isFrozen(task.migration)).toBe(true);
      expect(Object.isFrozen(task.migration.legacy_names)).toBe(true);
      expect(Object.isFrozen(task.uninstall)).toBe(true);
    }
  });

  it('uses hidden fixed-form commands and staggered non-zero minutes for active PowerShell tasks', () => {
    const activePowerShell = taskManifest.tasks.filter(
      task => task.state === 'active' && task.executable === 'powershell.exe',
    );
    const startTimes = activePowerShell.map(task => {
      expect(task.hidden).toBe(true);
      expect(task.script).toMatch(/^C:\\ProgramData\\PCDoctor\\/);
      expect(task.context).toBe('interactive-user');
      expect(task.arguments.join(' ')).not.toMatch(/Run-AutopilotScheduled|reboot|shutdown|ResetBase/i);
      expect(task.schedule.kind).not.toBe('demand');
      const at = 'at' in task.schedule ? task.schedule.at : null;
      expect(at).toMatch(/^\d{2}:\d{2}$/);
      expect(at).not.toMatch(/:00$/);
      return at;
    });
    expect(new Set(startTimes).size).toBe(startTimes.length);
  });

  it('keeps every legacy Autopilot identity as an exact removal entry', () => {
    const legacyNames = taskManifest.tasks
      .filter(task => task.id.startsWith('legacy-autopilot-'))
      .map(task => task.name);
    expect(legacyNames).toHaveLength(12);
    expect(legacyNames.every(name => name.startsWith('PCDoctor-Autopilot-'))).toBe(true);
    expect(taskManifest.tasks.filter(task => task.state === 'active').some(
      task => task.name.startsWith('PCDoctor-Autopilot-'),
    )).toBe(false);
  });
});

describe('strict task manifest validation', () => {
  it('rejects unknown keys at every contract layer', () => {
    expectInvalid(value => { value.surprise = true; }, /unknown.*surprise/i);
    expectInvalid(value => { value.tasks[0].surprise = true; }, /unknown.*surprise/i);
    expectInvalid(value => { value.tasks[0].migration.surprise = true; }, /unknown.*surprise/i);
    expectInvalid(value => { value.tasks[0].uninstall.surprise = true; }, /unknown.*surprise/i);
    expectInvalid(value => { value.tasks[0].schedule.surprise = true; }, /unknown.*surprise/i);
  });

  it('rejects duplicate IDs and case-insensitive duplicate Windows task names', () => {
    expectInvalid(value => { value.tasks[1].id = value.tasks[0].id; }, /duplicate.*id/i);
    expectInvalid(value => {
      value.tasks[1].name = `PCDoctor-${value.tasks[0].name.slice('PCDoctor-'.length).toLowerCase()}`;
    }, /duplicate.*name/i);
    expectInvalid(value => {
      value.tasks[1].migration.legacy_names = [value.tasks[0].name];
    }, /legacy.*canonical|namespace.*collision/i);
    expectInvalid(value => {
      value.tasks[1].migration.legacy_names = ['PCDoctor-Old-Shared'];
      value.tasks[2].migration.legacy_names = ['PCDoctor-Old-Shared'];
    }, /duplicate.*legacy/i);
  });

  it('rejects arbitrary executables, paths, and argument text', () => {
    expectInvalid(value => { value.tasks[0].executable = 'cmd.exe'; }, /executable/i);
    expectInvalid(value => { value.tasks[0].script = 'C:\\Users\\attacker\\run.ps1'; }, /script/i);
    expectInvalid(value => { value.tasks[0].arguments = ['-Command', 'calc.exe']; }, /argument/i);
  });

  it('rejects active mutation, dispatcher, reboot, visible-window, and overlapping schedules', () => {
    const activeIndex = taskManifest.tasks.findIndex(task => task.id === 'daily-quick-report');
    const secondActiveIndex = taskManifest.tasks.findIndex(task => task.id === 'nas-size-refresh');
    const autostartIndex = taskManifest.tasks.findIndex(task => task.id === 'workbench-autostart');
    expectInvalid(value => {
      value.tasks[activeIndex].script = 'C:\\ProgramData\\PCDoctor\\actions\\Shrink-ComponentStore.ps1';
    }, /active.*script|mutation/i);
    expectInvalid(value => {
      value.tasks[activeIndex].script = 'C:\\ProgramData\\PCDoctor\\Run-AutopilotScheduled.ps1';
    }, /script|dispatcher/i);
    expectInvalid(value => { value.tasks[activeIndex].arguments = ['reboot']; }, /reboot/i);
    expectInvalid(value => { value.tasks[activeIndex].arguments = ['-Mode', 'Auto']; }, /active.*arguments|command.*contract/i);
    expectInvalid(value => { value.tasks[activeIndex].hidden = false; }, /hidden/i);
    expectInvalid(value => { value.tasks[activeIndex].context = 'system'; }, /SYSTEM.*ProgramData/i);
    expectInvalid(value => { value.tasks[autostartIndex].context = 'system'; }, /interactive/i);
    expectInvalid(value => {
      value.tasks[secondActiveIndex].schedule.at = value.tasks[activeIndex].schedule.at;
    }, /stagger|duplicate.*time/i);
  });
});
