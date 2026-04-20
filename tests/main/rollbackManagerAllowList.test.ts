// @vitest-environment node
import { describe, it, expect } from 'vitest';
import path from 'node:path';

/**
 * Unit tests for the manifest-validation logic in revertRollback. The real
 * function mixes fs + db work that's hard to set up in a unit test, so we
 * pull the allow-list decision into a pure helper and exercise it here.
 * This mirrors the exact algorithm at rollbackManager.ts:211-234 (v2.3.13).
 *
 * Reviewer P2: these rules are load-bearing for the rollback security model
 * (a tampered manifest.json can't steer cpSync to overwrite arbitrary
 * files). Any refactor of revertRollback should keep these invariants.
 */

function isSourceAllowed(source: string, allowedSources: string[]): { allowed: boolean; isSystemPath: boolean } {
  const normalized = path.normalize(source).toLowerCase();
  const normalizedAllowed = allowedSources.map(p => path.normalize(p).toLowerCase());
  const allowed = normalizedAllowed.some(a => normalized === a || normalized.startsWith(a + path.sep));
  const forbidden = ['c:\\windows\\system32\\drivers\\etc\\hosts', 'c:\\windows', 'c:\\program files'];
  const isSystemPath = forbidden.some(f => normalized === f || normalized.startsWith(f + path.sep));
  const isExplicitlyAllowed = normalizedAllowed.includes(normalized);
  const finalAllowed = allowed && (!isSystemPath || isExplicitlyAllowed);
  return { allowed: finalAllowed, isSystemPath };
}

describe('rollbackManager manifest allow-list', () => {
  it('allows a source that exactly matches a declared snapshot_path', () => {
    const r = isSourceAllowed('C:\\Users\\greg\\AppData\\Local\\foo', ['C:\\Users\\greg\\AppData\\Local\\foo']);
    expect(r.allowed).toBe(true);
  });

  it('allows a source under a declared snapshot_path directory', () => {
    const r = isSourceAllowed('C:\\Users\\greg\\AppData\\Local\\foo\\bar.txt', ['C:\\Users\\greg\\AppData\\Local\\foo']);
    expect(r.allowed).toBe(true);
  });

  it('rejects a source unrelated to any declared snapshot_path', () => {
    const r = isSourceAllowed('C:\\Users\\attacker\\payload.dll', ['C:\\Users\\greg\\AppData\\Local\\foo']);
    expect(r.allowed).toBe(false);
  });

  it('rejects a write to C:\\Windows\\System32 even if the snapshot_path appears to match', () => {
    const r = isSourceAllowed('C:\\Windows\\System32\\drivers\\malicious.sys', ['C:\\Windows']);
    expect(r.allowed).toBe(false);
    expect(r.isSystemPath).toBe(true);
  });

  it('allows the hosts file iff it is explicitly listed (not just "under C:\\Windows")', () => {
    const viaExplicit = isSourceAllowed(
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      ['C:\\Windows\\System32\\drivers\\etc\\hosts'],
    );
    expect(viaExplicit.allowed).toBe(true);

    const viaUmbrella = isSourceAllowed(
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      ['C:\\Windows'],
    );
    expect(viaUmbrella.allowed).toBe(false);
  });

  it('normalizes case differences (Windows is case-insensitive)', () => {
    const r = isSourceAllowed('c:\\USERS\\greg\\appdata\\local\\FOO', ['C:\\Users\\greg\\AppData\\Local\\foo']);
    expect(r.allowed).toBe(true);
  });

  it('normalizes .. traversal before comparison', () => {
    const r = isSourceAllowed(
      'C:\\Users\\greg\\AppData\\..\\..\\..\\Windows\\explorer.exe',
      ['C:\\Users\\greg\\AppData'],
    );
    // Normalizes to C:\Windows\explorer.exe -> not under allowed source
    expect(r.allowed).toBe(false);
  });

  it('rejects empty allow list wholesale', () => {
    const r = isSourceAllowed('C:\\Users\\greg\\foo', []);
    expect(r.allowed).toBe(false);
  });
});

describe('channel id validation (ptyBridge + claudeBridgeWatcher)', () => {
  const CHANNEL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

  it('accepts safe ids', () => {
    expect(CHANNEL_ID_RE.test('abc123')).toBe(true);
    expect(CHANNEL_ID_RE.test('pty_session-1')).toBe(true);
    expect(CHANNEL_ID_RE.test('a'.repeat(64))).toBe(true);
  });

  it('rejects overly long ids', () => {
    expect(CHANNEL_ID_RE.test('a'.repeat(65))).toBe(false);
  });

  it('rejects ids with IPC-name metacharacters', () => {
    expect(CHANNEL_ID_RE.test('claude-approval-response-evil')).toBe(true); // hyphens + alnum OK
    expect(CHANNEL_ID_RE.test('evil"injection')).toBe(false);
    expect(CHANNEL_ID_RE.test('a.b')).toBe(false);
    expect(CHANNEL_ID_RE.test('a/b')).toBe(false);
    expect(CHANNEL_ID_RE.test('a b')).toBe(false);
    expect(CHANNEL_ID_RE.test('')).toBe(false);
  });
});

describe('param name validation (actionRunner)', () => {
  const PARAM_NAME_RE = /^[a-z_][a-z0-9_]*$/i;

  it('accepts ordinary param names', () => {
    expect(PARAM_NAME_RE.test('ip')).toBe(true);
    expect(PARAM_NAME_RE.test('items_json')).toBe(true);
    expect(PARAM_NAME_RE.test('Reason')).toBe(true);
  });

  it('rejects names starting with a digit', () => {
    expect(PARAM_NAME_RE.test('1stparam')).toBe(false);
  });

  it('rejects shell / PS metacharacters', () => {
    expect(PARAM_NAME_RE.test('foo;rm')).toBe(false);
    expect(PARAM_NAME_RE.test('foo bar')).toBe(false);
    expect(PARAM_NAME_RE.test('foo.bar')).toBe(false);
    expect(PARAM_NAME_RE.test('foo-bar')).toBe(false);  // hyphens intentionally rejected
    expect(PARAM_NAME_RE.test('foo"quoted')).toBe(false);
  });
});
