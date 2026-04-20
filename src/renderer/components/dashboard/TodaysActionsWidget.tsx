import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@renderer/lib/ipc.js';
import type { SystemStatus } from '@shared/types.js';

interface AutopilotActivity {
  id: number;
  ts: number;
  rule_id: string;
  tier: 1 | 2 | 3;
  action_name: string | null;
  outcome: string;
  bytes_freed: number | null;
  message: string | null;
}

/**
 * "Today's Actions" — 3-section prioritized widget for the Dashboard.
 *
 * Section 1: 🔴 Do Now   — critical findings
 * Section 2: 🟡 This Week — warnings
 * Section 3: ℹ  Info     — info-level findings
 *
 * Plus a summary of what Autopilot handled this week.
 */
export function TodaysActionsWidget({ status }: { status: SystemStatus }) {
  const navigate = useNavigate();
  const [activity, setActivity] = useState<AutopilotActivity[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await api.getAutopilotActivity(7);
      if (!cancelled && r.ok) setActivity(r.data as AutopilotActivity[]);
    })();
    return () => { cancelled = true; };
  }, []);

  const crit = status.findings.filter(f => f.severity === 'critical');
  const warn = status.findings.filter(f => f.severity === 'warning');
  const info = status.findings.filter(f => f.severity === 'info');

  const weeklyAutoRuns = activity.filter(a => a.outcome === 'auto_run');

  return (
    <div className="bg-surface-800 border border-surface-600 rounded-lg p-4 mb-3">
      <div className="flex justify-between items-center mb-3">
        <div className="text-sm font-semibold">🎯 Today's Actions</div>
        <button
          onClick={() => navigate('/autopilot')}
          className="text-[10px] text-text-secondary hover:text-text-primary"
        >
          View Autopilot activity →
        </button>
      </div>

      {status.findings.length === 0 && (
        <div className="text-xs text-text-secondary py-3">
          ✅ Nothing urgent. System is healthy.
        </div>
      )}

      {crit.length > 0 && (
        <Section
          title="🔴 DO NOW (Tier 3 Critical)"
          color="text-status-crit"
          findings={crit}
        />
      )}
      {warn.length > 0 && (
        <Section
          title="🟡 THIS WEEK (Tier 3 Important)"
          color="text-status-warn"
          findings={warn}
        />
      )}
      {info.length > 0 && (
        <Section
          title="ℹ  INFO"
          color="text-status-info"
          findings={info}
        />
      )}

      {weeklyAutoRuns.length > 0 && (
        <div className="mt-4 pt-3 border-t border-surface-700">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1.5">
            Autopilot handled this week ({weeklyAutoRuns.length}):
          </div>
          <div className="space-y-1">
            {weeklyAutoRuns.slice(0, 5).map(a => (
              <div key={a.id} className="text-[11px] text-text-secondary">
                ✓ {a.action_name ?? a.rule_id}
                {a.bytes_freed ? ` (${(a.bytes_freed / 1024 / 1024).toFixed(1)} MB)` : ''}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  color,
  findings,
}: {
  title: string;
  color: string;
  findings: Array<{ area: string; message: string }>;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className={`text-[10px] font-semibold uppercase tracking-wider mb-1.5 ${color}`}>{title}</div>
      <div className="space-y-1">
        {findings.slice(0, 8).map((f, i) => (
          <div key={i} className="text-xs flex items-start gap-2">
            <span className="text-text-secondary text-[10px] mt-0.5">•</span>
            <div className="flex-1 min-w-0">
              <span className="text-text-primary">{f.message}</span>
              {f.area && <span className="ml-2 text-[10px] text-text-secondary">[{f.area}]</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
