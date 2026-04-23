/**
 * Tests for src/renderer/hooks/useStatus.ts
 *
 * Mocking strategy:
 *   - @renderer/lib/ipc.js → expose a controllable `api` object with a mockable getStatus
 *   - @renderer/hooks/usePoll.js → fire the callback exactly once on mount (no timers needed)
 *   - window.addEventListener/removeEventListener → jsdom handles these natively
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useEffect } from 'react';

// ── Controllable api mock ──────────────────────────────────────────────────
const mockGetStatus = vi.fn();

vi.mock('@renderer/lib/ipc.js', () => ({
  api: { getStatus: (...args: unknown[]) => mockGetStatus(...args) },
}));

// ── usePoll mock: fires the callback once on mount ─────────────────────────
vi.mock('@renderer/hooks/usePoll.js', () => ({
  usePoll: (fn: () => Promise<void>, _interval: number) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      void fn();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
  },
}));

import { useStatus } from '@renderer/hooks/useStatus.js';
import type { SystemStatus } from '@shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatus(override: Partial<SystemStatus> = {}): SystemStatus {
  return {
    generated_at: 1_700_000_000,
    overall_severity: 'good',
    overall_label: 'Healthy',
    host: 'TESTPC',
    kpis: [],
    gauges: [],
    findings: [],
    services: [],
    smart: [],
    ...override,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initial state: loading=true before the poll resolves', () => {
    // Never-resolving promise keeps loading=true
    mockGetStatus.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useStatus());
    expect(result.current.loading).toBe(true);
    expect(result.current.status).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('populates status and sets loading=false after successful fetch', async () => {
    const status = makeStatus({ host: 'MYMACHINE' });
    mockGetStatus.mockResolvedValue({ ok: true, data: status });

    const { result } = renderHook(() => useStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.status).toEqual(status);
    expect(result.current.error).toBeNull();
  });

  it('sets error when api returns ok=false', async () => {
    mockGetStatus.mockResolvedValue({
      ok: false,
      error: { code: 'E_NO_REPORT', message: 'No report found' },
    });

    const { result } = renderHook(() => useStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.status).toBeNull();
    expect(result.current.error).toEqual({ code: 'E_NO_REPORT', message: 'No report found' });
  });

  it('refetch() returns fresh data and updates state', async () => {
    const first = makeStatus({ generated_at: 1_700_000_000 });
    const second = makeStatus({ generated_at: 1_700_000_100 });
    mockGetStatus
      .mockResolvedValueOnce({ ok: true, data: first })
      .mockResolvedValue({ ok: true, data: second });

    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.status?.generated_at).toBe(1_700_000_000));

    let refetchResult: SystemStatus | null = null;
    await act(async () => {
      refetchResult = await result.current.refetch();
    });

    expect(refetchResult).toEqual(second);
    expect(result.current.status?.generated_at).toBe(1_700_000_100);
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
  });

  it('refetch() returns null and sets error when api fails on second call', async () => {
    const goodStatus = makeStatus();
    mockGetStatus
      .mockResolvedValueOnce({ ok: true, data: goodStatus })
      .mockResolvedValue({ ok: false, error: { code: 'E_STALE', message: 'stale' } });

    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.status).toBeTruthy());

    let refetchResult: SystemStatus | null = null;
    await act(async () => {
      refetchResult = await result.current.refetch();
    });

    expect(refetchResult).toBeNull();
    expect(result.current.error).toEqual({ code: 'E_STALE', message: 'stale' });
  });

  it('window focus event triggers a re-fetch', async () => {
    const status = makeStatus();
    mockGetStatus.mockResolvedValue({ ok: true, data: status });

    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const callsAfterMount = mockGetStatus.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise(r => setTimeout(r, 10));
    });

    expect(mockGetStatus.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it('unmounting removes the focus listener — no re-fetch after unmount', async () => {
    mockGetStatus.mockResolvedValue({ ok: true, data: makeStatus() });

    const { result, unmount } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));

    unmount();
    const callsBeforeUnmount = mockGetStatus.mock.calls.length;

    window.dispatchEvent(new Event('focus'));
    await new Promise(r => setTimeout(r, 20));

    expect(mockGetStatus.mock.calls.length).toBe(callsBeforeUnmount);
  });

  /**
   * v2.4.36 (B43) regression: Electron emits window.focus events repeatedly
   * during a resize drag. Pre-v2.4.36 each event triggered a full getStatus
   * refetch (file read + SQLite write + notifier diff), producing a >1 min
   * UI freeze. A leading-edge debounce collapses storms into one refetch.
   */
  it('debounces focus storms to one refetch per 500ms window', async () => {
    mockGetStatus.mockResolvedValue({ ok: true, data: makeStatus() });

    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const baseline = mockGetStatus.mock.calls.length;

    // Fire 20 focus events back-to-back (simulating resize drag spam).
    await act(async () => {
      for (let i = 0; i < 20; i++) {
        window.dispatchEvent(new Event('focus'));
      }
      await new Promise(r => setTimeout(r, 10));
    });

    // Leading edge: first focus in the cluster is allowed through.
    // All 19 that follow within the 500ms debounce window are dropped.
    expect(mockGetStatus.mock.calls.length).toBe(baseline + 1);
  });

  it('allows a fresh refetch once the debounce window has elapsed', async () => {
    mockGetStatus.mockResolvedValue({ ok: true, data: makeStatus() });

    const { result } = renderHook(() => useStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const baseline = mockGetStatus.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise(r => setTimeout(r, 10));
    });
    expect(mockGetStatus.mock.calls.length).toBe(baseline + 1);

    // Wait > 500ms, then fire another focus — should go through.
    await act(async () => {
      await new Promise(r => setTimeout(r, 600));
      window.dispatchEvent(new Event('focus'));
      await new Promise(r => setTimeout(r, 10));
    });
    expect(mockGetStatus.mock.calls.length).toBe(baseline + 2);
  });
});
