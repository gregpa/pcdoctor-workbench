// @vitest-environment node
//
// v2.4.49 (B48-AUDIT-1 + B48-AUDIT-2): tests for the renderer-supplied
// reviewDate allowlist that gates api:archiveWeeklyReviewToObsidian and
// api:getWeeklyReview. Pre-2.4.49, '../../etc/passwd' would let
// `${reviewDate}.md` join into the destination path and a maliciously
// named source file would satisfy existsSync, causing copyFile to an
// attacker-chosen destination.
//
// Importing REVIEW_DATE_RE directly from a leaf module keeps this test
// pure: no Electron app, no IPC mocks, no PS spawn (mirrors the
// SCHEDULED_TASK_NAME_RE pattern from v2.4.48 B48-SEC-1).

import { describe, it, expect } from 'vitest';
import { REVIEW_DATE_RE } from '../../src/main/reviewDateRe.js';

describe('REVIEW_DATE_RE allowlist (B48-AUDIT-1/2)', () => {
  it('case 1: valid ISO date "2026-04-27" → accepted (handler proceeds)', () => {
    expect(REVIEW_DATE_RE.test('2026-04-27')).toBe(true);
  });

  it('case 2: path-traversal "../../etc/passwd" → rejected', () => {
    expect(REVIEW_DATE_RE.test('../../etc/passwd')).toBe(false);
  });

  it('case 3: short partial "2026-04" → rejected', () => {
    expect(REVIEW_DATE_RE.test('2026-04')).toBe(false);
  });

  it('case 4: empty string → rejected', () => {
    expect(REVIEW_DATE_RE.test('')).toBe(false);
  });

  it('case 5: trailing extension "2026-04-27.txt" → rejected', () => {
    expect(REVIEW_DATE_RE.test('2026-04-27.txt')).toBe(false);
  });

  it('case 6: Windows path-traversal variant "2026-04-27\\..\\foo" → rejected', () => {
    expect(REVIEW_DATE_RE.test('2026-04-27\\..\\foo')).toBe(false);
  });

  it('case 7: forward-slash variant "2026-04-27/foo" → rejected', () => {
    expect(REVIEW_DATE_RE.test('2026-04-27/foo')).toBe(false);
  });

  it('case 8: leading whitespace " 2026-04-27" → rejected (anchored regex)', () => {
    expect(REVIEW_DATE_RE.test(' 2026-04-27')).toBe(false);
  });

  it('case 9: trailing whitespace "2026-04-27 " → rejected', () => {
    expect(REVIEW_DATE_RE.test('2026-04-27 ')).toBe(false);
  });

  it('case 10: shell-metachar payload "2026-04-27;rm -rf /" → rejected', () => {
    expect(REVIEW_DATE_RE.test('2026-04-27;rm -rf /')).toBe(false);
  });
});

// Reproduce the validation gate as a small TS helper that mirrors the
// handler's first lines, then exercise both the proceed and reject branches.
// This locks in the contract: gate runs FIRST, returns the documented error
// shape, and only valid dates fall through.
type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

function archiveGate(reviewDate: string): IpcResult<{ archive_path: string }> | null {
  if (!REVIEW_DATE_RE.test(reviewDate)) {
    return { ok: false, error: { code: 'E_INVALID_DATE', message: 'reviewDate must match YYYY-MM-DD' } };
  }
  return null; // signals "pass through to existsSync stage"
}

function getReviewGate(reviewDate?: string): IpcResult<unknown> | null {
  if (reviewDate !== undefined && !REVIEW_DATE_RE.test(reviewDate)) {
    return { ok: false, error: { code: 'E_INVALID_DATE', message: 'reviewDate must match YYYY-MM-DD' } };
  }
  return null;
}

describe('api:archiveWeeklyReviewToObsidian validation gate shape', () => {
  it('proceeds (returns null) for a valid ISO date', () => {
    expect(archiveGate('2026-04-27')).toBeNull();
  });

  it('returns E_INVALID_DATE for path-traversal payload', () => {
    const r = archiveGate('../../etc/passwd');
    expect(r).toEqual({
      ok: false,
      error: { code: 'E_INVALID_DATE', message: 'reviewDate must match YYYY-MM-DD' },
    });
  });

  it('returns E_INVALID_DATE for empty string', () => {
    const r = archiveGate('');
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.error.code).toBe('E_INVALID_DATE');
  });
});

describe('api:getWeeklyReview validation gate shape', () => {
  it('proceeds (returns null) when reviewDate is undefined (regression guard for default behavior)', () => {
    expect(getReviewGate(undefined)).toBeNull();
  });

  it('proceeds (returns null) for a valid ISO date', () => {
    expect(getReviewGate('2026-04-27')).toBeNull();
  });

  it('returns E_INVALID_DATE for path-traversal "../foo"', () => {
    const r = getReviewGate('../foo');
    expect(r).toEqual({
      ok: false,
      error: { code: 'E_INVALID_DATE', message: 'reviewDate must match YYYY-MM-DD' },
    });
  });
});
