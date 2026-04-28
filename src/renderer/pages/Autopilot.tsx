import { useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';

interface AutopilotRule {
  id: string;
  tier: 1 | 2 | 3;
  description: string;
  trigger: 'schedule' | 'threshold';
  cadence: string | null;
  action_name: string | null;
  enabled: boolean;
  suppressed_until: number | null;
}

interface AutopilotActivity {
  id: number;
  ts: number;
  rule_id: string;
  tier: 1 | 2 | 3;
  action_name: string | null;
  outcome: string;
  bytes_freed: number | null;
  duration_ms: number | null;
  message: string | null;
}

const TIER_LABEL: Record<number, string> = { 1: 'Tier 1 · silent auto', 2: 'Tier 2 · auto + notify', 3: 'Tier 3 · alert only' };
const TIER_COLOR: Record<number, string> = {
  1: 'text-status-good',
  2: 'text-status-info',
  3: 'text-status-warn',
};
const TIER_BADGE: Record<number, string> = {
  1: 'bg-status-good/20 text-status-good',
  2: 'bg-status-info/20 text-status-info',
  3: 'bg-status-warn/20 text-status-warn',
};

function formatBytes(b: number | null): string {
  if (b === null || b === undefined) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function Autopilot() {
  const [tab, setTab] = useState<'activity' | 'rules'>('activity');
  const [rules, setRules] = useState<AutopilotRule[]>([]);
  const [activity, setActivity] = useState<AutopilotActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTier, setFilterTier] = useState<'all' | '1' | '2' | '3'>('all');
  const [filterTrigger, setFilterTrigger] = useState<'all' | 'schedule' | 'threshold'>('all');
  const [filterEnabled, setFilterEnabled] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [busyRule, setBusyRule] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function refreshAll() {
    const [rulesR, actR] = await Promise.all([
      api.listAutopilotRules(),
      api.getAutopilotActivity(30),
    ]);
    if (rulesR.ok) setRules(rulesR.data as AutopilotRule[]);
    if (actR.ok) setActivity(actR.data as AutopilotActivity[]);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshAll();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const lastRunByRule = useMemo(() => {
    const m = new Map<string, AutopilotActivity>();
    for (const a of activity) {
      const existing = m.get(a.rule_id);
      if (!existing || a.ts > existing.ts) m.set(a.rule_id, a);
    }
    return m;
  }, [activity]);

  if (loading) {
    return <div className="p-6 text-text-secondary">Loading Autopilot…</div>;
  }

  const thisWeek = activity.filter(a => a.ts > Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thisMonth = activity.filter(a => a.ts > Date.now() - 30 * 24 * 60 * 60 * 1000);
  const weekBytes = thisWeek.reduce((sum, a) => sum + (a.bytes_freed ?? 0), 0);
  const monthBytes = thisMonth.reduce((sum, a) => sum + (a.bytes_freed ?? 0), 0);
  const weekAutoRuns = thisWeek.filter(a => a.outcome === 'auto_run').length;
  const monthAutoRuns = thisMonth.filter(a => a.outcome === 'auto_run').length;
  const weekAlerts = thisWeek.filter(a => a.outcome === 'alerted').length;
  const weekSuppressed = thisWeek.filter(a => a.outcome === 'suppressed').length;

  const filteredRules = rules.filter(r => {
    if (filterTier !== 'all' && String(r.tier) !== filterTier) return false;
    if (filterTrigger !== 'all' && r.trigger !== filterTrigger) return false;
    if (filterEnabled === 'enabled' && !r.enabled) return false;
    if (filterEnabled === 'disabled' && r.enabled) return false;
    return true;
  });

  async function toggleEnabled(rule: AutopilotRule) {
    setBusyRule(rule.id);
    const r = await api.setAutopilotRuleEnabled(rule.id, !rule.enabled);
    if (r.ok) {
      setToast(`${rule.id}: ${rule.enabled ? 'disabled' : 'enabled'}`);
      await refreshAll();
    } else {
      setToast(`Failed: ${r.error.message}`);
    }
    setBusyRule(null);
    setTimeout(() => setToast(null), 3000);
  }

  async function snooze(rule: AutopilotRule, hours: number | 'forever') {
    setBusyRule(rule.id);
    const h = hours === 'forever' ? 24 * 30 : hours; // clamped to 30d in main
    const r = await api.suppressAutopilotRule(rule.id, h);
    if (r.ok) {
      setToast(`${rule.id}: snoozed ${hours === 'forever' ? '30d (max)' : `${hours}h`}`);
      await refreshAll();
    } else {
      setToast(`Failed: ${r.error.message}`);
    }
    setBusyRule(null);
    setTimeout(() => setToast(null), 3000);
  }

  async function runNow(rule: AutopilotRule) {
    setBusyRule(rule.id);
    const r = await api.runAutopilotRuleNow(rule.id);
    if (r.ok) {
      setToast(`${rule.id}: ${r.data.outcome}${r.data.message ? ` — ${r.data.message}` : ''}`);
      await refreshAll();
    } else {
      setToast(`Failed: ${r.error.message}`);
    }
    setBusyRule(null);
    setTimeout(() => setToast(null), 4000);
  }

  async function exportRules() {
    const r = await api.exportAutopilotRules();
    if (!r.ok) { setToast(`Export failed: ${r.error.message}`); return; }
    try {
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `autopilot-rules-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setToast(`Export error: ${e.message}`);
    }
  }

  async function importRules() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const parsed = JSON.parse(text);
        const r = await api.importAutopilotRules(parsed);
        if (r.ok) { setToast(`Imported ${r.data.imported} rules`); await refreshAll(); }
        else { setToast(`Import failed: ${r.error.message}`); }
      } catch (e: any) {
        setToast(`Import error: ${e.message}`);
      }
      setTimeout(() => setToast(null), 3000);
    };
    input.click();
  }

  function triggerLabel(r: AutopilotRule): string {
    if (r.trigger === 'schedule' && r.cadence) return `⏱ ${r.cadence}`;
    return '⚡ threshold';
  }

  return (
    <div className="p-5 max-w-6xl">
      <h1 className="text-lg font-bold mb-1">🤖 Autopilot</h1>
      <div className="text-[11px] text-text-secondary mb-4">
        Tiered automation policy engine. Tier 1/2 rules auto-run. Tier 3 rules alert Greg via Telegram.
      </div>

      {/* Tab bar */}
      <div className="flex gap-0.5 mb-4 border-b border-surface-700">
        <TabButton active={tab === 'activity'} onClick={() => setTab('activity')}>Activity</TabButton>
        <TabButton active={tab === 'rules'} onClick={() => setTab('rules')}>Rules ({rules.length})</TabButton>
      </div>

      {tab === 'activity' && (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-4 gap-3 mb-5">
            <StatCard label="Auto-runs (7d)" value={weekAutoRuns} />
            <StatCard label="Auto-runs (30d)" value={monthAutoRuns} />
            <StatCard label="Alerts sent (7d)" value={weekAlerts} tone="warn" />
            <StatCard label="Suppressed (7d)" value={weekSuppressed} />
          </div>
          <div className="grid grid-cols-2 gap-3 mb-5">
            <StatCard label="Freed this week" value={formatBytes(weekBytes)} />
            <StatCard label="Freed this month" value={formatBytes(monthBytes)} />
          </div>

          {/* Activity log */}
          <div>
            <h2 className="text-sm font-semibold mb-2">Activity (last 30 days — {activity.length} entries)</h2>
            <div className="pcd-section overflow-x-auto p-0">
              <table className="w-full text-xs">
                <thead className="bg-surface-700 text-text-secondary text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-3 py-2">When</th>
                    <th className="text-left px-3 py-2">Rule</th>
                    <th className="text-left px-3 py-2">Tier</th>
                    <th className="text-left px-3 py-2">Action</th>
                    <th className="text-left px-3 py-2">Outcome</th>
                    <th className="text-right px-3 py-2">Bytes freed</th>
                    <th className="text-left px-3 py-2">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-6 text-center text-text-secondary">No activity yet — Autopilot has not taken any actions in the last 30 days.</td></tr>
                  )}
                  {activity.map(a => (
                    <tr key={a.id} className="border-t border-surface-700">
                      <td className="px-3 py-1.5 text-text-secondary whitespace-nowrap">{new Date(a.ts).toLocaleString()}</td>
                      <td className="px-3 py-1.5 font-mono text-[10px]">{a.rule_id}</td>
                      <td className={`px-3 py-1.5 ${TIER_COLOR[a.tier]}`}>T{a.tier}</td>
                      <td className="px-3 py-1.5">{a.action_name ?? '—'}</td>
                      <td className="px-3 py-1.5">
                        <OutcomeBadge outcome={a.outcome} />
                      </td>
                      <td className="px-3 py-1.5 text-right">{formatBytes(a.bytes_freed)}</td>
                      <td className="px-3 py-1.5 text-text-secondary truncate max-w-xs">{a.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'rules' && (
        <>
          {/* Filter bar + import/export */}
          <div className="flex flex-wrap items-center gap-2 mb-3 text-[11px]">
            <FilterSelect label="Tier" value={filterTier} onChange={v => setFilterTier(v as any)}
              options={[{ v: 'all', label: 'All' }, { v: '1', label: 'T1' }, { v: '2', label: 'T2' }, { v: '3', label: 'T3' }]} />
            <FilterSelect label="Trigger" value={filterTrigger} onChange={v => setFilterTrigger(v as any)}
              options={[{ v: 'all', label: 'All' }, { v: 'schedule', label: 'Schedule' }, { v: 'threshold', label: 'Threshold' }]} />
            <FilterSelect label="State" value={filterEnabled} onChange={v => setFilterEnabled(v as any)}
              options={[{ v: 'all', label: 'All' }, { v: 'enabled', label: 'Enabled' }, { v: 'disabled', label: 'Disabled' }]} />
            <div className="flex-1" />
            <button
              onClick={exportRules}
              className="px-2.5 py-1 rounded bg-surface-700 border border-surface-600 hover:border-status-info/40"
            >
              ⬇ Export
            </button>
            <button
              onClick={importRules}
              className="px-2.5 py-1 rounded bg-surface-700 border border-surface-600 hover:border-status-info/40"
            >
              ⬆ Import
            </button>
          </div>

          {/* Rules table */}
          <div className="pcd-section overflow-x-auto p-0">
            <table className="w-full text-xs">
              <thead className="bg-surface-700 text-text-secondary text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="text-left px-3 py-2 w-12">Tier</th>
                  <th className="text-left px-3 py-2">ID</th>
                  <th className="text-left px-3 py-2">Description</th>
                  <th className="text-left px-3 py-2">Cadence / Trigger</th>
                  <th className="text-left px-3 py-2 w-20">Enabled</th>
                  <th className="text-left px-3 py-2">Last run</th>
                  <th className="text-left px-3 py-2">Last outcome</th>
                  <th className="text-right px-3 py-2 w-56">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRules.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-text-secondary">No rules match the filters.</td></tr>
                )}
                {filteredRules.map(r => {
                  const last = lastRunByRule.get(r.id);
                  const isSnoozed = r.suppressed_until && r.suppressed_until > Date.now();
                  return (
                    <tr key={r.id} className="border-t border-surface-700">
                      <td className="px-3 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${TIER_BADGE[r.tier]}`}>T{r.tier}</span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-[10px]">{r.id}</td>
                      <td className="px-3 py-1.5">{r.description}</td>
                      <td className="px-3 py-1.5 text-text-secondary">{triggerLabel(r)}</td>
                      <td className="px-3 py-1.5">
                        <label className="inline-flex items-center gap-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={r.enabled}
                            onChange={() => toggleEnabled(r)}
                            disabled={busyRule === r.id}
                          />
                          {isSnoozed && <span className="text-[10px] text-status-warn">(snoozed)</span>}
                        </label>
                      </td>
                      <td className="px-3 py-1.5 text-text-secondary whitespace-nowrap">
                        {last ? new Date(last.ts).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-1.5">
                        {last ? <OutcomeBadge outcome={last.outcome} /> : <span className="text-text-secondary">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <div className="inline-flex items-center gap-1">
                          <select
                            onChange={(e) => {
                              const v = e.target.value;
                              if (!v) return;
                              const h = v === 'forever' ? ('forever' as const) : Number(v);
                              snooze(r, h);
                              e.target.value = '';
                            }}
                            disabled={busyRule === r.id}
                            className="bg-surface-700 border border-surface-600 rounded px-1.5 py-0.5 text-[10px]"
                            defaultValue=""
                          >
                            <option value="">Snooze…</option>
                            <option value="24">24h</option>
                            <option value="168">7d</option>
                            <option value="720">30d</option>
                            <option value="forever">Forever (30d max)</option>
                          </select>
                          <button
                            onClick={() => runNow(r)}
                            disabled={busyRule === r.id}
                            className="px-2 py-0.5 rounded bg-status-info/20 text-status-info border border-status-info/40 text-[10px] disabled:opacity-50"
                          >
                            Run Now
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm border-b-2 -mb-px ${active ? 'border-status-info text-text-primary font-semibold' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
    >
      {children}
    </button>
  );
}

function FilterSelect<T extends string>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (v: string) => void; options: { v: string; label: string }[];
}) {
  return (
    <label className="inline-flex items-center gap-1">
      <span className="text-text-secondary">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-surface-700 border border-surface-600 rounded px-1.5 py-0.5 text-[11px]"
      >
        {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </label>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: 'warn' }) {
  const toneClass = tone === 'warn' ? 'text-status-warn' : 'text-text-primary';
  return (
    <div className="pcd-panel">
      <div className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${toneClass}`}>{value}</div>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const conf: Record<string, string> = {
    auto_run: 'bg-status-good/20 text-status-good',
    alerted: 'bg-status-warn/20 text-status-warn',
    suppressed: 'bg-surface-700 text-text-secondary',
    skipped: 'bg-surface-700 text-text-secondary',
    dispatched: 'bg-status-info/20 text-status-info',
    error: 'bg-status-crit/20 text-status-crit',
  };
  const cls = conf[outcome] ?? 'bg-surface-700 text-text-secondary';
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${cls}`}>{outcome}</span>;
}
