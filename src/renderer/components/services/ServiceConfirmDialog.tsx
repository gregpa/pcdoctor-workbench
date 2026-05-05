/**
 * v2.5.30: Confirmation dialog shown before any service mutate.
 *
 * Two variants gated by `loadBearing`:
 *   - regular: shows before/after state, Cancel | Confirm. Confirm enabled.
 *   - load-bearing: same content + red banner + "I understand" checkbox.
 *     Confirm is disabled until checkbox is ticked.
 *
 * Caller is expected to fetch the dry-run preview via the relevant
 * api.* function with { dryRun: true } and pass it as `preview` so the
 * dialog can show the projected after-state. The dialog itself does NOT
 * call IPC -- it just gathers consent.
 */

import { useEffect, useState } from 'react';

export type ServiceMutateKind = 'set-startup' | 'stop' | 'start';

export interface ServicePreview {
  before: { status: string; start_type?: string };
  after: { status: string; start_type?: string };
}

interface Props {
  open: boolean;
  service: { key: string; display: string };
  kind: ServiceMutateKind;
  /** For 'set-startup' the new value the user picked. */
  startupTypeTarget?: string;
  /** Dry-run result. If null, dialog shows a "computing preview..." line. */
  preview: ServicePreview | null;
  loadBearing: boolean;
  loadBearingReason: string | null;
  /** Running dependents that will be force-stopped (Stop only). */
  runningDependents?: string[];
  onCancel: () => void;
  onConfirm: () => void;
}

function titleFor(kind: ServiceMutateKind, target?: string): string {
  switch (kind) {
    case 'set-startup': return target ? `Change startup type to ${target}?` : 'Change startup type?';
    case 'stop':        return 'Stop this service?';
    case 'start':       return 'Start this service?';
  }
}

export function ServiceConfirmDialog({
  open, service, kind, startupTypeTarget, preview,
  loadBearing, loadBearingReason, runningDependents,
  onCancel, onConfirm,
}: Props) {
  const [understood, setUnderstood] = useState(false);

  // Reset the "I understand" checkbox each time the dialog re-opens so a
  // user closing and reopening on a different load-bearing service must
  // re-acknowledge.
  useEffect(() => { if (open) setUnderstood(false); }, [open]);

  if (!open) return null;

  const canConfirm = !loadBearing || understood;
  const title = titleFor(kind, startupTypeTarget);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="svc-confirm-title"
    >
      <div className="w-[480px] max-h-[90vh] rounded-xl bg-surface-800 border border-surface-600 shadow-2xl flex flex-col overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-surface-600">
          <h2 id="svc-confirm-title" className="text-base font-bold text-text-primary">{title}</h2>
          <p className="text-xs text-text-secondary mt-1">
            <span className="font-semibold text-text-primary">{service.display}</span>
            <span className="text-text-secondary"> ({service.key})</span>
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
          {loadBearing && (
            <div className="rounded-md border border-status-crit/50 bg-status-crit/10 px-3 py-2.5 flex gap-2">
              <span className="text-status-crit text-base shrink-0">⚠</span>
              <div className="text-[12px] text-text-primary">
                <div className="font-semibold text-status-crit">This is a system service.</div>
                <div className="mt-1 text-text-secondary">
                  {loadBearingReason ?? 'Disabling or stopping it can prevent Windows from booting normally.'}
                </div>
              </div>
            </div>
          )}

          <div className="rounded-md border border-surface-600 bg-surface-700/50 px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1">Preview</div>
            {preview === null ? (
              <div className="text-xs text-text-secondary italic">Computing preview…</div>
            ) : (
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="text-text-secondary text-[10px] uppercase">Before</div>
                  <div className="text-text-primary mt-0.5">{preview.before.status}</div>
                  {preview.before.start_type && (
                    <div className="text-text-secondary text-[11px]">Startup: {preview.before.start_type}</div>
                  )}
                </div>
                <div>
                  <div className="text-text-secondary text-[10px] uppercase">After</div>
                  <div className="text-text-primary mt-0.5">{preview.after.status}</div>
                  {preview.after.start_type && (
                    <div className="text-text-secondary text-[11px]">Startup: {preview.after.start_type}</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {runningDependents && runningDependents.length > 0 && (
            <div className="rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-[12px]">
              <div className="font-semibold text-status-warn">Will also stop {runningDependents.length} running dependent{runningDependents.length === 1 ? '' : 's'}:</div>
              <div className="text-text-secondary mt-1 break-all">{runningDependents.join(', ')}</div>
            </div>
          )}

          {loadBearing && (
            <label className="flex items-center gap-2 cursor-pointer text-[12px] text-text-primary">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
                className="shrink-0"
                aria-label="I understand the risk"
              />
              <span>I understand this is a system service and proceeding could break Windows.</span>
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
                ? loadBearing
                  ? 'bg-status-crit text-white hover:opacity-90'
                  : 'bg-status-info text-white hover:opacity-90'
                : 'bg-surface-700 text-text-secondary cursor-not-allowed opacity-60'
            }`}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
