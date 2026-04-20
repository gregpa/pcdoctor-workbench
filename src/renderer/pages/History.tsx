import { useHistory } from '@renderer/hooks/useHistory.js';
import { useConfirm } from '@renderer/lib/confirmContext.js';
import { formatDurationMs } from '@renderer/lib/formatters.js';
import { api } from '@renderer/lib/ipc.js';
import { useState } from 'react';
import type { AuditLogEntry } from '@shared/types.js';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

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
  const [detailItem, setDetailItem] = useState<AuditLogEntry | null>(null);

  if (loading) return (
    <div className="p-6 flex items-center gap-3 text-text-secondary">
      <LoadingSpinner size={18} /><span>Loading audit log…</span>
    </div>
  );

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
      setToast(r.data.reboot_required ? `Revert scheduled - reboot required. ${r.data.details}` : `Reverted: ${r.data.details}`);
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
                <div key={e.id} className="flex items-center gap-3 bg-surface-800 border border-surface-600 rounded-md p-2.5 text-xs hover:border-status-info/40 cursor-pointer transition" onClick={() => setDetailItem(e)}>
                  <span className={`text-base w-5 ${statusColor}`}>{status}</span>
                  <span className="text-text-secondary w-20">{time}</span>
                  <span className="flex-1 font-semibold">{e.action_label}</span>
                  <span className="text-text-secondary w-16 text-right">
                    {e.duration_ms != null ? formatDurationMs(e.duration_ms) : '-'}
                  </span>
                  <span className="text-text-secondary w-16 text-right capitalize">{e.triggered_by}</span>
                  {canRevert ? (
                    <button
                      onClick={(ev) => { ev.stopPropagation(); doRevert(e.id, e.action_label); }}
                      className="px-2 py-1 rounded bg-surface-700 border border-surface-600 hover:border-status-info/40 text-[10px]"
                    >
                      Revert
                    </button>
                  ) : e.status === 'error' ? (
                    <button
                      onClick={async (ev) => {
                        ev.stopPropagation();
                        const ctx = `This action failed. Help me understand why and suggest a fix:\n- Action: ${e.action_label}\n- Status: ${e.status}\n- Error: ${e.error_message ?? 'unknown'}\n- Duration: ${e.duration_ms}ms\n- Triggered by: ${e.triggered_by}`;
                        await (window as any).api.investigateWithClaude(ctx);
                      }}
                      className="px-2 py-1 rounded bg-surface-700 border border-surface-600 hover:border-status-info/40 text-[10px]"
                      title="Investigate failure in Claude"
                    >
                      🤖 Investigate
                    </button>
                  ) : (
                    <span className="w-[56px] text-right text-[10px] text-text-secondary/60">
                      {e.reverted_at ? 'reverted' : 'no rollback'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {detailItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setDetailItem(null)}>
          <div className="bg-surface-800 border border-surface-600 rounded-lg w-full max-w-3xl p-5 shadow-2xl max-h-[85vh] overflow-y-auto" onClick={(ev) => ev.stopPropagation()}>
            <h2 className="text-base font-semibold mb-3">{detailItem.action_label}</h2>

            <div className="text-sm text-text-secondary space-y-1 mb-4">
              <div>Ran: <span className="text-text-primary">{new Date(detailItem.ts).toLocaleString()}</span></div>
              <div>Duration: <span className="text-text-primary">{detailItem.duration_ms != null ? formatDurationMs(detailItem.duration_ms) : '-'}</span></div>
              <div>Triggered by: <span className="text-text-primary capitalize">{detailItem.triggered_by}</span></div>
              <div>Status: <span className={detailItem.status === 'success' ? 'text-status-good' : detailItem.status === 'error' ? 'text-status-crit' : 'text-text-primary'}>{detailItem.status}</span></div>
              {detailItem.rollback_id && <div>Rollback ID: <span className="text-text-primary">{detailItem.rollback_id}</span></div>}
              {detailItem.reverted_at && <div>Reverted: <span className="text-text-primary">{new Date(detailItem.reverted_at).toLocaleString()}</span></div>}
            </div>

            {detailItem.params && (
              <div className="mb-4">
                <div className="text-[10px] uppercase tracking-wider text-text-secondary font-semibold mb-1">Parameters</div>
                <pre className="bg-surface-900 border border-surface-700 rounded-md p-3 text-[11px] overflow-x-auto">{JSON.stringify(detailItem.params, null, 2)}</pre>
              </div>
            )}

            {detailItem.error_message && (
              <div className="mb-4">
                <div className="text-[10px] uppercase tracking-wider text-text-secondary font-semibold mb-1">Error</div>
                <pre className="bg-status-crit/10 border border-status-crit/40 rounded-md p-3 text-[11px] overflow-x-auto text-status-crit">{detailItem.error_message}</pre>
              </div>
            )}

            {detailItem.result && (
              <div className="mb-4">
                <div className="text-[10px] uppercase tracking-wider text-text-secondary font-semibold mb-1">Result</div>
                <pre className="bg-surface-900 border border-surface-700 rounded-md p-3 text-[11px] overflow-x-auto max-h-64">{JSON.stringify(detailItem.result, null, 2)}</pre>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={async () => {
                  // Build a plain-text payload that's useful for pasting into
                  // a ticket, Claude, or a notes app.
                  const payload = [
                    `# ${detailItem.action_label}`,
                    `Ran: ${new Date(detailItem.ts).toLocaleString()}`,
                    `Duration: ${detailItem.duration_ms != null ? detailItem.duration_ms + 'ms' : '-'}`,
                    `Triggered by: ${detailItem.triggered_by}`,
                    `Status: ${detailItem.status}`,
                    detailItem.rollback_id ? `Rollback ID: ${detailItem.rollback_id}` : '',
                    detailItem.reverted_at ? `Reverted at: ${new Date(detailItem.reverted_at).toISOString()}` : '',
                    detailItem.params ? '\n## Parameters\n' + JSON.stringify(detailItem.params, null, 2) : '',
                    detailItem.error_message ? '\n## Error\n' + detailItem.error_message : '',
                    detailItem.result ? '\n## Result\n' + JSON.stringify(detailItem.result, null, 2) : '',
                  ].filter(Boolean).join('\n');
                  const r = await (api as any).writeClipboard?.(payload);
                  setToast(r?.ok ? 'Copied to clipboard' : `Copy failed: ${r?.error?.message ?? 'unknown'}`);
                  setTimeout(() => setToast(null), 3000);
                }}
                className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 hover:border-status-info/40"
                title="Copy this result as a plain-text report to the clipboard"
              >
                📋 Copy
              </button>
              <button
                onClick={async () => {
                  const payload = [
                    `# ${detailItem.action_label}`,
                    `Ran: ${new Date(detailItem.ts).toLocaleString()}`,
                    `Duration: ${detailItem.duration_ms != null ? detailItem.duration_ms + 'ms' : '-'}`,
                    `Triggered by: ${detailItem.triggered_by}`,
                    `Status: ${detailItem.status}`,
                    detailItem.rollback_id ? `Rollback ID: ${detailItem.rollback_id}` : '',
                    detailItem.reverted_at ? `Reverted at: ${new Date(detailItem.reverted_at).toISOString()}` : '',
                    detailItem.params ? '\n## Parameters\n' + JSON.stringify(detailItem.params, null, 2) : '',
                    detailItem.error_message ? '\n## Error\n' + detailItem.error_message : '',
                    detailItem.result ? '\n## Result\n' + JSON.stringify(detailItem.result, null, 2) : '',
                  ].filter(Boolean).join('\n');
                  const r = await (api as any).saveActionResult?.(detailItem.action_name, detailItem.ts, payload);
                  if (r?.ok) {
                    setToast(`Saved to ${r.data.path}`);
                  } else {
                    setToast(`Save failed: ${r?.error?.message ?? 'unknown'}`);
                  }
                  setTimeout(() => setToast(null), 5000);
                }}
                className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 hover:border-status-info/40"
                title="Save this result to C:\\ProgramData\\PCDoctor\\exports\\"
              >
                💾 Save to File
              </button>
              <button onClick={() => setDetailItem(null)} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">Close</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
