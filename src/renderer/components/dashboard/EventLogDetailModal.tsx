import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@renderer/lib/ipc.js';

interface EventLogBreakdownEntry {
  provider: string;
  event_id: number;
  count: number;
  sample_message: string;
  last_seen_iso: string;
}

/**
 * Response shape from `Get-EventLogBreakdown.ps1`. Matches the fields the
 * PS script emits via `ConvertTo-Json`. Only fields we actually render are
 * declared — the PS script also returns `top_n` (requested count) and
 * `duration_ms`, but the renderer doesn't use them.
 */
interface EventLogBreakdown {
  success: boolean;
  days: number;
  total_errors: number;
  returned: number;
  accounted_for: number;
  accounted_pct: number;
  top: EventLogBreakdownEntry[];
  start_time_iso: string;
  message: string;
}

interface EventLogDetailModalProps {
  onClose: () => void;
}

/**
 * v2.4.6: shown when the user clicks the "Event Log Errors - 7 Day"
 * chart on the Dashboard. Fetches Get-EventLogBreakdown.ps1 on demand
 * (not part of the scheduled scan) and renders the top-N providers +
 * event IDs so the user can see which sources are driving the error
 * count. Hands off to Claude for interpretation of anything unfamiliar.
 */
export function EventLogDetailModal({ onClose }: EventLogDetailModalProps) {
  const [data, setData] = useState<EventLogBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);
  const [level, setLevel] = useState<'2' | '2,3'>('2');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      const r = await api.getEventLogBreakdown({ days, topN: 15, level });
      if (!alive) return;
      if (r?.ok) setData(r.data as EventLogBreakdown);
      else setError(r?.error?.message ?? 'Failed to fetch breakdown');
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [days, level]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        className="pcd-modal w-full max-w-3xl max-h-[85vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-5 border-b border-surface-600">
          <div className="flex-1">
            <h2 className="text-base font-semibold mb-1 flex items-center gap-2">
              <span>📋</span>
              <span>Event Log Errors — Breakdown</span>
            </h2>
            <p className="text-xs text-text-secondary">
              Top providers and event IDs driving the error count shown on the Dashboard chart.
              Click Investigate with Claude to have Claude interpret anything unfamiliar.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-text-secondary hover:text-text-primary text-xl leading-none px-2"
          >
            ×
          </button>
        </div>

        {/* Filter row */}
        <div className="flex items-center gap-4 px-5 py-3 border-b border-surface-600 bg-surface-900/40 text-xs">
          <label className="flex items-center gap-2">
            <span className="text-text-secondary">Window:</span>
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value, 10))}
              className="bg-surface-900 border border-surface-600 rounded px-2 py-1"
            >
              <option value={1}>1 day</option>
              <option value={3}>3 days</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-text-secondary">Severity:</span>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as '2' | '2,3')}
              className="bg-surface-900 border border-surface-600 rounded px-2 py-1"
            >
              <option value="2">Errors only</option>
              <option value="2,3">Errors + Warnings</option>
            </select>
          </label>
          {data && (
            <div className="ml-auto text-text-secondary">
              <strong className="text-text-primary">{data.total_errors.toLocaleString()}</strong> total ·
              top <strong className="text-text-primary">{data.returned}</strong> = <strong className="text-text-primary">{data.accounted_pct ?? 0}%</strong>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="p-5 space-y-3 text-xs">
          {loading && <div className="text-text-secondary">Loading…</div>}
          {error && (
            <div className="text-status-crit bg-status-crit/10 border border-status-crit/40 rounded p-3">
              Failed to load breakdown: {error}
            </div>
          )}
          {data && data.top.length === 0 && (
            <div className="text-text-secondary italic">No events in the selected window — your system is quiet.</div>
          )}
          {data && data.top.length > 0 && (
            <table className="w-full text-[11px]">
              <thead className="text-text-secondary text-left">
                <tr className="border-b border-surface-700">
                  <th className="py-2 pr-2 w-16">Count</th>
                  <th className="py-2 pr-2">Provider / Event</th>
                  <th className="py-2 pr-2 w-40">Last seen</th>
                  <th className="py-2 w-12" />
                </tr>
              </thead>
              <tbody>
                {data.top.map((e, i) => (
                  <EventLogRow key={`${e.provider}_${e.event_id}_${i}`} entry={e} total={data.total_errors} />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-surface-600 bg-surface-900/50">
          <button
            onClick={async () => {
              if (!data) return;
              const ctx = [
                `Investigate these Windows Event Log errors.`,
                '',
                `Context: Greg's dashboard shows ${data.total_errors} Error-level events in the last ${data.days} days on this Alienware R11. Here's the top ${data.returned} breakdown. Tell me which of these are benign noise I can ignore, which are real issues worth fixing, and suggest suppression or fixes where appropriate.`,
                '',
                '```json',
                JSON.stringify(data, null, 2),
                '```',
              ].join('\n');
              await api.investigateWithClaude(ctx);
              onClose();
            }}
            disabled={!data || data.total_errors === 0}
            className="px-3 py-1.5 rounded-md text-xs pcd-button hover:border-status-info/40 disabled:opacity-50"
          >
            🤖 Investigate with Claude
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs bg-status-info text-black font-semibold"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function EventLogRow({ entry, total }: { entry: EventLogBreakdownEntry; total: number }) {
  const [expanded, setExpanded] = useState(false);
  const pct = total > 0 ? Math.round((100 * entry.count) / total) : 0;
  return (
    <>
      <tr className="border-b border-surface-700/50 hover:bg-surface-900/40">
        <td className="py-2 pr-2 font-mono text-text-primary">{entry.count}</td>
        <td className="py-2 pr-2">
          <div className="font-semibold">{entry.provider}</div>
          <div className="text-text-secondary">Event ID {entry.event_id} · {pct}% of total</div>
        </td>
        <td className="py-2 pr-2 text-text-secondary font-mono text-[10px]">
          {entry.last_seen_iso.replace('T', ' ')}
        </td>
        <td className="py-2">
          <button
            onClick={() => setExpanded(v => !v)}
            className="px-2 py-0.5 rounded text-[10px] pcd-button hover:border-status-info/40"
            title={expanded ? 'Hide sample message' : 'Show sample message'}
          >
            {expanded ? '−' : '+'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-surface-700/50">
          <td colSpan={4} className="pb-3 px-2">
            <pre className="text-[10px] text-text-secondary bg-surface-900 border border-surface-700 rounded p-2 whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
              {/* v2.4.10: cap at ~1KB. Event Log sample messages can legally
                  reach 32KB (some providers dump full stack traces). Rendering
                  raw + shipping raw to Claude via Investigate is wasteful and
                  clutters the UI. PS-side truncation is at 400 chars but
                  defend-in-depth here too. */}
              {(entry.sample_message ?? '').length > 1024
                ? entry.sample_message.slice(0, 1024) + '… (truncated)'
                : entry.sample_message || '(no message body)'}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
