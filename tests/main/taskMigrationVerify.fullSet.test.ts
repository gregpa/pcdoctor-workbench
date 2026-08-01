// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskManifest } from '../../src/shared/taskManifest.js';

describe('manifest migration source parity', () => {
  it('keeps every manifest identity out of Register-All-Tasks.ps1 source', () => {
    const source = readFileSync(path.join(process.cwd(), 'powershell', 'Register-All-Tasks.ps1'), 'utf8');
    for (const task of taskManifest.tasks) expect(source).not.toContain(`'${task.name}'`);
  });

  it('tracks all legacy Autopilot aliases as removal entries', () => {
    const legacy = taskManifest.tasks.filter(task => task.name.startsWith('PCDoctor-Autopilot-'));
    expect(legacy).toHaveLength(12);
    expect(legacy.every(task => task.state === 'remove')).toBe(true);
  });

  it('has one register strategy per active entry and unregister for every other entry', () => {
    for (const task of taskManifest.tasks) {
      expect(task.migration.strategy).toBe(task.state === 'active' ? 'register' : 'unregister');
    }
  });
});
