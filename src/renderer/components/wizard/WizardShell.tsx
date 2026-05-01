/**
 * v2.5.18: Outer shell for the 10-step first-run wizard.
 *
 * Replaces the old 3-step FirstRunWizard with a wider, richer container
 * that hosts individual step components (added in Tasks 7-16). For now
 * each step renders a placeholder div.
 *
 * Gate:
 *   - Renders nothing once `first_run_complete === '1'` in settings.
 *   - Dev override: set `localStorage.pcd_force_wizard` to '1' to
 *     force the wizard open without resetting the DB.
 *
 * Completion:
 *   The Finish button on the final step writes `first_run_complete = '1'`.
 */

import { useEffect, useState, useCallback } from 'react';
import { WizardProvider, useWizard } from './WizardContext.js';
import { W1Welcome } from './steps/W1Welcome.js';
import { W2SystemProfile } from './steps/W2SystemProfile.js';
import { W3NetworkNas } from './steps/W3NetworkNas.js';
import { W4SecurityBaseline } from './steps/W4SecurityBaseline.js';
import { W5Notifications } from './steps/W5Notifications.js';
import { W6ToolsCatalog } from './steps/W6ToolsCatalog.js';
import { W7AutopilotRules } from './steps/W7AutopilotRules.js';
import { W8Integrations } from './steps/W8Integrations.js';
import { W9ScheduledTasks } from './steps/W9ScheduledTasks.js';
import { W10Finish } from './steps/W10Finish.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEP_LABELS = [
  'Welcome',       // 0 — W1
  'System',        // 1 — W2
  'Network',       // 2 — W3
  'Security',      // 3 — W4
  'Notifications', // 4 — W5
  'Tools',         // 5 — W6
  'Autopilot',     // 6 — W7
  'Integrations',  // 7 — W8
  'Tasks',         // 8 — W9
  'Finish',        // 9 — W10
] as const;

const TOTAL_STEPS = STEP_LABELS.length;

// ---------------------------------------------------------------------------
// Shell (outer gate — checks settings, renders provider)
// ---------------------------------------------------------------------------

export function WizardShell() {
  const [visible, setVisible] = useState<boolean | null>(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Dev override: always show when the force flag is set in localStorage.
        if (localStorage.getItem('pcd_force_wizard') === '1') {
          console.log('[WizardShell] Force-wizard override active');
          if (!cancelled) setVisible(true);
          return;
        }
        const r = await window.api.getSettings();
        if (!cancelled) {
          const done = r.ok && r.data['first_run_complete'] === '1';
          setVisible(!done);
        }
      } catch {
        // If settings fail to load, don't block the UI.
        if (!cancelled) setVisible(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Still loading or already completed — render nothing.
  if (visible === null || visible === false) return null;

  return (
    <WizardProvider>
      <WizardOverlay onDone={() => setVisible(false)} />
    </WizardProvider>
  );
}

// ---------------------------------------------------------------------------
// Overlay (inner — consumes WizardContext)
// ---------------------------------------------------------------------------

function WizardOverlay({ onDone }: { onDone: () => void }) {
  const { state, next, back } = useWizard();
  const { currentStep } = state;
  const isFirst = currentStep === 0;
  const isLast = currentStep === TOTAL_STEPS - 1;

  const handleFinish = useCallback(async () => {
    try {
      await window.api.setSetting('first_run_complete', '1');
    } catch { /* non-fatal */ }
    onDone();
  }, [onDone]);

  const handleNext = useCallback(() => {
    if (isLast) {
      void handleFinish();
    } else {
      next();
    }
  }, [isLast, handleFinish, next]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[640px] max-h-[90vh] rounded-xl bg-surface-800 border border-surface-600 shadow-2xl flex flex-col">

        {/* ── Progress bar ── */}
        <div className="px-6 pt-5 pb-4 border-b border-surface-600">
          <div className="flex items-center gap-1">
            {STEP_LABELS.map((label, i) => (
              <div key={label} className="flex-1 flex flex-col items-center gap-1.5">
                {/* Segment bar */}
                <div
                  className={`h-1 w-full rounded-full transition-colors ${
                    i < currentStep
                      ? 'bg-status-info'
                      : i === currentStep
                        ? 'bg-status-info'
                        : 'bg-surface-600'
                  }`}
                />
                {/* Label — show for current, first, last; hide others on narrow widths */}
                <span
                  className={`text-[10px] leading-none truncate max-w-full ${
                    i === currentStep
                      ? 'text-text-primary font-semibold'
                      : 'text-text-secondary'
                  }`}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Step content ── */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {currentStep === 0 ? <W1Welcome />
            : currentStep === 1 ? <W2SystemProfile />
            : currentStep === 2 ? <W3NetworkNas />
            : currentStep === 3 ? <W4SecurityBaseline />
            : currentStep === 4 ? <W5Notifications />
            : currentStep === 5 ? <W6ToolsCatalog />
            : currentStep === 6 ? <W7AutopilotRules />
            : currentStep === 7 ? <W8Integrations />
            : currentStep === 8 ? <W9ScheduledTasks />
            : currentStep === 9 ? <W10Finish />
            : <StepPlaceholder index={currentStep} label={STEP_LABELS[currentStep]} />}
        </div>

        {/* ── Bottom navigation ── */}
        <div className="px-6 py-4 border-t border-surface-600 flex items-center justify-between">
          <button
            onClick={back}
            disabled={isFirst}
            className="px-4 py-2 rounded-md border border-surface-600 text-text-secondary text-sm hover:bg-surface-700 transition disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Back
          </button>

          <span className="text-xs text-text-secondary">
            Step {currentStep + 1} of {TOTAL_STEPS}
          </span>

          <button
            onClick={handleNext}
            className="px-5 py-2 rounded-md bg-status-info text-white font-semibold text-sm hover:opacity-90 transition"
          >
            {isLast ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Placeholder (replaced by real step components in Tasks 7-16)
// ---------------------------------------------------------------------------

function StepPlaceholder({ index, label }: { index: number; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
      <div className="text-3xl text-text-secondary">{index + 1}</div>
      <h2 className="text-lg font-bold text-text-primary">{label}</h2>
      <p className="text-sm text-text-secondary">
        Step component not yet implemented (W{index + 1}).
      </p>
    </div>
  );
}
