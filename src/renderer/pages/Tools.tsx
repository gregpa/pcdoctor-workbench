import { useTools } from '@renderer/hooks/useTools.js';
import { useStatus } from '@renderer/hooks/useStatus.js';
import { TOOLS, TOOL_CATEGORIES, ToolDefinition } from '@shared/tools.js';
import type { ToolStatus } from '@shared/types.js';
import { useEffect, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

function ToolTile({ def, status, installing, upgrade, onLaunch, onInstall, onUpgrade, upgrading, working }: {
  def: ToolDefinition;
  status: ToolStatus | undefined;
  installing: boolean;
  upgrade?: { current: string; available: string } | null;
  onLaunch: (modeId: string) => void;
  onInstall: () => void;
  onUpgrade: () => void;
  upgrading: boolean;
  working: boolean;
}) {
  const [showModes, setShowModes] = useState(false);
  const hasMultipleModes = def.launch_modes.length > 1;
  const installed = status?.installed ?? false;

  return (
    <div className={`pcd-panel flex flex-col gap-2 relative h-full ${upgrade ? 'border-status-warn/50' : ''}`}>
      {upgrade && (
        <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-status-warn/20 text-status-warn border border-status-warn/40">
          Update
        </div>
      )}
      <div className="flex items-start gap-2">
        <div className="text-2xl">{def.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate">{def.name}</div>
          <div className="text-[10px] text-text-secondary leading-tight">{def.description}</div>
          <div className="text-[9px] text-text-secondary/80 mt-0.5">{def.publisher}</div>
          {upgrade && (
            <div className="text-[9px] text-status-warn mt-0.5">
              {upgrade.current} → <strong>{upgrade.available}</strong>
            </div>
          )}
        </div>
      </div>
      <div className="mt-auto space-y-2">
        {installing ? (
          <>
            <div className="text-[10px] text-status-info flex items-center gap-1.5">
              <div className="w-3 h-3 border-2 border-status-info/30 border-t-status-info rounded-full animate-spin"></div>
              <span>Installing via winget…</span>
            </div>
            <button disabled className="w-full px-2.5 py-1.5 rounded-md pcd-button text-[11px] opacity-50">
              Installing…
            </button>
          </>
        ) : upgrading ? (
          <>
            <div className="text-[10px] text-status-warn flex items-center gap-1.5">
              <div className="w-3 h-3 border-2 border-status-warn/30 border-t-status-warn rounded-full animate-spin"></div>
              <span>Upgrading via winget…</span>
            </div>
            <button disabled className="w-full px-2.5 py-1.5 rounded-md pcd-button text-[11px] opacity-50">
              Upgrading…
            </button>
          </>
        ) : installed ? (
          <>
            <div className="text-[10px] text-status-good flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-status-good"></span>
              <span>{upgrade ? `Installed · ${upgrade.current}` : 'Installed'}</span>
            </div>
            {upgrade && (
              <button
                onClick={onUpgrade}
                disabled={working}
                className="w-full px-2.5 py-1.5 rounded-md bg-status-warn/15 border border-status-warn/40 text-status-warn text-[11px] font-semibold hover:bg-status-warn/25 disabled:opacity-50"
                title={`Upgrade from ${upgrade.current} to ${upgrade.available} via winget. Requires admin (UAC).`}
              >
                ⬆ Upgrade to {upgrade.available}
              </button>
            )}
            {hasMultipleModes ? (
              <div className="relative">
                <button
                  onClick={() => setShowModes(!showModes)}
                  disabled={working}
                  className="w-full px-2.5 py-1.5 rounded-md bg-[#238636] text-white text-[11px] font-semibold disabled:opacity-50"
                >
                  ▶ Launch ▾
                </button>
                {showModes && (
                  <div className="absolute top-full mt-1 left-0 right-0 pcd-modal z-10">
                    {def.launch_modes.map(m => (
                      <button
                        key={m.id}
                        onClick={() => { setShowModes(false); onLaunch(m.id); }}
                        className="w-full px-3 py-1.5 text-left text-[11px] hover:bg-surface-700"
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => onLaunch(def.launch_modes[0]?.id ?? 'gui')}
                disabled={working}
                className="w-full px-2.5 py-1.5 rounded-md bg-[#238636] text-white text-[11px] font-semibold disabled:opacity-50"
              >
                ▶ Launch
              </button>
            )}
          </>
        ) : (
          <>
            <div className="text-[10px] text-text-secondary flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-surface-600"></span>
              <span>Not installed</span>
            </div>
            {def.winget_id ? (
              <button
                onClick={onInstall}
                disabled={working}
                className="w-full px-2.5 py-1.5 rounded-md pcd-button text-[11px] hover:border-status-info/40 disabled:opacity-50"
              >
                Install via winget
              </button>
            ) : def.download_url ? (
              <button
                onClick={() => { window.open(def.download_url!, '_blank'); }}
                className="w-full px-2.5 py-1.5 rounded-md pcd-button text-[11px]"
              >
                Download…
              </button>
            ) : (
              <div className="text-[10px] text-text-secondary italic">Manual install only</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function Tools() {
  const { statuses, loading, installing, refresh, launch, install, installAll } = useTools();
  const { status } = useStatus();
  // v2.5.9 (B3): hide HWiNFO CSV import banner when LHM is feeding live temps.
  // The CSV import is the legacy fallback path; LHM HTTP is the live source.
  const lhmHttpOpen = status?.cpu_temp_status?.lhm_http_open === true;
  const [toast, setToast] = useState<string | null>(null);
  const [bulkInstalling, setBulkInstalling] = useState(false);
  const [recentResults, setRecentResults] = useState<any[]>([]);
  const [toolUpdates, setToolUpdates] = useState<{ checked_at: string | null; upgrades: Array<{ winget_id: string; current: string; available: string }>; winget_available?: boolean | null }>({ checked_at: null, upgrades: [], winget_available: null });
  const [upgrading, setUpgrading] = useState<Set<string>>(new Set());
  const [bulkUpgrading, setBulkUpgrading] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await api.listToolResults();
      if (r.ok) setRecentResults(r.data);
    })();
  }, [statuses]);

  useEffect(() => {
    (async () => {
      const r = await api.getToolUpdates();
      if (r.ok) setToolUpdates({
        checked_at: r.data.checked_at ?? null,
        upgrades: r.data.upgrades ?? [],
        winget_available: r.data.winget_available ?? null,
      });
    })();
  }, []);

  // Build winget_id -> {current, available} map for per-tile lookup.
  const upgradesByWingetId = new Map<string, { current: string; available: string }>();
  for (const u of toolUpdates.upgrades) {
    if (u.winget_id) upgradesByWingetId.set(u.winget_id, { current: u.current, available: u.available });
  }

  async function onCheckUpdates() {
    setCheckingUpdates(true);
    setToast('Checking for tool updates via winget...');
    const r = await api.refreshToolUpdates();
    if (r.ok) {
      setToolUpdates({
        checked_at: r.data.checked_at ?? null,
        upgrades: r.data.upgrades ?? [],
        winget_available: r.data.winget_available ?? null,
      });
      setToast(`${r.data.count ?? 0} update(s) available`);
    } else {
      setToast(`Check failed: ${r.error.message}`);
    }
    setCheckingUpdates(false);
    setTimeout(() => setToast(null), 6000);
  }

  async function onUpgrade(wingetId: string, toolName: string) {
    setUpgrading(s => new Set(s).add(wingetId));
    setToast(`Upgrading ${toolName} via winget...`);
    const r = await api.upgradeTool(wingetId);
    setUpgrading(s => { const n = new Set(s); n.delete(wingetId); return n; });
    if (r.ok) {
      setToast(`${toolName} upgraded`);
      // Refresh cache so the badge disappears.
      const fresh = await api.getToolUpdates();
      if (fresh.ok) setToolUpdates({
        checked_at: fresh.data.checked_at ?? null,
        upgrades: fresh.data.upgrades ?? [],
        winget_available: fresh.data.winget_available ?? null,
      });
      refresh();
    } else {
      setToast(`Upgrade failed: ${r.error.message}`);
    }
    setTimeout(() => setToast(null), 6000);
  }

  async function onUpgradeAll() {
    const n = toolUpdates.upgrades.length;
    if (n === 0) return;
    if (!confirm(`Upgrade all ${n} tools with pending updates via winget? Each fires a UAC prompt; total may take 5-20 minutes.`)) return;
    setBulkUpgrading(true);
    setToast(`Upgrading ${n} tools...`);
    const r = await api.upgradeAllTools();
    setBulkUpgrading(false);
    if (r.ok) {
      setToast(`Upgraded ${r.data.upgraded_count ?? 0} / ${n} tools`);
      const fresh = await api.getToolUpdates();
      if (fresh.ok) setToolUpdates({
        checked_at: fresh.data.checked_at ?? null,
        upgrades: fresh.data.upgrades ?? [],
        winget_available: fresh.data.winget_available ?? null,
      });
      refresh();
    } else {
      setToast(`Bulk upgrade failed: ${r?.error?.message ?? 'unknown'}`);
    }
    setTimeout(() => setToast(null), 10000);
  }

  if (loading) return (
    <div className="p-6 flex items-center gap-3 text-text-secondary">
      <LoadingSpinner size={18} /><span>Scanning installed tools…</span>
    </div>
  );

  const statusById = new Map(statuses.map(s => [s.id, s]));
  const installedCount = statuses.filter(s => s.installed).length;
  const notInstalledCount = statuses.length - installedCount;

  async function onLaunch(id: string, modeId: string) {
    const r = await launch(id, modeId);
    if (r.ok) setToast(`Launched ${TOOLS[id].name}`);
    else setToast(`Launch failed: ${r.error.message}`);
    setTimeout(() => setToast(null), 4000);
  }

  async function onInstall(id: string) {
    setToast(`Installing ${TOOLS[id].name} via winget…`);
    const r = await install(id);
    if (r.ok) setToast(`${TOOLS[id].name} installed`);
    else setToast(`Install issue: ${r.message ?? 'unknown'}`);
    setTimeout(() => setToast(null), 6000);
  }

  async function onInstallAll() {
    if (!confirm(`Install all ${notInstalledCount} missing tools via winget? This will run them sequentially and can take 10–20 minutes.`)) return;
    setBulkInstalling(true);
    setToast(`Installing ${notInstalledCount} tools…`);
    const r = await installAll();
    setBulkInstalling(false);
    setToast(`Done: ${r.succeeded}/${r.attempted} installed${r.failed.length > 0 ? ` · ${r.failed.length} failed` : ''}`);
    setTimeout(() => setToast(null), 10000);
  }

  return (
    <div className="p-5">
      <div className="flex justify-between items-start mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold">🧰 Tools & Scanners</h1>
          <div className="text-[11px] text-text-secondary mt-1">
            {installedCount} of {statuses.length} tools installed
            {toolUpdates.upgrades.length > 0 && (
              <> · <span className="text-status-warn font-semibold">{toolUpdates.upgrades.length} update{toolUpdates.upgrades.length === 1 ? '' : 's'} available</span></>
            )}
            {toolUpdates.checked_at && (
              <> · <span className="text-text-secondary/70">checked {new Date(toolUpdates.checked_at).toLocaleString()}</span></>
            )}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          {toolUpdates.upgrades.length > 0 && (
            <button
              onClick={onUpgradeAll}
              disabled={bulkUpgrading || upgrading.size > 0}
              className="px-3 py-1.5 rounded-md text-xs bg-status-warn/15 border border-status-warn/40 text-status-warn font-semibold hover:bg-status-warn/25 disabled:opacity-50"
              title="Upgrade every tool with a pending update via winget. Single UAC prompt per tool."
            >
              {bulkUpgrading ? 'Upgrading all…' : `⬆ Upgrade All (${toolUpdates.upgrades.length})`}
            </button>
          )}
          <button
            onClick={onCheckUpdates}
            disabled={checkingUpdates}
            className="px-3 py-1.5 rounded-md text-xs pcd-button disabled:opacity-50"
            title="Run winget upgrade to refresh the update list. Weekly scheduled task also does this automatically."
          >
            {checkingUpdates ? 'Checking…' : '🔄 Check for Updates'}
          </button>
          {notInstalledCount > 0 && (
            <button
              onClick={onInstallAll}
              disabled={bulkInstalling || installing.size > 0}
              className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold disabled:opacity-50"
            >
              {bulkInstalling ? 'Installing all…' : `▶ Install All Missing (${notInstalledCount})`}
            </button>
          )}
          <button onClick={refresh} className="px-3 py-1.5 rounded-md text-xs pcd-button">
            Refresh
          </button>
        </div>
      </div>

      {!lhmHttpOpen && (
        <div className="mb-4 pcd-panel">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold">📊 Import HWiNFO CSV</div>
              <div className="text-[10px] text-text-secondary mt-0.5">
                Parses an overnight sensor log into CPU/GPU temperature trends (min/avg/max).
                Fallback path — when LHM Remote Web Server is running, live temps feed automatically.
              </div>
            </div>
            <button
              onClick={async () => {
                const file = prompt('Paste full path to HWiNFO CSV file:', 'C:\\Users\\greg_\\Downloads\\test.CSV');
                if (!file) return;
                setToast('Parsing HWiNFO CSV…');
                const r = await (window as any).api.runAction({ name: 'import_hwinfo_csv', params: { csv_path: file } });
                if (r.ok && r.data.success) {
                  const findings = r.data.result?.findings;
                  setToast(`Parsed ${r.data.result?.samples ?? 0} samples: ${findings ? Object.keys(findings).length : 0} sensor metrics captured`);
                } else {
                  setToast(`Import failed: ${r.error?.message ?? r.data?.error?.message ?? 'unknown'}`);
                }
                setTimeout(() => setToast(null), 8000);
              }}
              className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold"
            >
              Import…
            </button>
          </div>
        </div>
      )}

      {recentResults.length > 0 && (
        <div className="mb-4 pcd-panel">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary font-semibold mb-2">Recent Tool Results ({recentResults.length})</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {recentResults.map((r) => (
              <div key={r.id} className="flex items-start gap-3 p-2 rounded-md bg-surface-700 border border-surface-600 text-[11px] pcd-panel-interactive transition-colors transition-shadow">
                <span className="text-[9px] px-2 py-0.5 rounded bg-surface-700 text-text-secondary font-semibold">{r.tool_id.toUpperCase()}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-text-secondary">{new Date(r.ts).toLocaleString()}</div>
                  <div className="text-text-primary truncate">{r.summary ?? `${r.samples ?? '?'} samples`}</div>
                  {r.findings && (
                    <div className="text-[10px] text-text-secondary mt-1">
                      {Object.entries(r.findings).slice(0, 3).map(([k, v]: any) => (
                        <span key={k} className="mr-3">{k}: avg {v.avg} / max {v.max}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {TOOL_CATEGORIES.map(cat => {
        const toolsInCat = Object.values(TOOLS).filter(t => t.category === cat.id);
        if (toolsInCat.length === 0) return null;
        return (
          <section key={cat.id} className="mb-6">
            <h2 className="text-[10px] uppercase tracking-wider text-text-secondary font-semibold mb-2">{cat.label}</h2>
            <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
              {toolsInCat.map(def => (
                <ToolTile
                  key={def.id}
                  def={def}
                  status={statusById.get(def.id)}
                  installing={installing.has(def.id)}
                  upgrade={def.winget_id ? upgradesByWingetId.get(def.winget_id) : null}
                  upgrading={def.winget_id ? upgrading.has(def.winget_id) : false}
                  onLaunch={(modeId) => onLaunch(def.id, modeId)}
                  onInstall={() => onInstall(def.id)}
                  onUpgrade={() => def.winget_id && onUpgrade(def.winget_id, def.name)}
                  working={installing.size > 0 || bulkInstalling || bulkUpgrading || upgrading.size > 0}
                />
              ))}
            </div>
          </section>
        );
      })}

      {toast && (
        <div className="fixed bottom-4 right-4 pcd-button rounded-lg px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
