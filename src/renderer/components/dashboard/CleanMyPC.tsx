import { useState } from 'react';
import type { SystemStatus, ActionName } from '@shared/types.js';
import { ACTIONS } from '@shared/actions.js';
import { api } from '@renderer/lib/ipc.js';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';
import { useConfirm } from '@renderer/lib/confirmContext.js';

/** Actions in the "Clean My PC" safe-suite. All are Tier C (no rollback needed) or self-reversing. */
const SUITE_ACTIONS: ActionName[] = [
  'clear_temp_files',
  'clean_recycle_bin',
  'flush_dns',
  'flush_arp_cache',
  'trim_ssd',
  'clean_browser_cache',
  'clean_onedrive_cache',
  'clean_teams_cache',
  'clean_discord_cache',
  'clean_spotify_cache',
  'rebuild_search_index',
  'compact_docker',
];

interface ActionRelevance {
  name: ActionName;
  needed: boolean;
  reason: string;
}

/** Decides whether each suite action is "needed" based on current system state + findings. */
function analyzeRelevance(status: SystemStatus | null): ActionRelevance[] {
  if (!status) return [];
  const findings = status.findings ?? [];
  const hasArea = (area: string) => findings.some(f => f.area.toLowerCase() === area.toLowerCase());
  const ramKpi = status.kpis.find(k => k.label === 'RAM Usage');
  const diskKpi = status.kpis.find(k => k.label === 'C: Drive Free');
  const ramHigh = ramKpi ? ramKpi.value > 75 : false;
  const diskLow = diskKpi ? diskKpi.value < 30 : false;
  const searchCorrupt = hasArea('Search');
  const bloat = hasArea('Startup') || hasArea('Explorer');
  void bloat;

  const reasons: Partial<Record<ActionName, ActionRelevance>> = {};
  const set = (name: ActionName, needed: boolean, reason: string) => { reasons[name] = { name, needed, reason }; };

  set('clear_temp_files', diskLow || true, diskLow ? 'C: drive is getting tight - clearing temp reclaims space' : 'Routine cleanup (~500MB–2GB typically reclaimed)');
  set('clean_recycle_bin', diskLow, diskLow ? 'Free space is low - emptying Recycle Bin helps' : 'Nothing urgent - Recycle Bin rarely matters');
  set('flush_dns', true, 'Always safe - refreshes DNS resolver cache');
  set('flush_arp_cache', true, 'Always safe - clears stale LAN address cache');
  set('trim_ssd', true, 'Safe for modern SSDs - improves sustained write speed');
  set('clean_browser_cache', diskLow, diskLow ? 'Browser caches can hold multi-GB - worth clearing' : 'Cache is small right now');
  set('clean_onedrive_cache', false, 'Only needed if OneDrive sync acting up');
  set('clean_teams_cache', false, 'Only needed if Teams is slow/failing');
  set('clean_discord_cache', false, 'Only needed if Discord acting up');
  set('clean_spotify_cache', diskLow, diskLow ? 'Spotify cache can be several GB' : 'Small unless you stream a lot');
  set('rebuild_search_index', searchCorrupt, searchCorrupt ? 'Search index is corrupted - Windows flagged it' : 'Index is healthy');
  set('compact_docker', ramHigh || diskLow, (ramHigh || diskLow) ? 'Reclaims Docker disk/memory' : 'Low Docker footprint - skip');

  return SUITE_ACTIONS.map(n => reasons[n]!).filter(Boolean);
}

interface CleanMyPCProps {
  status: SystemStatus | null;
}

type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'error';

interface StepProgress {
  name: ActionName;
  state: StepState;
  duration_ms?: number;
  message?: string;
  error?: string;
}

