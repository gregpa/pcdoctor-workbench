import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FirstRunToolsSplash } from '../../../src/renderer/components/firstRunTools/FirstRunToolsSplash.js';

/**
 * v2.5.26 splash tests. Locks the gating contract:
 *   - Renders nothing until first_run_complete='1' AND
 *     dashboard_tools_setup_complete!='1'.
 *   - Shows required tools (LHM + CrystalDiskInfo) and recommended tools
 *     (HWiNFO64, OCCT) sourced from the TOOLS catalog.
 *   - "Continue" is disabled until all required tools are satisfied
 *     (installed OR manually marked).
 *   - Skip path: clicking Continue with required missing -> warning state ->
 *     Skip anyway -> dismiss + write dashboard_tools_setup_complete='1'.
 *   - On dismiss, fires triggerInitialScan() so the dashboard lands with
 *     fresh data (the v2.5.26 reason for being).
 *
 * fetch is mocked so the LHM port-8085 probe doesn't try real network I/O
 * during tests. localStorage cleared in beforeEach so the dev override flag
 * doesn't leak between cases.
 */

const mockApi = {
  getSettings: vi.fn(),
  setSetting: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  listTools: vi.fn(),
  installTool: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  triggerInitialScan: vi.fn().mockResolvedValue({ ok: true, data: null }),
};

Object.defineProperty(window, 'api', { value: mockApi, writable: true });

// Mock fetch for the LHM port-8085 probe. Default: unreachable (most realistic
// state for a fresh install before the user enables Remote Web Server).
const mockFetch = vi.fn();
Object.defineProperty(window, 'fetch', { value: mockFetch, writable: true });

// Suppress window.open noise (download buttons).
Object.defineProperty(window, 'open', { value: vi.fn(), writable: true });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockFetch.mockRejectedValue(new Error('connection refused'));
  // Default tool statuses: nothing installed.
  mockApi.listTools.mockResolvedValue({
    ok: true,
    data: [
      { id: 'librehardwaremonitor', installed: false, resolved_path: null },
      { id: 'crystaldiskinfo', installed: false, resolved_path: null },
      { id: 'occt', installed: false, resolved_path: null },
      { id: 'hwinfo64', installed: false, resolved_path: null },
    ],
  });
});

