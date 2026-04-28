import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Finding } from '@shared/types.js';
import type { ActionDefinition } from '@shared/actions.js';
import { api } from '@renderer/lib/ipc.js';

interface AlertDetailModalProps {
  finding: Finding;
  actionDef?: ActionDefinition;
  blockedReason?: string;
  canAutoFix: boolean;
  missingParams: string[];
  onClose: () => void;
  onFix: () => Promise<void>;
  onDismiss: () => void;
  onInvestigateWithClaude: () => void;
}

/**
 * v2.4.6: per-action skip-confirm key. When a user checks "Don't ask again"
 * and confirms a fix, we persist this flag so subsequent Fix clicks on that
 * action skip the detail modal entirely and fire the action. Keyed by
 * action name so each action is opted in independently.
 */
export function skipConfirmSettingKey(actionName: string): string {
  return `alert_fix_skip_confirm_${actionName}`;
}

/**
 * v2.4.6: dedicated detail modal for an alert / finding. Clicking
 * anywhere on an AlertCard opens this. Gives the user the context
 * the single-line finding message can't — why this matters, what
 * the Fix action actually does, what (if anything) gets rolled back —
 * before asking them to commit to the fix.
 *
 * The `<AlertCard>` Fix button now routes through this modal too
 * (instead of firing the action directly) so nobody bulldozes state
 * without seeing the side-effect summary first.
 */
