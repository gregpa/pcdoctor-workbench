import { useWeeklyReview } from '@renderer/hooks/useWeeklyReview.js';
import { useAction } from '@renderer/hooks/useAction.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName, WeeklyReviewActionItem } from '@shared/types.js';
import { useState } from 'react';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

function priorityClasses(p: WeeklyReviewActionItem['priority']) {
  switch (p) {
    case 'critical': return 'border-status-crit/40 bg-status-crit/[0.06]';
    case 'important': return 'border-status-warn/40 bg-status-warn/[0.06]';
    default: return 'border-status-info/40 bg-status-info/[0.06]';
  }
}

function priIcon(p: WeeklyReviewActionItem['priority']) {
  return p === 'critical' ? '🔴' : p === 'important' ? '🟡' : 'ℹ';
}

export function WeeklyReview() {
  const { review, loading, dismissFlag } = useWeeklyReview();
  const { run, running } = useAction();
  const [toast, setToast] = useState<string | null>(null);

  if (loading) return (
    <div className="p-6 flex items-center gap-3 text-text-secondary">
      <LoadingSpinner size={18} /><span>Loading weekly review…</span>
    </div>
  );
  if (!review) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-bold mb-4">📋 Weekly Review</h1>
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-4 text-sm text-text-secondary">
          No weekly review available yet. The next one runs Sunday 10 PM and will appear here Monday morning.
          <br /><br />
          You can also run it manually:
          <code className="block bg-surface-900 p-2 rounded mt-2 text-xs">
            pwsh -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Invoke-WeeklyReview.ps1"
          </code>
        </div>
      </div>
    );
  }

  async function applyAction(name: ActionName) {
    await run({ name });
    setToast(`${ACTIONS[name].label} triggered`);
    setTimeout(() => setToast(null), 4000);
  }

  const crit = review.action_items.filter(i => i.priority === 'critical');
  const imp = review.action_items.filter(i => i.priority === 'important');
  const info = review.action_items.filter(i => i.priority === 'info');

  return (
    <div className="p-5 max-w-5xl">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h1 className="text-lg font-bold">📋 Weekly Review — {review.review_date}</h1>
          <div className="text-[11px] text-text-secondary mt-1">
            {review.hostname} · {review.summary.overall} · {review.summary.critical_count} critical, {review.summary.warning_count} warnings, {review.summary.info_count} info
          </div>
        </div>
        {review.has_pending_flag && (
          <button onClick={dismissFlag} className="px-3 py-1.5 rounded-md text-xs bg-status-good text-black font-semibold">
            Mark Reviewed
          </button>
        )}
      </div>

      {crit.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">🔴 Critical — Act this week</h2>
          <div className="space-y-2">
            {crit.map(item => <Item key={item.id} item={item} onApply={applyAction} running={running !== null} />)}
          </div>
        </section>
      )}

      {imp.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">🟡 Important — Act this month</h2>
          <div className="space-y-2">
            {imp.map(item => <Item key={item.id} item={item} onApply={applyAction} running={running !== null} />)}
          </div>
        </section>
      )}

      {info.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">ℹ Info</h2>
          <div className="space-y-2">
            {info.map(item => <Item key={item.id} item={item} onApply={applyAction} running={running !== null} />)}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">📊 Headroom & Trends</h2>
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(review.headroom).map(([k, v]) => (
            <div key={k} className="bg-surface-800 border border-surface-600 rounded-md p-3 text-sm">
              <div className="text-[10px] uppercase tracking-wider text-text-secondary">{k.replace(/_/g, ' ')}</div>
              <div className="mt-0.5 text-text-primary">{v}</div>
            </div>
          ))}
        </div>
      </section>

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

function Item({ item, onApply, running }: { item: WeeklyReviewActionItem; onApply: (n: ActionName) => void; running: boolean }) {
  return (
    <div className={`border rounded-lg p-3 text-sm ${priorityClasses(item.priority)} flex justify-between items-start gap-3`}>
      <div className="flex-1">
        <div className="font-semibold mb-1 flex items-center gap-2">
          <span>{priIcon(item.priority)}</span><span>{item.area}</span>
        </div>
        <div className="text-text-secondary text-xs">{item.message}</div>
      </div>
      {item.suggested_action && (
        <button
          onClick={() => onApply(item.suggested_action!.action_name as ActionName)}
          disabled={running}
          className="px-2.5 py-1.5 rounded-md bg-status-warn text-black text-[11px] font-bold shrink-0 disabled:opacity-50"
        >
          {ACTIONS[item.suggested_action.action_name as ActionName]?.icon} Fix
        </button>
      )}
    </div>
  );
}
