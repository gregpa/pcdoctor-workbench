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

function stateIcon(s?: string) {
  switch (s) {
    case 'applied': return '✓';
    case 'dismissed': return '✖';
    case 'snoozed': return '💤';
    case 'auto_resolved': return '⟲';
    default: return '○';
  }
}

export function WeeklyReview() {
  const [pickedDate, setPickedDate] = useState<string | undefined>();
  const { review, loading, availableDates, dismissFlag, setItemState, archiveToObsidian } = useWeeklyReview(pickedDate);
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
          No weekly review available yet. Auto-runs Sunday 10 PM. Run manually:
          <code className="block bg-surface-900 p-2 rounded mt-2 text-xs">
            pwsh -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\PCDoctor\Invoke-WeeklyReview.ps1"
          </code>
        </div>
      </div>
    );
  }

  async function applyAction(itemId: string, name: ActionName) {
    setToast(`Running ${ACTIONS[name].label}…`);
    await run({ name });
    await setItemState(itemId, 'applied');
    setToast(`${ACTIONS[name].label} completed`);
    setTimeout(() => setToast(null), 4000);
  }

  const currentIdx = availableDates.indexOf(review.review_date);
  const prevDate = currentIdx >= 0 && currentIdx < availableDates.length - 1 ? availableDates[currentIdx + 1] : null;
  const nextDate = currentIdx > 0 ? availableDates[currentIdx - 1] : null;

  const crit = review.action_items.filter(i => i.priority === 'critical');
  const imp = review.action_items.filter(i => i.priority === 'important');
  const info = review.action_items.filter(i => i.priority === 'info');

  const applied = review.action_items.filter(i => i.state === 'applied').length;
  const total = review.action_items.length;

  const reviewDateStr = review.review_date;
  async function onExport(format: 'md' | 'json' | 'obsidian' | 'print') {
    if (format === 'obsidian') {
      const r = await archiveToObsidian();
      setToast(r.ok ? `✓ Archived to Obsidian Vault` : `Archive failed: ${r.error?.message ?? 'unknown'}`);
    } else if (format === 'print') {
      window.print();
    } else if (format === 'md') {
      setToast(`Markdown already at C:\\ProgramData\\PCDoctor\\reports\\weekly\\${reviewDateStr}.md`);
    } else if (format === 'json') {
      setToast(`JSON at C:\\ProgramData\\PCDoctor\\reports\\weekly\\${reviewDateStr}.json`);
    }
    setTimeout(() => setToast(null), 5000);
  }

  return (
    <div className="p-5 max-w-5xl">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h1 className="text-lg font-bold">📋 Weekly Review - {review.review_date}</h1>
          <div className="text-[11px] text-text-secondary mt-1">
            {review.hostname} · {review.summary.overall} · {review.summary.critical_count} critical, {review.summary.warning_count} warnings, {review.summary.info_count} info
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button disabled={!prevDate} onClick={() => setPickedDate(prevDate!)} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 disabled:opacity-30">
            ← Prev
          </button>
          <button disabled={!nextDate} onClick={() => setPickedDate(nextDate!)} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 disabled:opacity-30">
            Next →
          </button>
          {review.has_pending_flag && (
            <button onClick={dismissFlag} className="px-3 py-1.5 rounded-md text-xs bg-status-good text-black font-semibold">
              Mark Reviewed
            </button>
          )}
        </div>
      </div>

      <div className="mb-4 bg-surface-800 border border-surface-600 rounded-lg p-3 flex items-center gap-4">
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary">Progress</div>
          <div className="mt-1 h-2 bg-surface-900 rounded-full overflow-hidden">
            <div className="h-full bg-status-good transition-all" style={{ width: `${total === 0 ? 0 : Math.round(applied / total * 100)}%` }} />
          </div>
          <div className="text-[10px] text-text-secondary mt-1">{applied} of {total} items acted on</div>
        </div>
        <div className="flex gap-1.5">
          <button onClick={() => onExport('obsidian')} className="px-2.5 py-1.5 rounded-md text-[11px] bg-surface-700 border border-surface-600">Archive to Obsidian</button>
          <button onClick={() => onExport('print')} className="px-2.5 py-1.5 rounded-md text-[11px] bg-surface-700 border border-surface-600">Print</button>
          <button onClick={() => onExport('md')} className="px-2.5 py-1.5 rounded-md text-[11px] bg-surface-700 border border-surface-600">Show MD Path</button>
        </div>
      </div>

      {crit.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">🔴 Critical - Act this week</h2>
          <div className="space-y-2">
            {crit.map(item => <Item key={item.id} item={item} onApply={applyAction} onState={(s) => setItemState(item.id, s)} running={running !== null} />)}
          </div>
        </section>
      )}

      {imp.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">🟡 Important - Act this month</h2>
          <div className="space-y-2">
            {imp.map(item => <Item key={item.id} item={item} onApply={applyAction} onState={(s) => setItemState(item.id, s)} running={running !== null} />)}
          </div>
        </section>
      )}

      {info.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xs uppercase tracking-wider text-text-secondary font-semibold mb-2">ℹ Info</h2>
          <div className="space-y-2">
            {info.map(item => <Item key={item.id} item={item} onApply={applyAction} onState={(s) => setItemState(item.id, s)} running={running !== null} />)}
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

function Item({ item, onApply, onState, running }: {
  item: WeeklyReviewActionItem;
  onApply: (itemId: string, n: ActionName) => Promise<void>;
  onState: (s: string) => Promise<void>;
  running: boolean;
}) {
  const done = item.state === 'applied' || item.state === 'dismissed' || item.state === 'auto_resolved';
  return (
    <div className={`border rounded-lg p-3 text-sm ${priorityClasses(item.priority)} flex justify-between items-start gap-3 ${done ? 'opacity-50' : ''}`}>
      <div className="flex-1">
        <div className="font-semibold mb-1 flex items-center gap-2">
          <span>{priIcon(item.priority)}</span>
          <span>{item.area}</span>
          {item.state && item.state !== 'pending' && (
            <span className="text-[10px] px-2 py-0.5 rounded-full border border-current opacity-60">{stateIcon(item.state)} {item.state}</span>
          )}
        </div>
        <div className="text-text-secondary text-xs">{item.message}</div>
      </div>
      <div className="flex gap-1 flex-col items-stretch min-w-[110px]">
        {!done && item.suggested_action && (
          <button
            onClick={() => onApply(item.id, item.suggested_action!.action_name as ActionName)}
            disabled={running}
            className="px-2.5 py-1.5 rounded-md bg-status-warn text-black text-[11px] font-bold disabled:opacity-50"
          >
            {ACTIONS[item.suggested_action.action_name as ActionName]?.icon} Fix
          </button>
        )}
        {!done && (
          <>
            <button onClick={() => onState('dismissed')} className="px-2.5 py-1 rounded-md bg-surface-700 border border-surface-600 text-[10px]">Dismiss</button>
            <button onClick={() => onState('snoozed')} className="px-2.5 py-1 rounded-md bg-surface-700 border border-surface-600 text-[10px]">Snooze</button>
          </>
        )}
        {done && (
          <button onClick={() => onState('pending')} className="px-2.5 py-1 rounded-md bg-surface-700 border border-surface-600 text-[10px]">Reset</button>
        )}
      </div>
    </div>
  );
}
