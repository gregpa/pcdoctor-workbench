/**
 * W1 Welcome — first step of the first-run wizard (index 0).
 *
 * Pure informational: introduces the app, lists key features,
 * and provides a single "Get Started" CTA that advances the wizard.
 */

import { useWizard } from '../WizardContext.js';

const FEATURES = [
  { icon: '\u{1F4CA}', text: 'Real-time system health monitoring (CPU, RAM, disk, temps)' },
  { icon: '\u{1F6E1}', text: 'Automated security scanning and threat detection' },
  { icon: '\u{1F5C4}', text: 'NAS drive management and @Recycle cleanup' },
  { icon: '\u{1F916}', text: 'Autopilot maintenance (scheduled cleanup, scans, updates)' },
  { icon: '\u{1F4C8}', text: 'Weekly health reports and degradation forecasts' },
] as const;

export function W1Welcome() {
  const { next, markComplete } = useWizard();

  const handleGetStarted = () => {
    markComplete(0);
    next();
  };

  return (
    <div className="flex flex-col items-center text-center gap-5 py-4">
      {/* Hero icon */}
      <span className="text-5xl" role="img" aria-label="stethoscope">{'\u{1FA7A}'}</span>

      {/* Headline */}
      <h2 className="text-2xl font-bold text-text-primary">
        Welcome to PCDoctor Workbench
      </h2>

      {/* Subtitle */}
      <p className="text-sm text-text-secondary max-w-md">
        A local PC health dashboard that monitors your system around the clock.
      </p>

      {/* Feature bullets */}
      <ul className="text-left space-y-3 w-full max-w-md">
        {FEATURES.map(({ icon, text }) => (
          <li key={text} className="flex items-start gap-3 text-sm text-text-primary">
            <span className="text-lg leading-none mt-0.5">{icon}</span>
            <span>{text}</span>
          </li>
        ))}
      </ul>

      {/* Time estimate */}
      <p className="text-xs text-text-secondary max-w-md mt-1">
        This wizard will configure the app for your specific system. It takes about 5 minutes.
      </p>

      {/* CTA */}
      <button
        onClick={handleGetStarted}
        className="mt-2 px-6 py-2.5 rounded-lg bg-status-info text-white font-semibold text-sm hover:opacity-90 transition"
      >
        Get Started &rarr;
      </button>
    </div>
  );
}
