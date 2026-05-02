/**
 * v2.5.26: First-run tools setup splash.
 *
 * Renders AFTER the first-run wizard (gated by `first_run_complete === '1'`)
 * and BEFORE the dashboard becomes useful (gated by
 * `dashboard_tools_setup_complete !== '1'`).
 *
 * Why this exists: PCDoctor's dashboard surfaces data from external tools
 * (LibreHardwareMonitor for live temps, CrystalDiskInfo for SMART, OCCT for
 * stress tests, HWiNFO64 for sensor logs). Pre-2.5.26 a fresh-install user
 * landed on the dashboard with mostly-empty panels and no clear path to fix
 * it -- the Tools page existed but was discoverable only by sidebar
 * navigation. Greg's second-PC install (2026-05-01) hit this exact dead-end:
 * dashboard populated with diagnostic data but temp tiles stayed at "--"
 * because LHM was never installed.
 *
 * Design contract:
 *   - REQUIRED tools (LHM, CrystalDiskInfo): blocking. Continue button is
 *     disabled until they are installed, OR the user explicitly clicks
 *     "Skip anyway" (with a warning).
 *   - RECOMMENDED tools (HWiNFO64, OCCT): non-blocking. Tiles surface
 *     download_url + post-install instructions; user can "Mark as installed"
 *     to track they've handled it manually.
 *   - LHM gets a callout block with the Remote Web Server setup steps
 *     because that's the load-bearing knowledge for temp data to flow.
 *
 * Mirrors WizardShell's pattern:
 *   - Outer gate component reads settings, decides visibility.
 *   - Inner overlay component renders the actual UI.
 *   - Listens for `pcd:rerun-tools-setup` custom DOM event from Settings page.
 *   - Dev override: `localStorage.pcd_force_tools_setup = '1'` forces show.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { TOOLS, type ToolDefinition } from '@shared/tools.js';
import type { ToolStatus } from '@shared/types.js';

// ---------------------------------------------------------------------------
// Outer gate
// ---------------------------------------------------------------------------

export function FirstRunToolsSplash() {
  const [visible, setVisible] = useState<boolean | null>(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Dev override: always show when the force flag is set.
        if (localStorage.getItem('pcd_force_tools_setup') === '1') {
          if (!cancelled) setVisible(true);
          return;
        }
        const r = await window.api.getSettings();
        if (!cancelled) {
          if (!r.ok) {
            setVisible(false);
            return;
          }
          // Wizard must be done before the splash gates the dashboard;
          // otherwise users would see the splash before the wizard.
          const wizardDone = r.data['first_run_complete'] === '1';
          const setupDone = r.data['dashboard_tools_setup_complete'] === '1';
          setVisible(wizardDone && !setupDone);
        }
      } catch {
        if (!cancelled) setVisible(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Re-run from Settings page.
  useEffect(() => {
    const handler = () => setVisible(true);
    window.addEventListener('pcd:rerun-tools-setup', handler);
    return () => window.removeEventListener('pcd:rerun-tools-setup', handler);
  }, []);

  if (visible === null || visible === false) return null;

  return <ToolsSplashOverlay onDone={() => setVisible(false)} />;
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

type InstallState = 'idle' | 'installing' | 'failed';

interface ToolRow {
  def: ToolDefinition;
  status: ToolStatus | undefined;
  installState: InstallState;
  /** User flag: "I installed this manually, treat as done." Persisted only
   *  in component state; the actual installed-detection still drives display
   *  on next mount (next launch will detect the file path). */
  manuallyMarked: boolean;
}

type LhmHealth = 'unknown' | 'checking' | 'reachable' | 'unreachable';

