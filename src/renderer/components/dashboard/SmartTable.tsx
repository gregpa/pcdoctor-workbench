import type { SmartEntry } from '@shared/types.js';

interface SmartTableProps {
  entries: SmartEntry[];
  onRunSmartCheck?: () => void;
  /** v2.4.25: click a row to open DiskSmartDetailModal. Optional so other
   *  places can still embed the table in read-only mode. */
  onRowClick?: (entry: SmartEntry) => void;
}

export function SmartTable({ entries, onRunSmartCheck, onRowClick }: SmartTableProps) {
  if (entries.length === 0) {
    return (
      <div className="pcd-panel">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary mb-2">Disk SMART Health</div>
        <div className="text-xs text-text-secondary">No SMART data yet. Run Full PC Scan or install smartmontools.</div>
      </div>
    );
  }
  // v2.3.14: if any row came from the non-admin Get-PhysicalDisk fallback,
  // show a banner offering to elevate + re-query. Wear / temp / media errors
  // are unavailable in the fallback path.
  // v2.4.20: always surface the Run SMART Check button, even when every row
  // has cache data. Users need a way to force-refresh when the cache is
  // stale or when a new scanner version (e.g. v2.4.19's smartctl NVMe
  // fallback) shipped since the cache was last written. When no rows need
  // admin, the button goes to a subtler styling so it isn't alarming.
  const anyNeedsAdmin = entries.some(e => e.needs_admin);
  const buttonClass = anyNeedsAdmin
    ? 'px-2 py-0.5 rounded text-[10px] bg-status-warn/15 border border-status-warn/40 text-status-warn hover:bg-status-warn/25'
    : 'px-2 py-0.5 rounded text-[10px] pcd-button text-text-secondary hover:text-text-primary hover:border-surface-500';
  const buttonLabel = anyNeedsAdmin ? '💾 Run SMART Check (admin)' : '🔄 Refresh SMART (admin)';
  return (
    <div className="pcd-panel">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary">Disk SMART Health</div>
        {onRunSmartCheck && (
          <button
            onClick={onRunSmartCheck}
            className={buttonClass}
            title={anyNeedsAdmin
              ? 'Wear%, temp, and media-error counts need admin-level ATA pass-through. Click to UAC-elevate and re-query.'
              : 'Force a fresh elevated SMART scan. Useful if cached values look stale or the scanner was updated.'}
          >
            {buttonLabel}
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
            // v2.4.22: when the drive IS cached (needs_admin=false) but a
            // value is still null, it's a vendor-gated value - typically
            // an NVMe behind Intel RST where smartctl can see the drive
            // but can't reach the NVMe SMART log. Show a subtle "(n/a)"
            // hint instead of "-" so the user isn't left wondering
            // whether we tried. Tooltip explains.
            const wearDisplay = e.wear_pct != null
              ? `${e.wear_pct}%`
              : e.needs_admin ? 'admin' : 'n/a';
            const tempDisplay = e.temp_c != null
              ? `${e.temp_c}°C`
              : e.needs_admin ? 'admin' : 'n/a';
            const gatedTitle = 'Drive is cached but this value is not exposed - typical for NVMe behind Intel RST / RAID controllers. Status column still reflects Windows HealthStatus.';
            const clickable = !!onRowClick;
            const rowClasses = `border-t border-surface-700 ${clickable ? 'cursor-pointer hover:bg-surface-700/40' : ''}`;
            return (
              <tr
                key={i}
                className={rowClasses}
                onClick={clickable ? () => onRowClick!(e) : undefined}
                title={clickable ? 'Click for SMART details and refresh' : undefined}
              >
                <td className="py-1.5">{e.drive}</td>
                <td className="py-1.5 text-center">{e.health}</td>
                <td
                  className={`py-1.5 text-center ${dim}`}
                  title={!clickable && wearDisplay === 'n/a' ? gatedTitle : undefined}
                >
                  {wearDisplay}
                </td>
                <td
                  className={`py-1.5 text-center ${dim}`}
                  title={!clickable && tempDisplay === 'n/a' ? gatedTitle : undefined}
                >
                  {tempDisplay}
                </td>
                <td className={`py-1.5 text-center ${sevColor}`}>{sevMark}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
