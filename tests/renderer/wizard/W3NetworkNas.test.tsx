import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WizardProvider } from '../../../src/renderer/components/wizard/WizardContext.js';
import { W3NetworkNas } from '../../../src/renderer/components/wizard/steps/W3NetworkNas.js';

// ---------------------------------------------------------------------------
// Mock window.api
// ---------------------------------------------------------------------------

const mockApi = {
  getNasDrives: vi.fn(),
  setNasConfig: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  setSetting: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  getSettings: vi.fn().mockResolvedValue({ ok: true, data: {} }),
};

Object.defineProperty(window, 'api', { value: mockApi, writable: true });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const networkDrives = [
  {
    letter: 'M:',
    unc: '\\\\192.168.50.226\\Plex Movies',
    volume_name: 'Plex Movies',
    kind: 'network' as const,
    used_bytes: 2000000000000,
    free_bytes: 500000000000,
    total_bytes: 2500000000000,
    recycle_bytes: 1024000,
    reachable: true,
  },
  {
    letter: 'Z:',
    unc: '\\\\192.168.50.226\\Plex TV',
    volume_name: 'Plex TV',
    kind: 'network' as const,
    used_bytes: 3000000000000,
    free_bytes: 200000000000,
    total_bytes: 3200000000000,
    recycle_bytes: null,
    reachable: true,
  },
];

const localDrivesOnly = [
  {
    letter: 'C:',
    unc: null,
    volume_name: 'Windows',
    kind: 'local' as const,
    used_bytes: 300000000000,
    free_bytes: 200000000000,
    total_bytes: 500000000000,
    recycle_bytes: null,
    reachable: true,
  },
];

function renderW3() {
  return render(
    <WizardProvider>
      <W3NetworkNas />
    </WizardProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<W3NetworkNas>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while fetching drives', () => {
    // Never resolve -- keeps the component in loading state.
    mockApi.getNasDrives.mockReturnValue(new Promise(() => {}));
    renderW3();
    expect(screen.getByText(/Detecting network drives/)).toBeInTheDocument();
  });

  it('defaults toggle to Yes and populates server when network drives found', async () => {
    mockApi.getNasDrives.mockResolvedValue({ ok: true, data: networkDrives });
    renderW3();
    await waitFor(() => {
      expect(screen.getByText('Network & NAS')).toBeInTheDocument();
    });
    // Server IP should be auto-filled from UNC
    const serverInput = screen.getByLabelText('NAS server address') as HTMLInputElement;
    expect(serverInput.value).toBe('192.168.50.226');
    // NAS config section should be visible (Yes is active)
    expect(screen.getByText('NAS Brand')).toBeInTheDocument();
  });

  it('shows detected drives in the mappings table', async () => {
    mockApi.getNasDrives.mockResolvedValue({ ok: true, data: networkDrives });
    renderW3();
    await waitFor(() => {
      expect(screen.getByText('Drive Mappings')).toBeInTheDocument();
    });
    // Both network drives should appear with "Detected" badges
    const detectedBadges = screen.getAllByText('Detected');
    expect(detectedBadges).toHaveLength(2);
    // Check drive letters are populated
    const driveInputs = screen.getAllByLabelText(/Drive letter row/);
    expect((driveInputs[0] as HTMLInputElement).value).toBe('M:');
    expect((driveInputs[1] as HTMLInputElement).value).toBe('Z:');
    // Summary line
    expect(screen.getByText('2 drives configured')).toBeInTheDocument();
  });

  it('defaults toggle to No when no network drives found', async () => {
    mockApi.getNasDrives.mockResolvedValue({ ok: true, data: localDrivesOnly });
    renderW3();
    await waitFor(() => {
      expect(screen.getByText('Network & NAS')).toBeInTheDocument();
    });
    // Should show the "hidden" message
    expect(
      screen.getByText(/NAS features.*will be hidden/),
    ).toBeInTheDocument();
    // NAS config section should NOT be visible
    expect(screen.queryByText('NAS Brand')).not.toBeInTheDocument();
  });

  it('toggling No shows hidden-features message', async () => {
    mockApi.getNasDrives.mockResolvedValue({ ok: true, data: networkDrives });
    renderW3();
    await waitFor(() => {
      expect(screen.getByText('NAS Brand')).toBeInTheDocument();
    });
    // Click "No" toggle
    fireEvent.click(screen.getByText('No'));
    expect(
      screen.getByText(/NAS features.*will be hidden/),
    ).toBeInTheDocument();
    expect(screen.queryByText('NAS Brand')).not.toBeInTheDocument();
  });

  it('adding a manual mapping creates an empty row', async () => {
    mockApi.getNasDrives.mockResolvedValue({ ok: true, data: networkDrives });
    renderW3();
    await waitFor(() => {
      expect(screen.getByText('2 drives configured')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('+ Add Mapping'));
    expect(screen.getByText('3 drives configured')).toBeInTheDocument();
    // New row should show "Manual"
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('removing a mapping updates the count', async () => {
    mockApi.getNasDrives.mockResolvedValue({ ok: true, data: networkDrives });
    renderW3();
    await waitFor(() => {
      expect(screen.getByText('2 drives configured')).toBeInTheDocument();
    });
    // Remove first mapping
    const removeButtons = screen.getAllByLabelText(/Remove mapping row/);
    fireEvent.click(removeButtons[0]);
    expect(screen.getByText('1 drive configured')).toBeInTheDocument();
  });

  it('shows error banner when detection fails', async () => {
    mockApi.getNasDrives.mockResolvedValue({
      ok: false,
      error: { code: 'E_SCRIPT', message: 'WMI query failed' },
    });
    renderW3();
    await waitFor(() => {
      expect(
        screen.getByText(/Could not auto-detect network drives/),
      ).toBeInTheDocument();
      expect(screen.getByText('WMI query failed')).toBeInTheDocument();
    });
  });

  it('shows error banner when API throws', async () => {
    mockApi.getNasDrives.mockRejectedValue(new Error('IPC timeout'));
    renderW3();
    await waitFor(() => {
      expect(
        screen.getByText(/Could not auto-detect network drives/),
      ).toBeInTheDocument();
      expect(screen.getByText('IPC timeout')).toBeInTheDocument();
    });
  });
});
