// Tests for timeAgoShort (v2.5.9 B4) -- the relative-time helper in Updates.tsx.
// The function is module-private; exported via timeAgoShort_test for this file only.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { timeAgoShort_test as timeAgoShort } from '../../src/renderer/pages/Updates.js';

// Pin Date.now() so tests are deterministic.
const BASE_TS = 1_714_000_000_000; // arbitrary fixed epoch ms

afterEach(() => { vi.restoreAllMocks(); });

function setNow(nowMs: number) {
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);
}

describe('timeAgoShort edge cases and boundaries', () => {
  it('returns "just now" when delta is 0ms (exact same timestamp)', () => {
    setNow(BASE_TS);
    expect(timeAgoShort(BASE_TS)).toBe('just now');
  });

  it('returns "just now" when delta is 59 seconds (below 1-minute threshold)', () => {
    setNow(BASE_TS);
    expect(timeAgoShort(BASE_TS - 59_000)).toBe('just now');
  });

  it('returns "1m ago" when delta is exactly 60 seconds', () => {
    setNow(BASE_TS);
    expect(timeAgoShort(BASE_TS - 60_000)).toBe('1m ago');
  });

  it('returns "59m ago" just below the 1-hour threshold', () => {
    setNow(BASE_TS);
    expect(timeAgoShort(BASE_TS - 59 * 60_000)).toBe('59m ago');
  });

  it('returns "1h ago" when delta is exactly 60 minutes', () => {
    setNow(BASE_TS);
    expect(timeAgoShort(BASE_TS - 60 * 60_000)).toBe('1h ago');
  });

  it('returns "23h ago" just below the 1-day threshold', () => {
    setNow(BASE_TS);
    expect(timeAgoShort(BASE_TS - 23 * 60 * 60_000)).toBe('23h ago');
  });

  it('returns "1d ago" when delta is exactly 24 hours', () => {
    setNow(BASE_TS);
    expect(timeAgoShort(BASE_TS - 24 * 60 * 60_000)).toBe('1d ago');
  });

  it('returns "7d ago" for a week-old timestamp', () => {
    setNow(BASE_TS);
    expect(timeAgoShort(BASE_TS - 7 * 24 * 60 * 60_000)).toBe('7d ago');
  });

  it('returns "just now" for a future timestamp (clock skew, negative delta)', () => {
    setNow(BASE_TS);
    // ts is 5 minutes in the future relative to Date.now()
    expect(timeAgoShort(BASE_TS + 5 * 60_000)).toBe('just now');
  });
});
