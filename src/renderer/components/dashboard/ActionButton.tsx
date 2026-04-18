import { useState } from 'react';
import { Tooltip } from '@renderer/components/layout/Tooltip.js';
import type { ActionDefinition } from '@shared/actions.js';
import { useConfirm } from '@renderer/lib/confirmContext.js';

interface ActionButtonProps {
  action: ActionDefinition;
  onRun: () => Promise<void>;
  disabled?: boolean;
}

export function ActionButton({ action, onRun, disabled }: ActionButtonProps) {
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  async function handleClick() {
    if (busy || disabled) return;
    if (action.confirm_level !== 'none') {
      const ok = await confirm({
        title: action.label,
        body: (
          <div>
            <p className="mb-2">{action.tooltip}</p>
            <p className="text-xs">Estimated duration: ~{action.estimated_duration_s}s · Rollback: Tier {action.rollback_tier}</p>
          </div>
        ),
        tier: action.confirm_level === 'destructive' ? 'destructive' : 'risky',
        confirmLabel: 'Run',
      });
      if (!ok) return;
    }
    setBusy(true);
    try { await onRun(); } finally { setBusy(false); }
  }

  return (
    <Tooltip text={action.tooltip}>
      <button
        className="flex flex-col items-center justify-center gap-1.5 p-3 bg-surface-900 border border-surface-600 rounded-md text-[11px] text-text-primary hover:bg-surface-700 hover:border-status-info/40 transition disabled:opacity-50 disabled:cursor-not-allowed w-full h-[88px]"
        onClick={handleClick}
        disabled={busy || disabled}
      >
        <span className="text-xl leading-none">{action.icon}</span>
        <span className="text-center leading-tight">{busy ? 'Running…' : action.label}</span>
      </button>
    </Tooltip>
  );
}
