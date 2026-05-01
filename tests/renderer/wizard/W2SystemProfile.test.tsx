import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { WizardProvider } from '../../../src/renderer/components/wizard/WizardContext.js';
import { W2SystemProfile } from '../../../src/renderer/components/wizard/steps/W2SystemProfile.js';
import type { SystemProfile } from '../../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mock window.api
// ---------------------------------------------------------------------------

const mockApi = {
  getSystemProfile: vi.fn(),
  setSetting: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  getSettings: vi.fn().mockResolvedValue({ ok: true, data: {} }),
};

Object.defineProperty(window, 'api', { value: mockApi, writable: true });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockProfile: SystemProfile = {
  success: true,
  duration_ms: 1500,
  cpu: { name: 'Intel Core i7-12700K', cores: 12, logical_processors: 20, max_clock_mhz: 3600 },
  ram: { total_bytes: 34359738368, total_gb: 32, dimm_count: 2, speed_mhz: 3200 },
  gpu: { name: 'NVIDIA GeForce RTX 3080', vram_bytes: 4293918720 },
  os: { caption: 'Microsoft Windows 11 Pro', version: '10.0.22621', build: '22621', arch: '64-bit' },
  machine: { manufacturer: 'Dell Inc.', model: 'XPS 8950' },
  drives: [{ letter: 'C:', type: 3, size_bytes: 500107862016, free_bytes: 200000000000, filesystem: 'NTFS', label: 'Windows' }],
  wsl: { installed: true, wslconfig_exists: false, memory_limit_gb: null },
  claude_cli: { installed: true, path: 'C:\\Users\\test\\AppData\\Local\\Programs\\claude.exe' },
  obsidian: { installed: false, path: null },
};

function renderW2() {
  return render(
    <WizardProvider>
      <W2SystemProfile />
    </WizardProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<W2SystemProfile>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Detecting your hardware" while loading', () => {
    // Never resolve — keeps the component in loading state.
    mockApi.getSystemProfile.mockReturnValue(new Promise(() => {}));
    renderW2();
    expect(screen.getByText(/Detecting your hardware/)).toBeInTheDocument();
  });

  it('renders CPU name from profile data', async () => {
    mockApi.getSystemProfile.mockResolvedValue({ ok: true, data: mockProfile });
    renderW2();
    await waitFor(() => {
      expect(screen.getByText('Intel Core i7-12700K')).toBeInTheDocument();
    });
  });

  it('renders CPU core/thread detail', async () => {
    mockApi.getSystemProfile.mockResolvedValue({ ok: true, data: mockProfile });
    renderW2();
    await waitFor(() => {
      expect(screen.getByText('12 cores / 20 threads')).toBeInTheDocument();
    });
  });

  it('renders RAM total from profile data', async () => {
    mockApi.getSystemProfile.mockResolvedValue({ ok: true, data: mockProfile });
    renderW2();
    await waitFor(() => {
      expect(screen.getByText('32 GB')).toBeInTheDocument();
    });
  });

  it('renders GPU name and VRAM', async () => {
    mockApi.getSystemProfile.mockResolvedValue({ ok: true, data: mockProfile });
    renderW2();
    await waitFor(() => {
      expect(screen.getByText('NVIDIA GeForce RTX 3080')).toBeInTheDocument();
      expect(screen.getByText(/VRAM: 4096.0 MB|VRAM: 4\.0 GB/)).toBeInTheDocument();
    });
  });

  it('renders machine manufacturer and model', async () => {
    mockApi.getSystemProfile.mockResolvedValue({ ok: true, data: mockProfile });
    renderW2();
    await waitFor(() => {
      expect(screen.getByText('Dell Inc. XPS 8950')).toBeInTheDocument();
    });
  });

  it('renders OS caption', async () => {
    mockApi.getSystemProfile.mockResolvedValue({ ok: true, data: mockProfile });
    renderW2();
    await waitFor(() => {
      expect(screen.getByText('Microsoft Windows 11 Pro')).toBeInTheDocument();
    });
  });

  it('renders drive count', async () => {
    mockApi.getSystemProfile.mockResolvedValue({ ok: true, data: mockProfile });
    renderW2();
    await waitFor(() => {
      expect(screen.getByText('1 drive detected')).toBeInTheDocument();
    });
  });

  it('shows "Not detected" when a section is null', async () => {
    const partial: SystemProfile = {
      ...mockProfile,
      cpu: null,
      gpu: null,
    };
    mockApi.getSystemProfile.mockResolvedValue({ ok: true, data: partial });
    renderW2();
    await waitFor(() => {
      const badges = screen.getAllByText('Not detected');
      // CPU and GPU should both show "Not detected"
      expect(badges.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('renders threshold inputs with default values', async () => {
    mockApi.getSystemProfile.mockResolvedValue({ ok: true, data: mockProfile });
    renderW2();
    await waitFor(() => {
      expect(screen.getByText('Alert Thresholds')).toBeInTheDocument();
    });
    // Check that the 6 threshold inputs have the right defaults
    const cpuWarn = screen.getByLabelText('CPU Temp warning threshold') as HTMLInputElement;
    const cpuCrit = screen.getByLabelText('CPU Temp critical threshold') as HTMLInputElement;
    const gpuWarn = screen.getByLabelText('GPU Temp warning threshold') as HTMLInputElement;
    const gpuCrit = screen.getByLabelText('GPU Temp critical threshold') as HTMLInputElement;
    const ramWarn = screen.getByLabelText('RAM Usage warning threshold') as HTMLInputElement;
    const ramCrit = screen.getByLabelText('RAM Usage critical threshold') as HTMLInputElement;

    expect(cpuWarn.value).toBe('80');
    expect(cpuCrit.value).toBe('90');
    expect(gpuWarn.value).toBe('80');
    expect(gpuCrit.value).toBe('85');
    expect(ramWarn.value).toBe('85');
    expect(ramCrit.value).toBe('95');
  });

  it('shows error message when API fails', async () => {
    mockApi.getSystemProfile.mockResolvedValue({
      ok: false,
      error: { code: 'E_SCRIPT', message: 'PowerShell not found' },
    });
    renderW2();
    await waitFor(() => {
      expect(screen.getByText(/Could not detect hardware/)).toBeInTheDocument();
      expect(screen.getByText('PowerShell not found')).toBeInTheDocument();
    });
  });

  it('shows error message when API throws', async () => {
    mockApi.getSystemProfile.mockRejectedValue(new Error('IPC timeout'));
    renderW2();
    await waitFor(() => {
      expect(screen.getByText(/Could not detect hardware/)).toBeInTheDocument();
      expect(screen.getByText('IPC timeout')).toBeInTheDocument();
    });
  });
});
