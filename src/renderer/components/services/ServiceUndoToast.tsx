/**
 * v2.5.30: Auto-dismissing toast shown after a service mutate succeeds.
 * Click "Undo" to invoke api.undoServiceAction(actionId); auto-dismisses
 * after a few seconds otherwise.
 *
 * Long-term undo (after toast dismissed) lives in the UndoCenter page (S6).
 */

import { useEffect, useState } from 'react';

interface Props {
  actionId: number;
  /** Brief description of what was just done — shown above the Undo button. */
  message: string;
  /** Auto-dismiss after this many ms. Default 8000. */
  durationMs?: number;
  onUndo: (actionId: number) => Promise<void>;
  onDismiss: () => void;
}

export function ServiceUndoToast({ actionId, message, durationMs = 8000, onUndo, onDismiss }: Props) {
  const [undoing, setUndoing] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (undoing || done) return;
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [undoing, done, durationMs, onDismiss]);

  const handleUndo = async () => {
    setUndoing(true);
    try {
      await onUndo(actionId);
      setDone(true);
      // Brief pause to let the user see "Undone", then dismiss.
      setTimeout(onDismiss, 1200);
    } catch {
      // Caller surfaced the error via its own toast/alert; just close.
      onDismiss();
    }
  };

  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-40 max-w-[360px] rounded-lg border border-surface-600 bg-surface-800 shadow-2xl px-4 py-3 flex items-center gap-3"
    >
      <div className="flex-1 text-[12px]">
        <div className="text-text-primary">{message}</div>
        {done && <div className="text-status-good text-[11px] mt-0.5">Reverted</div>}
      </div>
      {!done && (
        <button
          type="button"
          onClick={handleUndo}
          disabled={undoing}
          className={`px-3 py-1 rounded-md text-[11px] font-semibold transition ${
            undoing
              ? 'bg-surface-700 text-text-secondary cursor-wait'
              : 'border border-status-info/50 text-status-info hover:bg-status-info/10'
          }`}
        >
          {undoing ? 'Undoing…' : 'Undo'}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="text-text-secondary text-[14px] hover:text-text-primary"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
