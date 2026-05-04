/**
 * Tests for v2.5.29 Surface-class hardware banner on Dashboard.tsx.
 *
 * Banner condition: lhm_http_open === true && source === 'none' && from_cache === false.
 *
 * Verifies mutual-exclusivity with the v2.5.2 LHM-off banner: the two banners
 * gate on lhm_http_open false vs true, so they cannot both render at once.
 *
 * Mirrors the mock setup from Dashboard.handleRunScanNow.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    runScheduledTaskNow: vi.fn().mockResolvedValue({ ok: true }),
    getStatus: vi.fn().mockResolvedValue({ ok: false, error: { code: 'E_MOCK', message: 'mock' } }),
    openLhm: vi.fn().mockResolvedValue({ ok: true }),
  },
}));
vi.mock('@renderer/lib/ipc.js', () => ({ api: mockApi }));

vi.mock('@renderer/components/layout/HeaderBar.js', () => ({
  HeaderBar: () => <div data-testid="header" />,
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
import type { SystemStatus, CpuTempStatus } from '@shared/types.js';

function makeStatus(cpu_temp_status?: CpuTempStatus): SystemStatus {
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
    cpu_temp_status,
  };
}

function setupHooks(status: SystemStatus) {
  (useStatus as ReturnType<typeof vi.fn>).mockReturnValue({
    status,
    error: null,
    loading: false,
    refetch: vi.fn().mockResolvedValue(status),
  });
  (useAction as ReturnType<typeof vi.fn>).mockReturnValue({ run: vi.fn(), running: null });
  (useTrend as ReturnType<typeof vi.fn>).mockReturnValue({ trend: null });
  (useSecurityPosture as ReturnType<typeof vi.fn>).mockReturnValue({ data: null });
  (useWeeklyReview as ReturnType<typeof vi.fn>).mockReturnValue({ review: null });
}

const SURFACE_HEADING = /no temperature sensors detected/i;
const LHM_OFF_HEADING = /lhm remote web server is off/i;

describe('Dashboard > Surface compat banner (v2.5.29)', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders when lhm_http_open=true, source=none, from_cache=false (the Surface case)', () => {
    setupHooks(makeStatus({ source: 'none', from_cache: false, lhm_http_open: true }));
    render(<Dashboard />);
    expect(screen.getByText(SURFACE_HEADING)).toBeInTheDocument();
    expect(screen.queryByText(LHM_OFF_HEADING)).not.toBeInTheDocument();
  });

  it('hides when lhm_http_open=false (the LHM-off banner takes over)', () => {
    setupHooks(makeStatus({ source: 'none', from_cache: false, lhm_http_open: false }));
    render(<Dashboard />);
    expect(screen.queryByText(SURFACE_HEADING)).not.toBeInTheDocument();
    expect(screen.getByText(LHM_OFF_HEADING)).toBeInTheDocument();
  });

  it('hides when source !== none (live source is producing temps)', () => {
    setupHooks(makeStatus({ source: 'LibreHardwareMonitor HTTP', from_cache: false, lhm_http_open: true }));
    render(<Dashboard />);
    expect(screen.queryByText(SURFACE_HEADING)).not.toBeInTheDocument();
    expect(screen.queryByText(LHM_OFF_HEADING)).not.toBeInTheDocument();
  });

  it('hides when from_cache=true (panel is showing a cached value, not a Surface case)', () => {
    setupHooks(makeStatus({ source: 'none', from_cache: true, lhm_http_open: true }));
    render(<Dashboard />);
    expect(screen.queryByText(SURFACE_HEADING)).not.toBeInTheDocument();
  });

  it('hides on cold-launch when cpu_temp_status is undefined', () => {
    setupHooks(makeStatus(undefined));
    render(<Dashboard />);
    expect(screen.queryByText(SURFACE_HEADING)).not.toBeInTheDocument();
    expect(screen.queryByText(LHM_OFF_HEADING)).not.toBeInTheDocument();
  });
});
