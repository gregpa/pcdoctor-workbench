import { useEffect, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';

export function Claude() {
  const [status, setStatus] = useState<{ installed: boolean; path: string | null } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await api.getClaudeStatus();
      if (r.ok) setStatus(r.data);
    })();
  }, []);

  async function launch() {
    setBusy(true);
    const r = await api.launchClaude();
    if (r.ok) setToast('Claude launched — check the new terminal window');
    else setToast(`Launch failed: ${r.error.message}`);
    setTimeout(() => setToast(null), 6000);
    setBusy(false);
  }

  return (
    <div className="p-5 max-w-4xl">
      <h1 className="text-lg font-bold mb-4">🤖 Claude Code</h1>

      <div className="bg-surface-800 border border-surface-600 rounded-lg p-5 mb-4">
        <div className="text-sm mb-3">
          Launches the Claude Code CLI in a new Windows Terminal window with PCDoctor context pre-loaded.
          You'll get the full Claude experience — all your skills, plugins, tools — with access to the PCDoctor
          diagnostic data already in its system prompt.
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={launch}
            disabled={busy || !status?.installed}
            className="px-4 py-2 rounded-md bg-[#238636] text-white text-sm font-bold disabled:opacity-50"
          >
            {busy ? 'Launching…' : 'Open Claude Terminal'}
          </button>
          {status && (
            <div className="text-xs text-text-secondary">
              {status.installed ? (
                <>✓ Claude detected at <code className="text-[10px]">{status.path}</code></>
              ) : (
                <>✗ Claude not found on PATH. Install via <code>npm install -g @anthropic-ai/claude-code</code></>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="bg-surface-800 border border-surface-600 rounded-lg p-5">
        <h2 className="text-sm font-semibold mb-2">What Claude can do</h2>
        <ul className="text-xs text-text-secondary space-y-1 list-disc pl-5">
          <li>Answer any question about your system state (pre-loaded latest.json in context)</li>
          <li>Investigate specific findings or persistence items</li>
          <li>Read any file on disk, run PowerShell / bash commands on your behalf</li>
          <li>Explain PCDoctor actions before you run them</li>
          <li>Help debug issues with the Workbench itself</li>
        </ul>
        <div className="mt-3 text-[11px] text-text-secondary/80">
          <strong>Prompt ideas:</strong> "What's the biggest issue on this PC right now?" · "Investigate this startup entry..." · "Walk me through what Run SFC does before I click it"
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
