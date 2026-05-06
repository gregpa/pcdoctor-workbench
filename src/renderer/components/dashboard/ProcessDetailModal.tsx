/**
 * ProcessDetailModal (v2.5.34)
 *
 * Click-to-inspect for the dashboard's RamPressurePanel top-consumer rows.
 * The panel only carries name/pid/ws_bytes/kind per scan tick; this modal
 * fetches rich details (path, description, command line, parent, threads,
 * handles) on-demand via api.getProcessDetail when a row is clicked.
 *
 * Design:
 *   - Loading state while the IPC is in flight (~150ms)
 *   - Error state if the process exited between the scan and the click
 *     (E_PROC_NOT_FOUND surfaces as a soft failure, not a crash)
 *   - Optional Kill button -- only rendered when the caller passes onKill
 *     (RamPressurePanel only kills 'user' kind; 'service' / 'system' rows
 *     get inspect-only access). Kill goes through the standard destructive
 *     confirm dialog before firing.
 *
 * Mirrors AlertDetailModal's portal + backdrop conventions to avoid
 * the v2.4.6 modal-flash bug (see AlertDetailModal.tsx:69-74).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@renderer/lib/ipc.js';
import { useConfirm } from '@renderer/lib/confirmContext.js';
import type { ProcessDetail } from '@shared/types.js';

export interface ProcessDetailModalProps {
  pid: number;
  /** Best-known name from the panel row (used as title before fetch resolves). */
  nameHint: string;
  onClose: () => void;
  /** Only present when the row is killable (user-kind). */
  onKill?: (pid: number, name: string) => void | Promise<void>;
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diffMs = Date.now() - t;
  if (diffMs < 0) return '—';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h ago`;
}

export function ProcessDetailModal({ pid, nameHint, onClose, onKill }: ProcessDetailModalProps) {
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const confirm = useConfirm();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.getProcessDetail(pid).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setDetail(r.data);
      } else {
        setError(`${r.error.code}: ${r.error.message}`);
      }
    });
    return () => { cancelled = true; };
  }, [pid]);

  async function handleKill() {
    if (!onKill || !detail) return;
    const ok = await confirm({
      title: `Kill ${detail.name} (PID ${detail.pid})?`,
      body: (
        <div>
          <p className="mb-2">Terminates the process. Any unsaved work is lost immediately and there is no Undo.</p>
          {detail.system_critical && (
            <p className="text-status-crit text-xs">
              ⚠ {detail.system_critical_reason ?? 'System-critical process'}. Killing this can crash Windows.
            </p>
          )}
        </div>
      ),
      tier: 'destructive',
      confirmLabel: 'Kill',
    });
    if (!ok) return;
    await onKill(detail.pid, detail.name);
    onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        className="pcd-modal w-full max-w-xl max-h-[85vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-5 border-b border-surface-600">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-text-secondary font-semibold">
              Process Details
            </div>
            <div className="text-sm font-semibold text-text-primary mt-0.5 truncate">
              {detail?.name ?? nameHint} <span className="text-text-secondary font-mono text-xs">(PID {pid})</span>
            </div>
            {detail?.description && (
              <div className="text-xs text-text-secondary mt-0.5 truncate">{detail.description}</div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-text-secondary hover:text-text-primary text-xl leading-none px-2"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="p-5 text-xs space-y-3" data-testid="process-detail-body">
          {loading && (
            <div className="text-text-secondary py-4 text-center">Loading process details…</div>
          )}
          {error && (
            <div className="rounded-md border border-status-crit/40 bg-status-crit/10 px-3 py-2 text-text-primary">
              {error.includes('E_PROC_NOT_FOUND')
                ? 'This process is no longer running. It may have exited between the dashboard scan and your click.'
                : error}
            </div>
          )}
          {detail && (
            <>
              {detail.system_critical && (
                <div className="rounded-md border border-status-crit/40 bg-status-crit/10 px-3 py-2 text-text-primary">
                  ⚠ <span className="font-semibold">System-critical:</span> {detail.system_critical_reason ?? 'killing this may crash Windows'}
                </div>
              )}

              <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
                <div className="text-text-secondary">Kind</div>
                <div>{detail.kind}</div>

                <div className="text-text-secondary">Path</div>
                <div className="font-mono break-all text-text-primary">{detail.path ?? <span className="text-text-secondary">—</span>}</div>

                <div className="text-text-secondary">Command line</div>
                <div className="font-mono break-all text-text-primary">
                  {detail.command_line
                    ? <span title={detail.command_line}>{detail.command_line.length > 200 ? detail.command_line.slice(0, 200) + '…' : detail.command_line}</span>
                    : <span className="text-text-secondary">—</span>}
                </div>

                <div className="text-text-secondary">Parent</div>
                <div>
                  {detail.parent_name
                    ? <>{detail.parent_name} <span className="text-text-secondary font-mono">(PID {detail.parent_pid})</span></>
                    : detail.parent_pid != null ? <span className="font-mono">PID {detail.parent_pid}</span>
                    : <span className="text-text-secondary">—</span>}
                </div>

                <div className="text-text-secondary">Started</div>
                <div>{fmtAge(detail.start_time)} {detail.start_time && <span className="text-text-secondary text-[10px]">({new Date(detail.start_time).toLocaleString()})</span>}</div>

                <div className="text-text-secondary">Working set</div>
                <div>{fmtBytes(detail.ws_bytes)}</div>

                <div className="text-text-secondary">Private bytes</div>
                <div>{fmtBytes(detail.pm_bytes)}</div>

                <div className="text-text-secondary">Threads</div>
                <div>{detail.thread_count}</div>

                <div className="text-text-secondary">Handles</div>
                <div>{detail.handle_count}</div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-surface-600">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-surface-600 text-text-secondary text-xs hover:bg-surface-700"
          >
            Close
          </button>
          {onKill && detail && !detail.system_critical && (
            <button
              onClick={() => { void handleKill(); }}
              className="px-3 py-1.5 rounded-md bg-status-crit/20 text-status-crit border border-status-crit/40 text-xs hover:bg-status-crit/30"
            >
              Kill
            </button>
          )}
          {onKill && detail && detail.system_critical && (
            <button
              disabled
              title={detail.system_critical_reason ?? 'System-critical process'}
              className="px-3 py-1.5 rounded-md border border-surface-600 text-text-secondary text-xs opacity-40 cursor-not-allowed"
            >
              Kill (blocked)
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
