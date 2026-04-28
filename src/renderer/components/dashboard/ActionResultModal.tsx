/**
 * ActionResultModal (v2.3.0 - B1)
 *
 * Shown when an "informational" action (analyze_minidump, run_smart_check,
 * parse_hwinfo_delta, run_adwcleaner_scan, run_safety_scanner,
 * run_malwarebytes_cli) completes successfully with a non-no-op result.
 *
 * Reads `window.__lastActionResult` (populated by useAction) and renders a
 * readable breakdown of the rich JSON output.
 */
import { useState } from 'react';
import type { ActionDefinition } from '@shared/actions.js';
import { api } from '@renderer/lib/ipc.js';

export interface ActionResultModalProps {
  action: ActionDefinition;
  result: Record<string, unknown>;
  onClose: () => void;
}

function formatBytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function KV({ k, v }: { k: string; v: unknown }) {
  return (
    <div className="flex items-start gap-2 text-[11px] py-0.5">
      <span className="text-text-secondary w-40 shrink-0">{k}</span>
      <span className="font-mono text-text-primary break-all">
        {v === null || v === undefined ? <em className="text-text-secondary">null</em> : String(v)}
      </span>
    </div>
  );
}

function CollapsibleJson({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-[10px] text-status-info underline underline-offset-2"
      >
        {open ? '▼' : '▶'} {label}
      </button>
      {open && (
        <pre className="mt-1 text-[10px] bg-surface-900 border border-surface-700 rounded p-2 overflow-auto max-h-60 font-mono">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function renderMinidump(result: Record<string, unknown>) {
  const tailRaw = Array.isArray(result.full_output_tail)
    ? (result.full_output_tail as string[]).join('\n')
    : typeof result.full_output_tail === 'string'
      ? (result.full_output_tail as string)
      : '';
  const tail = tailRaw.split(/\r?\n/).slice(-40).join('\n').trim();
  // v2.4.6: treat null / 'null' / empty as empty-parse. Upstream cdb may
  // have returned output but the regexes didn't match (symbol load
  // failure, unusual dump format, or the Analyze-Minidump.ps1 script
  // deployed to ProgramData is pre-v2.4.x and didn't capture tail).
  const isEmpty = (v: unknown) => v == null || v === '' || v === 'null';
  const allStructuredEmpty =
    isEmpty(result.bug_check_hex) &&
    isEmpty(result.faulting_module) &&
    isEmpty(result.probable_cause) &&
    isEmpty(result.bug_check);
  const dumpPath = typeof result.dump_path === 'string' ? result.dump_path : '';
  const errMessage = typeof result.message === 'string' ? result.message : '';

  // Surface a helpful "what now" block when the analyzer couldn't extract
  // the usual fields. Most common reason: Microsoft Symbol Server is
  // unreachable or slow on first use (no local SymCache yet). Second
  // most common: `cdb.exe` isn't installed (v2.4.6 fallback in v2.4.7).
  return (
    <div className="space-y-2">
      <KV k="bug_check_hex" v={result.bug_check_hex} />
      <KV k="faulting_module" v={result.faulting_module} />
      <KV k="probable_cause" v={result.probable_cause} />
      <KV k="dump_path" v={result.dump_path} />

      {allStructuredEmpty && (
        <div className="mt-3 p-3 rounded-md border border-status-warn/40 bg-status-warn/[0.06] text-[11px] leading-relaxed">
          <div className="font-semibold text-status-warn mb-1">⚠ Analyzer returned no structured findings</div>
          <div className="text-text-secondary space-y-1.5">
            <p>
              <strong>cdb.exe</strong> ran against <code className="font-mono">{dumpPath || '(unknown path)'}</code>
              {' '}but the parser didn't find BUGCHECK_CODE / MODULE_NAME / PROBABLY_CAUSED_BY in the output.
            </p>
            <p>Most common causes:</p>
            <ul className="list-disc list-inside space-y-0.5 ml-1">
              <li>Microsoft Symbol Server didn't finish downloading symbols on this run. Retry — the second run uses the local SymCache and completes in seconds.</li>
              <li><code>cdb.exe</code> not installed (no Windows SDK Debuggers / WinDbg). Run <code>winget install Microsoft.WinDbg</code>, then retry.</li>
              <li>Script deployment is stale (pre-v2.4.x <code>Analyze-Minidump.ps1</code> didn't capture the raw output tail). Upgrade to v2.4.6.</li>
            </ul>
            <p>Meanwhile, click <strong>Investigate with Claude</strong> in the footer to hand the dump path + whatever cdb did emit to Claude for a manual read.</p>
          </div>
        </div>
      )}

      {errMessage && allStructuredEmpty && !tail && (
        <div className="mt-2 text-[11px] text-text-secondary">
          <span className="font-semibold">Script message:</span>{' '}
          <code className="font-mono">{errMessage}</code>
        </div>
      )}

      {tail && (
        <div>
          <div className="text-[10px] text-text-secondary mt-3 mb-1">
            {allStructuredEmpty ? 'Raw cdb output (last 40 lines)' : 'Last 15 lines of !analyze -v'}
          </div>
          <pre className="text-[10px] bg-surface-900 border border-surface-700 rounded p-2 overflow-auto max-h-60 font-mono whitespace-pre-wrap break-all">
            {tail}
          </pre>
        </div>
      )}
    </div>
  );
}

function renderSmart(result: Record<string, unknown>) {
  const drives = Array.isArray(result.drives) ? (result.drives as any[]) : [];
  const skipped = Array.isArray(result.skipped) ? (result.skipped as any[]) : [];
  const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
  return (
    <div className="space-y-3">
      {drives.length > 0 && (
        <div>
          <div className="text-[10px] text-text-secondary mb-1">Drives ({drives.length})</div>
          <table className="w-full text-[10px]">
            <thead className="text-text-secondary text-left">
              <tr>
                <th className="py-1">Model</th>
                <th>Size</th>
                <th>Health</th>
                <th>Temp</th>
                <th>Wear</th>
              </tr>
            </thead>
            <tbody>
              {drives.map((d, i) => (
                <tr key={i} className="border-t border-surface-700">
                  <td className="py-1 font-mono">{d.model ?? d.FriendlyName ?? '—'}</td>
                  <td>{d.size_gb != null ? `${d.size_gb} GB` : '—'}</td>
                  <td>{d.health ?? '—'}</td>
                  <td>{d.temp_c != null ? `${d.temp_c}°C` : '—'}</td>
                  <td>{d.wear_pct != null ? `${d.wear_pct}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {skipped.length > 0 && (
        <div>
          <div className="text-[10px] text-text-secondary mb-1">Skipped ({skipped.length})</div>
          <ul className="text-[10px] font-mono list-disc pl-4">
            {skipped.map((s, i) => (
              <li key={i}>{s.model ?? '?'} — {s.reason ?? ''}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div>
          <div className="text-[10px] text-status-warn mb-1">Warnings ({warnings.length})</div>
          <ul className="text-[10px] font-mono list-disc pl-4 text-status-warn">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function renderGenericKV(result: Record<string, unknown>) {
  return (
    <div className="space-y-1">
      {Object.entries(result).map(([k, v]) => {
        if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          const display = typeof v === 'number' && /bytes|size/i.test(k) ? formatBytes(v) : v;
          return <KV key={k} k={k} v={display} />;
        }
        return <CollapsibleJson key={k} label={k} value={v} />;
      })}
    </div>
  );
}

export function ActionResultModal({ action, result, onClose }: ActionResultModalProps) {
  const ts = typeof result.generated_at === 'number'
    ? new Date((result.generated_at as number) * 1000).toLocaleString()
    : new Date().toLocaleString();

  // v2.4.3: main-process clipboard (navigator.clipboard silently fails in
  // the sandboxed renderer). Show a feedback flash so the user sees the
  // copy actually happened instead of the button doing nothing visible.
  const [copyFlash, setCopyFlash] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyResult = async () => {
    const payload = [
      `# ${action.label} - Result`,
      `Generated: ${ts}`,
      '',
      '```json',
      JSON.stringify(result, null, 2),
      '```',
    ].join('\n');
    const r = await (api as any).writeClipboard?.(payload);
    setCopyFlash(r?.ok ? 'copied' : 'failed');
    setTimeout(() => setCopyFlash('idle'), 2500);
  };

  const saveResult = async () => {
    const payload = [
      `# ${action.label} - Result`,
      `Generated: ${ts}`,
      '',
      '```json',
      JSON.stringify(result, null, 2),
      '```',
    ].join('\n');
    const r = await (api as any).saveActionResult?.(action.name, Date.now(), payload);
    setCopyFlash(r?.ok ? 'copied' : 'failed');
    setTimeout(() => setCopyFlash('idle'), 4000);
  };

  let body: JSX.Element;
  if (action.name === 'analyze_minidump') {
    body = renderMinidump(result);
  } else if (action.name === 'run_smart_check') {
    body = renderSmart(result);
  } else {
    body = renderGenericKV(result);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${action.label} result`}
    >
      <div
        className="pcd-modal w-full max-w-2xl p-5 shadow-2xl max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-1 flex items-center gap-2">
          <span>{action.icon}</span>
          <span>{action.label} — Result</span>
        </h2>
        <div className="text-[10px] text-text-secondary mb-3">Generated at {ts}</div>
        <div>{body}</div>
        <div className="flex justify-end items-center gap-2 mt-4 pt-3 border-t border-surface-700">
          {copyFlash !== 'idle' && (
            <span className={`text-[11px] mr-2 ${copyFlash === 'copied' ? 'text-status-good' : 'text-status-crit'}`}>
              {copyFlash === 'copied' ? '✓ Copied' : '✗ Failed'}
            </span>
          )}
          {/* v2.4.6: Investigate-with-Claude shortcut for informational
              actions. Sends the action label + full result JSON into a
              Claude PTY session so the user doesn't have to copy-paste
              it manually. Especially useful when the minidump analyzer
              returns empty structured fields and the user needs help
              reading raw cdb output. */}
          <button
            onClick={async () => {
              const ctx = [
                `Investigate this ${action.label} result.`,
                '',
                `Context: the user ran "${action.label}" from PCDoctor Workbench and got the result below. Help them interpret it, identify anything concerning, and recommend next steps.`,
                '',
                '```json',
                JSON.stringify(result, null, 2),
                '```',
              ].join('\n');
              await api.investigateWithClaude(ctx);
            }}
            className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 hover:border-status-info/40"
            title="Open a Claude session with this result pre-loaded as context"
          >
            🤖 Investigate with Claude
          </button>
          <button
            onClick={saveResult}
            className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 hover:border-status-info/40"
            title="Save to C:\\ProgramData\\PCDoctor\\exports\\"
          >
            💾 Save
          </button>
          <button
            onClick={copyResult}
            className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 hover:bg-surface-600"
          >
            📋 Copy Result
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs bg-status-info text-black font-semibold"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
