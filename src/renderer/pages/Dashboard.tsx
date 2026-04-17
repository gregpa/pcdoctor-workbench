import { useState } from 'react';
import { useStatus } from '@renderer/hooks/useStatus.js';
import { useAction } from '@renderer/hooks/useAction.js';
import { HeaderBar } from '@renderer/components/layout/HeaderBar.js';
import { KpiCard } from '@renderer/components/dashboard/KpiCard.js';
import { Gauge } from '@renderer/components/dashboard/Gauge.js';
import { ActionButton } from '@renderer/components/dashboard/ActionButton.js';
import { ACTIONS } from '@shared/actions.js';

export function Dashboard() {
  const { status, error, loading } = useStatus();
  const { run, running, lastResult, lastError } = useAction();
  const [toast, setToast] = useState<string | null>(null);

  if (loading) {
    return <div className="p-6 text-text-secondary">Loading diagnostic data…</div>;
  }

  if (error || !status) {
    return (
      <div className="p-6">
        <div className="bg-status-warn/10 border border-status-warn/40 rounded-lg p-4 text-sm">
          <div className="font-semibold text-status-warn mb-1">⚠ No diagnostic report available</div>
          <div className="text-text-secondary">
            {error?.message ?? 'latest.json not found at C:\\ProgramData\\PCDoctor\\reports\\latest.json.'}
            Run the daily scan or click "Run Scan Now" above to generate one.
          </div>
        </div>
      </div>
    );
  }

  async function handleAction(name: typeof ACTIONS[keyof typeof ACTIONS]['name']) {
    await run(name);
    if (lastError) {
      setToast(`✗ ${ACTIONS[name].label} failed: ${lastError.message}`);
    } else if (lastResult?.success) {
      setToast(`✓ ${ACTIONS[name].label} completed in ${lastResult.duration_ms}ms`);
    }
    setTimeout(() => setToast(null), 5000);
  }

  const subtitle = `${new Date(status.generated_at * 1000).toLocaleString()} · Polling every 60 s`;

  return (
    <div className="p-3 min-h-screen bg-surface-900">
      <HeaderBar
        host={status.host}
        severity={status.overall_severity}
        label={status.overall_label}
        subtitle={subtitle}
        onScan={() => { /* hooked up in Plan 2 */ }}
        scanning={false}
      />

      {/* KPI row */}
      <div className="grid grid-cols-6 gap-2.5 mb-3">
        {status.kpis.slice(0, 6).map((k) => (
          <KpiCard key={k.label} kpi={k} />
        ))}
      </div>

      {/* Gauges + placeholder trend chart area */}
      <div className="grid grid-cols-4 gap-2.5 mb-3">
        {status.gauges.slice(0, 3).map((g) => (
          <div key={g.label} className="bg-surface-800 border border-surface-600 rounded-lg p-3">
            <Gauge
              label={g.label}
              value={g.value}
              display={g.display}
              subtext={g.subtext}
              severity={g.severity}
            />
          </div>
        ))}
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 flex items-center justify-center text-text-secondary text-xs">
          Trend charts — coming in Plan 3
        </div>
      </div>

      {/* Quick actions */}
      <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 max-w-xl">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">
          ⚡ Quick Actions
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <ActionButton
            action={ACTIONS.flush_dns}
            icon="🔄"
            onRun={() => handleAction('flush_dns')}
            disabled={running !== null}
          />
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
