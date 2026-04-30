import { useForecast } from '@renderer/hooks/useForecast.js';
import { useAction } from '@renderer/hooks/useAction.js';
import { ACTIONS } from '@shared/actions.js';
import type { ForecastProjection, ActionName } from '@shared/types.js';
import { useState } from 'react';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

function severityClasses(s: ForecastProjection['severity']) {
  switch (s) {
    case 'critical': return 'border-status-crit/40 bg-status-crit/[0.06] text-status-crit';
    case 'important': return 'border-status-warn/40 bg-status-warn/[0.06] text-status-warn';
    case 'low': return 'border-surface-600 bg-surface-800 text-text-secondary';
    default: return 'border-status-info/40 bg-status-info/[0.06] text-status-info';
  }
}

function sevIcon(s: ForecastProjection['severity']) {
  return s === 'critical' ? '🔴' : s === 'important' ? '🟡' : s === 'low' ? '🟢' : 'ℹ';
}

export function Forecast() {
  const { data, loading, error, regenerate } = useForecast();
  const { run, running } = useAction();
  const [toast, setToast] = useState<string | null>(null);

  if (loading) return (
    <div className="p-6 flex items-center gap-3 text-text-secondary">
      <LoadingSpinner size={18} /><span>Computing forecasts…</span>
    </div>
  );
  if (error) return <div className="p-6 text-status-warn">Forecast error: {error}</div>;
  if (!data) return <div className="p-6 text-text-secondary">No forecast data yet.</div>;

  async function applyAction(name: ActionName) {
    await run({ name });
    setToast(`${ACTIONS[name].label} triggered`);
    setTimeout(() => setToast(null), 4000);
  }

  return (
    <div className="p-5">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h1 className="text-lg font-bold">🔮 Degradation Forecast</h1>
          <div className="text-[11px] text-text-secondary mt-1">
            Generated: {new Date(data.generated_at * 1000).toLocaleString()} · Based on metrics history
          </div>
        </div>
        <button
          onClick={regenerate}
          title="Re-run the forecast engine over your full metrics history. Recomputes linear regression + EWMA models and refreshes projected threshold-crossing dates. Read-only; no admin required."
          className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold"
        >
          Regenerate Now
        </button>
      </div>

      {data.projections.length === 0 && data.insufficient_data.length > 0 && (
        <div className="bg-status-info/10 border border-status-info/40 rounded-lg p-4 text-sm mb-4">
          <div className="font-semibold text-status-info mb-1">Gathering baseline data</div>
          <div className="text-text-secondary text-xs">
            Forecasts need at least 14 data points <strong>and</strong> 7 days of calendar span.
            Metrics accumulate every 60s while the dashboard runs.
            <ul className="mt-2 space-y-0.5">
              {data.insufficient_data.map((x: any) => {
                const reason = x.reason ?? 'not_enough_points';
                if (reason === 'not_enough_span') {
                  const span = x.days_span ?? 0;
                  const req = x.days_required ?? 7;
                  const remaining = Math.max(0, req - span).toFixed(1);
                  return (
                    <li key={x.metric}>
                      • <code>{x.metric}</code> - {x.points} points collected;{' '}
                      <strong>{span}d / {req}d calendar span</strong> ({remaining}d more needed)
                    </li>
                  );
                }
                return (
                  <li key={x.metric}>
                    • <code>{x.metric}</code> - {x.points} / {x.required} points collected
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {data.projections.map((p) => (
          <div key={p.metric} className={`pcd-panel pcd-panel-interactive ${severityClasses(p.severity)}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span>{sevIcon(p.severity)}</span>
                  <span className="font-bold text-sm">{p.metric_label}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-current opacity-80">
                    {p.confidence}
                  </span>
                </div>
                <div className="text-xs text-text-primary">
                  Current: <strong>{Math.round(p.current_value * 10) / 10}</strong>
                  {p.threshold_critical !== null && <> · Critical threshold: <strong>{p.threshold_critical}</strong></>}
                </div>
                {p.projected_critical_date && p.days_until_critical !== null && (
                  <div className="text-xs mt-1">
                    Projected critical: <strong>{p.projected_critical_date}</strong> (in {Math.round(p.days_until_critical)} days)
                  </div>
                )}
                {p.slope_per_day !== null && (
                  <div className="text-[10px] text-text-secondary mt-1">
                    Slope: {p.slope_per_day > 0 ? '+' : ''}{p.slope_per_day.toFixed(3)}/day · r² = {p.r_squared?.toFixed(2) ?? '-'}
                  </div>
                )}
              </div>
              {p.preventive_action && (
                <button
                  onClick={() => applyAction(p.preventive_action!.action_name as ActionName)}
                  disabled={running !== null}
                  className="px-3 py-1.5 rounded-md bg-status-warn text-black text-[11px] font-bold shrink-0 disabled:opacity-50"
                >
                  {ACTIONS[p.preventive_action.action_name as ActionName]?.icon} {p.preventive_action.label}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {toast && (
        <div className="fixed bottom-4 right-4 pcd-button rounded-lg px-4 py-3 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
