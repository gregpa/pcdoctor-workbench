import { useState, useEffect } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { useAction } from '@renderer/hooks/useAction.js';
import { useConfirm } from '@renderer/lib/confirmContext.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName } from '@shared/types.js';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

// v2.5.9 (B4): relative-time helper for "Last checked Xd ago" labels on the
// driver tiles. Inlined here -- not promoted to a shared util because it's
// the only site that needs this exact phrasing. If a second site needs it,
// extract to renderer/lib/.
/** @internal exported for unit tests only -- do not use outside Updates.tsx */
export function timeAgoShort_test(ts: number): string {
  return timeAgoShort(ts);
}

function timeAgoShort(ts: number): string {
  const ms = Date.now() - ts;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

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
  // v2.5.9 (B4): timestamp (ms epoch) of the last Nvidia check + last Dell scan.
  // Nvidia ts comes from the cached `nvidia_check_cache` setting (written
  // by api:getNvidiaDriverLatest). Dell ts comes from getLastActionSuccessMap
  // which queries actions_log for the most recent successful run.
  const [nvCheckedTs, setNvCheckedTs] = useState<number | null>(null);
  const [dellLastScanTs, setDellLastScanTs] = useState<number | null>(null);
  // v2.5.40: persistent display of the most recent Dell action result so the
  // tile can show "Applied N update(s)" + the list of titles inline. Replaces
  // the v2.5.39 toast-only path which evaporated after 6s while a 5+ min
  // action ran in the background.
  const [dellLastResult, setDellLastResult] = useState<any>(null);

  const load = async () => {
    setLoading(true);
    const r = await api.getWindowsUpdateDetail();
    if (r.ok) { setData(r.data as WUDetail); setError(null); }
    else setError(r.error.message);
    setLoading(false);
  };

  // v2.5.9 (B4): hydrate driver staleness state from persistent stores on mount.
  // Failure here is non-fatal -- tiles fall back to the "no data yet" UI.
  // Catch blocks log in dev but stay silent in production so a transient IPC
  // failure or one-off JSON parse error doesn't spam the user's console.
  const loadDriverStaleness = async () => {
    try {
      const settings = await api.getSettings();
      if (settings.ok) {
        const raw = settings.data['nvidia_check_cache'];
        if (raw) {
          const cached = JSON.parse(raw);
          if (cached?.ts) {
            // v2.5.40: persist all PS-script fields (download_url, details_url,
            // is_outdated, release_date) so the Download button is available on
            // cold mount without re-running the network check. Older caches
            // (pre-v2.5.40) lack these fields; the UI gracefully degrades.
            setNvInfo({
              installed_version: cached.installed_version,
              latest_version: cached.latest_version,
              message: cached.message,
              is_outdated: cached.is_outdated ?? null,
              download_url: cached.download_url ?? null,
              details_url: cached.details_url ?? null,
              release_date: cached.release_date ?? null,
            });
            setNvCheckedTs(cached.ts);
          }
        }
      }
    } catch (e) {
      if (import.meta.env.DEV) console.warn('loadDriverStaleness (nvidia):', e);
    }
    try {
      const r = await api.getLastActionSuccessMap();
      if (r.ok) {
        const ts = r.data['run_dell_command_update'];
        if (typeof ts === 'number') setDellLastScanTs(ts);
      }
    } catch (e) {
      if (import.meta.env.DEV) console.warn('loadDriverStaleness (dell):', e);
    }
    // v2.5.40: hydrate the parsed Dell result so the tile can render inline
    // "Applied N update(s)" + applied_titles list. Surfaces the structured
    // outcome of the most recent successful run; null if never run.
    try {
      const r = await api.getLastActionResult('run_dell_command_update');
      if (r.ok && r.data?.result) setDellLastResult(r.data.result);
    } catch (e) {
      if (import.meta.env.DEV) console.warn('loadDriverStaleness (dell result):', e);
    }
  };

  useEffect(() => { load(); loadDriverStaleness(); }, []);

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
    // v2.5.39: Dell tile previously stayed on "Not scanned yet" until next
    // page mount because install() only refreshed the WU detail. Pull the
    // result-shaped fields off __lastActionResult (set by useAction) so the
    // toast can show the real update count instead of a generic "completed".
    const r: any = (window as any).__lastActionResult ?? null;
    let toastMsg = `${def.label} completed`;
    if (name === 'run_dell_command_update' && r) {
      if (r.mode === 'scan_no_updates') toastMsg = 'Dell scan complete — no updates available.';
      else if (r.mode === 'applied') toastMsg = `Applied ${r.updates_applied} Dell update(s). Reboot may be required.`;
    }
    setToast(toastMsg);
    setTimeout(() => setToast(null), 6000);
    await load();
    await loadDriverStaleness();
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
    if (r.ok) {
      setNvInfo(r.data);
      setNvCheckedTs(Date.now());  // v2.5.9 (B4) — cache write happens main-side too
      setToast(null);
    } else {
      setToast(`Nvidia check failed: ${r.error.message}`);
      setTimeout(() => setToast(null), 4000);
    }
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
          <button
            onClick={() => install('repair_windows_update')}
            disabled={running !== null}
            title="Resets Windows Update services + component store. Run if updates are stuck or failing repeatedly. Admin required, no automatic rollback."
            className="px-3 py-1.5 rounded-md text-xs pcd-button disabled:opacity-50"
          >
            Repair WU
          </button>
          <button
            onClick={load}
            title="Re-read the pending update list. Doesn't trigger a Windows Update scan; just refreshes what PCDoctor already knows."
            className="px-3 py-1.5 rounded-md text-xs pcd-button"
          >
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
        <div className="mb-4 pcd-panel flex items-center gap-3">
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
          <div className="pcd-panel p-4 text-sm text-text-secondary">
            ✓ System is up to date.
          </div>
        ) : (
          <div className="space-y-1.5">
            {data.pending.map((u, i) => (
              <div key={i} className={`pcd-panel pcd-panel-interactive flex items-center gap-3 text-xs ${u.is_security ? 'bg-status-warn/10 border-status-warn/40' : ''}`}>
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
        <div className="pcd-panel max-h-80 overflow-y-auto !p-0">
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
        <div className="pcd-panel p-4">
          {!readiness ? (
            <div>
              <p className="text-[11px] text-text-secondary mb-2">
                Audits whether your machine is ready for the next major Windows feature upgrade (e.g. Win11 25H2 → 26H1). Checks free space, TPM, Secure Boot, CPU compatibility, pending reboots, and known blocker apps. Read-only — does not start the upgrade.
              </p>
              <button
                onClick={checkReadiness}
                title="Run the feature-upgrade compatibility audit. Read-only; no admin required."
                className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold"
              >
                Check Readiness
              </button>
            </div>
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
              <button onClick={checkReadiness} className="mt-3 px-2.5 py-1 rounded-md text-[11px] pcd-button">Re-check</button>
            </div>
          )}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">Driver Updates</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="pcd-panel p-4">
            <div className="flex items-start justify-between mb-1">
              <div className="font-semibold text-sm">🎮 Nvidia</div>
              {(() => {
                if (!nvInfo) return null;
                const installed = nvInfo.installed_version;
                const latest = nvInfo.latest_version;
                if (!installed || !latest || latest === 'unknown') return null;
                const outOfDate = installed !== latest;
                return (
                  <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold ${outOfDate ? 'bg-status-warn/20 text-status-warn border border-status-warn/40' : 'bg-status-good/20 text-status-good border border-status-good/40'}`}>
                    {outOfDate ? 'OUT OF DATE' : 'UP TO DATE'}
                  </span>
                );
              })()}
            </div>
            {!nvInfo ? (
              <div>
                <p className="text-[11px] text-text-secondary mb-2">
                  Queries Nvidia's driver feed for the latest GameReady/Studio version available for your GPU. After the first check, this tile shows installed-vs-latest comparison + an UP TO DATE / OUT OF DATE badge + "Last checked Xd ago".
                </p>
                <button
                  onClick={checkNvidia}
                  title="Fetch latest Nvidia driver version. Read-only network call to nvidia.com; no admin required."
                  className="px-3 py-1.5 rounded-md text-xs pcd-button"
                >
                  Check Latest Version
                </button>
              </div>
            ) : (
              <div className="text-xs space-y-1">
                <div>Installed: <code>{nvInfo.installed_version ?? '-'}</code></div>
                <div>Latest: <code>{nvInfo.latest_version ?? 'unknown'}</code></div>
                <div className="text-text-secondary text-[10px] mt-2">{nvInfo.message}</div>
                {nvCheckedTs !== null && (
                  <div className="text-text-secondary text-[10px]">Last checked {timeAgoShort(nvCheckedTs)}</div>
                )}
                {/* v2.5.40: actionable links when out of date. target="_blank" */}
                {/* routes through main.ts setWindowOpenHandler -> shell.openExternal, */}
                {/* which opens the URL in the user's default browser. No new IPC. */}
                <div className="flex gap-2 mt-2 items-center">
                  {nvInfo.is_outdated && nvInfo.download_url && (
                    <a
                      href={nvInfo.download_url}
                      target="_blank"
                      rel="noreferrer"
                      title="Opens the Nvidia download page in your default browser. You'll need to run the installer manually."
                      className="px-2.5 py-1 rounded-md text-[11px] bg-[#238636] text-white font-semibold no-underline hover:opacity-90"
                    >
                      📥 Download driver
                    </a>
                  )}
                  {nvInfo.details_url && (
                    <a
                      href={nvInfo.details_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-status-info underline hover:opacity-90"
                    >
                      Release notes
                    </a>
                  )}
                  <button onClick={checkNvidia} className="px-2.5 py-1 rounded-md text-[11px] pcd-button">Re-check</button>
                </div>
              </div>
            )}
          </div>
          <div className="pcd-panel p-4">
            <div className="font-semibold text-sm mb-1">💻 Dell Command Update</div>
            <p className="text-[11px] text-text-secondary mb-2">Alienware-specific updates (BIOS, chipset, GPU). Requires the Dell Command | Update app installed on your machine.</p>

            {/* v2.5.40: in-progress state. dcu-cli /scan + /applyUpdates can run */}
            {/* 5-10 minutes; without this, the user clicks the button, UAC fires, */}
            {/* the button greys out, and they think nothing happened. */}
            {running === 'run_dell_command_update' ? (
              <div className="mb-2 p-2 rounded-md bg-status-info/10 border border-status-info/40 flex items-center gap-2">
                <LoadingSpinner size={14} />
                <div className="text-[11px]">
                  <div className="font-semibold">Scanning + applying Dell updates…</div>
                  <div className="text-text-secondary">This can take 5–10 minutes. Safe to leave the page open or come back later.</div>
                </div>
              </div>
            ) : dellLastResult ? (
              <div className="mb-2 p-2 rounded-md bg-surface-700/50 border border-surface-600 text-[11px]">
                {dellLastScanTs !== null && (
                  <div className="text-text-secondary text-[10px] mb-1">Last scan {timeAgoShort(dellLastScanTs)}</div>
                )}
                {dellLastResult.mode === 'scan_no_updates' ? (
                  <div className="text-status-good">✓ No updates available</div>
                ) : dellLastResult.mode === 'applied' ? (
                  <div>
                    <div className="text-status-good font-semibold">✓ Applied {dellLastResult.updates_applied} update(s)</div>
                    {Array.isArray(dellLastResult.applied_titles) && dellLastResult.applied_titles.length > 0 && (
                      <ul className="mt-1 ml-4 list-disc text-[10px] text-text-secondary space-y-0.5">
                        {dellLastResult.applied_titles.map((t: string, i: number) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    )}
                    <div className="text-text-secondary text-[10px] mt-1">Reboot may be required for BIOS/firmware to take effect.</div>
                  </div>
                ) : (
                  // Legacy v2.5.38 scan_only result, or unrecognized mode.
                  <div className="text-text-secondary">{dellLastResult.message ?? 'Last scan complete.'}</div>
                )}
              </div>
            ) : (
              <p className="text-[10px] text-text-secondary mb-2 italic">Not scanned yet — click below to run for the first time.</p>
            )}

            <button
              onClick={() => install('run_dell_command_update')}
              disabled={running !== null}
              title="Runs Dell Command | Update CLI to scan + apply available BIOS/chipset/firmware updates. Admin required. May require reboot. Takes 5-10 minutes."
              className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold disabled:opacity-50"
            >
              {running === 'run_dell_command_update' ? 'Running…' : 'Run Dell Scan + Apply'}
            </button>
          </div>
        </div>
      </section>

      {toast && (
        <div className="fixed bottom-4 right-4 pcd-button rounded-lg px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
