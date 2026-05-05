/**
 * v2.5.30: integration tests for the Services page.
 *
 * The page calls api.listAllServices on mount, renders rows in a table,
 * filters via search + chip controls, and orchestrates the confirm
 * dialog + undo toast. These tests stub the api module + verify the
 * key flows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ServiceRow } from '@shared/types.js';

// ── Mocks ─────────────────────────────────────────────────────────────────
const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    listAllServices: vi.fn(),
    setServiceStartup: vi.fn(),
    stopService: vi.fn(),
    startService: vi.fn(),
    undoServiceAction: vi.fn(),
  },
}));
vi.mock('@renderer/lib/ipc.js', () => ({ api: mockApi }));
vi.mock('@renderer/components/layout/LoadingSpinner.js', () => ({ LoadingSpinner: () => <span>loading</span> }));

import { Services } from '@renderer/pages/Services.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    key: 'Spooler',
    display: 'Print Spooler',
    status: 'Running',
    start_type: 'Automatic',
    binary_path: 'spoolsv.exe',
    description: 'Print spooler',
    depends_on: [],
    dependents: [],
    load_bearing: false,
    load_bearing_reason: null,
    ...over,
  };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Services page', () => {
  it('renders rows from listAllServices', async () => {
    mockApi.listAllServices.mockResolvedValueOnce({
      ok: true, data: [
        makeRow({ key: 'Spooler', display: 'Print Spooler' }),
        makeRow({ key: 'Themes', display: 'Themes Service', status: 'Running' }),
        makeRow({ key: 'RpcSs', display: 'Remote Procedure Call (RPC)', load_bearing: true, load_bearing_reason: 'critical' }),
      ],
    });
    render(<Services />);
    await flush();
    expect(await screen.findByText('Print Spooler')).toBeInTheDocument();
    expect(screen.getByText('Themes Service')).toBeInTheDocument();
    expect(screen.getByText('Remote Procedure Call (RPC)')).toBeInTheDocument();
    cleanup();
  });

  it('renders error banner when listAllServices fails', async () => {
    mockApi.listAllServices.mockResolvedValueOnce({
      ok: false, error: { code: 'E_LIST_SERVICES', message: 'PS exited 1' },
    });
    render(<Services />);
    await flush();
    expect(await screen.findByText(/E_LIST_SERVICES/)).toBeInTheDocument();
    cleanup();
  });

  it('search filter narrows the row set', async () => {
    mockApi.listAllServices.mockResolvedValueOnce({
      ok: true, data: [
        makeRow({ key: 'Spooler', display: 'Print Spooler' }),
        makeRow({ key: 'ThemesKey', display: 'Themes Service' }),
        makeRow({ key: 'wuauserv', display: 'Windows Update' }),
      ],
    });
    render(<Services />);
    await flush();
    const search = screen.getByPlaceholderText(/search by key/i);
    fireEvent.change(search, { target: { value: 'theme' } });
    await flush();
    expect(screen.getByText('Themes Service')).toBeInTheDocument();
    expect(screen.queryByText('Print Spooler')).not.toBeInTheDocument();
    expect(screen.queryByText('Windows Update')).not.toBeInTheDocument();
    cleanup();
  });

  it('load-bearing chip filters to only the system services', async () => {
    mockApi.listAllServices.mockResolvedValueOnce({
      ok: true, data: [
        makeRow({ key: 'Spooler', display: 'Print Spooler', load_bearing: false }),
        makeRow({ key: 'RpcSs', display: 'RPC', load_bearing: true, load_bearing_reason: 'critical' }),
      ],
    });
    render(<Services />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /system/i }));
    await flush();
    expect(screen.getByText('RPC')).toBeInTheDocument();
    expect(screen.queryByText('Print Spooler')).not.toBeInTheDocument();
    cleanup();
  });

  it('clicking Stop opens the confirm dialog after dryRun resolves', async () => {
    mockApi.listAllServices.mockResolvedValueOnce({
      ok: true, data: [makeRow({ status: 'Running' })],
    });
    mockApi.stopService.mockResolvedValueOnce({
      ok: true, data: {
        service: 'Spooler',
        before: { status: 'Running' },
        after: { status: 'Stopped' },
        duration_ms: 5, dry_run: true,
      },
    });
    render(<Services />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /stop print spooler/i }));
    await flush();
    expect(mockApi.stopService).toHaveBeenCalledWith('Spooler', { dryRun: true });
    expect(await screen.findByText(/stop this service/i)).toBeInTheDocument();
    cleanup();
  });

  it('Confirm fires the real mutate IPC and shows the undo toast on success', async () => {
    mockApi.listAllServices.mockResolvedValueOnce({
      ok: true, data: [makeRow({ status: 'Running' })],
    });
    // dryRun preview
    mockApi.stopService.mockResolvedValueOnce({
      ok: true, data: {
        service: 'Spooler',
        before: { status: 'Running' },
        after: { status: 'Stopped' },
        duration_ms: 5, dry_run: true,
      },
    });
    // real run
    mockApi.stopService.mockResolvedValueOnce({
      ok: true, data: {
        service: 'Spooler',
        before: { status: 'Running' },
        after: { status: 'Stopped' },
        duration_ms: 600, dry_run: false,
        action_id: 42, rollback_id: 100,
      },
    });

    render(<Services />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /stop print spooler/i }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await flush();

    expect(mockApi.stopService).toHaveBeenCalledTimes(2);
    expect(mockApi.stopService).toHaveBeenLastCalledWith('Spooler');
    // Toast is in the document.
    await waitFor(() =>
      expect(screen.getByText(/print spooler: stopped/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^undo$/i })).toBeInTheDocument();
    cleanup();
  });

  it('refresh button re-fetches the services list', async () => {
    mockApi.listAllServices
      .mockResolvedValueOnce({ ok: true, data: [makeRow({ key: 'Spooler' })] })
      .mockResolvedValueOnce({ ok: true, data: [makeRow({ key: 'ThemesKey', display: 'Themes Service' })] });
    render(<Services />);
    await flush();
    expect(screen.getByText('Print Spooler')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await flush();
    expect(mockApi.listAllServices).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Themes Service')).toBeInTheDocument();
    cleanup();
  });
});
