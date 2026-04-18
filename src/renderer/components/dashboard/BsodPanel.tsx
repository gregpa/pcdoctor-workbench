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
    <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
      <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">💥 BSOD Minidump Analyzer</div>
      {!result && !loading && (
        <button onClick={analyze} className="px-2.5 py-1.5 rounded-md bg-[#238636] text-white text-[11px] font-semibold">Analyze Latest</button>
      )}
      {loading && (
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <LoadingSpinner size={14} /><span>Running cdb !analyze -v…</span>
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
              <div><strong>Bug Check:</strong> {result.bug_check ?? '—'} ({result.bug_check_hex ?? '—'})</div>
              <div><strong>Faulting Module:</strong> <code>{result.faulting_module ?? '—'}</code></div>
              <div><strong>Probable Cause:</strong> {result.probable_cause ?? '—'}</div>
              <div className="text-[10px] text-text-secondary mt-2">{result.dump_path}</div>
            </>
          )}
          <button onClick={analyze} className="mt-2 px-2 py-1 rounded-md text-[10px] bg-surface-700 border border-surface-600">Re-analyze</button>
        </div>
      )}
    </div>
  );
}
