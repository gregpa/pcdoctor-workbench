import type { ReactNode } from 'react';

interface ConfirmModalProps {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tier: 'risky' | 'destructive';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ title, body, confirmLabel = 'Run', cancelLabel = 'Cancel', tier, onConfirm, onCancel }: ConfirmModalProps) {
  const confirmColor = tier === 'destructive' ? 'bg-status-crit text-white' : 'bg-status-warn text-black';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-800 border border-surface-600 rounded-lg w-full max-w-md p-5 shadow-2xl">
        <h2 className="text-base font-semibold mb-2 flex items-center gap-2">
          <span>{tier === 'destructive' ? '⚠' : '▶'}</span>{title}
        </h2>
        <div className="text-sm text-text-secondary leading-relaxed mb-4">
          {body}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">
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
