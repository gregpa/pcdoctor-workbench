import { useState } from 'react';
import type { Severity } from '@shared/types.js';
import { api } from '@renderer/lib/ipc.js';

interface HeaderBarProps {
  host: string;
  severity: Severity;
  label: string;
  subtitle: string;
  onScan: () => void;
  scanning: boolean;
}

export function HeaderBar({ host, severity, label, subtitle, onScan, scanning }: HeaderBarProps) {
  const [exporting, setExporting] = useState(false);
  const [exportToast, setExportToast] = useState<string | null>(null);

  const badgeClass =
    severity === 'crit' ? 'bg-status-crit/10 text-status-crit border-status-crit/40' :
    severity === 'warn' ? 'bg-status-warn/10 text-status-warn border-status-warn/40' :
    'bg-status-good/10 text-status-good border-status-good/40';

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    setExportToast('Building report...');
    try {
      const r = await api.exportClaudeReport();
      if (!r.ok) {
        setExportToast(`Export failed: ${r.error.message}`);
        setTimeout(() => setExportToast(null), 6000);
        return;
      }
      // Copy to clipboard
      try {
        await navigator.clipboard.writeText(r.data.markdown);
        const kb = Math.round(r.data.byte_count / 1024);
        setExportToast(`Copied to clipboard (${kb} KB, ${r.data.line_count} lines). File also saved at: ${r.data.file_path}`);
      } catch {
        // Clipboard blocked - fall back to just the file path
        setExportToast(`Clipboard blocked. Report written to: ${r.data.file_path}`);
      }
      setTimeout(() => setExportToast(null), 12000);
    } catch (e: any) {
      setExportToast(`Export error: ${e?.message ?? 'unknown'}`);
      setTimeout(() => setExportToast(null), 6000);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div className="flex justify-between items-center p-3 px-4 bg-surface-800 border border-surface-600 rounded-lg mb-3">
        <div>
          <h1 className="text-[17px] font-bold tracking-tight">🖥 PC Doctor - {host}</h1>
          <div className="text-[10px] text-text-secondary mt-1">{subtitle}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const target = document.getElementById('active-alerts');
              if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                // Brief flash to draw the eye
                target.classList.add('ring-2', 'ring-status-info');
                setTimeout(() => target.classList.remove('ring-2', 'ring-status-info'), 1500);
              }
            }}
            className={`px-3 py-1 rounded-full text-[10px] font-bold tracking-wide border cursor-pointer hover:brightness-125 transition ${badgeClass}`}
            title="Click to jump to Active Alerts"
          >
            {label}
          </button>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="px-3 py-1.5 rounded-md text-xs font-semibold bg-status-info/15 border border-status-info/40 text-status-info hover:bg-status-info/25 disabled:opacity-50"
            title="Copy a full diagnostic snapshot (findings, failed actions, event log, scheduled tasks, system info) to the clipboard for pasting into Claude Code or claude.ai. Also saves a .md file under %PROGRAMDATA%\PCDoctor\exports\."
          >
            {exporting ? '⏳ Exporting...' : '🧠 Export for Claude'}
          </button>
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
      {exportToast && (
        <div className="fixed bottom-4 right-4 z-50 max-w-md px-4 py-3 bg-surface-800 border border-status-info/40 rounded-lg text-xs shadow-xl">
          <div className="font-semibold text-status-info mb-1">Export for Claude</div>
          <div className="text-text-secondary break-all">{exportToast}</div>
        </div>
      )}
    </>
  );
}
