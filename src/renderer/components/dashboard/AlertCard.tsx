import type { Finding, ActionName } from '@shared/types.js';
import { ACTIONS } from '@shared/actions.js';
import { useState } from 'react';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

interface AlertCardProps {
  finding: Finding;
  onApply: (action: ActionName) => Promise<void>;
}

export function AlertCard({ finding, onApply }: AlertCardProps) {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const border = finding.severity === 'critical' ? 'border-status-crit/40 bg-status-crit/[0.06]'
               : finding.severity === 'warning' ? 'border-status-warn/40 bg-status-warn/[0.06]'
               : 'border-status-info/40 bg-status-info/[0.06]';
  const icon = finding.severity === 'critical' ? '🔴' : finding.severity === 'warning' ? '⚠' : 'ℹ';
  const actionDef = finding.suggested_action ? ACTIONS[finding.suggested_action] : undefined;

  async function handleClick() {
    if (busy || !finding.suggested_action) return;
    setBusy(true);
    setElapsed(0);
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    try {
      await onApply(finding.suggested_action);
    } finally {
      clearInterval(timer);
      setBusy(false);
    }
  }

  return (
    <div className={`border rounded-lg p-3 text-xs ${border} flex justify-between items-start gap-3`}>
      <div className="flex-1">
        <div className="font-semibold mb-1 flex items-center gap-2">
          <span>{icon}</span><span>{finding.area}</span>
        </div>
        <div className="text-text-secondary leading-relaxed">{finding.message}</div>
        {busy && actionDef && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-status-info">
            <LoadingSpinner size={12} />
            <span>Running {actionDef.label}… {elapsed}s elapsed (~{actionDef.estimated_duration_s}s typical)</span>
          </div>
        )}
      </div>
      {actionDef && (
        <button
          onClick={handleClick}
          disabled={busy}
          className="px-2.5 py-1.5 rounded-md bg-status-warn text-black text-[11px] font-bold shrink-0 disabled:opacity-50 flex items-center gap-1.5"
          title={actionDef.tooltip}
        >
          {busy ? (<><LoadingSpinner size={10} /> <span>Running</span></>) : (<><span>{actionDef.icon}</span><span>Fix</span></>)}
        </button>
      )}
    </div>
  );
}
