/**
 * DiskSmartDetailModal (v2.4.25)
 *
 * Opened when the user clicks a row in the Disk SMART Health table.
 * Shows the full SMART attribute dump for that drive + context hints
 * for each field + a Refresh action that routes to run_smart_check.
 */
import type { SmartEntry } from '@shared/types.js';

export interface DiskSmartDetailModalProps {
  entry: SmartEntry;
  onClose: () => void;
  /** Routes to run_smart_check action (elevated). Parent handles
   *  refreshSecurity() after the action completes so the underlying
   *  entry updates. */
  onRunSmartCheck?: () => void | Promise<void>;
}

function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return '-';
  const days = Math.floor(h / 24);
  const remH = h % 24;
  if (days === 0) return `${h} h`;
  if (days < 365) return `${days} d ${remH} h (${h} h total)`;
  const years = (h / 24 / 365).toFixed(1);
  return `${years} years (${h} h total)`;
}

function severityHint(entry: SmartEntry): string {
  if (entry.status_severity === 'crit') {
    if (entry.health === 'FAILED') return 'Windows HealthStatus reports this drive as failed. Back up anything important ASAP.';
    if (entry.wear_pct !== null && entry.wear_pct !== undefined && entry.wear_pct > 90) return 'SSD wear is above 90% - drive is near end of life. Plan to replace.';
    return 'A critical threshold was crossed. Investigate the attributes below.';
  }
  if (entry.status_severity === 'warn') {
    if (entry.wear_pct !== null && entry.wear_pct !== undefined && entry.wear_pct > 75) return 'SSD wear is above 75%. Still usable but start planning replacement.';
    if (entry.temp_c !== null && entry.temp_c !== undefined && entry.temp_c > 65) return 'Drive is running warm (>65 C). Check airflow; sustained high temps accelerate wear.';
    return 'Non-critical attribute above normal. Watch the trend over time.';
  }
  return 'Drive reporting healthy on all accessible SMART attributes.';
}

function wearHint(pct: number | null | undefined, needsAdmin: boolean): string {
  if (pct === null || pct === undefined) {
    return needsAdmin
      ? 'Admin required - click Refresh SMART.'
      : 'Not reported by this drive (vendor-gated through Intel RST or USB bridge).';
  }
  if (pct >= 90) return 'Near end of life - replace soon.';
  if (pct >= 75) return 'Significant wear accumulated - plan replacement.';
  if (pct >= 50) return 'Half of rated endurance consumed.';
  if (pct >= 20) return 'Normal wear for an actively-used SSD.';
  return 'Minimal wear - drive is relatively fresh.';
}

function tempHint(t: number | null | undefined, needsAdmin: boolean): string {
  if (t === null || t === undefined) {
    return needsAdmin
      ? 'Admin required - click Refresh SMART.'
      : 'Not reported by this drive (vendor-gated through Intel RST or USB bridge).';
  }
  if (t >= 70) return 'Running hot - check cooling.';
  if (t >= 60) return 'Warm. Typical under heavy load, concerning at idle.';
  if (t >= 30) return 'Normal operating range.';
  return 'Cool - idle or ambient temperature.';
}

export function DiskSmartDetailModal({ entry, onClose, onRunSmartCheck }: DiskSmartDetailModalProps) {
  const sevBadge =
    entry.status_severity === 'good' ? 'bg-status-good/20 text-status-good border-status-good/40'
    : entry.status_severity === 'warn' ? 'bg-status-warn/20 text-status-warn border-status-warn/40'
    :                                     'bg-status-crit/20 text-status-crit border-status-crit/40';
  const needsAdmin = !!entry.needs_admin;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${entry.drive} SMART details`}
    >
      <div
        className="bg-surface-800 border border-surface-600 rounded-lg w-full max-w-2xl p-5 shadow-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 className="text-base font-semibold">
            <span className="mr-2">💾</span>
            {entry.drive}
          </h2>
          <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border ${sevBadge}`}>
            {entry.health}
          </span>
        </div>

        {/* High-level explanation */}
        <div className="text-[11px] text-text-secondary leading-relaxed mb-4 p-2.5 rounded bg-surface-900/50 border border-surface-700">
          {severityHint(entry)}
        </div>

        {/* Attribute grid */}
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-[11px] mb-4">
          {entry.model && (
            <>
              <span className="text-text-secondary">Model</span>
              <span className="font-mono text-text-primary">{entry.model}</span>
            </>
          )}

          <span className="text-text-secondary">Health</span>
          <span className="text-text-primary">{entry.health}</span>

          <span className="text-text-secondary">Wear</span>
          <span>
            <span className="font-mono text-text-primary">
              {entry.wear_pct !== null && entry.wear_pct !== undefined ? `${entry.wear_pct}%` : (needsAdmin ? 'admin required' : 'n/a')}
            </span>
            <span className="ml-2 text-text-secondary italic">{wearHint(entry.wear_pct, needsAdmin)}</span>
          </span>

          <span className="text-text-secondary">Temperature</span>
          <span>
            <span className="font-mono text-text-primary">
              {entry.temp_c !== null && entry.temp_c !== undefined ? `${entry.temp_c} °C` : (needsAdmin ? 'admin required' : 'n/a')}
            </span>
            <span className="ml-2 text-text-secondary italic">{tempHint(entry.temp_c, needsAdmin)}</span>
          </span>

          <span className="text-text-secondary">Media errors</span>
          <span className="font-mono text-text-primary">
            {entry.media_errors !== null && entry.media_errors !== undefined ? entry.media_errors : (needsAdmin ? 'admin required' : 'n/a')}
          </span>

          <span className="text-text-secondary">Power-on hours</span>
          <span className="font-mono text-text-primary">
            {formatHours(entry.power_on_hours)}
          </span>

          <span className="text-text-secondary">Data source</span>
          <span className="text-text-secondary italic">
            {needsAdmin
              ? 'Basic info from Get-PhysicalDisk (non-admin). Click Refresh SMART for full attributes.'
              : 'Cached from elevated Run-SmartCheck. Values update whenever you click Refresh SMART (max every few hours).'}
          </span>
        </div>

        <div className="flex justify-between items-center gap-2 pt-3 border-t border-surface-700">
          <span className="text-[10px] text-text-secondary italic">
            Health status reflects Windows' HealthStatus API - reliable even when individual attributes are vendor-gated.
          </span>
          <div className="flex gap-2">
            {onRunSmartCheck && (
              <button
                onClick={() => { void onRunSmartCheck(); }}
                className="px-3 py-1.5 rounded-md text-xs bg-status-info/20 border border-status-info/50 text-status-info hover:bg-status-info/30"
                title="Re-run the elevated SMART check to refresh all attributes."
              >
                🔄 Refresh SMART (admin)
              </button>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