function ToolsSplashOverlay({ onDone }: { onDone: () => void }) {
  const [statuses, setStatuses] = useState<ToolStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installStates, setInstallStates] = useState<Record<string, InstallState>>({});
  const [manuallyMarked, setManuallyMarked] = useState<Set<string>>(new Set());
  const [showSkipWarning, setShowSkipWarning] = useState(false);
  const [bulkInstalling, setBulkInstalling] = useState(false);
  const [lhmHealth, setLhmHealth] = useState<LhmHealth>('unknown');
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // v2.5.26: probe LHM's Remote Web Server directly from the renderer.
  // Port 8085 is unauthenticated and CORS-permissive on localhost, so a
  // bare fetch works. This catches the most common LHM gotcha (installed
  // and running, but Remote Web Server toggle is off) before the user
  // lands on a dashboard with empty temp tiles. Re-checks every 5s while
  // the splash is open.
  const probeLhm = useCallback(async () => {
    setLhmHealth('checking');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('http://localhost:8085/data.json', {
        signal: ctrl.signal,
        cache: 'no-store',
      });
      clearTimeout(timer);
      setLhmHealth(res.ok ? 'reachable' : 'unreachable');
    } catch {
      setLhmHealth('unreachable');
    }
  }, []);

  // Initial load + polling so the UI reflects external installs.
  const refreshStatuses = useCallback(async () => {
    try {
      const r = await window.api.listTools();
      if (r.ok) setStatuses(r.data);
      else setError(r.error?.message ?? 'Failed to read tool status');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read tool status');
    }
  }, []);

  useEffect(() => {
    // v2.5.27 (hotfix from v2.5.26): split the polling cadence by cost.
    // Pre-2.5.27 we polled BOTH listTools() AND the LHM HTTP probe every 5s.
    // listTools() goes through IPC and spawns a PowerShell process for each
    // tool's filesystem detection -- ~hundreds of ms per call, plus N
    // concurrent `pwsh.exe` workers. Stacking that on top of "Install all
    // required" (which spawns winget for ~30s per tool) backed up the IPC
    // queue and froze the renderer on Greg's second-PC install (2026-05-01,
    // hard-killed via Ctrl-Alt-Del).
    //
    // New cadence:
    //   - Initial load fires both ONCE on mount.
    //   - LHM HTTP probe (cheap, port-8085 fetch) keeps the 5s cadence so
    //     toggling Remote Web Server reflects within ~5s.
    //   - listTools() (expensive PS spawn) only re-runs:
    //       a) after a user-initiated install completes (handled in onInstall)
    //       b) on-demand via the Refresh button (added in this rev)
    //     Polling listTools() in the background was speculative anyway --
    //     splashes are short-lived sessions, not steady-state monitors.
    void refreshStatuses();
    void probeLhm();
    refreshTimer.current = setInterval(() => {
      void probeLhm();
    }, 5000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [refreshStatuses, probeLhm]);

  // Build display rows for required + recommended tools only.
  const allRows: ToolRow[] = Object.values(TOOLS)
    .filter((d) => d.dashboard_required || d.dashboard_recommended)
    .map((def) => ({
      def,
      status: statuses?.find((s) => s.id === def.id),
      installState: installStates[def.id] ?? 'idle',
      manuallyMarked: manuallyMarked.has(def.id),
    }));

  const required = allRows.filter((r) => r.def.dashboard_required);
  const recommended = allRows.filter((r) => r.def.dashboard_recommended);

  // A required tool counts as satisfied if it's actually installed OR the user
  // has explicitly marked it as manually installed (escape hatch for tools
  // detect_paths can't see, e.g. portable installs).
  const isSatisfied = (row: ToolRow) =>
    row.status?.installed === true || row.manuallyMarked;

  const allRequiredSatisfied = required.every(isSatisfied);

  const onInstall = useCallback(async (id: string) => {
    setInstallStates((s) => ({ ...s, [id]: 'installing' }));
    try {
      const r = await window.api.installTool(id);
      if (!r.ok) {
        setInstallStates((s) => ({ ...s, [id]: 'failed' }));
      } else {
        setInstallStates((s) => ({ ...s, [id]: 'idle' }));
        await refreshStatuses();
      }
    } catch {
      setInstallStates((s) => ({ ...s, [id]: 'failed' }));
    }
  }, [refreshStatuses]);

  const onInstallAllRequired = useCallback(async () => {
    setBulkInstalling(true);
    const targets = required.filter(
      (row) => !row.status?.installed && row.def.winget_id && !row.manuallyMarked,
    );
    for (const row of targets) {
      // Sequential -- winget bulk-install is not parallel-safe.
      // eslint-disable-next-line no-await-in-loop
      await onInstall(row.def.id);
    }
    setBulkInstalling(false);
  }, [required, onInstall]);

  const toggleManuallyMarked = (id: string) => {
    setManuallyMarked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const finish = useCallback(() => {
    // v2.5.27 (hotfix): dismiss IMMEDIATELY, settings + scan fire-and-forget.
    // Pre-2.5.27 finish() awaited setSetting() which could hang behind a
    // backed-up IPC queue (the v2.5.26 listTools polling spawned a PS
    // worker every 5s; stacked behind concurrent winget installs the
    // queue piled up and the await never resolved). Result on Greg's
    // second-PC install: clicking Continue did nothing, splash froze,
    // user had to Ctrl-Alt-Del to recover.
    //
    // Both calls are idempotent: setSetting writes the same value on retry,
    // triggerInitialScan no-ops if a scan is already running. Worst case:
    // the setting write loses the race against window unload, the next
    // launch re-shows the splash, user clicks Continue again. That's a
    // strictly better failure mode than freezing the renderer.
    void window.api.setSetting('dashboard_tools_setup_complete', '1').catch(() => {});
    void window.api.triggerInitialScan().catch(() => {});
    onDone();
  }, [onDone]);

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-[100] bg-surface-900/95 backdrop-blur-sm flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
      aria-label="First-run tools setup"
    >
      <div className="bg-surface-800 rounded-lg shadow-2xl border border-surface-600 max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-surface-600">
          <h2 className="text-lg font-bold text-text-primary">
            {'\u{1F6E0}'} Tools setup
          </h2>
          <p className="text-sm text-text-secondary mt-1">
            PCDoctor uses these external tools to populate the dashboard. Required tools must
            be installed for the dashboard to work fully; recommended tools enable extra panels.
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {error && (
            <div className="mb-4 px-3 py-2 rounded-md bg-status-warn/10 border border-status-warn/40 text-sm text-status-warn">
              {error}
            </div>
          )}

          {statuses === null && !error && (
            <div className="text-sm text-text-secondary">Detecting installed tools…</div>
          )}

          {/* v2.5.27: manual refresh. Replaces the v2.5.26 background poll
              that fired listTools() every 5s and froze the IPC queue when
              stacked on top of bulk winget installs. Click after manually
              installing a tool outside the splash to re-detect. */}
          {statuses !== null && (
            <div className="flex justify-end mb-2">
              <button
                type="button"
                onClick={() => void refreshStatuses()}
                disabled={bulkInstalling}
                className="text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-50"
              >
                ⟳ Refresh detection
              </button>
            </div>
          )}

          {statuses !== null && (
            <>
              {/* Required */}
              <h3 className="text-sm font-semibold text-text-primary mb-2">
                {'⚡'} Required ({required.filter(isSatisfied).length} of {required.length})
              </h3>
              <div className="flex flex-col gap-2 mb-5">
                {required.map((row) => (
                  <ToolRowCard
                    key={row.def.id}
                    row={row}
                    onInstall={() => void onInstall(row.def.id)}
                    onToggleManuallyMarked={() => toggleManuallyMarked(row.def.id)}
                    isRequired
                    // v2.5.26: pass LHM-specific RWS health state so the LHM
                    // tile shows a green/red indicator. Other tools ignore it.
                    lhmHealth={row.def.id === 'librehardwaremonitor' ? lhmHealth : undefined}
                  />
                ))}
                {required.some((r) => !r.status?.installed && r.def.winget_id && !r.manuallyMarked) && (
                  <button
                    type="button"
                    onClick={() => void onInstallAllRequired()}
                    disabled={bulkInstalling}
                    className="self-start px-4 py-2 rounded-md bg-status-info text-white font-semibold text-sm hover:opacity-90 disabled:opacity-50 transition"
                  >
                    {bulkInstalling ? 'Installing…' : 'Install all required (winget)'}
                  </button>
                )}
              </div>

              {/* Recommended */}
              <h3 className="text-sm font-semibold text-text-primary mb-2">
                {'\u{1F4A1}'} Recommended
              </h3>
              <div className="flex flex-col gap-2">
                {recommended.map((row) => (
                  <ToolRowCard
                    key={row.def.id}
                    row={row}
                    onInstall={() => void onInstall(row.def.id)}
                    onToggleManuallyMarked={() => toggleManuallyMarked(row.def.id)}
                    isRequired={false}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-surface-600 flex items-center justify-between gap-3">
          {showSkipWarning ? (
            <>
              <p className="text-xs text-status-warn flex-1">
                Required tools are missing. Some dashboard panels (live temps, SMART status)
                will be empty until you install them. Continue anyway?
              </p>
              <button
                type="button"
                onClick={() => setShowSkipWarning(false)}
                className="px-3 py-1.5 rounded-md border border-surface-600 text-text-secondary text-sm hover:bg-surface-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void finish()}
                className="px-4 py-2 rounded-md bg-status-warn text-white font-semibold text-sm hover:opacity-90"
              >
                Skip anyway
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-text-secondary flex-1">
                {allRequiredSatisfied
                  ? 'All required tools are installed. You can continue to the dashboard.'
                  : 'Install required tools above, then continue.'}
              </p>
              <button
                type="button"
                onClick={() => allRequiredSatisfied ? void finish() : setShowSkipWarning(true)}
                className={`px-4 py-2 rounded-md font-semibold text-sm transition ${
                  allRequiredSatisfied
                    ? 'bg-status-info text-white hover:opacity-90'
                    : 'border border-surface-600 text-text-secondary hover:bg-surface-700'
                }`}
              >
                {allRequiredSatisfied ? 'Continue to Dashboard' : 'Skip & Continue'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool row card (one tile per tool)
// ---------------------------------------------------------------------------

interface ToolRowCardProps {
  row: ToolRow;
  onInstall: () => void;
  onToggleManuallyMarked: () => void;
  isRequired: boolean;
  /** v2.5.26: optional health status from a live HTTP probe. Currently used
   *  only for LHM (port 8085 Remote Web Server). 'reachable' = green check,
   *  'unreachable' = orange warning, 'checking'/'unknown' = silent. */
  lhmHealth?: LhmHealth;
}

function ToolRowCard({ row, onInstall, onToggleManuallyMarked, isRequired, lhmHealth }: ToolRowCardProps) {
  const { def, status, installState, manuallyMarked } = row;
  const installed = status?.installed === true;
  const satisfied = installed || manuallyMarked;

  return (
    <div className="rounded-md border border-surface-600 bg-surface-700/50 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="text-xl shrink-0 mt-0.5" aria-hidden>{def.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text-primary truncate">{def.name}</span>
            {satisfied && (
              <span className="text-[10px] font-semibold text-status-good">{installed ? '✓ Installed' : '✓ Marked'}</span>
            )}
            {!satisfied && isRequired && (
              <span className="text-[10px] font-semibold text-status-warn">Missing</span>
            )}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">{def.description}</div>

          {/* Action row */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {!installed && def.winget_id && (
              <button
                type="button"
                onClick={onInstall}
                disabled={installState === 'installing'}
                className="px-2.5 py-1 rounded-md bg-status-info text-white text-[11px] font-medium hover:opacity-90 disabled:opacity-50"
              >
                {installState === 'installing' ? 'Installing…' :
                 installState === 'failed' ? 'Retry install' :
                 'Install via winget'}
              </button>
            )}
            {!installed && def.download_url && (
              <button
                type="button"
                onClick={() => { window.open(def.download_url!, '_blank'); }}
                className="px-2.5 py-1 rounded-md border border-surface-600 text-text-primary text-[11px] hover:bg-surface-700"
              >
                Download…
              </button>
            )}
            {!installed && (
              <label className="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={manuallyMarked}
                  onChange={onToggleManuallyMarked}
                  className="accent-status-info"
                />
                Mark as installed
              </label>
            )}
          </div>

          {/* v2.5.26: LHM Remote Web Server health line. Renders only when
              lhmHealth is passed (i.e. this tile is the LHM tile) and LHM is
              installed. Shows green when port 8085 is responding, orange
              when not -- this is the load-bearing post-install step that's
              easy to forget. */}
          {installed && lhmHealth !== undefined && lhmHealth !== 'unknown' && (
            <div className="mt-2 text-[11px]">
              {lhmHealth === 'reachable' && (
                <span className="text-status-good">
                  ✓ Remote Web Server reachable on port 8085 — temps will flow to the dashboard.
                </span>
              )}
              {lhmHealth === 'unreachable' && (
                <span className="text-status-warn">
                  ⚠ Remote Web Server is OFF. In LHM: <strong>Options → Remote Web Server → Run</strong>. (Re-checking every 5s.)
                </span>
              )}
              {lhmHealth === 'checking' && (
                <span className="text-text-secondary">Checking Remote Web Server…</span>
              )}
            </div>
          )}

          {/* Post-install instructions (only when not yet installed, to nudge
              the user; or always for LHM since the Remote Web Server step is
              easy to forget). For now: show if defined AND not installed, OR
              the tool is required and NOT yet satisfied (escapes the
              "installed but RWS off" pitfall for LHM specifically). */}
          {def.post_install_instructions && (!installed || (isRequired && !satisfied)) && (
            <details className="mt-2">
              <summary className="text-[11px] text-text-secondary cursor-pointer hover:text-text-primary">
                Setup steps after install
              </summary>
              <pre className="mt-1.5 px-2.5 py-1.5 rounded bg-surface-800 text-[10.5px] text-text-secondary whitespace-pre-wrap font-sans leading-snug">
                {def.post_install_instructions}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
