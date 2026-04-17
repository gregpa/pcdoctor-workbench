// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('snapshot + revert cycle (manual simulation)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pcd-rollback-test-'));
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('copies a file to snapshot and restores from it', () => {
    const sourceFile = path.join(tempDir, 'hosts');
    const snapshotDir = path.join(tempDir, 'snap');
    mkdirSync(snapshotDir, { recursive: true });

    writeFileSync(sourceFile, 'original content');
    cpSync(sourceFile, path.join(snapshotDir, 'hosts'));

    // Tamper with source
    writeFileSync(sourceFile, 'TAMPERED');
    expect(readFileSync(sourceFile, 'utf8')).toBe('TAMPERED');

    // Revert by copying snapshot back
    cpSync(path.join(snapshotDir, 'hosts'), sourceFile, { force: true });
    expect(readFileSync(sourceFile, 'utf8')).toBe('original content');
  });

  it('preserves whole directory trees', () => {
    const sourceDir = path.join(tempDir, 'config');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, 'a.txt'), 'a');
    writeFileSync(path.join(sourceDir, 'b.txt'), 'b');

    const snapshotDir = path.join(tempDir, 'snap');
    cpSync(sourceDir, snapshotDir, { recursive: true });

    // Delete original
    rmSync(sourceDir, { recursive: true, force: true });
    // Restore
    cpSync(snapshotDir, sourceDir, { recursive: true });

    expect(readFileSync(path.join(sourceDir, 'a.txt'), 'utf8')).toBe('a');
    expect(readFileSync(path.join(sourceDir, 'b.txt'), 'utf8')).toBe('b');
  });
});
