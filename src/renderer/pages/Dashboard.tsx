import { useState } from 'react';
import { useStatus } from '@renderer/hooks/useStatus.js';
import { useAction } from '@renderer/hooks/useAction.js';
import { HeaderBar } from '@renderer/components/layout/HeaderBar.js';
import { KpiCard } from '@renderer/components/dashboard/KpiCard.js';
import { Gauge } from '@renderer/components/dashboard/Gauge.js';
import { ActionButton } from '@renderer/components/dashboard/ActionButton.js';
import { AlertCard } from '@renderer/components/dashboard/AlertCard.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName } from '@shared/types.js';

// Actions displayed in the dashboard Quick Actions grid
const QUICK_ACTIONS: ActionName[] = [
  'clear_temp_files', 'flush_dns',
  'rebuild_search_index', 'run_sfc',
  'run_dism', 'remap_nas',
  'compact_docker', 'trim_ssd',
  'apply_wsl_cap', 'restart_explorer',
  'flush_arp_cache', 'kill_process',
];

export function Dashboard() {
  const { status, error, loading } = useStatus();
  const { run, running } = useAction();
  const [toast, setToast] = useState<string | null>(null);

  if (loading) return <div className="p-6 text-text-secondary">Loading…</div>;
  if (error || !status) {
    return (
      <div className="p-6">
        <div className="bg-status-warn/10 border border-status-warn/40 rounded-lg p-4 text-sm">
          <div className="font-semibold text-status-warn mb-1">⚠ No diagnostic report available</div>
          <div className="text-text-secondary">{error?.message ?? 'Run a scan to generate one.'}</div>
        </div>
      </div>
    );
  }

  async function handleAction(name: ActionName) {
    await run({ name });
    setToast(`${ACTIONS[name].label} completed`);
    setTimeout(() => setToast(null), 4000);
  }

  const subtitle = `${new Date(status.generated_at * 1000).toLocaleString()} · Polling every 60 s`;

  return (
    <div className="p-3 min-h-screen bg-surface-900">
      <HeaderBar
        host={status.host}
        severity={status.overall_severity}
        label={status.overall_label}
        subtitle={subtitle}
        onScan={() => { /* Plan 3 */ }}
        scanning={false}
      />

      {/* KPI row */}
      <div className="grid grid-cols-6 gap-2.5 mb-3">
        {status.kpis.slice(0, 6).map((k) => (<KpiCard key={k.label} kpi={k} />))}
      </div>

      {/* Gauges + placeholder trend chart */}
      <div className="grid grid-cols-4 gap-2.5 mb-3">
        {status.gauges.slice(0, 3).map((g) => (
          <div key={g.label} className="bg-surface-800 border border-surface-600 rounded-lg p-3">
            <Gauge label={g.label} value={g.value} display={g.display} subtext={g.subtext} severity={g.severity} />
          </div>
        ))}
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 flex items-center justify-center text-text-secondary text-xs">
          Trend charts — Plan 3
        </div>
      </div>

      {/* Three-column bottom: Actions grid | Alerts | (Services placeholder) */}
      <div className="grid grid-cols-3 gap-2.5">
        {/* Quick Actions grid */}
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2 flex items-center gap-1">
            <span>⚡</span><span>One-Click Actions</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {QUICK_ACTIONS.map((name) => (
              <ActionButton key={name} action={ACTIONS[name]} onRun={() => handleAction(name)} disabled={running !== null} />
            ))}
          </div>
        </div>

        {/* Active Alerts */}
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">
            Active Alerts {status.findings.length > 0 ? `(${status.findings.length})` : ''}
          </div>
          <div className="space-y-2">
            {status.findings.length === 0 && (
              <div className="text-xs text-text-secondary">No active findings. System healthy.</div>
            )}
            {status.findings.map((f, i) => (
              <AlertCard key={i} finding={f} onApply={handleAction} />
            ))}
          </div>
        </div>

        {/* Services & Processes — placeholder for now */}
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">
            Services & Processes
          </div>
          <div className="text-xs text-text-secondary">Full service pill panel arrives in Plan 3 (richer service health detection).</div>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
