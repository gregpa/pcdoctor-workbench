// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TASK_MANIFEST_DEPLOYMENT_FILES,
  shouldFireElevatedTaskManifestSync,
  taskManifestFilesAreStale,
} from '../../src/main/taskMigrationVerify.js';

describe('manifest deployment mismatch gate', () => {
  it('tracks the registrar, unregistrar, and generated manifest', () => {
    expect(TASK_MANIFEST_DEPLOYMENT_FILES).toEqual([
      'Register-All-Tasks.ps1',
      'Unregister-All-Tasks.ps1',
      'task-manifest.json',
    ]);
  });

  it.each([
    ['Register-All-Tasks.ps1'],
    ['nested\\Unregister-All-Tasks.ps1'],
    ['nested/task-manifest.json'],
  ])('detects stale deployment file %s', relativePath => {
    expect(taskManifestFilesAreStale([relativePath])).toBe(true);
  });

  it('does not substring-match unrelated files', () => {
    expect(taskManifestFilesAreStale(['MyRegister-All-Tasks.ps1', 'event-allowlist.json'])).toBe(false);
  });

  it('requires upgrade, elevation need, and a tracked mismatch', () => {
    expect(shouldFireElevatedTaskManifestSync({
      isUpgrade: true,
      bundleNeedsElevatedCopy: true,
      bundleMismatches: ['task-manifest.json'],
    })).toBe(true);
    expect(shouldFireElevatedTaskManifestSync({
      isUpgrade: false,
      bundleNeedsElevatedCopy: true,
      bundleMismatches: ['task-manifest.json'],
    })).toBe(false);
    expect(shouldFireElevatedTaskManifestSync({
      isUpgrade: true,
      bundleNeedsElevatedCopy: false,
      bundleMismatches: ['task-manifest.json'],
    })).toBe(false);
    expect(shouldFireElevatedTaskManifestSync({
      isUpgrade: true,
      bundleNeedsElevatedCopy: true,
      bundleMismatches: ['event-allowlist.json'],
    })).toBe(false);
  });
});

describe('main migration integration', () => {
  const source = readFileSync(path.join(process.cwd(), 'src', 'main', 'main.ts'), 'utf8');

  it('uses the manifest migration version and verifier', () => {
    expect(source).toContain("TASK_MIGRATION_SCHEMA = 'phase0-task-manifest-v1'");
    expect(source).toMatch(/TASK_MIGRATION_VERSION\s*=\s*`\$\{TASK_MIGRATION_SCHEMA\}:\$\{expectedSourceSha256\}`/);
    expect(source).toContain('verifyTaskManifestMigration(result, expectedSourceSha256)');
  });

  it('runs manifest registration elevated on upgrade and keeps steady-state fallback', () => {
    expect(source).toMatch(/runElevatedPowerShellScript[\s\S]{0,100}'Register-All-Tasks\.ps1'/);
    expect(source).toMatch(/runPowerShellScript<RegResult>[\s\S]{0,100}'Register-All-Tasks\.ps1'/);
    expect(source).toContain("args.push('-ForceRecreate')");
  });

  it('pins the packaged task executable to the current Program Files installation', () => {
    expect(source).toMatch(
      /if \(app\.isPackaged\) \{\s*args\.push\('-InstallDir', 'C:\\\\Program Files\\\\PCDoctor Workbench'\);\s*\}/,
    );
    expect(source).not.toMatch(/args\.push\('-InstallDir',[^\r\n]*(?:process\.argv|process\.env|process\.execPath)/);
  });

  it('cannot advance the migration marker without a valid bundled manifest hash', () => {
    expect(source).toMatch(
      /const verified = expectedSourceSha256 !== undefined\s*&& verifyTaskManifestMigration\(result, expectedSourceSha256\)/,
    );
    const verifierGuard = source.indexOf('const verified = expectedSourceSha256 !== undefined');
    const markerWrite = source.indexOf("setSetting('last_task_migration_version'", verifierGuard);
    expect(verifierGuard).toBeGreaterThan(-1);
    expect(markerWrite).toBeGreaterThan(verifierGuard);
    expect(source.slice(verifierGuard, markerWrite)).toContain('if (verified)');
  });
});
