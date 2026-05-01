/**
 * v2.5.17: First-run wizard shown on the very first launch.
 *
 * Scope (Standard: W1 + W2 + W5):
 *   W1 — Welcome screen explaining what PCDoctor Workbench does.
 *   W2 — Optional Defender exclusion for C:\ProgramData\PCDoctor.
 *         Eliminates real-time-scan overhead on scanner reads/writes.
 *   W5 — Initial scan trigger (Invoke-PCDoctor.ps1 -Mode Report),
 *         fire-and-forget so the dashboard has data within ~60 seconds.
 *
 * Gate: renders nothing once `first_run_complete` is set in workbench_settings.
 * Completion: writes `first_run_complete = '1'` via api.setSetting.
 * Each step has a "Skip" path so the user is never blocked.
 */

import { useEffect, useState } from 'react';

type Step = 1 | 2 | 3 | 'done';

export function FirstRunWizard() {
  const [step, setStep] = useState<Step | null>(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);

  // On mount, check if the wizard was already completed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.getSettings();
        if (!cancelled) {
          const done = r.ok && r.data['first_run_complete'] === '1';
          setStep(done ? 'done' : 1);
        }
      } catch {
        // If we can't load settings, skip the wizard rather than blocking the UI.
        if (!cancelled) setStep('done');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Write the completion flag and close the wizard. */
  async function finish() {
    try {
      await window.api.setSetting('first_run_complete', '1');
    } catch { /* non-fatal */ }
    setStep('done');
  }

  /** W2: run the Defender exclusion action (UAC-elevated). */
  async function applyDefenderExclusion() {
    setBusy(true);
    setStepError(null);
    try {
      const r = await window.api.runAction({ name: 'add_pcdoctor_exclusion' });
      if (r.ok && r.data.success) {
        setStep(3);
      } else {
        const msg = r.ok ? (r.data.error?.message ?? 'Action reported failure') : r.error.message;
        setStepError(msg);
      }
    } catch (e: any) {
      setStepError(e?.message ?? 'Unexpected error');
    } finally {
      setBusy(false);
    }
  }

  /** W5: fire the initial scan (non-blocking, fire-and-forget). */
  async function triggerScan() {
    setBusy(true);
    setStepError(null);
    try {
      await window.api.triggerInitialScan();
      // Ignore errors — the step advances regardless (fire-and-forget).
    } catch { /* non-fatal */ }
    setBusy(false);
    await finish();
  }

  // Render nothing until we know the gate state, or if wizard is done.
  if (step === null || step === 'done') return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[520px] rounded-xl bg-surface-800 border border-surface-600 shadow-2xl p-6 flex flex-col gap-4">

        {/* Progress dots */}
        <div className="flex items-center gap-2 justify-center">
          {([1, 2, 3] as const).map((n) => (
            <div
              key={n}
              className={`w-2 h-2 rounded-full transition-colors ${
                n === step ? 'bg-status-info' : n < step ? 'bg-status-info/40' : 'bg-surface-600'
              }`}
            />
          ))}
        </div>

        {step === 1 && <StepWelcome onNext={() => setStep(2)} />}
        {step === 2 && (
          <StepDefenderExclusion
            busy={busy}
            error={stepError}
            onApply={applyDefenderExclusion}
            onSkip={() => { setStepError(null); setStep(3); }}
          />
        )}
        {step === 3 && (
          <StepInitialScan
            busy={busy}
            error={stepError}
            onRun={triggerScan}
            onSkip={finish}
          />
        )}
      </div>
    </div>
  );
}

// ─── Individual steps ────────────────────────────────────────────────────────

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <>
      <div className="text-center">
        <div className="text-4xl mb-2">🩺</div>
        <h1 className="text-xl font-bold text-text-primary">Welcome to PCDoctor Workbench</h1>
        <p className="text-sm text-text-secondary mt-2">
          A local PC health dashboard that monitors your system around the clock.
        </p>
      </div>

      <ul className="text-sm text-text-secondary space-y-2 bg-surface-700 rounded-lg p-4">
        <li className="flex items-start gap-2">
          <span className="mt-0.5">📊</span>
          <span><strong className="text-text-primary">Dashboard</strong> — live KPIs, disk health, alerts, and 7-day trend charts.</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5">🛡</span>
          <span><strong className="text-text-primary">Security</strong> — Defender status, Windows Update, firewall, BitLocker, failed logons.</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5">🧭</span>
          <span><strong className="text-text-primary">Autopilot</strong> — 25 background maintenance rules that run on a schedule and alert you before acting.</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5">🤖</span>
          <span><strong className="text-text-primary">Claude integration</strong> — embedded terminal with system context pre-loaded for deep-dive investigations.</span>
        </li>
      </ul>

      <p className="text-xs text-text-secondary text-center">
        This quick setup takes about 60 seconds and covers two optional performance improvements.
      </p>

      <button
        onClick={onNext}
        className="w-full py-2.5 rounded-md bg-status-info text-white font-semibold text-sm hover:opacity-90 transition"
      >
        Get Started →
      </button>
    </>
  );
}

