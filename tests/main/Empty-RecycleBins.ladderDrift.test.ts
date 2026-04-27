// @vitest-environment node
//
// v2.4.49 (B47-3): stronger drift guard for the Empty-RecycleBins.ps1 status
// ladder. The existing partialClassification.test.ts uses a hand-rolled TS
// mirror of the ladder; if the PS file changes order without the TS mirror
// being updated, the mirror silently drifts. This file regex-extracts the
// actual branch predicates and their return values from the .ps1 source and
// validates the observed order matches the plan-specified sequence, catching
// structural rearrangements that the string-match spot-checks would miss.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Extract the $status = ... ladder block from the PS file.
// Returns an ordered list of { predicate, result } pairs derived directly
// from the source text, so any reordering or branch deletion fails this test.
function extractLadder(ps: string): Array<{ keyword: string; result: string }> {
  // Isolate the multi-line `$status = if/elseif/else` block.
  // The block ends with a blank line or a non-elseif/else line.
  const blockMatch = ps.match(/\$status\s*=\s*([\s\S]+?)(?=\n\s*\n|\n\s*if\s|\n\s*\$)/);
  if (!blockMatch) throw new Error('Could not find $status = ... block in Empty-RecycleBins.ps1');
  const block = blockMatch[1];

  // Pull each branch: `if(...)...{ 'result' }` or `elseif(...)...{ 'result' }` or `else...{ 'result' }`.
  // We only care about keyword + quoted return value; predicate content is validated by spot-check tests.
  const branchRe = /\b(if|elseif|else)\b[^{]*\{\s*'([^']+)'\s*\}/g;
  const branches: Array<{ keyword: string; result: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = branchRe.exec(block)) !== null) {
    branches.push({ keyword: m[1], result: m[2] });
  }
  return branches;
}

describe('Empty-RecycleBins.ps1 ladder structure drift guard (v2.4.49 B47-3)', () => {
  let ps: string;

  ps = readFileSync(
    path.join(process.cwd(), 'powershell', 'actions', 'Empty-RecycleBins.ps1'),
    'utf8',
  );

  it('ladder has exactly 7 branches in the documented order', () => {
    const branches = extractLadder(ps);
    expect(branches).toHaveLength(7);
  });

  it('first branch is the "empty" path (before=0, no error)', () => {
    const [first] = extractLadder(ps);
    expect(first.keyword).toBe('if');
    expect(first.result).toBe('empty');
  });

  it('second branch is "blocked" (has error AND after=before)', () => {
    const branches = extractLadder(ps);
    expect(branches[1].keyword).toBe('elseif');
    expect(branches[1].result).toBe('blocked');
  });

  it('third branch is "partial" (has error AND partial clear)', () => {
    const branches = extractLadder(ps);
    expect(branches[2].keyword).toBe('elseif');
    expect(branches[2].result).toBe('partial');
  });

  it('fourth branch is "cleared" (clean exit, after=0)', () => {
    const branches = extractLadder(ps);
    expect(branches[3].keyword).toBe('elseif');
    expect(branches[3].result).toBe('cleared');
  });

  it('fifth branch is "partial" (clean exit, after<before)', () => {
    const branches = extractLadder(ps);
    expect(branches[4].keyword).toBe('elseif');
    expect(branches[4].result).toBe('partial');
  });

  it('sixth branch is the v2.4.49 NEW "partial" path (clean exit, index lag)', () => {
    const branches = extractLadder(ps);
    expect(branches[5].keyword).toBe('elseif');
    expect(branches[5].result).toBe('partial');
    // This branch must reference the $null clearError predicate -- the bug fix.
    const block = ps.match(/\$status\s*=\s*([\s\S]+?)(?=\n\s*\n|\n\s*if\s|\n\s*\$)/)![1];
    // Sixth elseif: everything after the fifth elseif's closing brace.
    const sixthIdx = (() => {
      let count = 0;
      const branchRe = /\b(if|elseif|else)\b/g;
      let m: RegExpExecArray | null;
      while ((m = branchRe.exec(block)) !== null) {
        count++;
        if (count === 6) return m.index;
      }
      return -1;
    })();
    expect(sixthIdx).toBeGreaterThan(0);
    const sixthClause = block.slice(sixthIdx, sixthIdx + 80);
    expect(sixthClause).toMatch(/\$null\s+-eq\s+\$clearError/);
  });

  it('final branch is "error" (catch-all else)', () => {
    const branches = extractLadder(ps);
    const last = branches[branches.length - 1];
    expect(last.keyword).toBe('else');
    expect(last.result).toBe('error');
  });
});
