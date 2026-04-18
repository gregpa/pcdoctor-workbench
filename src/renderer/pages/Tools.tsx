import { useTools } from '@renderer/hooks/useTools.js';
import { TOOLS, TOOL_CATEGORIES, ToolDefinition } from '@shared/tools.js';
import type { ToolStatus } from '@shared/types.js';
import { useState } from 'react';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

function ToolTile({ def, status, installing, onLaunch, onInstall, working }: {
  def: ToolDefinition;
  status: ToolStatus | undefined;
  installing: boolean;
  onLaunch: (modeId: string) => void;
  onInstall: () => void;
  working: boolean;
}) {
  const [showModes, setShowModes] = useState(false);
  const hasMultipleModes = def.launch_modes.length > 1;
  const installed = status?.installed ?? false;

  return (
    <div className="bg-surface-900 border border-surface-600 rounded-lg p-3 flex flex-col gap-2 relative h-full">
      <div className="flex items-start gap-2">
        <div className="text-2xl">{def.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate">{def.name}</div>
          <div className="text-[10px] text-text-secondary leading-tight">{def.description}</div>
          <div className="text-[9px] text-text-secondary/80 mt-0.5">{def.publisher}</div>
        </div>
      </div>
      <div className="mt-auto space-y-2">
        {installing ? (
          <>
            <div className="text-[10px] text-status-info flex items-center gap-1.5">
              <div className="w-3 h-3 border-2 border-status-info/30 border-t-status-info rounded-full animate-spin"></div>
              <span>Installing via winget…</span>
            </div>
            <button disabled className="w-full px-2.5 py-1.5 rounded-md bg-surface-700 border border-surface-600 text-[11px] opacity-50">
              Installing…
            </button>
          </>
        ) : installed ? (
          <>
            <div className="text-[10px] text-status-good flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-status-good"></span>
              <span>Installed</span>
            </div>
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
                  <div className="absolute top-full mt-1 left-0 right-0 bg-surface-800 border border-surface-600 rounded-md shadow-xl z-10">
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
                className="w-full px-2.5 py-1.5 rounded-md bg-surface-700 border border-surface-600 text-[11px] hover:border-status-info/40 disabled:opacity-50"
              >
                Install via winget
              </button>
            ) : def.download_url ? (
              <button
                onClick={() => { window.open(def.download_url!, '_blank'); }}
                className="w-full px-2.5 py-1.5 rounded-md bg-surface-700 border border-surface-600 text-[11px]"
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
  const [toast, setToast] = useState<string | null>(null);
  const [bulkInstalling, setBulkInstalling] = useState(false);

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
          </div>
        </div>
        <div className="flex gap-2">
          {notInstalledCount > 0 && (
            <button
              onClick={onInstallAll}
              disabled={bulkInstalling || installing.size > 0}
              className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold disabled:opacity-50"
            >
              {bulkInstalling ? 'Installing all…' : `▶ Install All Missing (${notInstalledCount})`}
            </button>
          )}
          <button onClick={refresh} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">
            Refresh
          </button>
        </div>
      </div>

      <div className="mb-4 bg-surface-800 border border-surface-600 rounded-lg p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold">📊 Import HWiNFO CSV</div>
            <div className="text-[10px] text-text-secondary mt-0.5">
              Parses an overnight sensor log into CPU/GPU temperature trends (min/avg/max).
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
                  onLaunch={(modeId) => onLaunch(def.id, modeId)}
                  onInstall={() => onInstall(def.id)}
                  working={installing.size > 0 || bulkInstalling}
                />
              ))}
            </div>
          </section>
        );
      })}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
