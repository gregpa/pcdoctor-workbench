/**
 * v2.5.30 (P4): Confirmation dialog for process kill / suspend.
 *
 * Sister of ServiceConfirmDialog with process-specific labels.
 * Two variants gated by `systemCritical`:
 *   - regular: shows action target, Cancel | Confirm. Confirm enabled.
 *   - system_critical: red banner + "I understand" checkbox; Confirm
 *     disabled until checked.
 *
 * Used for Kill and Suspend buttons. Set-Priority and Set-Affinity skip
 * the dialog and fire immediately (Task Manager parity); Resume is also
 * safe and fires directly.
 */

import { useEffect, useState } from 'react';

export type ProcessActionKind = 'kill' | 'suspend';

interface Props {
  open: boolean;
  process: { pid: number; name: string };
  kind: ProcessActionKind;
  systemCritical: boolean;
  systemCriticalReason: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function titleFor(kind: ProcessActionKind): string {
  return kind === 'kill' ? 'Kill this process?' : 'Suspend this process?';
}

function bodyFor(kind: ProcessActionKind): string {
  return kind === 'kill'
    ? 'Unsaved work in this process will be lost. This action cannot be undone.'
    : 'The process will pause execution until you click Resume on the same row.';
}

export function ProcessConfirmDialog({
  open, process, kind, systemCritical, systemCriticalReason, onCancel, onConfirm,
}: Props) {
  const [understood, setUnderstood] = useState(false);

  useEffect(() => { if (open) setUnderstood(false); }, [open]);

  if (!open) return null;
  const canConfirm = !systemCritical || understood;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="proc-confirm-title"
    >
      <div className="w-[480px] max-h-[90vh] rounded-xl bg-surface-800 border border-surface-600 shadow-2xl flex flex-col overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-surface-600">
          <h2 id="proc-confirm-title" className="text-base font-bold text-text-primary">{titleFor(kind)}</h2>
          <p className="text-xs text-text-secondary mt-1">
            <span className="font-semibold text-text-primary">{process.name}</span>
            <span className="text-text-secondary"> (pid {process.pid})</span>
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
          {systemCritical && (
            <div className="rounded-md border border-status-crit/50 bg-status-crit/10 px-3 py-2.5 flex gap-2">
              <span className="text-status-crit text-base shrink-0">⚠</span>
              <div className="text-[12px] text-text-primary">
                <div className="font-semibold text-status-crit">This is a system process.</div>
                <div className="mt-1 text-text-secondary">
                  {systemCriticalReason ?? 'Terminating it is likely to crash Windows.'}
                </div>
              </div>
            </div>
          )}

          <div className="rounded-md border border-surface-600 bg-surface-700/50 px-3 py-2.5 text-xs text-text-secondary">
            {bodyFor(kind)}
          </div>

          {systemCritical && (
            <label className="flex items-center gap-2 cursor-pointer text-[12px] text-text-primary">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
                className="shrink-0"
                aria-label="I understand the risk"
              />
              <span>I understand this is a system process and proceeding could crash Windows.</span>
            </label>
          )}
        </div>

        <div className="px-5 py-3 border-t border-surface-600 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded-md border border-surface-600 text-text-secondary text-xs hover:bg-surface-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`px-4 py-1.5 rounded-md text-xs font-semibold transition ${
              canConfirm
                ? systemCritical
                  ? 'bg-status-crit text-white hover:opacity-90'
                  : kind === 'kill'
                    ? 'bg-status-crit text-white hover:opacity-90'
                    : 'bg-status-warn text-black hover:opacity-90'
                : 'bg-surface-700 text-text-secondary cursor-not-allowed opacity-60'
            }`}
          >
            {kind === 'kill' ? 'Kill' : 'Suspend'}
          </button>
        </div>
      </div>
    </div>
  );
}
