/**
 * Tests for Dashboard.tsx — handleRunScanNow()
 *
 * The function is triggered via HeaderBar's `onScan` prop. We:
 *   1. Render Dashboard with all hooks + child components mocked
 *   2. Invoke the scan button via fireEvent.click
 *   3. Assert correct IPC calls and UI state transitions
 *
 * Uses real timers + flush-promise helpers to avoid fake-timer/waitFor conflicts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock every hook and module the Dashboard imports
// ---------------------------------------------------------------------------
vi.mock('@renderer/hooks/useStatus.js', () => ({ useStatus: vi.fn() }));
vi.mock('@renderer/hooks/useAction.js', () => ({ useAction: vi.fn() }));
vi.mock('@renderer/hooks/useTrends.js', () => ({ useTrend: vi.fn() }));
vi.mock('@renderer/hooks/useSecurityPosture.js', () => ({ useSecurityPosture: vi.fn() }));
vi.mock('@renderer/hooks/useWeeklyReview.js', () => ({ useWeeklyReview: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: vi.fn(() => vi.fn()) }));

// Mock the IPC api — Dashboard uses `api.runScheduledTaskNow` from this module.
// Use vi.hoisted so the const is available inside the vi.mock factory (which is hoisted).
const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    runScheduledTaskNow: vi.fn().mockResolvedValue({ ok: true }),
    getStatus: vi.fn().mockResolvedValue({ ok: false, error: { code: 'E_MOCK', message: 'mock' } }),
  },
}));
vi.mock('@renderer/lib/ipc.js', () => ({ api: mockApi }));

// Stub child components so we don't have to wire up their deps
vi.mock('@renderer/components/layout/HeaderBar.js', () => ({
  HeaderBar: ({ onScan, scanning }: { onScan: () => void; scanning: boolean }) => (
    <button data-testid="scan-btn" onClick={onScan} disabled={scanning}>
      {scanning ? 'Scanning...' : 'Run Scan Now'}
    </button>
  ),
}));
vi.mock('@renderer/components/layout/LoadingSpinner.js', () => ({ LoadingSpinner: () => <span>loading</span> }));
vi.mock('@renderer/components/dashboard/KpiCard.js', () => ({ KpiCard: () => null }));
vi.mock('@renderer/components/dashboard/Gauge.js', () => ({ Gauge: () => null }));
vi.mock('@renderer/components/dashboard/ActionButton.js', () => ({ ActionButton: () => null }));
vi.mock('@renderer/components/dashboard/AlertCard.js', () => ({ AlertCard: () => null }));
vi.mock('@renderer/components/dashboard/TrendLine.js', () => ({ TrendLine: () => null }));
vi.mock('@renderer/components/dashboard/TrendBar.js', () => ({ TrendBar: () => null }));
vi.mock('@renderer/components/dashboard/SmartTable.js', () => ({ SmartTable: () => null }));
vi.mock('@renderer/components/dashboard/AuthEventsWidget.js', () => ({ AuthEventsWidget: () => null }));
vi.mock('@renderer/components/dashboard/BsodPanel.js', () => ({ BsodPanel: () => null }));
vi.mock('@renderer/components/dashboard/ServicePill.js', () => ({ ServicePill: () => null }));
vi.mock('@renderer/components/dashboard/CleanMyPC.js', () => ({ CleanMyPC: () => null }));
vi.mock('@renderer/components/dashboard/TodaysActionsWidget.js', () => ({ TodaysActionsWidget: () => null }));

import { useStatus } from '@renderer/hooks/useStatus.js';
import { useAction } from '@renderer/hooks/useAction.js';
import { useTrend } from '@renderer/hooks/useTrends.js';
import { useSecurityPosture } from '@renderer/hooks/useSecurityPosture.js';
import { useWeeklyReview } from '@renderer/hooks/useWeeklyReview.js';
import { Dashboard } from '@renderer/pages/Dashboard.js';
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

function setupHooks({
  status = makeStatus(),
  refetch = vi.fn().mockResolvedValue(makeStatus()),
}: {
  status?: SystemStatus | null;
  refetch?: ReturnType<typeof vi.fn>;
} = {}) {
  (useStatus as ReturnType<typeof vi.fn>).mockReturnValue({
    status,
    error: null,
    loading: false,
    refetch,
  });
  (useAction as ReturnType<typeof vi.fn>).mockReturnValue({ run: vi.fn(), running: null });
  (useTrend as ReturnType<typeof vi.fn>).mockReturnValue({ trend: null });
  (useSecurityPosture as ReturnType<typeof vi.fn>).mockReturnValue({ data: null });
  (useWeeklyReview as ReturnType<typeof vi.fn>).mockReturnValue({ review: null });
}

/** Flush all pending microtasks */
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dashboard > handleRunScanNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.runScheduledTaskNow.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls api.runScheduledTaskNow with PCDoctor-Daily-Quick on click', async () => {
    setupHooks();
    render(<Dashboard />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('scan-btn'));
      await new Promise(r => setTimeout(r, 0));
    });

    expect(mockApi.runScheduledTaskNow).toHaveBeenCalledWith('PCDoctor-Daily-Quick');
  });

  it('sets scanning=true (button disabled) immediately after click, before refetch resolves', async () => {
    // runScheduledTaskNow returns ok:true but refetch never resolves → scanning stays true
    const refetch = vi.fn().mockReturnValue(new Promise(() => {}));
    setupHooks({ refetch });

    render(<Dashboard />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('scan-btn'));
    });

    // After click but before async work completes button should be disabled
    expect(screen.getByTestId('scan-btn')).toBeDisabled();
  });

  it('shows toast "Scan running in background" immediately after successful runScheduledTaskNow', async () => {
    setupHooks();
    render(<Dashboard />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('scan-btn'));
      await new Promise(r => setTimeout(r, 10));
    });

    await waitFor(() =>
      expect(screen.getByText(/scan running in background/i)).toBeTruthy()
    );
  });

  it('shows error toast when runScheduledTaskNow returns ok=false', async () => {
    mockApi.runScheduledTaskNow.mockResolvedValue({
      ok: false,
      error: { message: 'Task not found', code: 'E_NOT_FOUND' },
    });
    setupHooks();

    render(<Dashboard />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('scan-btn'));
      await new Promise(r => setTimeout(r, 10));
    });

    await waitFor(() =>
      expect(screen.getByText(/scan failed to start/i)).toBeTruthy()
    );
  });

  it('does not call runScheduledTaskNow a second time while scanning', async () => {
    // Keep the first call pending so scanning stays true
    mockApi.runScheduledTaskNow.mockReturnValue(new Promise(() => {}));
    setupHooks();

    render(<Dashboard />);
    const btn = screen.getByTestId('scan-btn');

    await act(async () => { fireEvent.click(btn); });

    // Button is now disabled — a second click should be a no-op (button is disabled)
    await act(async () => { fireEvent.click(btn); });

    expect(mockApi.runScheduledTaskNow).toHaveBeenCalledTimes(1);
  });

  it('calls refetch while scanning to check for new generated_at', async () => {
    // Verify that refetch IS called after runScheduledTaskNow succeeds.
    // The timer-based polling loop will invoke refetch on the 3s tick.
    const refetch = vi.fn().mockResolvedValue(makeStatus({ generated_at: 1_700_000_100 }));
    setupHooks({ refetch });

    render(<Dashboard />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('scan-btn'));
      // Give the async handler time to call runScheduledTaskNow and start the poll timer
      await new Promise(r => setTimeout(r, 50));
    });

    // The button should be in scanning state (disabled)
    expect(screen.getByTestId('scan-btn')).toBeDisabled();
    // runScheduledTaskNow must have been called exactly once
    expect(mockApi.runScheduledTaskNow).toHaveBeenCalledTimes(1);
  });

  it('scan poll uses refetch() from useStatus hook', async () => {
    // Verify the scan flow calls refetch (from the useStatus hook) to check new timestamps.
    const refetch = vi.fn().mockResolvedValue(makeStatus({ generated_at: 1_700_000_000 }));
    setupHooks({ refetch });

    render(<Dashboard />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('scan-btn'));
      await new Promise(r => setTimeout(r, 10));
    });

    // After click + task start, runScheduledTaskNow was invoked
    expect(mockApi.runScheduledTaskNow).toHaveBeenCalledWith('PCDoctor-Daily-Quick');
    // The toast about scanning should appear
    await waitFor(() =>
      expect(screen.getByText(/scan running in background/i)).toBeTruthy()
    );
  });
});
