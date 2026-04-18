import { useState, useEffect } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { useAction } from '@renderer/hooks/useAction.js';
import { useConfirm } from '@renderer/lib/confirmContext.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName } from '@shared/types.js';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

interface PendingUpdate {
  title: string;
  kb: string;
  size_mb: number;
  categories: string[];
  is_security: boolean;
  severity: string;
  reboot_behavior: string;
}

interface WUDetail {
  pending: PendingUpdate[];
  pending_count: number;
  installed_last_50: Array<{ title: string; date: string }>;
  stuck: boolean;
  stuck_signals: Array<{ kind: string; value: string; severity: string }>;
}

export function Updates() {
  const [data, setData] = useState<WUDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { run, running } = useAction();
  const confirm = useConfirm();
  const [toast, setToast] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<any>(null);
  const [nvInfo, setNvInfo] = useState<any>(null);

  const load = async () => {
    setLoading(true);
    const r = await api.getWindowsUpdateDetail();
    if (r.ok) { setData(r.data as WUDetail); setError(null); }
    else setError(r.error.message);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  async function install(name: ActionName) {
    const def = ACTIONS[name];
    const ok = await confirm({
      title: def.label,
      body: <div><p className="mb-2">{def.tooltip}</p><p className="text-xs">Estimated: ~{def.estimated_duration_s}s · Rollback: Tier {def.rollback_tier}</p></div>,
      tier: 'destructive',
      confirmLabel: 'Install',
    });
    if (!ok) return;
    await run({ name });
    setToast(`${def.label} completed`);
    setTimeout(() => setToast(null), 6000);
    await load();
  }

  async function checkReadiness() {
    setToast('Checking upgrade readiness…');
    const r = await api.getFeatureUpgradeReadiness();
    if (r.ok) { setReadiness(r.data); setToast(null); }
    else { setToast(`Readiness check failed: ${r.error.message}`); setTimeout(() => setToast(null), 4000); }
  }

  async function checkNvidia() {
    setToast('Checking Nvidia driver feed…');
    const r = await api.getNvidiaDriverLatest();
    if (r.ok) { setNvInfo(r.data); setToast(null); }
    else { setToast(`Nvidia check failed: ${r.error.message}`); setTimeout(() => setToast(null), 4000); }
  }

  if (loading) return (
    <div className="p-6 flex items-center gap-3 text-text-secondary">
      <LoadingSpinner size={18} /><span>Querying Windows Update…</span>
    </div>
  );
  if (error) return <div className="p-6 text-status-warn">Error: {error}</div>;
  if (!data) return <div className="p-6 text-text-secondary">No data</div>;

  const securityKbs = data.pending.filter(p => p.is_security);
  const otherKbs = data.pending.filter(p => !p.is_security);

  return (
    <div className="p-5 max-w-5xl">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h1 className="text-lg font-bold">🪟 Windows Updates</h1>
          <div className="text-[11px] text-text-secondary mt-1">
            {data.pending_count} pending · {securityKbs.length} security · {otherKbs.length} other
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => install('repair_windows_update')} disabled={running !== null} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 disabled:opacity-50">
            Repair WU
          </button>
          <button onClick={load} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">
            Refresh
          </button>
        </div>
      </div>

      {data.stuck && data.stuck_signals.length > 0 && (
        <div className="mb-4 p-3 bg-status-crit/10 border border-status-crit/40 rounded-lg">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-bold text-sm text-status-crit flex items-center gap-2">
                <span>⚠</span><span>Windows Update Appears Stuck</span>
              </div>
              <ul className="text-[11px] text-text-secondary mt-1 list-disc pl-4">
                {data.stuck_signals.map((s, i) => <li key={i}>{s.value}</li>)}
              </ul>
            </div>
            <button
              onClick={() => install('repair_windows_update')}
              disabled={running !== null}
              className="px-3 py-1.5 rounded-md text-xs bg-status-crit text-white font-bold disabled:opacity-50 whitespace-nowrap"
            >
              🔧 Repair Windows Update
            </button>
          </div>
        </div>
      )}

      {data.pending_count > 0 && (
        <div className="mb-4 p-3 bg-surface-800 border border-surface-600 rounded-lg flex items-center gap-3">
          <div className="flex-1 text-sm">Ready to install. Creates a restore point first.</div>
          {securityKbs.length > 0 && (
            <button onClick={() => install('install_security_updates')} disabled={running !== null} className="px-3 py-1.5 rounded-md bg-status-warn text-black text-xs font-bold disabled:opacity-50">
              🛡 Install Security Only ({securityKbs.length})
            </button>
          )}
          <button onClick={() => install('install_windows_updates')} disabled={running !== null} className="px-3 py-1.5 rounded-md bg-[#238636] text-white text-xs font-bold disabled:opacity-50">
            Install All ({data.pending_count})
          </button>
        </div>
      )}

      <section className="mb-5">
        <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">Pending Updates</h2>
        {data.pending.length === 0 ? (
          <div className="bg-surface-800 border border-surface-600 rounded-lg p-4 text-sm text-text-secondary">
            ✓ System is up to date.
          </div>
        ) : (
          <div className="space-y-1.5">
            {data.pending.map((u, i) => (
              <div key={i} className={`flex items-center gap-3 p-3 rounded-md text-xs ${u.is_security ? 'bg-status-warn/10 border border-status-warn/40' : 'bg-surface-800 border border-surface-600'}`}>
                {u.is_security && <span className="text-[9px] px-2 py-0.5 rounded bg-status-warn/30 text-status-warn font-bold">SECURITY</span>}
                {u.kb && <span className="text-[10px] font-mono text-text-secondary">{u.kb}</span>}
                <div className="flex-1">
                  <div className="truncate">{u.title}</div>
                  {u.reboot_behavior && u.reboot_behavior !== 'Never' && <div className="text-[9px] text-text-secondary">Reboot: {u.reboot_behavior}</div>}
                </div>
                <span className="text-[10px] text-text-secondary">{u.size_mb} MB</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">Recently Installed (last 50)</h2>
        <div className="bg-surface-800 border border-surface-600 rounded-lg max-h-80 overflow-y-auto">
          {data.installed_last_50.length === 0 ? (
            <div className="p-4 text-xs text-text-secondary">No install history available</div>
          ) : (
            data.installed_last_50.map((h, i) => (
              <div key={i} className="flex gap-3 px-3 py-1.5 text-[11px] border-b border-surface-700 last:border-0">
                <span className="text-text-secondary w-32 shrink-0">{new Date(h.date).toLocaleDateString()}</span>
                <span className="truncate flex-1">{h.title}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">Feature Upgrade Readiness</h2>
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-4">
          {!readiness ? (
            <button onClick={checkReadiness} className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold">
              Check Readiness
            </button>
          ) : (
            <div>
              <div className={`text-sm font-bold mb-2 ${readiness.ready ? 'text-status-good' : 'text-status-warn'}`}>
                {readiness.ready ? '✓ Ready for feature upgrade' : `⚠ ${readiness.blockers.length} blocker(s)`}
              </div>
              <div className="space-y-1">
                {readiness.checks.map((c: any, i: number) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span>{c.ok ? '✓' : '✗'} {c.name.replace(/_/g, ' ')}</span>
                    <span className={c.ok ? 'text-text-secondary' : 'text-status-warn'}>{c.value}</span>
                  </div>
                ))}
              </div>
              <button onClick={checkReadiness} className="mt-3 px-2.5 py-1 rounded-md text-[11px] bg-surface-700 border border-surface-600">Re-check</button>
            </div>
          )}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">Driver Updates</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-surface-800 border border-surface-600 rounded-lg p-4">
            <div className="font-semibold text-sm mb-1">🎮 Nvidia</div>
            {!nvInfo ? (
              <button onClick={checkNvidia} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">Check Latest Version</button>
            ) : (
              <div className="text-xs space-y-1">
                <div>Installed: <code>{nvInfo.installed_version ?? '-'}</code></div>
                <div>Latest: <code>{nvInfo.latest_version ?? 'unknown'}</code></div>
                <div className="text-text-secondary text-[10px] mt-2">{nvInfo.message}</div>
                <button onClick={checkNvidia} className="mt-2 px-2.5 py-1 rounded-md text-[11px] bg-surface-700 border border-surface-600">Re-check</button>
              </div>
            )}
          </div>
          <div className="bg-surface-800 border border-surface-600 rounded-lg p-4">
            <div className="font-semibold text-sm mb-1">💻 Dell Command Update</div>
            <p className="text-[11px] text-text-secondary mb-2">Alienware-specific updates (BIOS, chipset, GPU). Requires the Dell Command | Update app.</p>
            <button onClick={() => install('run_dell_command_update')} disabled={running !== null} className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold disabled:opacity-50">Run Dell Scan + Apply</button>
          </div>
        </div>
      </section>

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
