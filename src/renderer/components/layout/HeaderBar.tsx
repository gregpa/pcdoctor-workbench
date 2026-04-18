import type { Severity } from '@shared/types.js';

interface HeaderBarProps {
  host: string;
  severity: Severity;
  label: string;
  subtitle: string;
  onScan: () => void;
  scanning: boolean;
}

export function HeaderBar({ host, severity, label, subtitle, onScan, scanning }: HeaderBarProps) {
  const badgeClass =
    severity === 'crit' ? 'bg-status-crit/10 text-status-crit border-status-crit/40' :
    severity === 'warn' ? 'bg-status-warn/10 text-status-warn border-status-warn/40' :
    'bg-status-good/10 text-status-good border-status-good/40';

  return (
    <div className="flex justify-between items-center p-3 px-4 bg-surface-800 border border-surface-600 rounded-lg mb-3">
      <div>
        <h1 className="text-[17px] font-bold tracking-tight">🖥 PC Doctor - {host}</h1>
        <div className="text-[10px] text-text-secondary mt-1">{subtitle}</div>
      </div>
      <div className="flex items-center gap-2">
        <span className={`px-3 py-1 rounded-full text-[10px] font-bold tracking-wide border ${badgeClass}`}>
          {label}
        </span>
        <button
          onClick={onScan}
          disabled={scanning}
          className="px-3.5 py-1.5 rounded-md text-xs font-semibold bg-[#238636] text-white
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {scanning ? '⏳ Scanning…' : '▶ Run Scan Now'}
        </button>
      </div>
    </div>
  );
}
