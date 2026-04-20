// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

/**
 * v2.3.13 Tier B rollback integrity (rollbackManager.ts):
 *
 *   function encodeSnapshotName(srcPath)  -- lines 56-63
 *     -> safeBase + '-' + sha256(srcPath).slice(0,12)
 *
 *   function hashPath(p)                  -- lines 26-53
 *     -> sha256 of file content, or sha256 of (relPath\tsha256)+ for dirs
 *
 * Neither is exported so we mirror the algorithm verbatim here and test
 * its observable invariants - same pattern as rollbackManagerAllowList
 * (also a pure-algorithm mirror of the live code).
 *
 * Invariants under test:
 *   1. encodeSnapshotName is stable  (same input -> same output)
 *   2. encodeSnapshotName is collision-free for different parents sharing a basename
 *   3. encodeSnapshotName sanitizes charset to [a-zA-Z0-9._-]
 *   4. hashPath is stable for identical file content
 *   5. hashPath detects tampering (single byte flip -> different hash)
 *   6. hashPath on a directory reflects *any* file change within the tree
 *   7. hashPath returns null for non-existent paths
 */

function encodeSnapshotName(srcPath: string): string {
  const short = createHash('sha256').update(srcPath).digest('hex').slice(0, 12);
  const safeBase = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${safeBase}-${short}`;
}

function hashPath(p: string): string | null {
  try {
    const { statSync, readdirSync } = require('node:fs');
    const st = statSync(p);
    if (st.isFile()) {
      return createHash('sha256').update(readFileSync(p)).digest('hex');
    }
    if (st.isDirectory()) {
      const entries: string[] = [];
      const walk = (dir: string, rel: string) => {
        const list = readdirSync(dir, { withFileTypes: true });
        for (const e of list) {
          const full = path.join(dir, e.name);
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(full, r);
          else if (e.isFile()) {
            const h = createHash('sha256').update(readFileSync(full)).digest('hex');
            entries.push(`${r}\t${h}`);
          }
        }
      };
      walk(p, '');
      entries.sort();
      return createHash('sha256').update(entries.join('\n')).digest('hex');
    }
  } catch {}
  return null;
}

describe('encodeSnapshotName', () => {
  it('is deterministic: same input -> same output across calls', () => {
    const a = encodeSnapshotName('C:\\Users\\greg\\AppData\\Local\\foo.txt');
    const b = encodeSnapshotName('C:\\Users\\greg\\AppData\\Local\\foo.txt');
    expect(a).toBe(b);
  });

  it('produces DIFFERENT dest names for two sources that share a basename (the collision fix)', () => {
    // This is the reviewer-P1 landmine: prior basename-only code made
    // C:\A\foo.txt and C:\B\foo.txt collide in the snapshot dir.
    const a = encodeSnapshotName('C:\\A\\foo.txt');
    const b = encodeSnapshotName('C:\\B\\foo.txt');
    expect(a).not.toBe(b);
    // Both end with the base name portion though.
    expect(a.startsWith('foo.txt-')).toBe(true);
    expect(b.startsWith('foo.txt-')).toBe(true);
  });

  it('sanitizes the basename (no shell-unsafe chars land on disk)', () => {
    const bad = encodeSnapshotName('C:\\tmp\\weird name; with *bad* chars.txt');
    // The safeBase portion (before the last '-<12hex>') must be charset-safe.
    const hex = bad.split('-').pop()!;
    const base = bad.slice(0, bad.length - hex.length - 1);
    expect(/^[a-zA-Z0-9._-]+$/.test(base)).toBe(true);
    expect(hex).toMatch(/^[a-f0-9]{12}$/);
  });

  it('includes a 12-char sha256 prefix suffix for disambiguation', () => {
    const n = encodeSnapshotName('C:\\A\\file');
    const hex = n.split('-').pop()!;
    expect(hex).toMatch(/^[a-f0-9]{12}$/);
    // Matches the first 12 chars of sha256 of the full source path.
    const expected = createHash('sha256').update('C:\\A\\file').digest('hex').slice(0, 12);
    expect(hex).toBe(expected);
  });
});

describe('hashPath', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pcd-hashpath-'));
  });
  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('returns null for a non-existent path', () => {
    expect(hashPath(path.join(tempDir, 'nope'))).toBeNull();
  });

  it('produces stable hash for identical file content', () => {
    const a = path.join(tempDir, 'a.txt');
    const b = path.join(tempDir, 'b.txt');
    writeFileSync(a, 'hello world');
    writeFileSync(b, 'hello world');
    expect(hashPath(a)).toBe(hashPath(b));
  });

  it('detects a single-byte tamper on a file', () => {
    const f = path.join(tempDir, 'victim.txt');
    writeFileSync(f, 'original content');
    const before = hashPath(f);
    writeFileSync(f, 'original contenx');   // one byte flipped
    const after = hashPath(f);
    expect(after).not.toBe(before);
  });

  it('hashes a directory tree; any file change inside changes the top-level hash', () => {
    const dir = path.join(tempDir, 'tree');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'a.txt'), 'a');
    writeFileSync(path.join(dir, 'b.txt'), 'b');
    const before = hashPath(dir);
    expect(before).not.toBeNull();

    // Modify one nested file.
    writeFileSync(path.join(dir, 'b.txt'), 'B');
    const after = hashPath(dir);
    expect(after).not.toBe(before);
  });

  it('hashes a directory tree: adding a new file also changes the hash', () => {
    const dir = path.join(tempDir, 'tree2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'a.txt'), 'a');
    const before = hashPath(dir);
    writeFileSync(path.join(dir, 'c.txt'), 'c');
    const after = hashPath(dir);
    expect(after).not.toBe(before);
  });

  it('directory hash is independent of the directory name itself (content-only)', () => {
    const d1 = path.join(tempDir, 'aaa');
    const d2 = path.join(tempDir, 'bbb');
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    writeFileSync(path.join(d1, 'x.txt'), 'x');
    writeFileSync(path.join(d2, 'x.txt'), 'x');
    // Same inner tree under different parents -> same hash (hashPath
    // only hashes relpath\thash, which is identical in both).
    expect(hashPath(d1)).toBe(hashPath(d2));
  });
});