export function AlertDetailModal({
  finding, actionDef, blockedReason, canAutoFix, missingParams,
  onClose, onFix, onDismiss, onInvestigateWithClaude,
}: AlertDetailModalProps) {
  const [skipFuture, setSkipFuture] = useState(false);
  const severityBadge = finding.severity === 'critical' ? 'bg-status-crit/20 text-status-crit border-status-crit/40'
                      : finding.severity === 'warning' ? 'bg-status-warn/20 text-status-warn border-status-warn/40'
                      : 'bg-status-info/20 text-status-info border-status-info/40';
  const severityIcon = finding.severity === 'critical' ? '🔴' : finding.severity === 'warning' ? '⚠' : 'ℹ';
  // v2.4.6: prefer the backend-sourced `why` field (emitted by the v2.4.6
  // scanner) over the static renderer-side keyword map. The map is kept
  // as a fallback for older scanner reports that haven't emitted `why`
  // and for findings the scanner doesn't yet enrich.
  const why: ReactNode | null = finding.why
    ? <p>{finding.why}</p>
    : explainFinding(finding);
  const whatFixDoes = actionDef?.tooltip ?? null;

  const rollbackHint = actionDef
    ? (actionDef.rollback_tier === 'A' ? 'Tier A rollback: system Restore Point created; full OS-level revert available.'
      : actionDef.rollback_tier === 'B' ? 'Tier B rollback: snapshot of the exact files/keys modified; revert from History page.'
      : 'Tier C (none): cannot be automatically undone. Review what it will do before clicking.')
    : null;

  const willTouch: string[] = [];
  if (actionDef?.snapshot_paths?.length) {
    for (const p of actionDef.snapshot_paths) willTouch.push(p);
  }

  // v2.4.6: render via Portal at document.body so the modal isn't a DOM
  // descendant of the AlertCard that opened it. Without this, clicks on
  // the backdrop (and mouse-enter of the modal element) propagate UP to
  // the card's onClick handler — which calls setShowDetail(true) again —
  // creating a modal-mount/unmount flash loop. Observed on v2.4.6 live
  // install: 20-30 flashes on open plus continuous flashing on hover.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        className="pcd-modal w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-5 border-b border-surface-600">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${severityBadge}`}>
                {severityIcon} {finding.severity}
              </span>
              <span className="text-sm font-semibold text-text-primary">{finding.area}</span>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">{finding.message}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-text-secondary hover:text-text-primary text-xl leading-none px-2"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs">
          {why && (
            <Section title="Why this matters">
              {why}
            </Section>
          )}

          {actionDef && (
            <Section title={`What "Fix" does — ${actionDef.label}`}>
              {whatFixDoes && <p className="mb-2">{whatFixDoes}</p>}
              {willTouch.length > 0 && (
                <div className="mb-2">
                  <div className="text-text-secondary font-semibold mb-1">Modifies:</div>
                  <ul className="list-disc list-inside text-text-secondary space-y-0.5">
                    {willTouch.map(p => <li key={p} className="font-mono text-[11px]">{p}</li>)}
                  </ul>
                </div>
              )}
              {rollbackHint && <p className="text-text-secondary italic">{rollbackHint}</p>}
              {!canAutoFix && actionDef && (
                <p className="mt-2 text-status-warn">
                  Can't auto-fix from this alert: action needs {missingParams.join(', ')}. Open the action manually to pick a target.
                </p>
              )}
              {blockedReason && (
                <p className="mt-2 text-status-crit">
                  Blocked: {blockedReason}
                </p>
              )}
            </Section>
          )}

          {!actionDef && (
            <Section title="No automatic fix available">
              <p>
                This alert is informational — there's no one-click action mapped to it.
                {' '}Click <strong>Investigate with Claude</strong> to open a diagnostic session with
                the alert context pre-loaded, or use the <strong>History</strong> and{' '}
                <strong>Security</strong> pages to drill in.
              </p>
            </Section>
          )}

          {/* Raw finding (power-user) */}
          <details className="text-[11px]">
            <summary className="cursor-pointer text-text-secondary hover:text-text-primary select-none">
              Show raw finding JSON
            </summary>
            <pre className="mt-2 p-3 bg-surface-900 border border-surface-600 rounded overflow-x-auto text-[10px] leading-snug">
              {JSON.stringify(finding, null, 2)}
            </pre>
          </details>
        </div>

        {/* Footer */}
        <div className="flex justify-between gap-2 p-4 border-t border-surface-600 bg-surface-900/50">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 rounded-md text-xs pcd-button hover:border-surface-500"
            title="Suppress this alert until state changes"
          >
            🗑 Dismiss
          </button>
          <div className="flex gap-2">
            <button
              onClick={onInvestigateWithClaude}
              className="px-3 py-1.5 rounded-md text-xs pcd-button hover:border-status-info/40"
            >
              🤖 Investigate with Claude
            </button>
            {actionDef && canAutoFix && !blockedReason && (
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[10px] text-text-secondary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={skipFuture}
                    onChange={(e) => setSkipFuture(e.target.checked)}
                    className="accent-status-warn"
                  />
                  <span>Don't ask again for this action</span>
                </label>
                <button
                  onClick={async () => {
                    // v2.4.6: persist the skip preference BEFORE running the
                    // action. If the action fails mid-flight, the preference
                    // still takes effect next time — that's intentional; the
                    // user said "stop asking me" and we respect that even
                    // through failures.
                    if (skipFuture && actionDef) {
                      try { await api.setSetting(skipConfirmSettingKey(actionDef.name), '1'); } catch {}
                    }
                    await onFix();
                    onClose();
                  }}
                  className="px-3 py-1.5 rounded-md text-xs font-semibold bg-status-warn text-black hover:brightness-110"
                >
                  {actionDef.icon} Fix Now
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-secondary mb-1.5">{title}</h3>
      <div className="text-text-primary leading-relaxed">{children}</div>
    </div>
  );
}

/**
 * Static "why this matters" blurbs for well-known areas. Scanner doesn't
 * currently emit a structured `why` field (that's a v2.4.7 item); until
 * then this fallback matches on Finding.area keywords so the common
 * alerts always get context.
 */
function explainFinding(f: Finding): ReactNode | null {
  const a = (f.area ?? '').toLowerCase();
  const m = (f.message ?? '').toLowerCase();
  const text = `${a} ${m}`;

  if (text.includes('ram') || text.includes('memory')) {
    return (
      <>
        <p>High RAM usage forces Windows to page active memory to disk (pagefile.sys). Once swap kicks in, apps stutter, input latency spikes, and disk I/O pressure cascades.</p>
        <p className="mt-2">Common causes on a dev box: Chrome tabs, Electron apps (VS Code / Discord / Slack), WSL2 (vmmemWSL), Docker Desktop, leaky services. <strong>Fix options:</strong> kill top consumer (see RAM Pressure panel), cap WSL memory (Apply WSL Memory Cap action), restart Explorer, or reboot.</p>
      </>
    );
  }
  if (text.includes('eventlog') || text.includes('event log')) {
    return (
      <>
        <p>A single event in the Windows Event Log is usually noise. A recurring pattern (same EventID, same source, multiple times per day) indicates a service, driver, or hardware component that's failing silently.</p>
        <p className="mt-2">Hyper-V VmSwitch errors often trace to a virtual network adapter that WSL / Docker / a VM left in a bad state. The event itself rarely affects the host directly but signals something worth investigating.</p>
      </>
    );
  }
  if (text.includes('stability') || text.includes('bsod') || text.includes('shutdown')) {
    return (
      <>
        <p>Unexpected shutdowns or BSODs within a 7-day window usually point to one of three things: a recently updated / broken driver, failing memory, or thermal issues under load.</p>
        <p className="mt-2"><strong>Analyze Minidump</strong> runs WinDbg's <code>!analyze -v</code> on the most recent <code>C:\Windows\Minidump\*.dmp</code> to identify the faulting module. If the analyzer returns empty fields, WinDbg likely couldn't load symbols — the raw output is included in the result so Claude can interpret it.</p>
      </>
    );
  }
  if (text.includes('startup') || text.includes('auto-start')) {
    return (
      <>
        <p>Windows auto-starts programs from ~15 different registry + folder locations at every boot. Each one adds startup time and background memory. "Healthy" is under 20 real entries.</p>
        <p className="mt-2">The Fix button opens a picker so you choose what to disable — it will NOT automatically disable anything without explicit confirmation (v2.3.14 changed this after the nzbget-got-auto-disabled incident). For bulk cleanup, <strong>Autoruns</strong> from Sysinternals is still the best tool.</p>
      </>
    );
  }
  if (text.includes('reboot') || text.includes('pending')) {
    return (
      <>
        <p>A "pending reboot" flag means Windows queued a file rename, service restart, or component update that can only complete on reboot. Ignoring it can leave the system half-patched — new Windows Updates may refuse to install until you reboot.</p>
        <p className="mt-2">If this flag has been stuck for days across multiple reboots, it's almost certainly a browser auto-updater leftover (Chrome's <code>old_chrome.exe</code> deletes never finishing). Run <strong>Clear Stale Pending Renames</strong> to scrub those stale entries from the registry — the flag will clear on the next scan.</p>
      </>
    );
  }
  if (text.includes('disk') || text.includes('c: drive')) {
    return (
      <>
        <p>Low free space on the system drive (C:) compounds several problems: Windows Update needs 8-20 GB for in-place upgrades, hibernation + pagefile + DISM repair all need headroom, and SSDs lose performance as they approach full.</p>
        <p className="mt-2">Quick wins: <strong>Clear Browser Caches</strong>, <strong>Empty Recycle Bins</strong>, <strong>Shrink Component Store</strong>. For deeper cleanup, <strong>Remove Feature Update Leftovers</strong> can free 10+ GB of Windows.old + $Windows.~BT.</p>
      </>
    );
  }
  return null;
}
