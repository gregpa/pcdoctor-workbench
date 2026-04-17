import type { Finding, ActionName } from '@shared/types.js';
import { ACTIONS } from '@shared/actions.js';

interface AlertCardProps {
  finding: Finding;
  onApply: (action: ActionName) => Promise<void>;
}

export function AlertCard({ finding, onApply }: AlertCardProps) {
  const border = finding.severity === 'critical' ? 'border-status-crit/40 bg-status-crit/[0.06]'
               : finding.severity === 'warning' ? 'border-status-warn/40 bg-status-warn/[0.06]'
               : 'border-status-info/40 bg-status-info/[0.06]';
  const icon = finding.severity === 'critical' ? '🔴' : finding.severity === 'warning' ? '⚠' : 'ℹ';
  const actionDef = finding.suggested_action ? ACTIONS[finding.suggested_action] : undefined;

  return (
    <div className={`border rounded-lg p-3 text-xs ${border} flex justify-between items-start gap-3`}>
      <div className="flex-1">
        <div className="font-semibold mb-1 flex items-center gap-2">
          <span>{icon}</span><span>{finding.area}</span>
        </div>
        <div className="text-text-secondary leading-relaxed">{finding.message}</div>
      </div>
      {actionDef && (
        <button
          onClick={() => onApply(finding.suggested_action!)}
          className="px-2.5 py-1.5 rounded-md bg-status-warn text-black text-[11px] font-bold shrink-0"
          title={actionDef.tooltip}
        >
          {actionDef.icon} Fix
        </button>
      )}
    </div>
  );
}
