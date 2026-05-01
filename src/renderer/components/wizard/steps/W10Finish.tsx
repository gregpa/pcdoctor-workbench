/**
 * W10 Finish — tenth and final step of the first-run wizard (index 9).
 *
 * Summarises every wizard decision in a compact grid, offers a one-click
 * initial scan trigger, and writes completion metadata to settings.
 *
 * No API calls on mount beyond setSetting (fire-and-forget).
 * All data is read from wizard state populated by earlier steps.
 *
 * Settings written on mount:
 *   wizard_completed_at (ISO timestamp)
 *   wizard_version ('2')
 *
 * On unmount: markComplete(9)
 */

import { useEffect, useState, useRef } from 'react';
import { useWizard } from '../WizardContext.js';

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function W10Finish() {
  const { state, dispatch, markComplete } = useWizard();
  const [scanTriggered, setScanTriggered] = useState(state.initialScanTriggered);
  const settingsWritten = useRef(false);

  // -- Write completion metadata on mount --
  useEffect(() => {
    if (settingsWritten.current) return;
    settingsWritten.current = true;
    void Promise.all([
      window.api.setSetting('wizard_completed_at', new Date().toISOString()),
      window.api.setSetting('wizard_version', '2'),
    ]).catch(() => { /* non-fatal */ });
  }, []);

  // -- Mark complete on unmount --
  useEffect(() => {
    return () => {
      markComplete(9);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Helpers --
  const sp = state.systemProfile;

  const systemSummary = sp
    ? `${sp.cpu?.name ?? 'Unknown CPU'} / ${sp.ram?.total_gb ?? '?'} GB / ${sp.gpu?.name ?? 'No GPU detected'}`
    : 'Not detected';

  const nasSummary =
    state.nasServer && state.nasMappings.length > 0
      ? `${state.nasMappings.length} drive${state.nasMappings.length !== 1 ? 's' : ''} mapped to ${state.nasServer}`
      : 'Disabled';

  const securitySummary = state.defenderExclusionApplied
    ? 'Defender exclusion applied'
    : 'Defender exclusion skipped';

  const notifSummary = state.telegramEnabled ? 'Telegram configured' : 'Telegram skipped';

  const toolsSummary =
    state.selectedTools.length > 0
      ? `${state.selectedTools.length} tool${state.selectedTools.length !== 1 ? 's' : ''} selected`
      : 'Skipped';

  const autopilotSummary = state.autopilotEnabled ? 'Enabled' : 'Customized';

  const integrationParts: string[] = [];
  if (state.claudeDetected) integrationParts.push('Claude');
  if (state.obsidianEnabled) integrationParts.push('Obsidian');
  if (state.wslMemoryLimitGb !== null) integrationParts.push('WSL');
  const integrationsSummary = integrationParts.length > 0
    ? integrationParts.join(', ')
    : 'None';

  const tasksSummary = state.tasksRegistered ? 'Registered' : 'Skipped';

  const handleRunScan = () => {
    void window.api.triggerInitialScan();
    setScanTriggered(true);
    dispatch({ type: 'SET_FIELD', field: 'initialScanTriggered', value: true });
  };

  // -- Summary rows config --
  const rows: Array<{ icon: string; label: string; value: string; active: boolean }> = [
    { icon: '\u{1F5A5}', label: 'System',        value: systemSummary,       active: !!sp },
    { icon: '\u{1F5C4}', label: 'NAS',           value: nasSummary,          active: !!state.nasServer },
    { icon: '\u{1F6E1}', label: 'Security',      value: securitySummary,     active: state.defenderExclusionApplied },
    { icon: '\u{1F4F1}', label: 'Notifications', value: notifSummary,        active: state.telegramEnabled },
    { icon: '\u{1F6E0}', label: 'Tools',         value: toolsSummary,        active: state.selectedTools.length > 0 },
    { icon: '\u{1F916}', label: 'Autopilot',     value: autopilotSummary,    active: state.autopilotEnabled },
    { icon: '\u{1F50C}', label: 'Integrations',  value: integrationsSummary, active: integrationParts.length > 0 },
    { icon: '\u{1F4C5}', label: 'Tasks',         value: tasksSummary,        active: state.tasksRegistered },
  ];

  return (
    <div className="flex flex-col gap-5 py-2">
      {/* -- Title -- */}
      <div className="text-center">
        <h2 className="text-lg font-bold text-text-primary">
          {'\u{1F389}'} Setup Complete!
        </h2>
        <p className="text-sm text-text-secondary mt-0.5">
          Here's a summary of your configuration.
        </p>
      </div>

      {/* -- Summary grid -- */}
      <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-3 py-1">
              <span className="text-base w-6 text-center shrink-0">{row.icon}</span>
              <span className="text-sm font-medium text-text-primary w-28 shrink-0">{row.label}</span>
              <span className={`text-sm ${row.active ? 'text-status-good' : 'text-text-secondary'}`}>
                {row.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* -- Initial scan section -- */}
      <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary mb-1">Initial Diagnostic Scan</h3>
        <p className="text-xs text-text-secondary mb-3">
          Run an initial diagnostic scan to populate the dashboard?
        </p>

        {scanTriggered ? (
          <p className="text-sm text-status-good">
            {'✓'} Scan started — dashboard will populate shortly
          </p>
        ) : (
          <button
            type="button"
            onClick={handleRunScan}
            className="px-4 py-2 rounded-md bg-status-info text-white font-semibold text-sm hover:opacity-90 transition"
          >
            Run Scan
          </button>
        )}
      </div>

      {/* -- Final note -- */}
      <p className="text-xs text-text-secondary text-center">
        Click <span className="font-semibold text-text-primary">Finish</span> below to close the wizard and open the dashboard.
      </p>
    </div>
  );
}
