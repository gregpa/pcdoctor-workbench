import type { SmartEntry } from '@shared/types.js';

interface SmartTableProps {
  entries: SmartEntry[];
  onRunSmartCheck?: () => void;
}

export function SmartTable({ entries, onRunSmartCheck }: SmartTableProps) {
  if (entries.length === 0) {
    return (
      <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary mb-2">Disk SMART Health</div>
        <div className="text-xs text-text-secondary">No SMART data yet. Run Full PC Scan or install smartmontools.</div>
      </div>
    );
  }
  // v2.3.14: if any row came from the non-admin Get-PhysicalDisk fallback,
  // show a banner offering to elevate + re-query. Wear / temp / media errors
  // are unavailable in the fallback path.
  const anyNeedsAdmin = entries.some(e => e.needs_admin);
  return (
    <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary">Disk SMART Health</div>
        {anyNeedsAdmin && onRunSmartCheck && (
          <button
            onClick={onRunSmartCheck}
            className="px-2 py-0.5 rounded text-[10px] bg-status-warn/15 border border-status-warn/40 text-status-warn hover:bg-status-warn/25"
            title="Wear%, temp, and media-error counts need admin-level ATA pass-through. Click to UAC-elevate and re-query."
          >
            💾 Run SMART Check (admin)
          </button>
        )}
      </div>
      {anyNeedsAdmin && (
        <div className="text-[10px] text-text-secondary mb-2">
          Basic info only (drive + health status). Click Run SMART Check for wear/temp/media-error counts.
        </div>
      )}
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
            const dim = e.needs_admin ? 'text-text-secondary' : '';
            return (
              <tr key={i} className="border-t border-surface-700">
                <td className="py-1.5">{e.drive}</td>
                <td className="py-1.5 text-center">{e.health}</td>
                <td className={`py-1.5 text-center ${dim}`}>{e.wear_pct != null ? `${e.wear_pct}%` : (e.needs_admin ? 'admin' : '-')}</td>
                <td className={`py-1.5 text-center ${dim}`}>{e.temp_c != null ? `${e.temp_c}°C` : (e.needs_admin ? 'admin' : '-')}</td>
                <td className={`py-1.5 text-center ${sevColor}`}>{sevMark}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
