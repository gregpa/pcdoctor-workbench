import type { KpiValue } from '@shared/types.js';
import { severityBorderClass, severityColorClass } from '@renderer/lib/thresholds.js';

export function KpiCard({ kpi }: { kpi: KpiValue }) {
  const deltaClass =
    kpi.delta?.severity === 'crit' ? 'text-status-crit' :
    kpi.delta?.severity === 'warn' ? 'text-status-warn' :
    kpi.delta?.severity === 'good' ? 'text-status-good' :
    'text-text-secondary';

  const arrow = kpi.delta?.direction === 'up' ? '▲' : kpi.delta?.direction === 'down' ? '▼' : '-';

  return (
    <div className={`bg-surface-800 border border-surface-600 rounded-lg p-3 panel-contain ${severityBorderClass[kpi.severity]}`}>
      <div className="text-[10px] uppercase tracking-wider text-text-secondary">{kpi.label}</div>
      <div className={`text-2xl font-bold leading-tight mt-1 mb-0.5 ${severityColorClass[kpi.severity]}`}>
        {kpi.value}{kpi.unit ?? ''}
      </div>
      {kpi.sub && <div className="text-[10px] text-text-secondary">{kpi.sub}</div>}
      {kpi.delta && (
        <div className={`text-[10px] mt-1 flex items-center gap-1 ${deltaClass}`}>
          <span>{arrow}</span><span>{kpi.delta.text}</span>
        </div>
      )}
    </div>
  );
}
