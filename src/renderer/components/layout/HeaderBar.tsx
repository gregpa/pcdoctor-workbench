import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Severity } from '@shared/types.js';
import { api } from '@renderer/lib/ipc.js';
import { PENDING_CONTEXT_KEY } from '@renderer/pages/Claude.js';

interface HeaderBarProps {
  host: string;
  severity: Severity;
  label: string;
  subtitle: string;
  onScan: () => void;
  scanning: boolean;
}

export function HeaderBar({ host, severity, label, subtitle, onScan, scanning }: HeaderBarProps) {
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);
  const [exportToast, setExportToast] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(0);

  // Sync zoom widget with the actual window zoom on mount + any time it
  // changes (Ctrl+= / Ctrl+- keyboard shortcuts are handled in main).
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const r = await (api as any).getZoom?.();
      if (alive && r?.ok && r.data !== zoomLevel) setZoomLevel(r.data);
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doZoom(delta: number) {
    const r = await (api as any).setZoom?.(delta);
    if (r?.ok) setZoomLevel(r.data);
  }

  // zoomLevel of 0 == 100%. Each step is ~25%; the formula matches the way
  // Chromium maps SetZoomLevel to a visible percentage.
  const zoomPct = Math.round(Math.pow(1.2, zoomLevel) * 100);

  const badgeClass =
    severity === 'crit' ? 'bg-status-crit/10 text-status-crit border-status-crit/40' :
    severity === 'warn' ? 'bg-status-warn/10 text-status-warn border-status-warn/40' :
    'bg-status-good/10 text-status-good border-status-good/40';

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    setExportToast('Building report + launching Claude...');
    try {
      const r = await api.exportClaudeReport();
      if (!r.ok) {
        setExportToast(`Export failed: ${r.error.message}`);
        setTimeout(() => setExportToast(null), 6000);
        return;
      }
      // Stash the markdown so the Claude page can seed the embedded
      // terminal with it as pre-loaded context. Also copy to clipboard as a
      // fallback (user can paste into claude.ai or elsewhere).
      try { sessionStorage.setItem(PENDING_CONTEXT_KEY, r.data.markdown); } catch {}
      try { await navigator.clipboard.writeText(r.data.markdown); } catch {}
      const kb = Math.round(r.data.byte_count / 1024);
      setExportToast(`Report ready (${kb} KB, ${r.data.line_count} lines) - opening Claude...`);
      setTimeout(() => setExportToast(null), 5000);
      navigate('/claude');
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
          <div className="flex items-center gap-0.5 bg-surface-900 border border-surface-600 rounded-md" title="Zoom (Ctrl+= / Ctrl+- / Ctrl+0)">
            <button
              onClick={() => doZoom(-0.5)}
              className="px-2 py-1 text-xs hover:bg-surface-700 rounded-l-md"
              aria-label="Zoom out"
              disabled={zoomLevel <= -3}
            >-</button>
            <button
              onClick={() => doZoom(0)}
              className="px-2 py-1 text-[10px] font-mono text-text-secondary hover:bg-surface-700 min-w-[48px]"
              aria-label="Reset zoom"
              title="Click to reset to 100%"
            >{zoomPct}%</button>
            <button
              onClick={() => doZoom(0.5)}
              className="px-2 py-1 text-xs hover:bg-surface-700 rounded-r-md"
              aria-label="Zoom in"
              disabled={zoomLevel >= 5}
            >+</button>
          </div>
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
