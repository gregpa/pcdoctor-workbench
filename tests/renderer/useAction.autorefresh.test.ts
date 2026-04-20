/**
 * Tests for useAction.ts — auto-refresh behavior.
 *
 * Verifies that after a successful action:
 *   1. api.runScheduledTaskNow is called once with 'PCDoctor-Daily-Quick'
 *   2. api.getStatus is polled until generated_at advances
 *   3. onRefresh callback is invoked with the fresh status
 *   4. No auto-refresh for dry_run or failed actions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Controllable api mock — use vi.hoisted so mocks are available before imports
// ---------------------------------------------------------------------------
const { mockRunAction, mockRunScheduledTaskNow, mockGetStatus } = vi.hoisted(() => ({
  mockRunAction: vi.fn(),
  mockRunScheduledTaskNow: vi.fn(),
  mockGetStatus: vi.fn(),
}));

vi.mock('@renderer/lib/ipc.js', () => ({
  api: {
    runAction: (...args: unknown[]) => mockRunAction(...args),
    runScheduledTaskNow: (...args: unknown[]) => mockRunScheduledTaskNow(...args),
    getStatus: (...args: unknown[]) => mockGetStatus(...args),
  },
}));

import { useAction } from '@renderer/hooks/useAction.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeActionResult(overrides: Record<string, unknown> = {}) {
  return {
    action: 'flush_dns' as const,
    success: true,
    duration_ms: 100,
    result: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAction — autoRefresh=true (default)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls runScheduledTaskNow after a successful action', async () => {
    mockRunAction.mockResolvedValue({ ok: true, data: makeActionResult() });
    mockRunScheduledTaskNow.mockResolvedValue({ ok: true });
    // Baseline getStatus + at least one poll returning same ts (no advance needed to check call count)
    mockGetStatus.mockResolvedValue({ ok: true, data: { generated_at: 1_700_000_000 } });

    const { result } = renderHook(() => useAction());

    await act(async () => {
      await result.current.run({ name: 'flush_dns' });
    });

    expect(mockRunScheduledTaskNow).toHaveBeenCalledWith('PCDoctor-Daily-Quick');
    expect(mockRunScheduledTaskNow).toHaveBeenCalledTimes(1);
  });

  it('polls getStatus until generated_at advances and calls onRefresh', async () => {
    mockRunAction.mockResolvedValue({ ok: true, data: makeActionResult() });
    mockRunScheduledTaskNow.mockResolvedValue({ ok: true });

    // Baseline → poll-1 (no advance) → poll-2 (advance)
    mockGetStatus
      .mockResolvedValueOnce({ ok: true, data: { generated_at: 1_700_000_000 } }) // baseline
      .mockResolvedValueOnce({ ok: true, data: { generated_at: 1_700_000_000 } }) // poll 1 - same
      .mockResolvedValueOnce({ ok: true, data: { generated_at: 1_700_000_100 } }); // poll 2 - advance

    const onRefresh = vi.fn();
    const { result } = renderHook(() => useAction({ onRefresh }));

    // Run the action (triggers background scan + baseline getStatus)
    await act(async () => {
      await result.current.run({ name: 'flush_dns' });
    });

    // Advance timer for first poll tick (3s) + flush promises
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      // flush microtasks
      await Promise.resolve();
      await Promise.resolve();
    });

    // Advance timer for second poll tick + flush
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockGetStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onRefresh).toHaveBeenCalledWith(expect.objectContaining({ generated_at: 1_700_000_100 }));
  });
});

describe('useAction — does NOT auto-refresh on failure or dry_run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up default return values so the mock doesn't return undefined
    mockRunAction.mockResolvedValue({
      ok: false,
      error: { code: 'E_PS_NONZERO_EXIT', message: 'Script failed' },
    });
    mockRunScheduledTaskNow.mockResolvedValue({ ok: true });
    mockGetStatus.mockResolvedValue({ ok: true, data: { generated_at: 1_700_000_000 } });
  });

  it('does NOT call runScheduledTaskNow when action returns ok=false', async () => {
    const { result } = renderHook(() => useAction());

    await act(async () => {
      await result.current.run({ name: 'flush_dns' });
    });

    expect(mockRunScheduledTaskNow).not.toHaveBeenCalled();
  });

  it('does NOT call runScheduledTaskNow when action success=false (IPC ok but script failed)', async () => {
    mockRunAction.mockResolvedValue({
      ok: true,
      data: {
        ...makeActionResult(),
        success: false,
        error: { code: 'E_SCRIPT_FAIL', message: 'oops' },
      },
    });

    const { result } = renderHook(() => useAction());

    await act(async () => {
      await result.current.run({ name: 'flush_dns' });
    });

    expect(mockRunScheduledTaskNow).not.toHaveBeenCalled();
  });

  it('does NOT call runScheduledTaskNow for dry_run even on success', async () => {
    mockRunAction.mockResolvedValue({ ok: true, data: makeActionResult() });

    const { result } = renderHook(() => useAction());

    await act(async () => {
      await result.current.run({ name: 'flush_dns', dry_run: true });
    });

    expect(mockRunScheduledTaskNow).not.toHaveBeenCalled();
  });
});

describe('useAction — autoRefresh=false opt-out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAction.mockResolvedValue({ ok: true, data: makeActionResult() });
    mockRunScheduledTaskNow.mockResolvedValue({ ok: true });
    mockGetStatus.mockResolvedValue({ ok: true, data: { generated_at: 1_700_000_000 } });
  });

  it('does NOT call runScheduledTaskNow when autoRefresh=false', async () => {
    const { result } = renderHook(() => useAction({ autoRefresh: false }));

    await act(async () => {
      await result.current.run({ name: 'flush_dns' });
    });

    expect(mockRunScheduledTaskNow).not.toHaveBeenCalled();
  });
});

describe('useAction — scan start failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAction.mockResolvedValue({ ok: true, data: makeActionResult() });
    mockRunScheduledTaskNow.mockResolvedValue({
      ok: false,
      error: { code: 'E_TASK_NOT_FOUND', message: 'Task not found' },
    });
    mockGetStatus.mockResolvedValue({ ok: true, data: { generated_at: 1_700_000_000 } });
  });

  it('does not call getStatus for polling when runScheduledTaskNow fails', async () => {
    const { result } = renderHook(() => useAction());

    await act(async () => {
      await result.current.run({ name: 'flush_dns' });
    });

    // Only the baseline getStatus call (before scan result) should have been skipped entirely
    // since scanResult.ok=false means we bail out before polling
    expect(mockGetStatus).not.toHaveBeenCalled();
  });
});
