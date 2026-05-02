import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useEffect } from 'react';
import { WizardProvider, useWizard } from '../../../src/renderer/components/wizard/WizardContext.js';
import { W8Integrations } from '../../../src/renderer/components/wizard/steps/W8Integrations.js';
import type { SystemProfile } from '../../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Mock window.api
// ---------------------------------------------------------------------------

const mockApi = {
  setSetting: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  getSettings: vi.fn().mockResolvedValue({ ok: true, data: {} }),
};

Object.defineProperty(window, 'api', { value: mockApi, writable: true });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fullProfile: SystemProfile = {
  success: true,
  duration_ms: 1500,
  cpu: { name: 'Test CPU', cores: 8, logical_processors: 16, max_clock_mhz: 3600 },
  ram: { total_bytes: 34359738368, total_gb: 32, dimm_count: 2, speed_mhz: 3200 },
  gpu: { name: 'Test GPU', vram_bytes: 4293918720 },
  os: { caption: 'Windows 11', version: '10.0.22621', build: '22621', arch: '64-bit' },
  machine: { manufacturer: 'Test', model: 'PC' },
  drives: [],
  wsl: { installed: true, wslconfig_exists: true, memory_limit_gb: 8 },
  claude_cli: { installed: true, path: 'C:\\test\\claude.exe' },
  obsidian: { installed: true, path: 'C:\\test\\Obsidian.exe' },
};

const noClaudeProfile: SystemProfile = {
  ...fullProfile,
  claude_cli: { installed: false, path: null },
};

const noWslProfile: SystemProfile = {
  ...fullProfile,
  wsl: { installed: false, wslconfig_exists: false, memory_limit_gb: null },
};

// ---------------------------------------------------------------------------
// Helper: inject system profile into wizard context via useEffect
// ---------------------------------------------------------------------------

function ProfileInjector({ profile }: { profile: SystemProfile }) {
  const { dispatch } = useWizard();
  useEffect(() => {
    dispatch({ type: 'SET_SYSTEM_PROFILE', payload: profile });
  }, [dispatch, profile]);
  return null;
}

/** Render W8 with optional profile injection, wrapped in act(). */
function renderW8(profile?: SystemProfile) {
  let result: ReturnType<typeof render>;
  act(() => {
    result = render(
      <WizardProvider>
        {profile && <ProfileInjector profile={profile} />}
        <W8Integrations />
      </WizardProvider>,
    );
  });
  return result!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<W8Integrations>', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders integration title', () => {
    renderW8(fullProfile);
    expect(screen.getByText(/Integrations/)).toBeInTheDocument();
    expect(screen.getByText(/Optional connections with external tools/)).toBeInTheDocument();
  });

  it('shows Claude Code detected status with path', () => {
    renderW8(fullProfile);
    expect(screen.getByText(/Claude Code detected/)).toBeInTheDocument();
    expect(screen.getByText('C:\\test\\claude.exe')).toBeInTheDocument();
  });

  it('shows Claude Code not-detected when claude_cli.installed is false', () => {
    renderW8(noClaudeProfile);
    expect(screen.getByText(/Claude Code not detected/)).toBeInTheDocument();
    expect(screen.getByText(/anthropic.com\/claude-code/)).toBeInTheDocument();
  });

  // v2.5.23: section was renamed from "Obsidian Archive" to "Weekly Report
  // Archive" so non-Obsidian users aren't confused. Tests still cover the
  // same toggle + reveal flow, just match the generic aria-label.
  it('Weekly archive toggle is present and defaults to disabled', () => {
    renderW8(fullProfile);
    const toggle = screen.getByRole('switch', { name: /Save weekly reports to a folder/ });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('enabling weekly archive toggle reveals directory input', () => {
    renderW8(fullProfile);
    expect(screen.queryByLabelText('Archive Directory')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Save weekly reports to a folder/ }));
    expect(screen.getByLabelText('Archive Directory')).toBeInTheDocument();
  });

  it('WSL section shown when WSL installed', () => {
    renderW8(fullProfile);
    expect(screen.getByText(/WSL Memory Cap/)).toBeInTheDocument();
    expect(screen.getByText(/Your system has 32 GB RAM/)).toBeInTheDocument();
    expect(screen.getByText(/WSL defaults to using 16 GB/)).toBeInTheDocument();
  });

  it('WSL section hidden when WSL not installed', () => {
    renderW8(noWslProfile);
    expect(screen.queryByText(/WSL Memory Cap/)).not.toBeInTheDocument();
  });

  it('fallback shown when systemProfile is null', () => {
    renderW8(); // no profile injected
    expect(screen.getByText(/System profile not available/)).toBeInTheDocument();
    expect(screen.getByText(/You can configure these in Settings later/)).toBeInTheDocument();
  });

  it('enabling WSL toggle reveals memory limit input', () => {
    renderW8(fullProfile);
    expect(screen.queryByLabelText('Memory Limit (GB)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Limit WSL memory usage/ }));
    expect(screen.getByLabelText('Memory Limit (GB)')).toBeInTheDocument();
  });
});
