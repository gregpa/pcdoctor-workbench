import type { ReactNode } from 'react';

interface ConfirmModalProps {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // v2.4.23: 'info' tier for neutral "read-before-run" pre-click modals.
  // 'risky' signals "double check before proceeding" (amber). 'destructive'
  // signals "might break something" (red). 'info' is for safe actions that
  // still benefit from a brief description before firing.
  tier: 'info' | 'risky' | 'destructive';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ title, body, confirmLabel = 'Run', cancelLabel = 'Cancel', tier, onConfirm, onCancel }: ConfirmModalProps) {
  const confirmColor =
    tier === 'destructive' ? 'bg-status-crit text-white'
    : tier === 'risky'     ? 'bg-status-warn text-black'
    :                         'bg-status-info text-white';
  const icon =
    tier === 'destructive' ? '⚠'
    : tier === 'risky'     ? '▶'
    :                         'ℹ';
  // v2.5.36: z-[60] (everyone else is z-50). The confirm dialog is the
  // highest-priority interaction in the app — any modal can trigger one
  // (Greg report v2.5.35: clicked Kill in ProcessDetailModal at z-50,
  // confirm rendered BEHIND the inspect modal because both shared z-50
  // and the inspect modal's portal mounted later in DOM order). New
  // modals MUST stay <= z-50 so the confirm always wins.
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="pcd-modal w-full max-w-md p-5 shadow-2xl">
        <h2 className="text-base font-semibold mb-2 flex items-center gap-2">
          <span>{icon}</span>{title}
        </h2>
        <div className="text-sm text-text-secondary leading-relaxed mb-4">
          {body}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 rounded-md text-xs pcd-button">
            {cancelLabel}
          </button>
          <button onClick={onConfirm} className={`px-3 py-1.5 rounded-md text-xs font-semibold ${confirmColor}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
