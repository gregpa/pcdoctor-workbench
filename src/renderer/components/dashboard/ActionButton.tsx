import { useEffect, useState } from 'react';
import { Tooltip } from '@renderer/components/layout/Tooltip.js';
import type { ActionDefinition } from '@shared/actions.js';
import type { ActionRecommendation } from '@shared/recommendations.js';
import { useConfirm } from '@renderer/lib/confirmContext.js';
import { ActionParameterModal } from './ActionParameterModal.js';

interface ActionButtonProps {
  action: ActionDefinition;
  onRun: (params?: Record<string, string>, dryRun?: boolean) => Promise<void>;
  disabled?: boolean;
  recommendation?: ActionRecommendation;
}

function formatElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

const LEVEL_STRIP: Record<string, string> = {
  recommended_high: 'bg-status-good',   // priority 1-3
  recommended_low:  'bg-status-warn',   // priority 4+
  blocked:          'bg-status-crit',
};

function RecIcon({ level, priority }: { level: string; priority?: number }) {
  if (level === 'recommended') {
    return <span className="text-[10px] leading-none">{(priority ?? 10) <= 3 ? '⭐' : '💡'}</span>;
  }
  if (level === 'consider') return <span className="text-[10px] leading-none">ℹ</span>;
  if (level === 'skip')    return <span className="text-[10px] leading-none">↩</span>;
  if (level === 'blocked') return <span className="text-[10px] leading-none">🚫</span>;
  return null;
}

export function ActionButton({ action, onRun, disabled, recommendation }: ActionButtonProps) {
  const [busy, setBusy] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const confirm = useConfirm();

  // Live elapsed-time counter while the action is running.
  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  // Progress percentage is capped at 95% until the script actually finishes; the
  // remaining 5% snaps full on completion. This avoids the "100% then still running" UX.
  const estimated = Math.max(1, action.estimated_duration_s);
  const pct = busy ? Math.min(95, Math.round((elapsed / estimated) * 100)) : 0;
  const overrun = busy && elapsed > estimated;

  const isBlocked = recommendation?.level === 'blocked';
  const isSkip    = recommendation?.level === 'skip';

  async function handleClick() {
    if (busy || disabled || isBlocked) return;

    // Parametric actions show the parameter modal (which includes its own confirm)
    if (action.params_schema && Object.keys(action.params_schema).length > 0) {
      setShowParams(true);
      return;
    }

    if (action.confirm_level !== 'none') {
      // v2.4.23: map each confirm_level 1:1 to the ConfirmModal tier.
      // Previously 'info' collapsed to 'risky' which showed an amber
      // warning for actions that aren't actually risky (Flush DNS etc).
      const tier: 'info' | 'risky' | 'destructive' =
        action.confirm_level === 'destructive' ? 'destructive'
        : action.confirm_level === 'risky'     ? 'risky'
        :                                         'info';
      const ok = await confirm({
        title: action.label,
        body: (
          <div>
            <p className="mb-2">{action.tooltip}</p>
            <p className="text-xs">Estimated duration: ~{action.estimated_duration_s}s · Rollback: Tier {action.rollback_tier}</p>
          </div>
        ),
        tier,
        confirmLabel: 'Run',
      });
      if (!ok) return;
    }
    setBusy(true);
    try { await onRun(); } finally { setBusy(false); }
  }

  async function handleParamSubmit(params: Record<string, string>, dryRun: boolean) {
    setShowParams(false);
    setBusy(true);
    try { await onRun(params, dryRun); } finally { setBusy(false); }
  }

  // Determine top-strip color
  let stripClass = '';
  if (recommendation?.level === 'recommended') {
    stripClass = (recommendation.priority ?? 10) <= 3 ? LEVEL_STRIP.recommended_high : LEVEL_STRIP.recommended_low;
  } else if (recommendation?.level === 'blocked') {
    stripClass = LEVEL_STRIP.blocked;
  }

  // Tooltip text: prefer recommendation reason on hover
  const tooltipText = recommendation?.level === 'skip'
    ? `Not needed now: ${recommendation.reason}`
    : recommendation?.level === 'blocked'
    ? `Blocked: ${recommendation.reason}`
    : recommendation?.reason
    ? `${action.tooltip}\n\n${recommendation.reason}`
    : action.tooltip;

  return (
    <>
      <Tooltip text={tooltipText}>
        <button
          className={[
            'relative flex flex-col items-center justify-center gap-1.5 p-3',
            'bg-surface-900 border border-surface-600 rounded-md text-[11px] text-text-primary',
            'hover:bg-surface-700 hover:border-status-info/40 transition',
            'disabled:cursor-not-allowed w-full h-[88px] overflow-hidden',
            isSkip ? 'opacity-50' : '',
            isBlocked ? 'opacity-50' : '',
          ].join(' ')}
          onClick={handleClick}
          disabled={busy || disabled || isBlocked}
        >
          {/* 2px colored strip at top (recommended/blocked) */}
          {stripClass && !busy && (
            <div aria-hidden className={`absolute top-0 left-0 right-0 h-[2px] ${stripClass}`} />
          )}

          {/* Animated progress bar overlay (only while running) */}
          {busy && (
            <div
              aria-hidden
              className={`absolute left-0 bottom-0 h-1 transition-all duration-700 ease-out ${
                overrun ? 'bg-status-warn' : 'bg-status-info'
              }`}
              style={{ width: `${pct}%` }}
            />
          )}
          {/* Indeterminate shimmer once we pass the estimate */}
          {busy && overrun && (
            <div
              aria-hidden
              className="absolute left-0 right-0 bottom-0 h-1 bg-gradient-to-r from-transparent via-status-warn/60 to-transparent animate-pulse pointer-events-none"
            />
          )}

          <span className="text-xl leading-none">{action.icon}</span>
          <span className="text-center leading-tight w-full">
            {busy ? (
              <>
                <span className="block">Running… {formatElapsed(elapsed)}</span>
                <span className="block text-[9px] text-text-secondary">
                  {overrun ? `over estimate (~${formatElapsed(estimated)})` : `~${formatElapsed(estimated)} typical`}
                </span>
              </>
            ) : (
              <>
                {/* Label row with recommendation icon */}
                <span className="flex items-center justify-center gap-1">
                  {recommendation && <RecIcon level={recommendation.level} priority={recommendation.priority} />}
                  <span>{action.label}</span>
                </span>
                {/* Reason sub-line */}
                {recommendation && (
                  <span
                    className="block text-[9px] text-text-secondary truncate w-full px-1 mt-0.5"
                    title={recommendation.reason}
                  >
                    {recommendation.reason}
                  </span>
                )}
              </>
            )}
          </span>
        </button>
      </Tooltip>

      {showParams && (
        <ActionParameterModal
          action={action}
          onSubmit={handleParamSubmit}
          onCancel={() => setShowParams(false)}
        />
      )}
    </>
  );
}
