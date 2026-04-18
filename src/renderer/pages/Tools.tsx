import { useTools } from '@renderer/hooks/useTools.js';
import { TOOLS, TOOL_CATEGORIES, ToolDefinition } from '@shared/tools.js';
import { useState } from 'react';

function ToolTile({ def, installed, onLaunch, onInstall, running }: {
  def: ToolDefinition;
  installed: boolean;
  resolved: string | null;
  onLaunch: (modeId: string) => void;
  onInstall: () => void;
  running: boolean;
}) {
  const [showModes, setShowModes] = useState(false);
  const hasMultipleModes = def.launch_modes.length > 1;

  return (
    <div className="bg-surface-900 border border-surface-600 rounded-lg p-3 flex flex-col gap-2 relative">
      <div className="flex items-start gap-2">
        <div className="text-2xl">{def.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate">{def.name}</div>
          <div className="text-[10px] text-text-secondary leading-tight">{def.description}</div>
          <div className="text-[9px] text-text-secondary/80 mt-0.5">{def.publisher}</div>
        </div>
      </div>
      {installed ? (
        <>
          <div className="text-[10px] text-status-good flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-status-good"></span>
            <span>Installed</span>
          </div>
          {hasMultipleModes ? (
            <div className="relative">
              <button
                onClick={() => setShowModes(!showModes)}
                disabled={running}
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
              disabled={running}
              className="px-2.5 py-1.5 rounded-md bg-[#238636] text-white text-[11px] font-semibold disabled:opacity-50"
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
              disabled={running}
              className="px-2.5 py-1.5 rounded-md bg-surface-700 border border-surface-600 text-[11px] hover:border-status-info/40 disabled:opacity-50"
            >
              Install via winget
            </button>
          ) : def.download_url ? (
            <button
              onClick={() => { window.open(def.download_url!, '_blank'); }}
              className="px-2.5 py-1.5 rounded-md bg-surface-700 border border-surface-600 text-[11px]"
            >
              Download…
            </button>
          ) : (
            <div className="text-[10px] text-text-secondary italic">Manual install only</div>
          )}
        </>
      )}
    </div>
  );
}

export function Tools() {
  const { statuses, loading, refresh, launch, install } = useTools();
  const [toast, setToast] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  if (loading) return <div className="p-6 text-text-secondary">Scanning installed tools…</div>;

  const statusById = new Map(statuses.map(s => [s.id, s]));

  async function onLaunch(id: string, modeId: string) {
    setWorking(true);
    const r = await launch(id, modeId);
    if (r.ok) setToast(`Launched ${TOOLS[id].name}`);
    else setToast(`Launch failed: ${r.error.message}`);
    setTimeout(() => setToast(null), 4000);
    setWorking(false);
  }

  async function onInstall(id: string) {
    setWorking(true);
    setToast(`Installing ${TOOLS[id].name} via winget (may take a few min)…`);
    const r = await install(id);
    if (r.ok) setToast(`Installed ${TOOLS[id].name}`);
    else setToast(`Install failed: ${r.error.message}`);
    setTimeout(() => setToast(null), 8000);
    setWorking(false);
  }

  return (
    <div className="p-5">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h1 className="text-lg font-bold">🧰 Tools & Scanners</h1>
          <div className="text-[11px] text-text-secondary mt-1">
            {statuses.filter(s => s.installed).length} of {statuses.length} tools installed
          </div>
        </div>
        <button onClick={refresh} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">
          Refresh
        </button>
      </div>

      {TOOL_CATEGORIES.map(cat => {
        const toolsInCat = Object.values(TOOLS).filter(t => t.category === cat.id);
        if (toolsInCat.length === 0) return null;
        return (
          <section key={cat.id} className="mb-6">
            <h2 className="text-[10px] uppercase tracking-wider text-text-secondary font-semibold mb-2">{cat.label}</h2>
            <div className="grid grid-cols-4 gap-2.5">
              {toolsInCat.map(def => {
                const s = statusById.get(def.id);
                return (
                  <ToolTile
                    key={def.id}
                    def={def}
                    installed={s?.installed ?? false}
                    resolved={s?.resolved_path ?? null}
                    onLaunch={(modeId) => onLaunch(def.id, modeId)}
                    onInstall={() => onInstall(def.id)}
                    running={working}
                  />
                );
              })}
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
