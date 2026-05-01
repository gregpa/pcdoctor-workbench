/**
 * NasRecycleBinPanel (v2.4.13)
 *
 * window.api is stubbed via vi.stubGlobal in beforeEach so every test is
 * independent. onEmptyDrive is always a vi.fn() returning a resolved promise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { NasRecycleBinPanel } from '../../src/renderer/components/dashboard/NasRecycleBinPanel.js';
import type { NasDrive } from '../../src/renderer/components/dashboard/NasRecycleBinPanel.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function drive(overrides: Partial<NasDrive> = {}): NasDrive {
  return {
    letter: 'M:',
    unc: '\\\\nas\\Plex Movies',
    used_bytes: 8 * 1024 ** 3,        // 8 GB
    free_bytes: 6 * 1024 ** 3,        // 6 GB
    total_bytes: 14 * 1024 ** 3,      // 14 GB
    recycle_bytes: 512 * 1024 ** 2,   // 512 MB
    reachable: true,
    ...overrides,
  };
}

function makeApi(drives: NasDrive[]) {
  return {
    getNasDrives: vi.fn().mockResolvedValue({ ok: true, data: drives }),
  };
}

// ---------------------------------------------------------------------------

describe('<NasRecycleBinPanel>', () => {
  const noop = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.stubGlobal('api', undefined);
    noop.mockReset();
    noop.mockResolvedValue(undefined);
  });

  it('renders loading state while API call is in flight', () => {
    vi.stubGlobal('api', {
      getNasDrives: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    // v2.4.14: renamed from "Enumerating network drives" to match the
    // all-drive-types expansion.
    expect(screen.getByText(/Enumerating drives/)).toBeTruthy();
  });

  it('renders error state when API is unavailable (no window.api)', async () => {
    // api is already undefined from beforeEach
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() =>
      expect(screen.getByText(/NAS API unavailable in this build/)).toBeTruthy()
    );
  });

  it('renders error state when getNasDrives returns ok=false', async () => {
    vi.stubGlobal('api', {
      getNasDrives: vi.fn().mockResolvedValue({
        ok: false,
        error: { message: 'WMI timeout', code: 'E_WMI' },
      }),
    });
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() =>
      expect(screen.getByText(/WMI timeout/)).toBeTruthy()
    );
  });

  it('renders empty state when drives list is an empty array', async () => {
    vi.stubGlobal('api', makeApi([]));
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() =>
      // v2.4.14: renamed from "No network drives mapped".
      expect(screen.getByText(/No drives detected/)).toBeTruthy()
    );
  });

  it('renders drive letter and UNC path for a reachable drive', async () => {
    vi.stubGlobal('api', makeApi([drive()]));
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() => expect(screen.getByText('M:')).toBeTruthy());
    expect(screen.getByText(/\\\\nas\\Plex Movies/)).toBeTruthy();
  });

  it('renders the size bar for a reachable drive', async () => {
    vi.stubGlobal('api', makeApi([drive()]));
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() => expect(screen.getByText('M:')).toBeTruthy());
    // Size usage text: 8 GB used, 14 GB total
    expect(screen.getByText(/8\.0 GB \/ 14\.0 GB/)).toBeTruthy();
  });

  it('renders recycle bin size on the trash button', async () => {
    vi.stubGlobal('api', makeApi([drive({ recycle_bytes: 1024 ** 3 })]));
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() => expect(screen.getByText('M:')).toBeTruthy());
    // Button text contains the formatted size
    expect(screen.getByText(/1\.0 GB/)).toBeTruthy();
  });

  it('offline drive row renders with offline text', async () => {
    vi.stubGlobal('api', makeApi([drive({ reachable: false, unc: '\\\\nas\\Plex' })]));
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() => expect(screen.getByText('M:')).toBeTruthy());
    expect(screen.getByText('offline')).toBeTruthy();
  });

  it('offline drive row has the trash button disabled', async () => {
    vi.stubGlobal('api', makeApi([drive({ reachable: false })]));
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() => expect(screen.getByText('M:')).toBeTruthy());
    const trashBtn = screen.getByTitle(/Drive offline/);
    expect(trashBtn).toBeDisabled();
  });

  // v2.4.50 (B49-NAS-1): the button no longer gates on recycle_bytes.
  // Pre-2.4.50 the gate was `(recycle_bytes ?? 0) === 0` which mixed
  // "size known to be 0" and "size unknown"; the underlying script's
  // recursive SMB scan blew the 30s IPC budget on Plex shares so we
  // now skip the scan and report null. Button enabled whenever the
  // drive is reachable; the empty action no-ops gracefully.
  it('trash button stays enabled when recycle_bytes is 0 (size known empty)', async () => {
    vi.stubGlobal('api', makeApi([drive({ recycle_bytes: 0, reachable: true })]));
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() => expect(screen.getByText('M:')).toBeTruthy());
    // v2.5.21: tooltip now says "@Recycle is empty" (shorter, no "or missing").
    const trashBtn = screen.getByTitle(/@Recycle is empty/);
    expect(trashBtn).not.toBeDisabled();
  });

  it('trash button stays enabled when recycle_bytes is null (size unknown — v2.4.50 deferred-compute path)', async () => {
    vi.stubGlobal('api', makeApi([drive({ recycle_bytes: null, reachable: true })]));
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() => expect(screen.getByText('M:')).toBeTruthy());
    // v2.5.21: tooltip still says "size scanning in background".
    const trashBtn = screen.getByTitle(/size scanning in background/);
    expect(trashBtn).not.toBeDisabled();
    // v2.5.21: label changed from '🗑 Empty…' to '🗑 Scanning…' to be
    // more explicit about what's happening.
    expect(screen.getByRole('button', { name: /🗑 Scanning…/ })).toBeTruthy();
  });

  it('clicking the trash button calls onEmptyDrive with the letter without the colon', async () => {
    vi.stubGlobal('api', makeApi([drive()]));
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() => expect(screen.getByText('M:')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Empty M:/));
    });

    expect(noop).toHaveBeenCalledWith('M');
  });

  it('parent bumping refreshToken after empty re-fetches the drive list', async () => {
    // v2.4.13 W4: panel no longer self-refreshes in handleEmpty. Refresh is
    // parent-owned via the refreshToken prop - the Dashboard bumps it after
    // handleAction resolves. This test simulates that contract: render the
    // panel, click empty, then re-render with an incremented refreshToken
    // and assert getNasDrives was called twice (initial + on token change).
    const getNasDrives = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: [drive()] })
      .mockResolvedValue({ ok: true, data: [drive({ recycle_bytes: 0 })] });
    vi.stubGlobal('api', { getNasDrives });

    const { rerender } = render(
      <NasRecycleBinPanel onEmptyDrive={noop} refreshToken={0} />,
    );
    await waitFor(() => expect(screen.getByText('M:')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Empty M:/));
    });

    // Parent bumps the token after the destructive action completes.
    rerender(<NasRecycleBinPanel onEmptyDrive={noop} refreshToken={1} />);

    await waitFor(() => expect(getNasDrives).toHaveBeenCalledTimes(2));
  });

  it('renders multiple drive rows', async () => {
    vi.stubGlobal('api', makeApi([
      drive({ letter: 'M:' }),
      drive({ letter: 'Z:', unc: '\\\\nas\\TV' }),
    ]));
    render(<NasRecycleBinPanel onEmptyDrive={noop} />);
    await waitFor(() => expect(screen.getByText('M:')).toBeTruthy());
    expect(screen.getByText('Z:')).toBeTruthy();
  });

  it('refreshToken change triggers a re-fetch', async () => {
    const getNasDrives = vi.fn().mockResolvedValue({ ok: true, data: [drive()] });
    vi.stubGlobal('api', { getNasDrives });

    const { rerender } = render(<NasRecycleBinPanel onEmptyDrive={noop} refreshToken={0} />);
    await waitFor(() => expect(getNasDrives).toHaveBeenCalledTimes(1));

    rerender(<NasRecycleBinPanel onEmptyDrive={noop} refreshToken={1} />);
    await waitFor(() => expect(getNasDrives).toHaveBeenCalledTimes(2));
  });
});
