/**
 * StartupPickerModal — v2.4.13 additions
 * (threshold input + "Never warn" allowlist toggle + save button)
 *
 * The pre-existing C1 tests cover: filtering, preselection, onDisable submit.
 * These tests cover only the new v2.4.13 surface area so the two files stay
 * independent and easy to bisect.
 *
 * window.api is stubbed via vi.stubGlobal so each test starts clean.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StartupPickerModal } from '../../src/renderer/components/dashboard/StartupPickerModal.js';
import type { StartupItemMetric } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------
const ITEMS: StartupItemMetric[] = [
  { name: 'Steam',   kind: 'Run',      location: '', is_essential: false, disabled_in_registry: false },
  { name: 'Discord', kind: 'Run',      location: '', is_essential: false, disabled_in_registry: false },
  { name: 'Antivirus', kind: 'HKLM_Run', location: '', is_essential: true, disabled_in_registry: false },
];

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    getStartupConfig: vi.fn().mockResolvedValue({
      ok: true,
      data: { threshold: 20, allowlist: [] },
    }),
    setStartupConfig: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('<StartupPickerModal> v2.4.13 — threshold + allowlist', () => {
  beforeEach(() => {
    // Remove any leftover window.api stub from previous test.
    vi.stubGlobal('api', undefined);
  });

  it('renders the threshold input pre-seeded from the threshold prop', () => {
    vi.stubGlobal('api', makeApi({ getStartupConfig: vi.fn().mockReturnValue(new Promise(() => {})) }));
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} threshold={42} />);
    const input = screen.getByLabelText('Healthy startup threshold') as HTMLInputElement;
    expect(input.value).toBe('42');
  });

  it('updates threshold input value from getStartupConfig response', async () => {
    vi.stubGlobal('api', makeApi());
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} threshold={10} />);
    // After the promise resolves, input should update to 20 (from the mock).
    await waitFor(() => {
      const input = screen.getByLabelText('Healthy startup threshold') as HTMLInputElement;
      expect(input.value).toBe('20');
    });
  });

  it('clicking a Never-warn star toggles the allowlist state (off -> on)', () => {
    vi.stubGlobal('api', makeApi({ getStartupConfig: vi.fn().mockReturnValue(new Promise(() => {})) }));
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} />);
    const addBtn = screen.getByLabelText('Add Steam to allowlist');
    fireEvent.click(addBtn);
    // After toggle, aria-label should flip to "Remove"
    expect(screen.getByLabelText('Remove Steam from allowlist')).toBeTruthy();
  });

  it('clicking a Never-warn star twice reverts to off state', () => {
    vi.stubGlobal('api', makeApi({ getStartupConfig: vi.fn().mockReturnValue(new Promise(() => {})) }));
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} />);
    const btn = screen.getByLabelText('Add Steam to allowlist');
    fireEvent.click(btn);
    fireEvent.click(screen.getByLabelText('Remove Steam from allowlist'));
    expect(screen.getByLabelText('Add Steam to allowlist')).toBeTruthy();
  });

  it('Save settings calls window.api.setStartupConfig with threshold and allowlist array of kind::name keys', async () => {
    const setStartupConfig = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('api', makeApi({ setStartupConfig }));

    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} />);

    // Wait for getStartupConfig to settle
    await waitFor(() => {
      const input = screen.getByLabelText('Healthy startup threshold') as HTMLInputElement;
      expect(input.value).toBe('20');
    });

    // Change threshold
    const input = screen.getByLabelText('Healthy startup threshold');
    fireEvent.change(input, { target: { value: '30' } });

    // Toggle Steam onto the allowlist
    fireEvent.click(screen.getByLabelText('Add Steam to allowlist'));

    await act(async () => {
      fireEvent.click(screen.getByText('Save settings'));
    });

    expect(setStartupConfig).toHaveBeenCalledWith({
      threshold: 30,
      allowlist: ['Run::Steam'],
    });
  });

  it('shows error text when threshold is invalid on save (below MIN)', async () => {
    vi.stubGlobal('api', makeApi());
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} />);
    await waitFor(() => {
      const input = screen.getByLabelText('Healthy startup threshold') as HTMLInputElement;
      expect(input.value).toBe('20');
    });

    const input = screen.getByLabelText('Healthy startup threshold');
    fireEvent.change(input, { target: { value: '1' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Save settings'));
    });

    expect(screen.getByText(/Threshold must be 5-200/)).toBeTruthy();
  });

  it('shows error text when threshold is 1000 (above MAX)', async () => {
    vi.stubGlobal('api', makeApi());
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} />);
    await waitFor(() => {
      const input = screen.getByLabelText('Healthy startup threshold') as HTMLInputElement;
      expect(input.value).toBe('20');
    });

    const input = screen.getByLabelText('Healthy startup threshold');
    fireEvent.change(input, { target: { value: '1000' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Save settings'));
    });

    expect(screen.getByText(/Threshold must be 5-200/)).toBeTruthy();
  });

  it('shows "Settings API unavailable" when window.api is missing', async () => {
    // api stub was cleared in beforeEach (undefined)
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Save settings'));
    });

    expect(screen.getByText(/Settings API unavailable/)).toBeTruthy();
  });

  it('shows "Settings API unavailable" when window.api exists but lacks setStartupConfig', async () => {
    vi.stubGlobal('api', { getStartupConfig: undefined, setStartupConfig: undefined });
    render(<StartupPickerModal items={ITEMS} onClose={() => {}} onDisable={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByText('Save settings'));
    });

    expect(screen.getByText(/Settings API unavailable/)).toBeTruthy();
  });

  it('seeds the allowlist from item.allowlisted flags when no API is present', () => {
    vi.stubGlobal('api', undefined);
    const itemsWithAllowlist: StartupItemMetric[] = [
      { ...ITEMS[0], allowlisted: true },
      { ...ITEMS[1], allowlisted: false },
    ];
    render(<StartupPickerModal items={itemsWithAllowlist} onClose={() => {}} onDisable={() => {}} />);
    // Steam should already show "Remove" since it was pre-allowlisted
    expect(screen.getByLabelText('Remove Steam from allowlist')).toBeTruthy();
    expect(screen.getByLabelText('Add Discord to allowlist')).toBeTruthy();
  });
});