function StepDefenderExclusion({
  busy,
  error,
  onApply,
  onSkip,
}: {
  busy: boolean;
  error: string | null;
  onApply: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <div>
        <h2 className="text-lg font-bold text-text-primary">🛡 Improve Scan Performance</h2>
        <p className="text-sm text-text-secondary mt-1">
          Recommended — takes about 5 seconds.
        </p>
      </div>

      <div className="text-sm text-text-secondary bg-surface-700 rounded-lg p-4 space-y-2">
        <p>
          PCDoctor stores scan reports, logs, and its database under{' '}
          <code className="text-text-primary text-xs bg-surface-600 px-1 rounded">C:\ProgramData\PCDoctor</code>.
        </p>
        <p>
          Windows Defender's real-time protection intercepts every read and write to that folder.
          On busy machines this can cause 30–70 second stalls when the scanner runs.
        </p>
        <p>
          Adding the folder to Defender's <strong className="text-text-primary">ExclusionPath</strong> eliminates
          that overhead without weakening your overall protection — the exclusion only applies to files
          inside the PCDoctor data directory.
        </p>
      </div>

      {error && (
        <div className="text-xs text-status-warn bg-status-warn/10 border border-status-warn/30 rounded-md p-3">
          <strong>Action failed:</strong> {error}
          <br />
          <span className="opacity-80">You can skip this step and add the exclusion manually later from Windows Security → Virus &amp; threat protection → Exclusions.</span>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onApply}
          disabled={busy}
          className="flex-1 py-2.5 rounded-md bg-[#238636] text-white font-semibold text-sm hover:opacity-90 transition disabled:opacity-50"
        >
          {busy ? 'Applying…' : '✓ Apply (Recommended)'}
        </button>
        <button
          onClick={onSkip}
          disabled={busy}
          className="px-4 py-2.5 rounded-md border border-surface-600 text-text-secondary text-sm hover:bg-surface-700 transition disabled:opacity-50"
        >
          Skip
        </button>
      </div>
    </>
  );
}

function StepInitialScan({
  busy,
  error,
  onRun,
  onSkip,
}: {
  busy: boolean;
  error: string | null;
  onRun: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <div>
        <h2 className="text-lg font-bold text-text-primary">🔍 Run Your First Scan</h2>
        <p className="text-sm text-text-secondary mt-1">
          Populates the Dashboard with your system's current health.
        </p>
      </div>

      <div className="text-sm text-text-secondary bg-surface-700 rounded-lg p-4 space-y-2">
        <p>
          The Dashboard shows live KPIs, alerts, and 7-day trends — but it needs at least one
          diagnostic scan to have data to display.
        </p>
        <p>
          Clicking <strong className="text-text-primary">Run Scan Now</strong> starts the PCDoctor
          scanner in the background. It reads system state (CPU, RAM, disks, services, events, SMART)
          and writes a report in about 60 seconds. The dashboard will populate automatically when it finishes.
        </p>
        <p className="text-xs opacity-70">
          The scanner also runs daily at 08:00 via a scheduled task, so you'll always have fresh data.
        </p>
      </div>

      {error && (
        <div className="text-xs text-status-warn bg-status-warn/10 border border-status-warn/30 rounded-md p-3">
          <strong>Could not start scan:</strong> {error}
          <br />
          <span className="opacity-80">
            You can trigger a manual scan later by running{' '}
            <code className="bg-surface-600 px-1 rounded">powershell -File C:\ProgramData\PCDoctor\Invoke-PCDoctor.ps1 -Mode Report</code>.
          </span>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onRun}
          disabled={busy}
          className="flex-1 py-2.5 rounded-md bg-[#238636] text-white font-semibold text-sm hover:opacity-90 transition disabled:opacity-50"
        >
          {busy ? 'Starting…' : '▶ Run Scan Now'}
        </button>
        <button
          onClick={onSkip}
          disabled={busy}
          className="px-4 py-2.5 rounded-md border border-surface-600 text-text-secondary text-sm hover:bg-surface-700 transition disabled:opacity-50"
        >
          Skip
        </button>
      </div>
    </>
  );
}
