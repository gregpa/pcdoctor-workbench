// @vitest-environment node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, 'src', 'shared', 'task-manifest.json');
const generatedPath = path.join(repoRoot, 'powershell', 'task-manifest.json');
const generatorPath = path.join(repoRoot, 'scripts', 'generate-task-manifest.mjs');

function expectCopiedGeneratorToReject(edit: (manifest: any) => void, message: RegExp): void {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pcdoctor-task-generator-invalid-'));
  const tempScripts = path.join(tempRoot, 'scripts');
  const tempShared = path.join(tempRoot, 'src', 'shared');
  const tempGenerator = path.join(tempScripts, 'generate-task-manifest.mjs');
  const tempSource = path.join(tempShared, 'task-manifest.json');
  const tempOutput = path.join(tempRoot, 'output', 'task-manifest.json');
  mkdirSync(tempScripts, { recursive: true });
  mkdirSync(tempShared, { recursive: true });
  mkdirSync(path.dirname(tempOutput), { recursive: true });
  copyFileSync(generatorPath, tempGenerator);
  const manifest = JSON.parse(readFileSync(sourcePath, 'utf8')) as any;
  edit(manifest);
  writeFileSync(tempSource, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  try {
    expect(() => execFileSync(process.execPath, [tempGenerator, '--output', tempOutput], {
      cwd: tempRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    })).toThrow(message);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe('deterministic generated PowerShell task manifest', () => {
  it('is current according to the generator check mode', () => {
    expect(() => execFileSync(process.execPath, [generatorPath, '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    })).not.toThrow();
  });

  it('records the exact canonical source SHA-256 and sorts tasks by stable ID', () => {
    const sourceBytes = readFileSync(sourcePath);
    const expectedHash = createHash('sha256').update(sourceBytes).digest('hex');
    const generated = JSON.parse(readFileSync(generatedPath, 'utf8')) as {
      source_sha256: string;
      tasks: Array<{ id: string }>;
    };
    expect(generated.source_sha256).toBe(expectedHash);
    expect(generated.tasks.map(task => task.id)).toEqual(
      [...generated.tasks.map(task => task.id)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('atomically emits byte-identical output on repeated generation', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'pcdoctor-task-manifest-'));
    const outputPath = path.join(tempDir, 'task-manifest.json');
    try {
      execFileSync(process.execPath, [generatorPath, '--output', outputPath], { cwd: repoRoot });
      const first = readFileSync(outputPath);
      const preservedTime = new Date('2001-02-03T04:05:06.000Z');
      utimesSync(outputPath, preservedTime, preservedTime);
      execFileSync(process.execPath, [generatorPath, '--output', outputPath], { cwd: repoRoot });
      const second = readFileSync(outputPath);
      expect(second).toEqual(first);
      expect(second).toEqual(readFileSync(generatedPath));
      expect(statSync(outputPath).mtimeMs).toBe(preservedTime.getTime());
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown and missing task contract keys before emitting output', () => {
    expectCopiedGeneratorToReject(manifest => {
      manifest.tasks[0].surprise = true;
    }, /unknown.*surprise/i);
    expectCopiedGeneratorToReject(manifest => {
      delete manifest.tasks[0].context;
    }, /context|required/i);
  });

  it('rejects unsafe command values before emitting output', () => {
    expectCopiedGeneratorToReject(manifest => {
      manifest.tasks[0].executable = 'cmd.exe';
    }, /executable/i);
    expectCopiedGeneratorToReject(manifest => {
      const active = manifest.tasks.find((task: any) => task.state === 'active');
      active.script = 'C:\\ProgramData\\PCDoctor\\actions\\Shrink-ComponentStore.ps1';
    }, /active.*script|mutation/i);
    expectCopiedGeneratorToReject(manifest => {
      const autostart = manifest.tasks.find((task: any) => task.id === 'workbench-autostart');
      autostart.context = 'system';
    }, /interactive/i);
    expectCopiedGeneratorToReject(manifest => {
      const dailyQuick = manifest.tasks.find((task: any) => task.id === 'daily-quick-report');
      dailyQuick.arguments = ['-Mode', 'Auto'];
    }, /active.*arguments|command.*contract/i);
    expectCopiedGeneratorToReject(manifest => {
      manifest.tasks[1].migration.legacy_names = [manifest.tasks[0].name];
    }, /legacy.*canonical|namespace.*collision/i);
    expectCopiedGeneratorToReject(manifest => {
      manifest.tasks[1].migration.legacy_names = ['PCDoctor-Old-Shared'];
      manifest.tasks[2].migration.legacy_names = ['PCDoctor-Old-Shared'];
    }, /duplicate.*legacy/i);
  });
});