export function CleanMyPC({ status }: CleanMyPCProps) {
  const confirm = useConfirm();
  const [modalOpen, setModalOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepProgress[]>([]);
  const [completedAt, setCompletedAt] = useState<number | null>(null);

  const relevance = analyzeRelevance(status);
  const needed = relevance.filter(r => r.needed);
  const pct = relevance.length === 0 ? 0 : Math.round((needed.length / relevance.length) * 100);
  const threshold = 70;
  const canClean = pct >= threshold;

  function openModal() {
    setModalOpen(true);
    setSteps([]);
    setCompletedAt(null);
  }

  async function startClean() {
    const ok = await confirm({
      title: 'Clean My PC',
      body: (
        <div>
          <p className="mb-2">Runs {needed.length} cleanup actions in sequence. All are Tier C (no rollback needed). Takes ~3–8 minutes typically.</p>
          <p className="text-xs">Your PC will stay responsive throughout. Some browsers and chat apps will be briefly closed.</p>
        </div>
      ),
      tier: 'risky',
      confirmLabel: 'Start Clean',
    });
    if (!ok) return;

    setRunning(true);
    const plan: StepProgress[] = needed.map(r => ({ name: r.name, state: 'pending' }));
    setSteps([...plan]);

    for (let i = 0; i < plan.length; i++) {
      plan[i].state = 'running';
      setSteps([...plan]);
      try {
        const r = await api.runAction({ name: plan[i].name });
        if (r.ok) {
          if (r.data.success) {
            plan[i].state = 'done';
            plan[i].duration_ms = r.data.duration_ms;
            const res = r.data.result as { message?: string } | undefined;
            plan[i].message = res?.message ?? 'done';
          } else {
            plan[i].state = 'error';
            plan[i].error = r.data.error?.message ?? 'failed';
          }
        } else {
          plan[i].state = 'error';
          plan[i].error = r.error.message;
        }
      } catch (e: unknown) {
        plan[i].state = 'error';
        plan[i].error = e instanceof Error ? e.message : 'crashed';
      }
      setSteps([...plan]);
    }
    setRunning(false);
    setCompletedAt(Date.now());
  }

  return (
    <>
      <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 panel-contain">
        <div className="flex justify-between items-start gap-2 mb-2">
          <div>
            <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold">🧼 Clean My PC</div>
            <div className="text-[11px] text-text-secondary mt-1">
              {pct}% of cleanup steps look useful right now
            </div>
          </div>
          <button
            onClick={openModal}
            disabled={!canClean}
            className={`px-3 py-1.5 rounded-md text-[11px] font-bold ${canClean ? 'bg-[#238636] text-white' : 'bg-surface-700 text-text-secondary cursor-not-allowed'}`}
            title={canClean ? 'Open clean suite' : `Only ${pct}% of cleanup steps are needed right now - not worth running the full suite`}
          >
            {canClean ? `Clean My PC (${needed.length})` : 'Not Needed'}
          </button>
        </div>
        {!canClean && (
          <div className="text-[10px] text-text-secondary mt-1">
            Your PC looks clean - threshold to enable is {threshold}% of cleanup steps applicable. Individual actions still available in One-Click Actions.
          </div>
        )}
        {canClean && !running && steps.length === 0 && (
          <div className="text-[10px] text-status-warn mt-1">
            ⚠ Conditions suggest a cleanup pass would help. Click above to review.
          </div>
        )}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => !running && setModalOpen(false)}>
          <div className="bg-surface-800 border border-surface-600 rounded-lg w-full max-w-2xl p-5 shadow-2xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold mb-3">🧼 Clean My PC - Suite</h2>

            {!running && steps.length === 0 && (
              <>
                <div className="text-sm text-text-secondary mb-3">
                  Based on current state, <strong className="text-text-primary">{needed.length} of {relevance.length}</strong> cleanup steps look useful. Review below and click Start when ready.
                </div>
                <div className="space-y-1.5 mb-4">
                  {relevance.map(r => (
                    <div key={r.name} className={`flex items-start gap-2 p-2 rounded-md text-xs ${r.needed ? 'bg-status-info/5 border border-status-info/30' : 'bg-surface-900 border border-surface-700 opacity-60'}`}>
                      <span className="text-base">{r.needed ? '✓' : '○'}</span>
                      <div className="flex-1">
                        <div className="font-semibold">{ACTIONS[r.name].icon} {ACTIONS[r.name].label}</div>
                        <div className="text-[10px] text-text-secondary">{r.reason}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mb-4 p-3 bg-status-warn/10 border border-status-warn/40 rounded-md text-xs">
                  <strong>Actions you should ALSO run (not part of suite):</strong>
                  <ul className="list-disc pl-5 mt-1 space-y-0.5">
                    <li><strong>Run SFC</strong> - scans system files (5–15 min). Different from cleanup; do once a month.</li>
                    <li><strong>Run DISM Repair</strong> - fixes component store. Do after SFC if it reports issues.</li>
                    <li><strong>Windows Update</strong> - Updates page. Do monthly or when you see security KBs pending.</li>
                    <li><strong>MemTest86</strong> - RAM stress test. Only if you've had BSODs (requires reboot into USB).</li>
                    <li><strong>CPU repaste / heatsink clean</strong> - physical maintenance every 3–5 years.</li>
                  </ul>
                </div>

                <div className="flex justify-end gap-2">
                  <button onClick={() => setModalOpen(false)} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">Cancel</button>
                  <button onClick={startClean} className="px-4 py-1.5 rounded-md text-xs bg-[#238636] text-white font-bold">Start Clean ({needed.length} steps)</button>
                </div>
              </>
            )}

            {(running || steps.length > 0) && (
              <>
                <div className="text-sm text-text-secondary mb-3">
                  {running ? 'Running cleanup suite…' : (completedAt ? `Completed at ${new Date(completedAt).toLocaleTimeString()}` : 'Idle')}
                </div>
                <div className="space-y-1.5 mb-4">
                  {steps.map((s, i) => {
                    const def = ACTIONS[s.name];
                    const icon = s.state === 'done' ? '✓' : s.state === 'error' ? '✗' : s.state === 'running' ? null : s.state === 'skipped' ? '⤾' : '○';
                    const stateColor = s.state === 'done' ? 'text-status-good' : s.state === 'error' ? 'text-status-crit' : s.state === 'running' ? 'text-status-info' : 'text-text-secondary';
                    return (
                      <div key={i} className="flex items-start gap-2 p-2 rounded-md bg-surface-900 border border-surface-700 text-xs">
                        <span className={`w-5 text-center ${stateColor}`}>
                          {s.state === 'running' ? <LoadingSpinner size={12} /> : icon}
                        </span>
                        <div className="flex-1">
                          <div className="font-semibold">{def.icon} {def.label}</div>
                          <div className={`text-[10px] ${stateColor}`}>
                            {s.state === 'running' && 'Running…'}
                            {s.state === 'done' && (s.message ?? 'done')}
                            {s.state === 'error' && `Failed: ${s.error}`}
                            {s.state === 'pending' && 'Waiting…'}
                          </div>
                        </div>
                        {s.duration_ms != null && (
                          <div className="text-[10px] text-text-secondary">{(s.duration_ms / 1000).toFixed(1)}s</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {!running && (
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setModalOpen(false)} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">Close</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