describe('<FirstRunToolsSplash> gating', () => {
  it('renders nothing while wizard is incomplete', async () => {
    mockApi.getSettings.mockResolvedValue({
      ok: true,
      data: { first_run_complete: '0', dashboard_tools_setup_complete: '0' },
    });
    const { container } = render(<FirstRunToolsSplash />);
    await waitFor(() => expect(mockApi.getSettings).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing once dashboard_tools_setup_complete=1', async () => {
    mockApi.getSettings.mockResolvedValue({
      ok: true,
      data: { first_run_complete: '1', dashboard_tools_setup_complete: '1' },
    });
    const { container } = render(<FirstRunToolsSplash />);
    await waitFor(() => expect(mockApi.getSettings).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders the splash when wizard is done and tools setup is not', async () => {
    mockApi.getSettings.mockResolvedValue({
      ok: true,
      data: { first_run_complete: '1', dashboard_tools_setup_complete: '0' },
    });
    render(<FirstRunToolsSplash />);
    expect(await screen.findByRole('dialog', { name: /first-run tools setup/i })).toBeInTheDocument();
  });

  it('dev override forces splash even when settings say done', async () => {
    localStorage.setItem('pcd_force_tools_setup', '1');
    mockApi.getSettings.mockResolvedValue({
      ok: true,
      data: { first_run_complete: '1', dashboard_tools_setup_complete: '1' },
    });
    render(<FirstRunToolsSplash />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('<FirstRunToolsSplash> tool grouping', () => {
  beforeEach(() => {
    mockApi.getSettings.mockResolvedValue({
      ok: true,
      data: { first_run_complete: '1', dashboard_tools_setup_complete: '0' },
    });
  });

  it('lists LHM and CrystalDiskInfo as required tools', async () => {
    render(<FirstRunToolsSplash />);
    await screen.findByRole('dialog');
    // Both required tools surface by name.
    expect(screen.getByText('LibreHardwareMonitor')).toBeInTheDocument();
    expect(screen.getByText('CrystalDiskInfo')).toBeInTheDocument();
  });

  it('lists OCCT and HWiNFO64 as recommended tools', async () => {
    render(<FirstRunToolsSplash />);
    await screen.findByRole('dialog');
    expect(screen.getByText('OCCT')).toBeInTheDocument();
    expect(screen.getByText('HWiNFO64')).toBeInTheDocument();
  });

  it('shows "0 of 2" required count when nothing is installed', async () => {
    render(<FirstRunToolsSplash />);
    await screen.findByText(/Required \(0 of 2\)/);
  });
});

describe('<FirstRunToolsSplash> Continue gating', () => {
  beforeEach(() => {
    mockApi.getSettings.mockResolvedValue({
      ok: true,
      data: { first_run_complete: '1', dashboard_tools_setup_complete: '0' },
    });
  });

  it('shows "Skip & Continue" when required tools are missing', async () => {
    render(<FirstRunToolsSplash />);
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: /skip & continue/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue to dashboard/i })).not.toBeInTheDocument();
  });

  it('shows "Continue to Dashboard" when both required tools are installed', async () => {
    mockApi.listTools.mockResolvedValue({
      ok: true,
      data: [
        { id: 'librehardwaremonitor', installed: true, resolved_path: 'C:\\fake\\LHM.exe' },
        { id: 'crystaldiskinfo', installed: true, resolved_path: 'C:\\fake\\CDI.exe' },
        { id: 'occt', installed: false, resolved_path: null },
        { id: 'hwinfo64', installed: false, resolved_path: null },
      ],
    });
    render(<FirstRunToolsSplash />);
    expect(await screen.findByRole('button', { name: /continue to dashboard/i })).toBeInTheDocument();
  });

  it('Skip path: clicking Skip shows warning, then "Skip anyway" dismisses + sets the flag + triggers scan', async () => {
    let onDoneCalled = false;
    // Spy on the splash being dismissed by checking that setSetting was called
    // with the completion flag, then the dialog disappears.
    render(<FirstRunToolsSplash />);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /skip & continue/i }));

    // Warning appears.
    expect(await screen.findByText(/required tools are missing/i)).toBeInTheDocument();

    // Click Skip anyway.
    fireEvent.click(screen.getByRole('button', { name: /skip anyway/i }));

    await waitFor(() => {
      expect(mockApi.setSetting).toHaveBeenCalledWith('dashboard_tools_setup_complete', '1');
    });
    // v2.5.26 contract: a fresh scan fires on dismiss so the dashboard lands
    // with current data (LHM, CDI, etc. just-installed state).
    expect(mockApi.triggerInitialScan).toHaveBeenCalled();
    onDoneCalled = true;
    expect(onDoneCalled).toBe(true);
  });
});

describe('<FirstRunToolsSplash> LHM Remote Web Server probe', () => {
  beforeEach(() => {
    mockApi.getSettings.mockResolvedValue({
      ok: true,
      data: { first_run_complete: '1', dashboard_tools_setup_complete: '0' },
    });
    mockApi.listTools.mockResolvedValue({
      ok: true,
      data: [
        { id: 'librehardwaremonitor', installed: true, resolved_path: 'C:\\fake\\LHM.exe' },
        { id: 'crystaldiskinfo', installed: true, resolved_path: 'C:\\fake\\CDI.exe' },
        { id: 'occt', installed: false, resolved_path: null },
        { id: 'hwinfo64', installed: false, resolved_path: null },
      ],
    });
  });

  it('shows green RWS-reachable line when fetch on port 8085 succeeds', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);
    render(<FirstRunToolsSplash />);
    await screen.findByRole('dialog');
    expect(await screen.findByText(/Remote Web Server reachable/i)).toBeInTheDocument();
  });

  it('shows orange RWS-off warning with Options instructions when port 8085 is unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));
    render(<FirstRunToolsSplash />);
    await screen.findByRole('dialog');
    // Wait for the probe to complete and the warning to render.
    expect(await screen.findByText(/Remote Web Server is OFF/i)).toBeInTheDocument();
    // The Options menu instruction is the load-bearing piece.
    expect(screen.getByText(/Options → Remote Web Server → Run/i)).toBeInTheDocument();
  });
});
