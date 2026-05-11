import { useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

export function BsodPanel() {
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function analyze() {
    setLoading(true);
    const r = await api.runAction({ name: 'analyze_minidump' });
    if (r.ok) {
      setResult(r.data.result);
    } else {
      setResult({ error: r.error.message });
    }
    setLoading(false);
  }

  return (
    <div className="pcd-panel pcd-panel-interactive">
      <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">💥 BSOD Minidump Analyzer</div>
      {!result && !loading && (
        <button onClick={analyze} className="px-2.5 py-1.5 rounded-md bg-[#238636] text-white text-[11px] font-semibold">Analyze Latest</button>
      )}
      {loading && (
        <div className="flex items-start gap-2 text-xs text-text-secondary">
          <div className="mt-0.5"><LoadingSpinner size={14} /></div>
          <div>
            <div>Running cdb !analyze -v…</div>
            {/* v2.5.47: set duration expectations. First run downloads */}
            {/* Windows symbols from msdl.microsoft.com (~30-90s, depends on */}
            {/* network + Win build). Subsequent runs hit C:\SymCache and */}
            {/* finish in under 10s. Without this the user just sees a */}
            {/* spinner for a minute and assumes the action is hung. */}
            <div className="text-[10px] mt-0.5">
              ~30–90s on first run (downloading Windows symbols), &lt;10s after.
            </div>
          </div>
        </div>
      )}
      {result && !loading && (
        <div className="text-[11px] space-y-1">
          {result.error ? (
            <div className="text-status-crit">{result.error}</div>
          ) : result.success === false ? (
            <div className="text-text-secondary">{result.message}</div>
          ) : (
            <>
              <div><strong>Bug Check:</strong> {result.bug_check ?? '-'} ({result.bug_check_hex ?? '-'})</div>
              <div><strong>Faulting Module:</strong> <code>{result.faulting_module ?? '-'}</code></div>
              <div><strong>Probable Cause:</strong> {result.probable_cause ?? '-'}</div>
              <div className="text-[10px] text-text-secondary mt-2">{result.dump_path}</div>
            </>
          )}
          <button onClick={analyze} className="mt-2 px-2 py-1 rounded-md text-[10px] pcd-button">Re-analyze</button>
        </div>
      )}
    </div>
  );
}
