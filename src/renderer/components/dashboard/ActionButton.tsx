import { useState } from 'react';
import { Tooltip } from '@renderer/components/layout/Tooltip.js';
import type { ActionDefinition } from '@shared/actions.js';

interface ActionButtonProps {
  action: ActionDefinition;
  icon: string;
  onRun: () => Promise<void>;
  disabled?: boolean;
}

export function ActionButton({ action, icon, onRun, disabled }: ActionButtonProps) {
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy || disabled) return;

    if (action.confirm_level === 'destructive') {
      const ok = window.confirm(
        `${action.label}\n\n${action.tooltip}\n\nEstimated duration: ${action.estimated_duration_s}s.\nProceed?`,
      );
      if (!ok) return;
    } else if (action.confirm_level === 'risky') {
      const ok = window.confirm(`Run "${action.label}"?\n\n${action.tooltip}`);
      if (!ok) return;
    }

    setBusy(true);
    try {
      await onRun();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Tooltip text={action.tooltip}>
      <button
        className="flex items-center gap-2 px-2.5 py-2 bg-surface-900 border border-surface-600
                   rounded-md text-[11px] text-text-primary
                   hover:bg-surface-700 hover:border-status-info/40 transition
                   disabled:opacity-50 disabled:cursor-not-allowed
                   w-full"
        onClick={handleClick}
        disabled={busy || disabled}
      >
        <span className="text-sm">{icon}</span>
        <span>{busy ? 'Running…' : action.label}</span>
      </button>
    </Tooltip>
  );
}
