/**
 * W8 Integrations — eighth step of the first-run wizard (index 7).
 *
 * Three sub-sections:
 *   A) Claude Code — pure detection display (no user input)
 *   B) Obsidian Archive — optional toggle + directory input
 *   C) WSL Memory Cap — conditional on WSL being installed
 *
 * Reads everything from wizard state.systemProfile (fetched in W2).
 * No API calls on mount.
 *
 * Settings written on unmount:
 *   claude_detected, obsidian_enabled, obsidian_archive_dir, wsl_memory_limit_gb
 */

import { useEffect, useState, useCallback } from 'react';
import { useWizard } from '../WizardContext.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a default vault archive directory from the Obsidian executable path. */
function deriveObsidianDir(obsidianPath: string | null): string {
  if (!obsidianPath) return '';
  // Obsidian.exe is typically at C:\Users\<user>\AppData\Local\Obsidian\Obsidian.exe
  // A reasonable default vault location is the user's Documents folder.
  // Strip to the drive root + Users\<user> and append Documents\ObsidianReports.
  const match = obsidianPath.match(/^([A-Z]:\\Users\\[^\\]+)/i);
  if (match) return `${match[1]}\\Documents\\PCDoctor Reports`;
  return '';
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function W8Integrations() {
  const { state, dispatch, markComplete } = useWizard();
  const sp = state.systemProfile;

  // -- Section A: Claude Code (read-only) --
  const claudeInstalled = sp?.claude_cli?.installed ?? false;
  const claudePath = sp?.claude_cli?.path ?? null;

  // -- Section B: Obsidian --
  const obsidianInstalled = sp?.obsidian?.installed ?? false;
  const [obsEnabled, setObsEnabled] = useState(state.obsidianEnabled);
  const [obsDir, setObsDir] = useState(
    state.obsidianArchiveDir || deriveObsidianDir(sp?.obsidian?.path ?? null),
  );

  // -- Section C: WSL --
  const wslInstalled = sp?.wsl?.installed ?? false;
  const totalRamGb = sp?.ram?.total_gb ?? 0;
  const wslDefault = Math.floor(totalRamGb / 2);
  const [wslEnabled, setWslEnabled] = useState(state.wslMemoryLimitGb !== null);
  const [wslGb, setWslGb] = useState(
    state.wslMemoryLimitGb ?? sp?.wsl?.memory_limit_gb ?? wslDefault,
  );

  // -- Save all settings and mark complete on unmount --
  const saveSettings = useCallback(async () => {
    try {
      await Promise.all([
        window.api.setSetting('claude_detected', claudeInstalled ? '1' : '0'),
        window.api.setSetting('obsidian_enabled', obsEnabled ? '1' : '0'),
        window.api.setSetting('obsidian_archive_dir', obsDir),
        window.api.setSetting(
          'wsl_memory_limit_gb',
          wslInstalled && wslEnabled ? String(wslGb) : '',
        ),
      ]);
    } catch {
      // Non-fatal — settings can be adjusted later from the Settings page.
    }

    dispatch({ type: 'SET_FIELD', field: 'claudeDetected', value: claudeInstalled });
    dispatch({ type: 'SET_FIELD', field: 'obsidianEnabled', value: obsEnabled });
    dispatch({ type: 'SET_FIELD', field: 'obsidianArchiveDir', value: obsDir });
    dispatch({
      type: 'SET_FIELD',
      field: 'wslMemoryLimitGb',
      value: wslInstalled && wslEnabled ? wslGb : null,
    });
  }, [claudeInstalled, obsEnabled, obsDir, wslInstalled, wslEnabled, wslGb, dispatch]);

  useEffect(() => {
    return () => {
      void saveSettings();
      markComplete(7);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveSettings]);

  // -- Fallback: system profile not available --
  if (!sp) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
        <h2 className="text-lg font-bold text-text-primary">System profile not available.</h2>
        <p className="text-sm text-text-secondary">
          You can configure these in Settings later.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-2">
      {/* ── Title ── */}
      <div>
        <h2 className="text-lg font-bold text-text-primary flex items-center gap-2">
          {'\u{1F50C}'} Integrations
        </h2>
        <p className="text-sm text-text-secondary mt-0.5">
          Optional connections with external tools.
        </p>
      </div>

      {/* ── Section A: Claude Code ── */}
      <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary mb-2">Claude Code</h3>
        {claudeInstalled ? (
          <p className="text-sm text-status-good">
            {'✓'} Claude Code detected at <span className="font-mono text-xs">{claudePath}</span>.
            The Claude page will be available.
          </p>
        ) : (
          <p className="text-sm text-status-warn">
            Claude Code not detected. Install from{' '}
            <span className="underline">anthropic.com/claude-code</span>.
            The Claude page will be hidden until installed.
          </p>
        )}
      </div>

      {/* ── Section B: Obsidian Archive ── */}
      <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">Obsidian Archive</h3>
          <button
            type="button"
            role="switch"
            aria-checked={obsEnabled}
            aria-label="Save weekly reports to Obsidian vault"
            onClick={() => setObsEnabled(!obsEnabled)}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              obsEnabled ? 'bg-status-info' : 'bg-surface-600'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                obsEnabled ? 'translate-x-5' : ''
              }`}
            />
          </button>
        </div>
        <p className="text-xs text-text-secondary mt-1">
          Save weekly review reports to an Obsidian vault?
          {obsidianInstalled && ' Obsidian was detected on this system.'}
        </p>

        {obsEnabled && (
          <div className="mt-3">
            <label className="text-sm text-text-primary font-medium" htmlFor="obs-dir">
              Archive Directory
            </label>
            <input
              id="obs-dir"
              type="text"
              value={obsDir}
              onChange={(e) => setObsDir(e.target.value)}
              placeholder="C:\\Users\\you\\Documents\\PCDoctor Reports"
              className="w-full mt-1 px-3 py-2 rounded-md border border-surface-600 bg-surface-800 text-text-primary text-sm font-mono"
            />
          </div>
        )}
      </div>

      {/* ── Section C: WSL Memory Cap (conditional) ── */}
      {wslInstalled && (
        <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary">WSL Memory Cap</h3>
            <button
              type="button"
              role="switch"
              aria-checked={wslEnabled}
              aria-label="Limit WSL memory usage"
              onClick={() => setWslEnabled(!wslEnabled)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                wslEnabled ? 'bg-status-info' : 'bg-surface-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  wslEnabled ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>
          <p className="text-xs text-text-secondary mt-1">
            Your system has {totalRamGb} GB RAM. WSL defaults to using {wslDefault} GB.
          </p>

          {wslEnabled && (
            <div className="mt-3 flex items-center gap-2">
              <label className="text-sm text-text-primary font-medium" htmlFor="wsl-gb">
                Memory Limit (GB)
              </label>
              <input
                id="wsl-gb"
                type="number"
                min={1}
                max={totalRamGb}
                value={wslGb}
                onChange={(e) =>
                  setWslGb(Math.max(1, Math.min(totalRamGb, Number(e.target.value))))
                }
                className="w-20 px-2 py-1 rounded border border-surface-600 bg-surface-800 text-text-primary text-sm text-center"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
