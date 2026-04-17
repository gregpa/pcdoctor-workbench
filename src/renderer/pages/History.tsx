import { useHistory } from '@renderer/hooks/useHistory.js';
import { useConfirm } from '@renderer/lib/confirmContext.js';
import { formatDurationMs } from '@renderer/lib/formatters.js';
import { useState } from 'react';
import type { AuditLogEntry } from '@shared/types.js';

function groupByDay(entries: AuditLogEntry[]) {
  const groups = new Map<string, AuditLogEntry[]>();
  for (const e of entries) {
    const day = new Date(e.ts).toDateString();
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(e);
  }
  return Array.from(groups.entries());
}

export function History() {
  const { entries, loading, revert } = useHistory();
  const confirm = useConfirm();
  const [toast, setToast] = useState<string | null>(null);

  if (loading) return <div className="p-6 text-text-secondary">Loading audit log…</div>;

  async function doRevert(id: number, label: string) {
    const ok = await confirm({
      title: `Revert "${label}"?`,
      body: <p>This will undo the action. Some reverts require a reboot.</p>,
      tier: 'destructive',
      confirmLabel: 'Revert',
    });
    if (!ok) return;
    const r = await revert(id);
    if (r.ok) {
      setToast(r.data.reboot_required ? `Revert scheduled — reboot required. ${r.data.details}` : `Reverted: ${r.data.details}`);
    } else {
      setToast(`Revert failed: ${r.error.message}`);
    }
    setTimeout(() => setToast(null), 8000);
  }

  const grouped = groupByDay(entries);

  return (
    <div className="p-5">
      <h1 className="text-lg font-bold mb-4">📜 Action History</h1>
      {grouped.length === 0 && <div className="text-text-secondary text-sm">No actions run yet.</div>}
      {grouped.map(([day, items]) => (
        <div key={day} className="mb-5">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-2">{day}</div>
          <div className="space-y-1.5">
            {items.map((e) => {
              const time = new Date(e.ts).toLocaleTimeString();
              const status = e.reverted_at ? '⟲' : e.status === 'success' ? '✓' : e.status === 'error' ? '✗' : '…';
              const statusColor = e.reverted_at ? 'text-text-secondary' : e.status === 'success' ? 'text-status-good' : e.status === 'error' ? 'text-status-crit' : 'text-status-info';
              const canRevert = !e.reverted_at && e.rollback_id && e.status === 'success';
              return (
                <div key={e.id} className="flex items-center gap-3 bg-surface-800 border border-surface-600 rounded-md p-2.5 text-xs">
                  <span className={`text-base w-5 ${statusColor}`}>{status}</span>
                  <span className="text-text-secondary w-20">{time}</span>
                  <span className="flex-1 font-semibold">{e.action_label}</span>
                  <span className="text-text-secondary w-16 text-right">
                    {e.duration_ms != null ? formatDurationMs(e.duration_ms) : '—'}
                  </span>
                  <span className="text-text-secondary w-16 text-right capitalize">{e.triggered_by}</span>
                  {canRevert ? (
                    <button
                      onClick={() => doRevert(e.id, e.action_label)}
                      className="px-2 py-1 rounded bg-surface-700 border border-surface-600 hover:border-status-info/40 text-[10px]"
                    >
                      Revert
                    </button>
                  ) : (
                    <span className="w-[56px] text-right text-[10px] text-text-secondary/60">
                      {e.reverted_at ? 'reverted' : e.status === 'error' ? '—' : 'no rollback'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
