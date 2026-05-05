/**
 * v2.5.30 (S6): tests for the UndoCenter page.
 *
 * Locks:
 *   - empty-list state copy ("Nothing to undo right now…")
 *   - rows render with service / verb / expires countdown
 *   - error state on listUndoableServiceActions failure
 *   - Undo button fires undoServiceAction and removes the row on success
 *   - expired rows render the Undo button disabled with status-crit color
 *   - formatAgo / formatExpiresIn helpers cover boundary cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    listUndoableServiceActions: vi.fn(),
    undoServiceAction: vi.fn(),
  },
}));
vi.mock('@renderer/lib/ipc.js', () => ({ api: mockApi }));
vi.mock('@renderer/components/layout/LoadingSpinner.js', () => ({ LoadingSpinner: () => <span>spinner</span> }));

import { UndoCenter, _testing } from '@renderer/pages/UndoCenter.js';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(over: Partial<any> = {}) {
  const now = Date.now();
  return {
    action_id: 42,
    rollback_id: 100,
    ts: now - 5 * 60_000,
    action_name: 'set_service_startup',
    action_label: 'Set startup type: Spooler -> Disabled',
    expires_at: now + 6 * 24 * 60 * 60 * 1000,
    service: 'Spooler',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Page tests
// ---------------------------------------------------------------------------

describe('UndoCenter', () => {
  it('shows empty-state copy when no undoable actions', async () => {
    mockApi.listUndoableServiceActions.mockResolvedValueOnce({
      ok: true, data: { rows: [], server_now: Date.now() },
    });
    render(<UndoCenter />);
    await flush();
    expect(await screen.findByText(/nothing to undo right now/i)).toBeInTheDocument();
    cleanup();
  });

  it('renders rows with service and action verb', async () => {
    mockApi.listUndoableServiceActions.mockResolvedValueOnce({
      ok: true, data: {
        rows: [
          makeRow({ action_id: 1, service: 'Spooler', action_name: 'set_service_startup' }),
          makeRow({ action_id: 2, service: 'wuauserv', action_name: 'stop_service', action_label: 'Stop service: wuauserv' }),
        ],
        server_now: Date.now(),
      },
    });
    render(<UndoCenter />);
    await flush();
    expect(await screen.findByText('Spooler')).toBeInTheDocument();
    expect(screen.getByText('wuauserv')).toBeInTheDocument();
    // Verb prefix appears in the action column. action_label may contain
    // the same prefix, so getAllByText to disambiguate.
    expect(screen.getAllByText(/Set startup type/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Stopped/i).length).toBeGreaterThanOrEqual(1);
    cleanup();
  });

  it('error banner on listUndoableServiceActions failure', async () => {
    mockApi.listUndoableServiceActions.mockResolvedValueOnce({
      ok: false, error: { code: 'E_LIST_UNDOABLE', message: 'sqlite locked' },
    });
    render(<UndoCenter />);
    await flush();
    expect(await screen.findByText(/E_LIST_UNDOABLE/)).toBeInTheDocument();
    cleanup();
  });

  it('Undo button fires undoServiceAction and removes the row on success', async () => {
    mockApi.listUndoableServiceActions.mockResolvedValueOnce({
      ok: true, data: { rows: [makeRow({ action_id: 99, service: 'Spooler' })], server_now: Date.now() },
    });
    mockApi.undoServiceAction.mockResolvedValueOnce({
      ok: true, data: { service: 'Spooler', before: { status: 'Running', start_type: 'Disabled' }, after: { status: 'Running', start_type: 'Automatic' }, duration_ms: 200, dry_run: false },
    });
    render(<UndoCenter />);
    await flush();
    expect(screen.getByText('Spooler')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /undo set startup type/i }));
    await flush();
    expect(mockApi.undoServiceAction).toHaveBeenCalledWith(99);
    // Row removed from local state.
    expect(screen.queryByText('Spooler')).not.toBeInTheDocument();
    expect(screen.getByText(/nothing to undo right now/i)).toBeInTheDocument();
    cleanup();
  });

  it('expired row disables the Undo button', async () => {
    const now = Date.now();
    mockApi.listUndoableServiceActions.mockResolvedValueOnce({
      ok: true, data: {
        rows: [makeRow({
          action_id: 5,
          ts: now - 8 * 24 * 60 * 60 * 1000,
          expires_at: now - 1000, // already past
        })],
        server_now: now,
      },
    });
    render(<UndoCenter />);
    await flush();
    expect(screen.getByText(/expired/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /undo/i })).toBeDisabled();
    cleanup();
  });

  it('refresh button re-fetches the list', async () => {
    mockApi.listUndoableServiceActions
      .mockResolvedValueOnce({ ok: true, data: { rows: [makeRow({ action_id: 1, service: 'Spooler' })], server_now: Date.now() } })
      .mockResolvedValueOnce({ ok: true, data: { rows: [makeRow({ action_id: 2, service: 'wuauserv' })], server_now: Date.now() } });
    render(<UndoCenter />);
    await flush();
    expect(screen.getByText('Spooler')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await flush();
    expect(mockApi.listUndoableServiceActions).toHaveBeenCalledTimes(2);
    expect(screen.getByText('wuauserv')).toBeInTheDocument();
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Helper unit tests (covers boundary cases without rendering)
// ---------------------------------------------------------------------------

describe('UndoCenter helpers', () => {
  const NOW = 1_000_000_000_000;

  it('formatAgo: just now for <60s', () => {
    expect(_testing.formatAgo(NOW - 30_000, NOW)).toBe('just now');
  });

  it('formatAgo: minutes', () => {
    expect(_testing.formatAgo(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
  });

  it('formatAgo: hours', () => {
    expect(_testing.formatAgo(NOW - 3 * 60 * 60_000, NOW)).toBe('3 hr ago');
  });

  it('formatAgo: days (singular vs plural)', () => {
    expect(_testing.formatAgo(NOW - 1 * 24 * 60 * 60_000, NOW)).toBe('1 day ago');
    expect(_testing.formatAgo(NOW - 4 * 24 * 60 * 60_000, NOW)).toBe('4 days ago');
  });

  it('formatExpiresIn: expired when <=0', () => {
    expect(_testing.formatExpiresIn(NOW - 1, NOW)).toBe('expired');
    expect(_testing.formatExpiresIn(NOW, NOW)).toBe('expired');
  });

  it('formatExpiresIn: minutes / hours / days', () => {
    expect(_testing.formatExpiresIn(NOW + 30 * 60_000, NOW)).toBe('expires in 30 min');
    expect(_testing.formatExpiresIn(NOW + 5 * 60 * 60_000, NOW)).toBe('expires in 5 hr');
    // 6 days, 3 hours
    expect(_testing.formatExpiresIn(NOW + (6 * 24 + 3) * 60 * 60_000, NOW)).toBe('expires in 6d 3h');
  });

  it('actionVerb maps the three service action names', () => {
    expect(_testing.actionVerb('set_service_startup')).toBe('Set startup type');
    expect(_testing.actionVerb('stop_service')).toBe('Stopped');
    expect(_testing.actionVerb('start_service')).toBe('Started');
    expect(_testing.actionVerb('flush_dns')).toBe('flush_dns'); // fallback to raw
  });
});
