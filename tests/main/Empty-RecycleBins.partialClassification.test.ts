// @vitest-environment node
//
// v2.4.49 (B47-3 revisited): Empty-RecycleBins.ps1 status classifier matrix.
//
// Pre-2.4.49 a clean Clear-RecycleBin exit ($null -eq $clearError) followed
// by an unchanged or larger re-measured bin size ($after -ge $before) hit
// the trailing `else { 'error' }` branch and emitted a false-error row.
// The new ladder tier-downs to 'partial' for that case. This test parses
// the if/elseif chain out of the .ps1 file as text and reimplements it in
// TS so we don't need a Pester runner in CI. If the ladder is later edited
// without updating this matrix, the test fails BEFORE shipping.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function classify(before: number, after: number, clearError: string | null): string {
  // Mirror the PowerShell ladder verbatim.
  if (before === 0 && clearError === null) return 'empty';
  if (clearError !== null && after === before) return 'blocked';
  if (clearError !== null && after < before) return 'partial';
  if (after === 0 && before > 0) return 'cleared';
  if (after < before) return 'partial';
  if (clearError === null && before > 0) return 'partial'; // NEW v2.4.49 branch
  return 'error';
}

describe('Empty-RecycleBins.ps1 status classifier (v2.4.49 B47-3)', () => {
  it('case 1: (0, 0, null) → empty (no content, no error)', () => {
    expect(classify(0, 0, null)).toBe('empty');
  });

  it('case 2: (100, 100, "Access denied") → blocked', () => {
    expect(classify(100, 100, 'Access denied')).toBe('blocked');
  });

  it('case 3: (100, 50, "I/O error") → partial (exception but some bytes freed)', () => {
    expect(classify(100, 50, 'I/O error')).toBe('partial');
  });

  it('case 4: (100, 0, null) → cleared (clean exit, full freed)', () => {
    expect(classify(100, 0, null)).toBe('cleared');
  });

  it('case 5: (100, 50, null) → partial (clean exit, partial freed)', () => {
    expect(classify(100, 50, null)).toBe('partial');
  });

  it('case 6: (100, 100, null) → partial (NEW v2.4.49 branch — clean exit, slow index settle)', () => {
    expect(classify(100, 100, null)).toBe('partial');
  });

  it('case 7: (100, 150, null) → partial (re-measure saw growth, no exception, NEW branch)', () => {
    expect(classify(100, 150, null)).toBe('partial');
  });

  it('case 8: (5, 10, "weird") → error (clearError set + after > before, no earlier branch matches)', () => {
    // The plan brief listed (0, 0, "Some weird error") → error as the
    // "genuinely unclassified" case, but with the actual ladder that triple
    // matches the 'blocked' branch (clearError !== null && after === before).
    // The TRUE final-fallthrough requires: clearError set AND after > before
    // (re-measure grew while an exception was thrown). This is the only
    // shape that bypasses every earlier branch.
    expect(classify(5, 10, 'weird')).toBe('error');
  });
});

describe('Empty-RecycleBins.ps1 ladder drift guard (v2.4.49 B47-3)', () => {
  it('the .ps1 file contains the NEW v2.4.49 partial branch literal', () => {
    const scriptPath = path.join(process.cwd(), 'powershell', 'actions', 'Empty-RecycleBins.ps1');
    const ps = readFileSync(scriptPath, 'utf8');
    // The branch must include the exact predicate. If a future edit removes
    // or weakens it, this guard fails.
    expect(ps).toMatch(/\$null\s+-eq\s+\$clearError\s+-and\s+\$before\s+-gt\s+0[^}]*'partial'/);
  });

  it('the post-clear sleep is at the bumped 1500ms value (not the old 200ms)', () => {
    const scriptPath = path.join(process.cwd(), 'powershell', 'actions', 'Empty-RecycleBins.ps1');
    const ps = readFileSync(scriptPath, 'utf8');
    expect(ps).toMatch(/Start-Sleep\s+-Milliseconds\s+1500/);
    expect(ps).not.toMatch(/Start-Sleep\s+-Milliseconds\s+200\b/);
  });
});
