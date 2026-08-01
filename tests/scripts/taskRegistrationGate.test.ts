import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('manifest task-registration gate', () => {
  it('runs a source-only static leg without touching Task Scheduler', () => {
    const scriptPath = path.join(process.cwd(), 'scripts', 'test-task-registration.ps1');
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-StaticOnly',
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim();

    expect(JSON.parse(output)).toEqual({
      mode: 'static',
      success: true,
      source_sha256_valid: true,
      total: 27,
      active: 7,
      deferred: 7,
      remove: 13,
      live_task_scheduler_calls: 0,
    });
  });
});
