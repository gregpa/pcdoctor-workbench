import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WizardProvider } from '../../../src/renderer/components/wizard/WizardContext.js';
import { W4SecurityBaseline } from '../../../src/renderer/components/wizard/steps/W4SecurityBaseline.js';
import type { SecurityPosture } from '../../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mock window.api
// ---------------------------------------------------------------------------

const mockApi = {
  getSecurityPosture: vi.fn(),
  runAction: vi.fn(),
  setSetting: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  getSettings: vi.fn().mockResolvedValue({ ok: true, data: {} }),
};

Object.defineProperty(window, 'api', { value: mockApi, writable: true });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockPosture: SecurityPosture = {
  generated_at: Date.now(),
  defender: {
    realtime_protection: true,
    antispyware_enabled: true,
    defs_version: '1.411.123.0',
    defs_age_hours: 12,
    engine_version: '1.1.24040.1',
    last_quick_scan_hours: 4,
    last_full_scan_days: 3,
    threats_quarantined_7d: 0,
    threats_active: 0,
    tamper_protection: true,
    cloud_protection: true,
    puaprotection: 'Enabled',
    controlled_folder_access: 'Enabled',
    network_protection: 'Enabled',
    exclusions_count: 2,
    severity: 'good',
  },
  firewall: {
    domain_enabled: true,
    private_enabled: true,
    public_enabled: true,
    default_inbound_action: 'Block',
    rules_total: 300,
    rules_added_7d: 0,
    severity: 'good',
  },
  windows_update: {
    pending_count: 0,
    pending_security_count: 0,
    last_success_days: 1,
    reboot_pending: false,
    wu_service_status: 'Running',
    severity: 'good',
  },
  failed_logins: {
    total_7d: 3,
    total_24h: 0,
    lockouts_7d: 0,
    top_sources: [{ ip: '192.168.1.100', count: 3 }],
    rdp_attempts_7d: 2,
    severity: 'warn',
  },
  bitlocker: [
    { drive: 'C:', status: 'FullyEncrypted', protection_on: true, encryption_pct: 100 },
  ],
  uac: { enabled: true, level: 'Default', severity: 'good' },
  gpu_driver: null,
  persistence_new_count: 0,
  persistence_items: [],
  threat_indicators: [],
  smart: [],
  overall_severity: 'good',
};

function renderW4() {
  return render(
    <WizardProvider>
      <W4SecurityBaseline />
    </WizardProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<W4SecurityBaseline>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while fetching security posture', () => {
    mockApi.getSecurityPosture.mockReturnValue(new Promise(() => {}));
    renderW4();
    expect(screen.getByText(/Checking security configuration/)).toBeInTheDocument();
  });

  it('renders Defender status from posture data', async () => {
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: mockPosture });
    renderW4();
    await waitFor(() => {
      expect(screen.getByLabelText('Defender good')).toBeInTheDocument();
      expect(screen.getByText(/Real-time: On/)).toBeInTheDocument();
      expect(screen.getByText(/Definitions: 12 hours old/)).toBeInTheDocument();
    });
  });

  it('renders Firewall status', async () => {
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: mockPosture });
    renderW4();
    await waitFor(() => {
      expect(screen.getByText('All profiles active')).toBeInTheDocument();
    });
  });

  it('renders Firewall warning when profiles are disabled', async () => {
    const partial: SecurityPosture = {
      ...mockPosture,
      firewall: { ...mockPosture.firewall!, public_enabled: false },
    };
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: partial });
    renderW4();
    await waitFor(() => {
      expect(screen.getByText('Some profiles disabled')).toBeInTheDocument();
    });
  });

  it('renders BitLocker status', async () => {
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: mockPosture });
    renderW4();
    await waitFor(() => {
      expect(screen.getByText(/1 of 1 volume encrypted/)).toBeInTheDocument();
    });
  });

  it('renders BitLocker "Not configured" when no volumes', async () => {
    const partial: SecurityPosture = { ...mockPosture, bitlocker: [] };
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: partial });
    renderW4();
    await waitFor(() => {
      expect(screen.getByText('Not configured')).toBeInTheDocument();
    });
  });

  it('renders UAC status', async () => {
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: mockPosture });
    renderW4();
    await waitFor(() => {
      // UAC shows "Enabled" — we already have Defender "Enabled" so we check the UAC card label
      const uacLabel = screen.getByLabelText('UAC good');
      expect(uacLabel).toBeInTheDocument();
    });
  });

  it('shows "Apply" button for Defender exclusion', async () => {
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: mockPosture });
    renderW4();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply \(Recommended\)/ })).toBeInTheDocument();
    });
  });

  it('applies Defender exclusion on button click', async () => {
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: mockPosture });
    mockApi.runAction.mockResolvedValue({
      ok: true,
      data: { action: 'add_pcdoctor_exclusion', success: true, duration_ms: 500 },
    });
    renderW4();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply \(Recommended\)/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Apply \(Recommended\)/ }));

    await waitFor(() => {
      expect(mockApi.runAction).toHaveBeenCalledWith({ name: 'add_pcdoctor_exclusion' });
      expect(screen.getByText('Exclusion applied successfully.')).toBeInTheDocument();
    });
  });

  it('shows exclusion error on failure', async () => {
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: mockPosture });
    mockApi.runAction.mockResolvedValue({
      ok: true,
      data: {
        action: 'add_pcdoctor_exclusion',
        success: false,
        duration_ms: 100,
        error: { code: 'E_UAC', message: 'UAC prompt was declined' },
      },
    });
    renderW4();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply \(Recommended\)/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Apply \(Recommended\)/ }));

    await waitFor(() => {
      expect(screen.getByText('UAC prompt was declined')).toBeInTheDocument();
    });
  });

  it('shows RDP toggle', async () => {
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: mockPosture });
    renderW4();
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: /Auto-block RDP brute force/ })).toBeInTheDocument();
    });
  });

  it('defaults RDP toggle on when failed logins > 0', async () => {
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: mockPosture });
    renderW4();
    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: /Auto-block RDP brute force/ });
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('defaults RDP toggle off when no failed logins', async () => {
    const noLogins: SecurityPosture = {
      ...mockPosture,
      failed_logins: { ...mockPosture.failed_logins!, total_7d: 0 },
    };
    mockApi.getSecurityPosture.mockResolvedValue({ ok: true, data: noLogins });
    renderW4();
    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: /Auto-block RDP brute force/ });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('shows error message when API fails', async () => {
    mockApi.getSecurityPosture.mockResolvedValue({
      ok: false,
      error: { code: 'E_SCRIPT', message: 'Scanner not found' },
    });
    renderW4();
    await waitFor(() => {
      expect(screen.getByText(/Could not retrieve security posture/)).toBeInTheDocument();
      expect(screen.getByText('Scanner not found')).toBeInTheDocument();
    });
  });

  it('shows error message when API throws', async () => {
    mockApi.getSecurityPosture.mockRejectedValue(new Error('IPC timeout'));
    renderW4();
    await waitFor(() => {
      expect(screen.getByText(/Could not retrieve security posture/)).toBeInTheDocument();
      expect(screen.getByText('IPC timeout')).toBeInTheDocument();
    });
  });
});
