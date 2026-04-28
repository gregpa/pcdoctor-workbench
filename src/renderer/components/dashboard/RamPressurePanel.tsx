/**
 * RamPressurePanel (v2.3.0 - C3)
 *
 * Deeper RAM breakdown that replaces the simple RAM gauge when RAM > 75%.
 * Uses status.metrics.memory_pressure (scanner emits this via Get-Counter) to
 * surface commit state, top consumers, and a contextual advice sentence.
 */
import type { SystemStatus } from '@shared/types.js';
import { useConfirm } from '@renderer/lib/confirmContext.js';

interface TopProcess {
  name: string;
  pid: number;
  ws_bytes: number;
  kind: 'user' | 'service' | 'system';
}

export interface RamPressurePanelProps {
  status: SystemStatus;
  onKillProcess?: (name: string) => void | Promise<void>;
}

function gb(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Greg often has 4+ `claude` processes; aggregate them into a single row for
 * the UI (one Kill button stops them all) so the top-5 doesn't get crowded.
 */
function groupClaudeProcesses(procs: TopProcess[]): TopProcess[] {
  const claudes = procs.filter(p => /^claude(\.exe)?$/i.test(p.name));
  if (claudes.length <= 1) return procs;
  const totalWs = claudes.reduce((s, p) => s + p.ws_bytes, 0);
  const nonClaude = procs.filter(p => !/^claude(\.exe)?$/i.test(p.name));
  return [
    { name: 'claude.exe', pid: -1, ws_bytes: totalWs, kind: 'user' as const },
    ...nonClaude,
  ];
}

function advice(status: SystemStatus): string | null {
  const m = status.metrics?.memory_pressure;
  const wsl = status.metrics?.wsl_config;
  if (!m) return null;

  // Severely overcommitted — committed bytes exceed physical RAM total
  const kpi = status.kpis.find(k => k.label?.toLowerCase().includes('ram') && k.unit === '%');
  // Rough estimate of physical from KPI sub text ("x GB free of y GB")
  // We use the commit_limit / committed ratio instead for robustness.
  if (m.committed_bytes && m.commit_limit && m.committed_bytes > m.commit_limit * 0.95) {
    const overGb = ((m.committed_bytes - m.commit_limit) / 1024 ** 3).toFixed(1);
    return `⚠ Severely overcommitted — ${overGb} GB paging to disk. Close apps or add RAM.`;
  }

  // WSL at the cap
  if (wsl?.has_memory_cap && (wsl.vmmem_utilization_pct ?? 0) >= 90) {
    return `WSL is hitting its ${wsl.memory_gb} GB cap. \`wsl --shutdown\` will free it.`;
  }

  // Large Memory Compression
  if (typeof m.compression_mb === 'number' && m.compression_mb > 1024) {
    const compGb = (m.compression_mb / 1024).toFixed(1);
    return `Windows is compressing ${compGb} GB of memory — reboot clears.`;
  }

  // No pressure
  if (kpi && typeof kpi.value === 'number' && kpi.value <= 75) {
    return '✓ RAM healthy';
  }
  return null;
}

export function RamPressurePanel({ status, onKillProcess }: RamPressurePanelProps) {
  const confirm = useConfirm();
  // v2.4.31 B22: gate the Kill button behind a destructive confirm.
  // Previously a single mis-click terminated a user-process with its
  // unsaved work. All dashboard action buttons go through confirm at
  // risky/destructive levels; the kill button was the one exception.
  async function handleKillClick(name: string) {
    if (!onKillProcess) return;
    const ok = await confirm({
      title: `Kill ${name}?`,
      body: (
        <div>
          <p className="mb-2">Terminates the process. Any unsaved work is lost immediately and there is no Undo.</p>
          <p className="text-xs">Use this when a process is runaway or unresponsive; for normal quitting, close the app via its own UI first.</p>
        </div>
      ),
      tier: 'destructive',
      confirmLabel: 'Kill',
    });
    if (!ok) return;
    await onKillProcess(name);
  }

  const m = status.metrics?.memory_pressure ?? {
    committed_bytes: null, commit_limit: null, pages_per_sec: null, page_faults_per_sec: null, compression_mb: null, top_processes: [],
  };
  const ramKpi = status.kpis.find(k => k.label?.toLowerCase().includes('ram') && k.unit === '%');
  const ramPct = typeof ramKpi?.value === 'number' ? ramKpi.value : 0;
  const ramSub = ramKpi?.sub ?? '';

  const paging = m.committed_bytes && m.commit_limit && m.committed_bytes > m.commit_limit
    ? m.committed_bytes - m.commit_limit
    : 0;

  const topRaw = (m.top_processes ?? []) as TopProcess[];
  const top = groupClaudeProcesses(topRaw).slice(0, 5);
  const tip = advice(status);

  return (
    // v2.4.30: dropped col-span-2. v2.4.29 moved the gauges row to
    // grid-cols-3 (CPU gauge + Disk gauge + RAM panel), but the
    // lingering col-span-2 made RAM panel 2 cols wide, pushing the
    // total to 4 cols in a 3-col grid which wrapped RAM onto its own
    // row below the gauges. Single col is slightly denser but
    // matches the requested CPU | Disk | RAM layout.
    <div className="pcd-panel pcd-panel-interactive">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold">RAM Pressure</div>
          <div className="text-sm font-semibold mt-0.5">
            {ramPct}% used {ramSub && <span className="text-[11px] text-text-secondary font-normal"> · {ramSub}</span>}
          </div>
        </div>
      </div>

      {/* Commit state */}
      <div className="mt-1.5 text-[10px] text-text-secondary">
        Committed {gb(m.committed_bytes)} / {gb(m.commit_limit)}
        {paging > 0 && (
          <> · <span className="text-status-warn">paging {gb(paging)} to disk</span></>
        )}
        {typeof m.compression_mb === 'number' && m.compression_mb > 0 && (
          <> · compression {Math.round(m.compression_mb)} MB</>
        )}
      </div>

      {/* Top consumers */}
      {top.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] text-text-secondary mb-1">Top memory consumers</div>
          <div className="space-y-0.5">
            {top.map((p, i) => (
              <div key={`${p.name}-${p.pid}-${i}`} className="flex items-center gap-2 text-[11px]">
                <span className="w-4 text-text-secondary">
                  {p.kind === 'system' ? '⚙' : p.kind === 'service' ? '🔧' : '📦'}
                </span>
                <span className="font-mono flex-1 truncate">{p.name}{p.pid > 0 ? ` (${p.pid})` : ''}</span>
                <span className="text-text-secondary">{gb(p.ws_bytes)}</span>
                {p.kind === 'user' && onKillProcess && (
                  <button
                    onClick={() => { void handleKillClick(p.name); }}
                    className="px-1.5 py-0.5 rounded text-[10px] bg-status-crit/20 text-status-crit border border-status-crit/40"
                  >
                    Kill
                  </button>
                )}
                {p.kind === 'service' && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface-700 border border-surface-600 text-text-secondary">
                    service
                  </span>
                )}
                {p.kind === 'system' && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface-700 border border-surface-600 text-text-secondary opacity-60">
                    system
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tip && (
        <div className="mt-2 text-[10px] text-status-info border-t border-surface-700 pt-2">
          {tip}
        </div>
      )}
    </div>
  );
}
