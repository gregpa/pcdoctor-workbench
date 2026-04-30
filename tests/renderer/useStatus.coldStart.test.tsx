// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the api module BEFORE importing useStatus so the import sees the mock.
vi.mock('@renderer/lib/ipc.js', () => ({
  api: {
    getStatus: vi.fn(),
  },
}));

// usePoll is a no-op in these tests so we can drive refetch() explicitly
// and observe retry timing without racing against an auto-firing poll.
// (Real usePoll fires fn() once on mount + every interval; the cold-start
// retry path triggered by that first call is exercised here by an explicit
// refetch() call instead.)
vi.mock('@renderer/hooks/usePoll.js', () => ({
  usePoll: () => {},
}));

// perfLog mocks -- noop everything, we don't assert on telemetry here.
vi.mock('@renderer/lib/perfLog.js', () => ({
  logPerf: vi.fn(),
  markPerf: vi.fn(() => () => {}),
}));

import { useStatus } from '@renderer/hooks/useStatus.js';
import { api } from '@renderer/lib/ipc.js';

const mockedGetStatus = api.getStatus as unknown as ReturnType<typeof vi.fn>;

const SAMPLE_STATUS = {
  overall_severity: 'good',
  kpis: [],
  gauges: [],
  trends: {},
  findings: [],
  smart: [],
  services: [],
  metrics: {},
} as any;

