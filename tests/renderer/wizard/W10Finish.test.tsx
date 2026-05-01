import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useEffect } from 'react';
import { WizardProvider, useWizard } from '../../../src/renderer/components/wizard/WizardContext.js';
import { W10Finish } from '../../../src/renderer/components/wizard/steps/W10Finish.js';
import type { SystemProfile } from '../../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mock window.api
// ---------------------------------------------------------------------------

const mockApi = {
  setSetting: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  getSettings: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  triggerInitialScan: vi.fn().mockResolvedValue({ ok: true, data: null }),
};

Object.defineProperty(window, 'api', { value: mockApi, writable: true });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fullProfile: SystemProfile = {
  success: true,
  duration_ms: 1500,
  cpu: { name: 'AMD Ryzen 9 5900X', cores: 12, logical_processors: 24, max_clock_mhz: 3700 },
  ram: { total_bytes: 34359738368, total_gb: 32, dimm_count: 2, speed_mhz: 3200 },
  gpu: { name: 'NVIDIA RTX 3080', vram_bytes: 10737418240 },
  os: { caption: 'Windows 11', version: '10.0.22621', build: '22621', arch: '64-bit' },
  machine: { manufacturer: 'Test', model: 'PC' },
  drives: [],
  wsl: { installed: true, wslconfig_exists: true, memory_limit_gb: 8 },
  claude_cli: { installed: true, path: 'C:\\test\\claude.exe' },
  obsidian: { installed: true, path: 'C:\\test\\Obsidian.exe' },
};

// ---------------------------------------------------------------------------
// Helper: inject wizard state via dispatch
// ---------------------------------------------------------------------------

function StateInjector({
  profile,
  nasServer,
  nasMappings,
  defenderExclusionApplied,
  telegramEnabled,
  selectedTools,
  autopilotEnabled,
  claudeDetected,
  obsidianEnabled,
  tasksRegistered,
}: {
  profile?: SystemProfile;
  nasServer?: string;
  nasMappings?: Array<{ drive: string; share: string }>;
  defenderExclusionApplied?: boolean;
  telegramEnabled?: boolean;
  selectedTools?: string[];
  autopilotEnabled?: boolean;
  claudeDetected?: boolean;
  obsidianEnabled?: boolean;
  tasksRegistered?: boolean;
}) {
  const { dispatch } = useWizard();
  useEffect(() => {
    if (profile) dispatch({ type: 'SET_SYSTEM_PROFILE', payload: profile });
    if (nasServer !== undefined) dispatch({ type: 'SET_FIELD', field: 'nasServer', value: nasServer });
    if (nasMappings !== undefined) dispatch({ type: 'SET_FIELD', field: 'nasMappings', value: nasMappings });
    if (defenderExclusionApplied !== undefined) dispatch({ type: 'SET_FIELD', field: 'defenderExclusionApplied', value: defenderExclusionApplied });
    if (telegramEnabled !== undefined) dispatch({ type: 'SET_FIELD', field: 'telegramEnabled', value: telegramEnabled });
    if (selectedTools !== undefined) dispatch({ type: 'SET_FIELD', field: 'selectedTools', value: selectedTools });
    if (autopilotEnabled !== undefined) dispatch({ type: 'SET_FIELD', field: 'autopilotEnabled', value: autopilotEnabled });
    if (claudeDetected !== undefined) dispatch({ type: 'SET_FIELD', field: 'claudeDetected', value: claudeDetected });
    if (obsidianEnabled !== undefined) dispatch({ type: 'SET_FIELD', field: 'obsidianEnabled', value: obsidianEnabled });
    if (tasksRegistered !== undefined) dispatch({ type: 'SET_FIELD', field: 'tasksRegistered', value: tasksRegistered });
  }, [dispatch, profile, nasServer, nasMappings, defenderExclusionApplied, telegramEnabled, selectedTools, autopilotEnabled, claudeDetected, obsidianEnabled, tasksRegistered]);
  return null;
}

/** Render W10 with injected state, wrapped in act(). */
function renderW10(overrides: Parameters<typeof StateInjector>[0] = {}) {
  let result: ReturnType<typeof render>;
  act(() => {
    result = render(
      <WizardProvider>
        <StateInjector {...overrides} />
        <W10Finish />
      </WizardProvider>,
    );
  });
  return result!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<W10Finish>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "Setup Complete" title', () => {
    renderW10();
    expect(screen.getByText(/Setup Complete/)).toBeInTheDocument();
    expect(screen.getByText(/Here's a summary of your configuration/)).toBeInTheDocument();
  });

  it('shows system summary from wizard state', () => {
    renderW10({ profile: fullProfile });
    expect(screen.getByText(/AMD Ryzen 9 5900X/)).toBeInTheDocument();
    expect(screen.getByText(/32 GB/)).toBeInTheDocument();
    expect(screen.getByText(/NVIDIA RTX 3080/)).toBeInTheDocument();
  });

  it('shows NAS summary as disabled when no NAS configured', () => {
    renderW10({ profile: fullProfile });
    // nasServer defaults to '' — should show "Disabled"
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('shows NAS summary with drive count when configured', () => {
    renderW10({
      profile: fullProfile,
      nasServer: '192.168.1.100',
      nasMappings: [
        { drive: 'M:', share: 'movies' },
        { drive: 'Z:', share: 'tv' },
      ],
    });
    expect(screen.getByText(/2 drives mapped to 192\.168\.1\.100/)).toBeInTheDocument();
  });

  it('"Run Scan" button is present and clickable', () => {
    renderW10({ profile: fullProfile });
    const btn = screen.getByRole('button', { name: /Run Scan/ });
    expect(btn).toBeInTheDocument();
  });

  it('clicking "Run Scan" shows confirmation and calls triggerInitialScan', () => {
    renderW10({ profile: fullProfile });
    const btn = screen.getByRole('button', { name: /Run Scan/ });
    fireEvent.click(btn);

    expect(mockApi.triggerInitialScan).toHaveBeenCalledOnce();
    expect(screen.getByText(/Scan started/)).toBeInTheDocument();
    // Button should be gone after scan triggers
    expect(screen.queryByRole('button', { name: /Run Scan/ })).not.toBeInTheDocument();
  });

  it('writes wizard_completed_at and wizard_version on mount', () => {
    renderW10();
    expect(mockApi.setSetting).toHaveBeenCalledWith('wizard_completed_at', expect.any(String));
    expect(mockApi.setSetting).toHaveBeenCalledWith('wizard_version', '2');
  });

  it('shows configured integration summary', () => {
    renderW10({
      profile: fullProfile,
      claudeDetected: true,
      obsidianEnabled: true,
    });
    expect(screen.getByText(/Claude, Obsidian/)).toBeInTheDocument();
  });

  it('shows tasks as registered when tasksRegistered is true', () => {
    renderW10({ tasksRegistered: true });
    expect(screen.getByText('Registered')).toBeInTheDocument();
  });

  it('shows Finish instruction note', () => {
    renderW10();
    expect(screen.getByText(/Click/)).toBeInTheDocument();
    expect(screen.getByText(/Finish/)).toBeInTheDocument();
  });
});
