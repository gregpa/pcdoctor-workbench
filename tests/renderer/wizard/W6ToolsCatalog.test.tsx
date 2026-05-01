import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WizardProvider } from '../../../src/renderer/components/wizard/WizardContext.js';
import { W6ToolsCatalog } from '../../../src/renderer/components/wizard/steps/W6ToolsCatalog.js';
import type { ToolStatus } from '../../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mock window.api
// ---------------------------------------------------------------------------

const mockApi = {
  listTools: vi.fn(),
  setSetting: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  getSettings: vi.fn().mockResolvedValue({ ok: true, data: {} }),
};

Object.defineProperty(window, 'api', { value: mockApi, writable: true });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const toolStatuses: ToolStatus[] = [
  { id: 'occt', installed: true, resolved_path: 'C:\\Program Files\\OCCT\\OCCT.exe' },
  { id: 'hwinfo64', installed: false, resolved_path: null },
  { id: 'awcc', installed: false, resolved_path: null },
  { id: 'dcu', installed: true, resolved_path: 'C:\\Program Files (x86)\\Dell\\CommandUpdate\\DellCommandUpdate.exe' },
  { id: 'gpu-z', installed: false, resolved_path: null },
  { id: 'cpu-z', installed: false, resolved_path: null },
  { id: 'librehardwaremonitor', installed: false, resolved_path: null },
  { id: 'treesize', installed: false, resolved_path: null },
  { id: 'crystaldiskinfo', installed: true, resolved_path: 'C:\\Program Files\\CrystalDiskInfo\\DiskInfo64.exe' },
  { id: 'crystaldiskmark', installed: false, resolved_path: null },
  { id: 'mbam', installed: false, resolved_path: null },
  { id: 'adwcleaner', installed: false, resolved_path: null },
  { id: 'mss', installed: false, resolved_path: null },
  { id: 'autoruns', installed: false, resolved_path: null },
  { id: 'procexp', installed: false, resolved_path: null },
  { id: 'procmon', installed: false, resolved_path: null },
  { id: 'tcpview', installed: false, resolved_path: null },
  { id: 'rufus', installed: false, resolved_path: null },
  { id: 'bluescreenview', installed: false, resolved_path: null },
  { id: 'msinfo32', installed: true, resolved_path: 'C:\\Windows\\System32\\msinfo32.exe' },
  { id: 'perfmon', installed: true, resolved_path: 'C:\\Windows\\System32\\perfmon.exe' },
  { id: 'eventvwr', installed: true, resolved_path: 'C:\\Windows\\System32\\eventvwr.msc' },
  { id: 'resmon', installed: true, resolved_path: 'C:\\Windows\\System32\\resmon.exe' },
];

function renderW6() {
  return render(
    <WizardProvider>
      <W6ToolsCatalog />
    </WizardProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<W6ToolsCatalog>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while fetching tool statuses', () => {
    mockApi.listTools.mockReturnValue(new Promise(() => {})); // never resolves
    renderW6();
    expect(screen.getByText(/Checking installed tools/)).toBeInTheDocument();
  });

  it('renders tool names from TOOLS constant', async () => {
    mockApi.listTools.mockResolvedValue({ ok: true, data: toolStatuses });
    renderW6();
    await waitFor(() => {
      expect(screen.getByText('OCCT')).toBeInTheDocument();
      expect(screen.getByText('HWiNFO64')).toBeInTheDocument();
      expect(screen.getByText('CrystalDiskInfo')).toBeInTheDocument();
      expect(screen.getByText('Malwarebytes Free')).toBeInTheDocument();
      expect(screen.getByText('Autoruns')).toBeInTheDocument();
    });
  });

  it('shows "Installed" badge for tools that are installed', async () => {
    mockApi.listTools.mockResolvedValue({ ok: true, data: toolStatuses });
    renderW6();
    await waitFor(() => {
      // Count "Installed" badges — should match installed tools count (7: occt, dcu, crystaldiskinfo, msinfo32, perfmon, eventvwr, resmon)
      const installed = screen.getAllByText('Installed');
      expect(installed.length).toBe(7);
    });
  });

  it('shows "Not Installed" badge for tools that are not installed', async () => {
    mockApi.listTools.mockResolvedValue({ ok: true, data: toolStatuses });
    renderW6();
    await waitFor(() => {
      const notInstalled = screen.getAllByText('Not Installed');
      // 23 total tools minus 7 installed = 16 not installed
      expect(notInstalled.length).toBe(16);
    });
  });

  it('checkbox toggles update the selected count', async () => {
    mockApi.listTools.mockResolvedValue({ ok: true, data: toolStatuses });
    renderW6();

    await waitFor(() => {
      expect(screen.getByText('Diagnostic Tools')).toBeInTheDocument();
    });

    // Initially, installed tools are pre-checked.
    // OCCT is installed — should be pre-checked.
    const occtCheckbox = screen.getByLabelText(/OCCT/);
    expect(occtCheckbox).toBeChecked();

    // HWiNFO64 is not installed — should NOT be pre-checked.
    const hwinfoCheckbox = screen.getByLabelText(/HWiNFO64/);
    expect(hwinfoCheckbox).not.toBeChecked();

    // No not-installed tools are selected, so count shows "No new tools selected"
    expect(screen.getByText(/No new tools selected/)).toBeInTheDocument();

    // Check HWiNFO64 (not installed) — should increase "for installation" count
    fireEvent.click(hwinfoCheckbox);

    await waitFor(() => {
      const countText = screen.getByText(/1 tool selected for installation/);
      expect(countText).toBeInTheDocument();
    });

    // Uncheck OCCT (installed) — unchecking an installed tool doesn't change installation count
    fireEvent.click(occtCheckbox);

    await waitFor(() => {
      expect(occtCheckbox).not.toBeChecked();
    });
  });

  it('shows category headers', async () => {
    mockApi.listTools.mockResolvedValue({ ok: true, data: toolStatuses });
    renderW6();
    await waitFor(() => {
      expect(screen.getByText('Hardware')).toBeInTheDocument();
      expect(screen.getByText('Security')).toBeInTheDocument();
      expect(screen.getByText('Forensics')).toBeInTheDocument();
      expect(screen.getByText('Disk')).toBeInTheDocument();
      expect(screen.getByText('Diagnostic')).toBeInTheDocument();
      expect(screen.getByText('Windows Native')).toBeInTheDocument();
    });
  });

  it('shows error state when API fails', async () => {
    mockApi.listTools.mockResolvedValue({
      ok: false,
      error: { code: 'E_SCRIPT', message: 'Tool detection failed' },
    });
    renderW6();
    await waitFor(() => {
      expect(screen.getByText(/Could not check installed tools/)).toBeInTheDocument();
      expect(screen.getByText('Tool detection failed')).toBeInTheDocument();
    });
  });

  it('shows error state when API throws', async () => {
    mockApi.listTools.mockRejectedValue(new Error('IPC timeout'));
    renderW6();
    await waitFor(() => {
      expect(screen.getByText(/Could not check installed tools/)).toBeInTheDocument();
      expect(screen.getByText('IPC timeout')).toBeInTheDocument();
    });
  });
});
