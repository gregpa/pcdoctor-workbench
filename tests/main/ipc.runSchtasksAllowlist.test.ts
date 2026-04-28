// @vitest-environment node
//
// v2.4.48 (B48-SEC-1): tests for the renderer-controlled scheduled-task
// name allowlist. The pre-2.4.48 helper concatenated arg strings into a
// powershell.exe -Command line; a name with shell metacharacters would
// have been parsed by PowerShell. The new defence is two-layer:
//   1. Regex allowlist at the IPC entrypoint (this test exercises the
//      regex constant directly).
//   2. Direct execFile('schtasks.exe', args) helper -- no shell parser
//      can reach an arg even if the regex regresses.
//
// Importing the regex from scheduledTaskNames.ts (a leaf module) keeps
// this test pure: no Electron app, no IPC mocks, no PS spawn.

import { describe, it, expect } from 'vitest';
import { SCHEDULED_TASK_NAME_RE } from '../../src/main/scheduledTaskNames.js';

describe('SCHEDULED_TASK_NAME_RE allowlist (B48-SEC-1)', () => {
  it('accepts a canonical autopilot task name', () => {
    expect(SCHEDULED_TASK_NAME_RE.test('PCDoctor-Autopilot-DefenderQuickScan')).toBe(true);
  });

  it('accepts the workbench-autostart task name', () => {
    expect(SCHEDULED_TASK_NAME_RE.test('PCDoctor-Workbench-Autostart')).toBe(true);
  });

  it('rejects a wrong-prefix name', () => {
    expect(SCHEDULED_TASK_NAME_RE.test('NotPCDoctor-Foo')).toBe(false);
  });

  it('rejects a name containing shell metacharacters (semicolon + space + slash)', () => {
    expect(SCHEDULED_TASK_NAME_RE.test('PCDoctor-Foo; rm -rf /')).toBe(false);
  });

  it('rejects a name containing PowerShell sub-expression syntax', () => {
    expect(SCHEDULED_TASK_NAME_RE.test('PCDoctor-Foo$(whoami)')).toBe(false);
  });

  it('rejects a name longer than the 64-char cap', () => {
    expect(SCHEDULED_TASK_NAME_RE.test('PCDoctor-' + 'a'.repeat(65))).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(SCHEDULED_TASK_NAME_RE.test('')).toBe(false);
  });

  it('rejects "PCDoctor-" alone (must have at least one char after the prefix)', () => {
    expect(SCHEDULED_TASK_NAME_RE.test('PCDoctor-')).toBe(false);
  });

  it('rejects names with backticks or pipes (PS expansion)', () => {
    expect(SCHEDULED_TASK_NAME_RE.test('PCDoctor-Foo`whoami`')).toBe(false);
    expect(SCHEDULED_TASK_NAME_RE.test('PCDoctor-Foo|calc')).toBe(false);
  });

  it('accepts a name at exactly the 64-char limit', () => {
    expect(SCHEDULED_TASK_NAME_RE.test('PCDoctor-' + 'a'.repeat(64))).toBe(true);
  });
});
