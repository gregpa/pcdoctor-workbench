import type { Finding, ActionName } from '@shared/types.js';
import { ACTIONS } from '@shared/actions.js';
import { recommendAction } from '@shared/recommendations.js';
import { useState, useEffect } from 'react';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';
import { skipConfirmSettingKey } from './AlertDetailModal.js';
import { api } from '@renderer/lib/ipc.js';

interface AlertCardProps {
  finding: Finding;
  onApply: (action: ActionName, params?: Record<string, string>) => Promise<void>;
  /**
   * v2.4.6: card-click / Fix-click handler. AlertCard no longer renders
   * the detail modal itself — Dashboard owns that state and places the
   * modal at the root of the page so clicks inside the modal don't
   * bubble (React-tree-bubble) back up to the card and cause flashes.
   */
  onOpenDetail: (finding: Finding) => void;
}

/**
 * Extract params from a finding's detail object that match the action's
 * required params_schema keys. Returns undefined if the action takes no params
 * or none of them are satisfied by detail.
 */
function extractParamsFromDetail(
  action: ActionName,
  detail: unknown,
): Record<string, string> | undefined {
  const def = ACTIONS[action];
  if (!def?.params_schema) return undefined;
  if (!detail || typeof detail !== 'object') return undefined;
  const d = detail as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, schema] of Object.entries(def.params_schema)) {
    const v = d[key];
    if (v === null || v === undefined) continue;
    out[key] = String(v);
    void schema;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function AlertCard({ finding, onApply, onOpenDetail }: AlertCardProps) {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // v2.4.6: per-action skip-confirm preference. When set, the Fix button
  // fires the action directly without opening the detail modal.
  const [skipConfirmLoaded, setSkipConfirmLoaded] = useState(false);
  const [skipConfirm, setSkipConfirm] = useState(false);

  const border = finding.severity === 'critical' ? 'border-status-crit/40 bg-status-crit/[0.06]'
               : finding.severity === 'warning' ? 'border-status-warn/40 bg-status-warn/[0.06]'
               : 'border-status-info/40 bg-status-info/[0.06]';
  const icon = finding.severity === 'critical' ? '🔴' : finding.severity === 'warning' ? '⚠' : 'ℹ';
  const actionDef = finding.suggested_action ? ACTIONS[finding.suggested_action] : undefined;

  const requiredParams = actionDef?.params_schema
    ? Object.entries(actionDef.params_schema).filter(([, s]) => s.required).map(([k]) => k)
    : [];
  const derivedParams = finding.suggested_action
    ? extractParamsFromDetail(finding.suggested_action, finding.detail)
    : undefined;
  const missingParams = requiredParams.filter(k => !derivedParams || !derivedParams[k]);
  const canAutoFix = !!actionDef && missingParams.length === 0;

  const actionRec = finding.suggested_action
    ? recommendAction(finding.suggested_action, null, null)
    : null;
  const isActionBlocked = actionRec?.level === 'blocked';

  const estimated = actionDef ? Math.max(1, actionDef.estimated_duration_s) : 1;
  const progressPct = busy ? Math.min(95, Math.round((elapsed / estimated) * 100)) : 0;
  const overrun = busy && elapsed > estimated;

  const isBsodFinding = !actionDef && (
    finding.area?.toLowerCase().includes('bsod') ||
    finding.area?.toLowerCase().includes('stability') ||
    finding.message?.toLowerCase().includes('bsod') ||
    finding.message?.toLowerCase().includes('blue screen') ||
    finding.message?.toLowerCase().includes('minidump')
  );

  useEffect(() => {
    let alive = true;
    // v2.4.10: reset the load flag + skipConfirm value when the suggested
    // action changes. Prior code left skipConfirmLoaded=true from the
    // previous action across the re-render gap while async getSettings()
    // was still in-flight — brief window where handleFixButton could use
    // the stale skipConfirm for the PREVIOUS action. Reset forces the Fix
    // button to be disabled until the new value lands.
    setSkipConfirmLoaded(false);
    setSkipConfirm(false);
    (async () => {
      if (!finding.suggested_action) { if (alive) setSkipConfirmLoaded(true); return; }
      try {
        const r = await api.getSettings();
        if (alive && r.ok) {
          const v = r.data[skipConfirmSettingKey(finding.suggested_action)];
          setSkipConfirm(v === '1');
        }
      } catch { /* non-fatal; default to show-confirm */ }
      finally { if (alive) setSkipConfirmLoaded(true); }
    })();
    return () => { alive = false; };
  }, [finding.suggested_action]);

  async function runFixNow() {
    if (busy || !finding.suggested_action || !canAutoFix) return;
    setBusy(true);
    setElapsed(0);
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    try {
      await onApply(finding.suggested_action, derivedParams);
    } finally {
      clearInterval(timer);
      setBusy(false);
    }
  }

  // v2.4.6: Fix button routes through Dashboard's detail modal by
  // default (see onOpenDetail callback). When "Don't ask again" is set
  // for this action, we fire runFixNow directly.
  function handleFixButton(e: React.MouseEvent) {
    e.stopPropagation(); // don't also trigger card-body click
    if (busy || !finding.suggested_action || !canAutoFix) return;
    if (!skipConfirmLoaded) return;
    if (skipConfirm) {
      void runFixNow();
    } else {
      onOpenDetail(finding);
    }
  }

  function handleCardBodyClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('a')) return;
    onOpenDetail(finding);
  }

  return (
    <div
      className={`border rounded-lg p-3 text-xs ${border} flex justify-between items-start gap-3 relative overflow-hidden cursor-pointer hover:brightness-110 transition`}
      onClick={handleCardBodyClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDetail(finding); } }}
    >
      {busy && actionDef && (
        <>
          <div
            aria-hidden
            className={`absolute left-0 bottom-0 h-1 transition-all duration-700 ease-out ${overrun ? 'bg-status-warn' : 'bg-status-info'}`}
            style={{ width: `${progressPct}%` }}
          />
          {overrun && (
            <div
              aria-hidden
              className="absolute left-0 right-0 bottom-0 h-1 bg-gradient-to-r from-transparent via-status-warn/60 to-transparent animate-pulse pointer-events-none"
            />
          )}
        </>
      )}
      <div className="flex-1">
        <div className="font-semibold mb-1 flex items-center gap-2">
          <span>{icon}</span><span>{finding.area}</span>
        </div>
        <div className="text-text-secondary leading-relaxed">{finding.message}</div>
        {busy && actionDef && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-status-info">
            <LoadingSpinner size={12} />
            <span>
              Running {actionDef.label}… {elapsed}s elapsed
              {overrun ? <> · <span className="text-status-warn">over estimate (~{estimated}s)</span></> : ` · ~${estimated}s typical`}
              {' '}({progressPct}%)
            </span>
          </div>
        )}
      </div>
      <div className="flex gap-1 shrink-0">
        {actionDef ? (
          <button
            onClick={handleFixButton}
            disabled={busy || !canAutoFix || isActionBlocked}
            className="px-2.5 py-1.5 rounded-md bg-status-warn text-black text-[11px] font-bold disabled:opacity-50 flex items-center gap-1.5"
            title={isActionBlocked
              ? `Blocked: ${actionRec?.reason}`
              : canAutoFix
              ? (skipConfirm ? `${actionDef.tooltip} (click to run immediately — confirmation disabled)` : `${actionDef.tooltip} (click to see details + confirm)`)
              : `Cannot auto-fix: ${actionDef.label} needs ${missingParams.join(', ')}. Open the action manually to pick a target.`}
          >
            {busy ? (<><LoadingSpinner size={10} /> <span>Running</span></>) : (<><span>{actionDef.icon}</span><span>Fix</span></>)}
          </button>
        ) : isBsodFinding ? (
          <button
            onClick={async (e) => {
              e.stopPropagation();
              await onApply('analyze_minidump');
            }}
            disabled={busy}
            className="px-2.5 py-1.5 rounded-md bg-status-info/20 border border-status-info/40 text-status-info text-[11px] font-bold disabled:opacity-50 flex items-center gap-1.5"
            title="Analyze the most recent BSOD minidump with WinDbg"
          >
            <span>🔍</span><span>Analyze Minidump</span>
          </button>
        ) : (
          <span className="px-2.5 py-1.5 rounded-md pcd-button text-[11px] text-text-secondary">
            ℹ Info only
          </span>
        )}
        {actionDef && (
          <button
            onClick={async (e) => {
              e.stopPropagation();
              const ctx = `Investigate this alert:\n- Area: ${finding.area}\n- Severity: ${finding.severity}\n- Message: ${finding.message}\n- Auto-fixed: ${finding.auto_fixed}\n\nExplain the root cause, describe what the "${actionDef.label}" action would do, and recommend whether to run it.`;
              await api.investigateWithClaude(ctx);
            }}
            className="px-2 py-1.5 rounded-md pcd-button text-[11px] hover:border-status-info/40"
            title="Investigate this in Claude"
          >
            🤖
          </button>
        )}
      </div>
    </div>
  );
}