beforeEach(() => {
  mockedGetStatus.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useStatus cold-start cache-empty retry (v2.5.13)', () => {
  it('retries every 500ms when first call returns E_BRIDGE_CACHE_EMPTY', async () => {
    mockedGetStatus
      .mockResolvedValueOnce({ ok: false, error: { code: 'E_BRIDGE_CACHE_EMPTY', message: 'cold' } } as any)
      .mockResolvedValueOnce({ ok: false, error: { code: 'E_BRIDGE_CACHE_EMPTY', message: 'cold' } } as any)
      .mockResolvedValueOnce({ ok: true, data: SAMPLE_STATUS } as any);

    const { result } = renderHook(() => useStatus());

    // First explicit refetch (simulates usePoll's first-tick call).
    await act(async () => { await result.current.refetch(); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(1);
    expect(result.current.error?.code).toBe('E_BRIDGE_CACHE_EMPTY');
    expect(result.current.status).toBeNull();

    // Advance to first retry firing.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(2);
    expect(result.current.error?.code).toBe('E_BRIDGE_CACHE_EMPTY');

    // Advance to second retry firing -- this one returns OK.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(3);
    expect(result.current.status).not.toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('does NOT retry on non-cache-empty errors', async () => {
    mockedGetStatus.mockResolvedValueOnce({
      ok: false,
      error: { code: 'E_BRIDGE_READ_FAILED', message: 'disk' },
    } as any);

    const { result } = renderHook(() => useStatus());

    await act(async () => { await result.current.refetch(); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(1);
    expect(result.current.error?.code).toBe('E_BRIDGE_READ_FAILED');

    // Advance well past 500ms — no retry should fire.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(1);
  });

  it('caps retries at MAX_COLD_START_RETRIES (20 attempts = 10s window)', async () => {
    mockedGetStatus.mockResolvedValue({
      ok: false,
      error: { code: 'E_BRIDGE_CACHE_EMPTY', message: 'cold' },
    } as any);

    const { result } = renderHook(() => useStatus());

    await act(async () => { await result.current.refetch(); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(1);

    // Advance through the full retry window + buffer (25 ticks of 500ms).
    for (let i = 0; i < 25; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    }

    // 1 (initial) + 20 (retries) = 21. No more, even after 25 ticks.
    expect(mockedGetStatus).toHaveBeenCalledTimes(21);
    expect(result.current.error?.code).toBe('E_BRIDGE_CACHE_EMPTY');
  });

  it('cancels pending retry on unmount', async () => {
    mockedGetStatus.mockResolvedValue({
      ok: false,
      error: { code: 'E_BRIDGE_CACHE_EMPTY', message: 'cold' },
    } as any);

    const { result, unmount } = renderHook(() => useStatus());

    await act(async () => { await result.current.refetch(); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(1);

    // Unmount before the retry timer fires.
    unmount();

    // Advance well past several retry windows.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(1);
  });

  it('resets retry counter after a successful refetch', async () => {
    mockedGetStatus
      .mockResolvedValueOnce({ ok: false, error: { code: 'E_BRIDGE_CACHE_EMPTY', message: 'cold' } } as any)
      .mockResolvedValueOnce({ ok: true, data: SAMPLE_STATUS } as any)
      .mockResolvedValueOnce({ ok: false, error: { code: 'E_BRIDGE_CACHE_EMPTY', message: 'cold' } } as any)
      .mockResolvedValueOnce({ ok: true, data: SAMPLE_STATUS } as any);

    const { result } = renderHook(() => useStatus());

    await act(async () => { await result.current.refetch(); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(1);

    // Retry succeeds.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(2);
    expect(result.current.status).not.toBeNull();

    // Manually trigger another refetch (simulating a focus event).
    await act(async () => { await result.current.refetch(); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(3);
    expect(result.current.error?.code).toBe('E_BRIDGE_CACHE_EMPTY');

    // Counter was reset on the prior success, so this fresh empty triggers a retry.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(4);
    expect(result.current.error).toBeNull();
  });

  it('does not stack timers when concurrent callers fail with cache-empty', async () => {
    // v2.5.15: simulate the race where usePoll + focus event both call
    // refetch within the same retry window. The "clearTimeout + replace"
    // pattern in useStatus.ts must guarantee at most ONE pending retry
    // timer at any moment, even when multiple concurrent callers each
    // see cache-empty.
    mockedGetStatus.mockResolvedValue({
      ok: false,
      error: { code: 'E_BRIDGE_CACHE_EMPTY', message: 'cold' },
    } as any);

    const { result } = renderHook(() => useStatus());

    // Two callers fire concurrently, each fails cache-empty, each
    // increments the counter and re-arms the single timer slot.
    await act(async () => {
      await Promise.all([
        result.current.refetch(),
        result.current.refetch(),
      ]);
    });
    expect(mockedGetStatus).toHaveBeenCalledTimes(2);

    // Advance ONE retry window. Only ONE retry should fire (the most
    // recent timer the second caller scheduled), not two -- the first
    // caller's timer was cleared when the second caller scheduled its
    // own. If timers stacked, this would fire 2x and consume budget at
    // 2x rate.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(3);

    // Advance another retry window -- still strictly +1 per tick.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mockedGetStatus).toHaveBeenCalledTimes(4);
  });

  it('concurrent caller burst does not consume retry budget at N-x rate', async () => {
    // v2.5.15 (W4 from code-reviewer): the retry counter must increment
    // ONCE per fired retry, not once per concurrent caller. A burst of 10
    // simultaneous refetches in the cold-start window should leave the
    // full 20-retry budget intact for subsequent timer firings.
    mockedGetStatus.mockResolvedValue({
      ok: false,
      error: { code: 'E_BRIDGE_CACHE_EMPTY', message: 'cold' },
    } as any);

    const { result } = renderHook(() => useStatus());

    // Fire 10 concurrent refetches.
    await act(async () => {
      await Promise.all(Array.from({ length: 10 }, () => result.current.refetch()));
    });
    expect(mockedGetStatus).toHaveBeenCalledTimes(10);

    // Advance through the full retry-cap window (25 ticks of 500ms,
    // budget is 20). If counter incremented per CALLER (the W4 bug),
    // budget would be exhausted by tick (20-10)=10 with mock count
    // capped at 10 + 10 = 20. The post-fix counter increments per FIRED
    // retry only, so we expect 10 + 20 = 30.
    for (let i = 0; i < 25; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    }
    expect(mockedGetStatus).toHaveBeenCalledTimes(30);
  });
});
