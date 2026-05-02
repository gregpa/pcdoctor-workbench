import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WizardProvider } from '../../../src/renderer/components/wizard/WizardContext.js';
import { W7AutopilotRules } from '../../../src/renderer/components/wizard/steps/W7AutopilotRules.js';

// ---------------------------------------------------------------------------
// Mock window.api
// ---------------------------------------------------------------------------

const mockApi = {
  listAutopilotRules: vi.fn(),
  setAutopilotRuleEnabled: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  setSetting: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  getSettings: vi.fn().mockResolvedValue({ ok: true, data: {} }),
};

Object.defineProperty(window, 'api', { value: mockApi, writable: true });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeRules = [
  { id: 'empty_recycle_bins_weekly',      tier: 1, description: 'Empty recycle bins weekly',       enabled: true },
  { id: 'clear_browser_caches_weekly',    tier: 1, description: 'Clear browser caches weekly',     enabled: true },
  { id: 'defender_quick_scan_daily',      tier: 1, description: 'Defender quick scan daily',       enabled: true },
  { id: 'update_defender_defs_daily',     tier: 1, description: 'Update Defender defs daily',      enabled: true },
  { id: 'run_smart_check_daily',          tier: 1, description: 'SMART check daily',               enabled: true },
  { id: 'run_malwarebytes_cli_weekly',    tier: 1, description: 'Malwarebytes quick scan weekly',  enabled: false },
  { id: 'run_adwcleaner_scan_monthly',    tier: 1, description: 'AdwCleaner scan monthly',         enabled: true },
  { id: 'run_hwinfo_log_monthly',         tier: 1, description: '2-hour sensor log monthly',       enabled: true },
  { id: 'shrink_component_store_monthly', tier: 1, description: 'Shrink component store monthly', enabled: true },
  { id: 'run_safety_scanner_monthly',     tier: 1, description: 'Safety Scanner monthly',          enabled: true },
  { id: 'refresh_nas_recycle_sizes_daily', tier: 1, description: 'Refresh NAS @Recycle sizes daily', enabled: true },
  { id: 'remove_feature_update_leftovers_low_disk', tier: 1, description: 'Remove feature-update leftovers when disk C <15% free', enabled: true },
  { id: 'apply_wsl_cap_high_ram',         tier: 2, description: 'Apply WSL cap when RAM >90% for 3 days', enabled: true },
  { id: 'clear_browser_caches_low_disk',  tier: 2, description: 'Clear browser caches when disk C <15%', enabled: true },
  { id: 'update_hosts_stevenblack_monthly', tier: 2, description: 'Refresh StevenBlack hosts monthly', enabled: true },
  { id: 'alert_bsod_7d',                  tier: 3, description: 'BSOD detected in last 7 days',   enabled: true },
  { id: 'alert_smart_warning',            tier: 3, description: 'SMART pre-fail/warning',          enabled: true },
  { id: 'alert_pending_reboot_7d',        tier: 3, description: 'Pending reboot older than 7d',    enabled: true },
  { id: 'alert_defender_defs_stale',      tier: 3, description: 'Defender defs >48h old',          enabled: true },
  { id: 'alert_new_persistence',          tier: 3, description: 'New persistence item added',      enabled: true },
  { id: 'alert_thermal_regression',       tier: 3, description: 'Temperature rise >5C week-over-week', enabled: true },
  { id: 'alert_old_driver',               tier: 3, description: 'GPU/chipset driver >180 days old', enabled: true },
  { id: 'alert_security_crit',            tier: 3, description: 'UAC/BitLocker/Firewall/Defender off', enabled: true },
  { id: 'alert_forecast_critical',        tier: 3, description: 'Forecast: metric crosses critical in 30d', enabled: true },
  { id: 'alert_action_repeated_failures', tier: 3, description: 'Any action failed 3x in 7d',     enabled: true },
];

function renderW7() {
  return render(
    <WizardProvider>
      <W7AutopilotRules />
    </WizardProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<W7AutopilotRules>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while fetching rules', () => {
    mockApi.listAutopilotRules.mockReturnValue(new Promise(() => {})); // never resolves
    renderW7();
    expect(screen.getByText(/Loading autopilot rules/)).toBeInTheDocument();
  });

  it('renders tier section headers', async () => {
    mockApi.listAutopilotRules.mockResolvedValue({ ok: true, data: fakeRules });
    renderW7();
    await waitFor(() => {
      expect(screen.getByText('Tier 1 — Silent')).toBeInTheDocument();
      expect(screen.getByText('Tier 2 — Auto + Notify')).toBeInTheDocument();
      expect(screen.getByText('Tier 3 — Alerts Only')).toBeInTheDocument();
    });
  });

  it('shows rule descriptions', async () => {
    mockApi.listAutopilotRules.mockResolvedValue({ ok: true, data: fakeRules });
    renderW7();
    await waitFor(() => {
      expect(screen.getByText('Empty recycle bins weekly')).toBeInTheDocument();
      expect(screen.getByText('BSOD detected in last 7 days')).toBeInTheDocument();
      expect(screen.getByText('Refresh StevenBlack hosts monthly')).toBeInTheDocument();
    });
  });

  it('renders preset buttons (Enable All, Minimal)', async () => {
    mockApi.listAutopilotRules.mockResolvedValue({ ok: true, data: fakeRules });
    renderW7();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Enable All' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Minimal' })).toBeInTheDocument();
    });
  });

  it('renders rule count summary', async () => {
    mockApi.listAutopilotRules.mockResolvedValue({ ok: true, data: fakeRules });
    renderW7();
    await waitFor(() => {
      // 24 of 25 enabled (run_malwarebytes_cli_weekly is disabled in fixtures)
      expect(screen.getByText(/24 of 25 rules enabled/)).toBeInTheDocument();
    });
  });

  it('toggles a rule when the switch is clicked', async () => {
    mockApi.listAutopilotRules.mockResolvedValue({ ok: true, data: fakeRules });
    renderW7();
    await waitFor(() => {
      expect(screen.getByText('Empty recycle bins weekly')).toBeInTheDocument();
    });

    // Find the toggle for "Empty recycle bins weekly"
    const toggle = screen.getByRole('switch', { name: 'Empty recycle bins weekly' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    // Count should decrease
    await waitFor(() => {
      expect(screen.getByText(/23 of 25 rules enabled/)).toBeInTheDocument();
    });
  });

  it('shows Requires NAS badge when NAS is not configured', async () => {
    mockApi.listAutopilotRules.mockResolvedValue({ ok: true, data: fakeRules });
    renderW7();
    await waitFor(() => {
      expect(screen.getByText('Requires NAS')).toBeInTheDocument();
    });
  });

  it('Enable All preset enables all rules', async () => {
    mockApi.listAutopilotRules.mockResolvedValue({ ok: true, data: fakeRules });
    renderW7();
    await waitFor(() => {
      expect(screen.getByText(/24 of 25 rules enabled/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Enable All' }));

    await waitFor(() => {
      expect(screen.getByText(/25 of 25 rules enabled/)).toBeInTheDocument();
    });
  });

  it('Minimal preset enables only tier 3 rules', async () => {
    mockApi.listAutopilotRules.mockResolvedValue({ ok: true, data: fakeRules });
    renderW7();
    await waitFor(() => {
      expect(screen.getByText('Autopilot Rules')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Minimal' }));

    await waitFor(() => {
      // 10 tier 3 rules enabled out of 25 total
      expect(screen.getByText(/10 of 25 rules enabled/)).toBeInTheDocument();
    });
  });
});
