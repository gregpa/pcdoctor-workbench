import { useEffect, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { ClaudeTerminal } from '@renderer/components/claude/ClaudeTerminal.js';

export function Claude() {
  const [status, setStatus] = useState<{ installed: boolean; path: string | null } | null>(null);
  const [mode, setMode] = useState<'embedded' | 'external'>('embedded');
  const [embeddedStarted, setEmbeddedStarted] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [embeddedAvailable, setEmbeddedAvailable] = useState<boolean | null>(null);
  const [embeddedError, setEmbeddedError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const r = await api.getClaudeStatus();
      if (r.ok) setStatus(r.data);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const r = await (window as any).api.claudePty.available();
      setEmbeddedAvailable(!!r?.available);
      setEmbeddedError(r?.error ?? null);
    })();
  }, []);

  async function launchExternal() {
    setBusy(true);
    const r = await api.launchClaude();
    if (r.ok) setToast('Claude launched in Windows Terminal - check the new tab');
    else setToast(`Launch failed: ${r.error.message}`);
    setTimeout(() => setToast(null), 6000);
    setBusy(false);
  }

  return (
    <div className="p-5 max-w-6xl">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-lg font-bold">🤖 Claude Code</h1>
          <div className="text-[11px] text-text-secondary mt-1">
            {status?.installed ? (
              <>✓ Claude at <code className="text-[10px]">{status.path}</code></>
            ) : (
              <>✗ Claude not found. Install via <code>npm install -g @anthropic-ai/claude-code</code></>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setMode('embedded')}
            className={`px-3 py-1.5 rounded-md text-xs ${mode === 'embedded' ? 'bg-status-info/20 border border-status-info/60 text-status-info font-semibold' : 'bg-surface-700 border border-surface-600'}`}
          >
            Embedded
          </button>
          <button
            onClick={() => setMode('external')}
            className={`px-3 py-1.5 rounded-md text-xs ${mode === 'external' ? 'bg-status-info/20 border border-status-info/60 text-status-info font-semibold' : 'bg-surface-700 border border-surface-600'}`}
          >
            External Window
          </button>
        </div>
      </div>

      {mode === 'embedded' ? (
        !embeddedStarted ? (
          <div className="bg-surface-800 border border-surface-600 rounded-lg p-5">
            <p className="text-sm mb-3">
              Embedded terminal runs Claude inside this window with full system context pre-loaded.
              Type commands directly in the terminal below.
            </p>
            <button
              onClick={() => setEmbeddedStarted(true)}
              disabled={!status?.installed || embeddedAvailable === false}
              className="px-4 py-2 rounded-md bg-[#238636] text-white text-sm font-bold disabled:opacity-50"
            >
              Start Embedded Terminal
            </button>
            {embeddedAvailable === false && (
              <div className="mt-3 p-3 bg-status-warn/10 border border-status-warn/40 rounded-md text-[11px] text-status-warn">
                <strong>Embedded terminal unavailable on this install.</strong><br/>
                {embeddedError ?? 'node-pty native module failed to load.'}<br/>
                Use "External Window" mode instead - it launches Claude in a Windows Terminal tab.
              </div>
            )}
          </div>
        ) : (
          <div className="bg-surface-800 border border-surface-600 rounded-lg overflow-hidden" style={{ height: 'calc(100vh - 200px)' }}>
            <ClaudeTerminal onExit={() => setEmbeddedStarted(false)} />
          </div>
        )
      ) : (
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-5">
          <p className="text-sm mb-3">
            External mode launches Claude Code in a new Windows Terminal window with context pre-loaded.
            Use this if the embedded terminal has issues with rendering or input.
          </p>
          <button
            onClick={launchExternal}
            disabled={busy || !status?.installed}
            className="px-4 py-2 rounded-md bg-[#238636] text-white text-sm font-bold disabled:opacity-50"
          >
            {busy ? 'Launching…' : 'Open Claude in Windows Terminal'}
          </button>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
