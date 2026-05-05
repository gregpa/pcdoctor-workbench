/**
 * v2.5.30 (S6): UndoCenter page.
 *
 * Long-term undo browser — lists every service mutation still inside its
 * 7-day rollback window, sorted newest-first. Each row exposes an Undo
 * button that fires api:undoServiceAction. Complements the immediate-
 * undo ServiceUndoToast (which only lives 8s after a mutation).
 *
 * Read-only feed; mutations route through the existing undoServiceAction
 * IPC, which is already covered by elevatedWorker dispatch + DB writes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

interface Row {
  action_id: number;
  rollback_id: number;
  ts: number;
  action_name: string;
  action_label: string;
  expires_at: number;
  service: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "5 min ago", "2 hr ago", "3 days ago". */
function formatAgo(ts: number, now: number): string {
  const ms = now - ts;
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** "expires in 6d 23h" or "expires in 12 min". */
function formatExpiresIn(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `expires in ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `expires in ${hrs} hr`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs - days * 24;
  return `expires in ${days}d ${remHrs}h`;
}

function actionVerb(actionName: string): string {
  switch (actionName) {
    case 'set_service_startup': return 'Set startup type';
    case 'stop_service':        return 'Stopped';
    case 'start_service':       return 'Started';
    default:                    return actionName;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function UndoCenter() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [serverNow, setServerNow] = useState<number>(Date.now());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // Refresh the "expires in X" labels every 60s without re-fetching the rows.
  const [tickNow, setTickNow] = useState<number>(Date.now());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await api.listUndoableServiceActions();
    setLoading(false);
    if (r.ok) {
      setRows(r.data.rows);
      setServerNow(r.data.server_now);
      setTickNow(Date.now());
    } else {
      setError(`${r.error.code}: ${r.error.message}`);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Tick the clock so countdowns stay live. 60s cadence keeps it accurate
  // enough for the "expires in Xd Yh" granularity without churning React.
  useEffect(() => {
    const t = setInterval(() => setTickNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const handleUndo = useCallback(async (actionId: number) => {
    setBusyId(actionId);
    try {
      const r = await api.undoServiceAction(actionId);
      if (r.ok) {
        // Drop the reverted row from the list locally so the page reflects
        // the change without a full refetch.
        setRows((prev) => prev?.filter((row) => row.action_id !== actionId) ?? null);
      } else {
        // eslint-disable-next-line no-alert
        alert(`Undo failed: ${r.error.code}: ${r.error.message}`);
      }
    } finally {
      setBusyId(null);
    }
  }, []);

  // Apply tick offset to server_now so countdowns advance smoothly between
  // refreshes without the renderer trusting wall-clock skew.
  const effectiveNow = useMemo(() => serverNow + (tickNow - serverNow), [serverNow, tickNow]);

  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary">Undo Center</h1>
          <p className="text-xs text-text-secondary mt-0.5">
            Service mutations within the 7-day rollback window. Click Undo to revert.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="px-3 py-1 rounded-md border border-surface-600 text-text-secondary text-xs hover:bg-surface-700 disabled:opacity-50"
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-status-crit/40 bg-status-crit/10 px-3 py-2 text-xs text-text-primary">
          {error}
        </div>
      )}

      {!rows && loading && (
        <div className="flex items-center gap-2 text-xs text-text-secondary py-6">
          <LoadingSpinner /> Loading undoable actions…
        </div>
      )}

      {rows && rows.length === 0 && (
        <div className="rounded-lg border border-surface-600 bg-surface-800 p-6 text-center text-xs text-text-secondary">
          Nothing to undo right now. Service mutations from the Services page show up here for 7 days.
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="rounded-lg border border-surface-600 bg-surface-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-surface-700 text-text-secondary uppercase text-[10px] tracking-wider">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">When</th>
                <th className="text-left px-3 py-2 font-semibold">Service</th>
                <th className="text-left px-3 py-2 font-semibold">Action</th>
                <th className="text-left px-3 py-2 font-semibold">Expires</th>
                <th className="text-right px-3 py-2 font-semibold">Undo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const busy = busyId === row.action_id;
                const expired = row.expires_at <= effectiveNow;
                return (
                  <tr key={row.action_id} className="border-t border-surface-700 hover:bg-surface-700/30">
                    <td className="px-3 py-2 text-text-secondary whitespace-nowrap">
                      {formatAgo(row.ts, effectiveNow)}
                    </td>
                    <td className="px-3 py-2 text-text-primary font-mono">{row.service ?? '—'}</td>
                    <td className="px-3 py-2 text-text-primary">
                      <span className="text-text-secondary">{actionVerb(row.action_name)}: </span>
                      {row.action_label}
                    </td>
                    <td className={`px-3 py-2 whitespace-nowrap ${expired ? 'text-status-crit' : 'text-text-secondary'}`}>
                      {formatExpiresIn(row.expires_at, effectiveNow)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={busy || expired}
                        onClick={() => void handleUndo(row.action_id)}
                        className={`px-3 py-0.5 rounded text-[11px] font-semibold transition ${
                          busy
                            ? 'bg-surface-700 text-text-secondary cursor-wait'
                            : expired
                              ? 'border border-surface-600 text-text-secondary opacity-30 cursor-not-allowed'
                              : 'border border-status-info/50 text-status-info hover:bg-status-info/10'
                        }`}
                        aria-label={`Undo ${row.action_label}`}
                      >
                        {busy ? 'Undoing…' : 'Undo'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Re-export helpers for unit testing.
export const _testing = { formatAgo, formatExpiresIn, actionVerb };
