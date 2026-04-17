import type { SmartEntry } from '@shared/types.js';

interface SmartTableProps {
  entries: SmartEntry[];
}

export function SmartTable({ entries }: SmartTableProps) {
  if (entries.length === 0) {
    return (
      <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary mb-2">Disk SMART Health</div>
        <div className="text-xs text-text-secondary">No SMART data yet. Run Full PC Scan or install smartmontools.</div>
      </div>
    );
  }
  return (
    <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
      <div className="text-[9.5px] uppercase tracking-wider text-text-secondary mb-2">Disk SMART Health</div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-text-secondary text-[9px] uppercase tracking-wider">
            <th className="text-left font-semibold pb-1">Drive</th>
            <th className="text-center font-semibold pb-1">Health</th>
            <th className="text-center font-semibold pb-1">Wear</th>
            <th className="text-center font-semibold pb-1">Temp</th>
            <th className="text-center font-semibold pb-1">Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => {
            const sevColor = e.status_severity === 'good' ? 'text-status-good' : e.status_severity === 'warn' ? 'text-status-warn' : 'text-status-crit';
            const sevMark = e.status_severity === 'good' ? '✓' : e.status_severity === 'warn' ? '!' : '✗';
            return (
              <tr key={i} className="border-t border-surface-700">
                <td className="py-1.5">{e.drive}</td>
                <td className="py-1.5 text-center">{e.health}</td>
                <td className="py-1.5 text-center">{e.wear_pct != null ? `${e.wear_pct}%` : '—'}</td>
                <td className="py-1.5 text-center">{e.temp_c != null ? `${e.temp_c}°C` : '—'}</td>
                <td className={`py-1.5 text-center ${sevColor}`}>{sevMark}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
