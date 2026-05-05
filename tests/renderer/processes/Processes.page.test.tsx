/**
 * v2.5.30 (P4): integration tests for the Processes page.
 *
 * Locks the high-value flows; doesn't repeat every variant from the
 * services page tests. Notable behaviors:
 *   - Renders rows from listAllProcesses
 *   - Search + chip filters narrow the row set
 *   - Priority dropdown change fires setProcessPriority immediately
 *     (no confirm dialog)
 *   - Kill click opens ProcessConfirmDialog; Confirm fires killProcess
 *     and removes the row
 *   - Suspend click opens dialog; Confirm fires suspendProcess and
 *     marks the row [paused]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ProcessRow } from '@shared/types.js';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    listAllProcesses: vi.fn(),
    killProcess: vi.fn(),
    setProcessPriority: vi.fn(),
    setProcessAffinity: vi.fn(),
    suspendProcess: vi.fn(),
    resumeProcess: vi.fn(),
  },
}));
vi.mock('@renderer/lib/ipc.js', () => ({ api: mockApi }));
vi.mock('@renderer/components/layout/LoadingSpinner.js', () => ({ LoadingSpinner: () => <span>spinner</span> }));

import { Processes } from '@renderer/pages/Processes.js';

function makeRow(over: Partial<ProcessRow> = {}): ProcessRow {
  return {
    pid: 1234,
    name: 'chrome',
    ws_mb: 412,
    cpu_pct: null,
    kind: 'user',
    system_critical: false,
    system_critical_reason: null,
    ...over,
  };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  vi.clearAllMocks();
  // Stub the auto-refresh interval so tests don't fire repeated IPC calls.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Processes page', () => {
  it('renders rows from listAllProcesses', async () => {
    mockApi.listAllProcesses.mockResolvedValueOnce({
      ok: true, data: [
        makeRow({ pid: 1234, name: 'chrome', ws_mb: 500 }),
        makeRow({ pid: 5678, name: 'notepad', ws_mb: 12 }),
        makeRow({ pid: 1596, name: 'csrss', system_critical: true, system_critical_reason: 'critical', kind: 'system' }),
      ],
    });
    render(<Processes />);
    await flush();
    expect(await screen.findByText('chrome')).toBeInTheDocument();
    expect(screen.getByText('notepad')).toBeInTheDocument();
    expect(screen.getByText('csrss')).toBeInTheDocument();
    cleanup();
  });

  it('error banner on listAllProcesses failure', async () => {
    mockApi.listAllProcesses.mockResolvedValueOnce({
      ok: false, error: { code: 'E_LIST_PROCESSES', message: 'PS exited 1' },
    });
    render(<Processes />);
    await flush();
    expect(await screen.findByText(/E_LIST_PROCESSES/)).toBeInTheDocument();
    cleanup();
  });

  it('critical chip filters to only system-critical processes', async () => {
    mockApi.listAllProcesses.mockResolvedValueOnce({
      ok: true, data: [
        makeRow({ pid: 1234, name: 'chrome' }),
        makeRow({ pid: 1596, name: 'csrss', system_critical: true, kind: 'system' }),
      ],
    });
    render(<Processes />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /critical/i }));
    await flush();
    expect(screen.getByText('csrss')).toBeInTheDocument();
    expect(screen.queryByText('chrome')).not.toBeInTheDocument();
    cleanup();
  });

  it('priority dropdown change fires setProcessPriority immediately', async () => {
    mockApi.listAllProcesses.mockResolvedValueOnce({
      ok: true, data: [makeRow({ pid: 1234, name: 'chrome' })],
    });
    mockApi.setProcessPriority.mockResolvedValueOnce({
      ok: true, data: { pid: 1234, name: 'chrome', before: { priority: 'Normal' }, after: { priority: 'High' }, duration_ms: 5, dry_run: false },
    });
    render(<Processes />);
    await flush();
    const select = screen.getByLabelText(/priority for chrome/i);
    fireEvent.change(select, { target: { value: 'High' } });
    await flush();
    expect(mockApi.setProcessPriority).toHaveBeenCalledWith(1234, 'High');
    cleanup();
  });

  it('Kill click opens dialog; Confirm fires killProcess and drops the row', async () => {
    mockApi.listAllProcesses.mockResolvedValueOnce({
      ok: true, data: [makeRow({ pid: 1234, name: 'chrome' })],
    });
    mockApi.killProcess.mockResolvedValueOnce({
      ok: true, data: { pid: 1234, name: 'chrome', count: 1, killed: [{ pid: 1234, name: 'chrome' }], duration_ms: 50, dry_run: false, action_id: 7 },
    });
    render(<Processes />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /kill chrome/i }));
    await flush();
    // Dialog open with title "Kill this process?"
    expect(screen.getByText(/kill this process/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^kill$/i }));
    await flush();
    expect(mockApi.killProcess).toHaveBeenCalledWith(1234);
    await waitFor(() =>
      expect(screen.queryByText('chrome')).not.toBeInTheDocument(),
    );
    cleanup();
  });

  it('Suspend click opens dialog; Confirm marks row [paused]', async () => {
    mockApi.listAllProcesses.mockResolvedValueOnce({
      ok: true, data: [makeRow({ pid: 1234, name: 'chrome' })],
    });
    mockApi.suspendProcess.mockResolvedValueOnce({
      ok: true, data: { pid: 1234, name: 'chrome', before: { status: 'Running' }, after: { status: 'Suspended' }, duration_ms: 5, dry_run: false, action_id: 8 },
    });
    render(<Processes />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /suspend chrome/i }));
    await flush();
    expect(screen.getByText(/suspend this process/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^suspend$/i }));
    await flush();
    expect(mockApi.suspendProcess).toHaveBeenCalledWith(1234);
    await waitFor(() =>
      expect(screen.getByText(/\[paused\]/i)).toBeInTheDocument(),
    );
    cleanup();
  });
});
