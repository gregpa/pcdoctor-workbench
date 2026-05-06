/**
 * v2.5.30 (P4): Processes page.
 *
 * Lists running processes via api.listAllProcesses, with search + filter
 * chips + sort. Each row offers Priority dropdown (immediate fire),
 * Suspend/Resume button, and Kill button. Kill and Suspend on
 * system_critical processes route through ProcessConfirmDialog with the
 * "I understand" gate. Set-Affinity is intentionally NOT exposed in the
 * UI (advanced; can be invoked via DevTools or future detail panel) --
 * the IPC handler still works.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { ProcessRow, ProcessPriorityClass } from '@shared/types.js';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';
import { ProcessConfirmDialog, type ProcessActionKind } from '@renderer/components/processes/ProcessConfirmDialog.js';
import { AffinityModal } from '@renderer/components/processes/AffinityModal.js';

type FilterChip = 'all' | 'system' | 'user' | 'critical';
type SortKey = 'name' | 'pid' | 'memory';

const PRIORITIES: ProcessPriorityClass[] = ['Idle','BelowNormal','Normal','AboveNormal','High','RealTime'];

interface PendingAction {
  process: ProcessRow;
  kind: ProcessActionKind;
}

interface ToastState {
  message: string;
}

function rowMatchesChip(row: ProcessRow, chip: FilterChip): boolean {
  switch (chip) {
    case 'all':       return true;
    case 'system':    return row.kind === 'system';
    case 'user':      return row.kind === 'user';
    case 'critical':  return row.system_critical;
  }
}

function rowMatchesSearch(row: ProcessRow, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return row.name.toLowerCase().includes(needle) || String(row.pid).includes(needle);
}

function compareRows(a: ProcessRow, b: ProcessRow, key: SortKey): number {
  switch (key) {
    case 'name':   return a.name.localeCompare(b.name);
    case 'pid':    return a.pid - b.pid;
    case 'memory': return b.ws_mb - a.ws_mb;
  }
}

export function Processes() {
  const [processes, setProcesses] = useState<ProcessRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<FilterChip>('all');
  const [sortKey, setSortKey] = useState<SortKey>('memory');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);
  // Track suspended PIDs locally (PS-side status detection cross-shell isn't
  // reliable; clearing on next refresh restores authoritative state).
  const [suspendedPids, setSuspendedPids] = useState<Set<number>>(new Set());
  // v2.5.38: which row's affinity modal is open
  const [affinityFor, setAffinityFor] = useState<ProcessRow | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const r = await api.listAllProcesses();
    setLoading(false);
    if (r.ok) {
      setProcesses(r.data);
      // Drop suspended state for PIDs that no longer exist (the real state
      // re-asserts itself on next user-initiated suspend).
      setSuspendedPids((prev) => {
        const alive = new Set(r.data.map((p) => p.pid));
        const next = new Set<number>();
        for (const pid of prev) if (alive.has(pid)) next.add(pid);
        return next;
      });
    } else {
      setLoadError(`${r.error.code}: ${r.error.message}`);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Auto-refresh every 5s so the list reflects new/dead processes.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!processes) return [];
    return processes
      .filter((p) => rowMatchesChip(p, chip) && rowMatchesSearch(p, search))
      .sort((a, b) => compareRows(a, b, sortKey));
  }, [processes, chip, search, sortKey]);

  const showToast = (message: string) => {
    setToast({ message });
    setTimeout(() => setToast(null), 5000);
  };

  const dropProcess = useCallback((pid: number) => {
    setProcesses((prev) => prev?.filter((p) => p.pid !== pid) ?? null);
    setSuspendedPids((prev) => { const n = new Set(prev); n.delete(pid); return n; });
  }, []);

  // ── Mutate handlers ────────────────────────────────────────────────────
  const handlePriorityChange = useCallback(async (proc: ProcessRow, target: ProcessPriorityClass) => {
    setBusyPid(proc.pid);
    try {
      const r = await api.setProcessPriority(proc.pid, target);
      if (r.ok) {
        showToast(`${proc.name} (pid ${proc.pid}): priority → ${target}`);
      } else {
        // eslint-disable-next-line no-alert
        alert(`Set priority failed: ${r.error.code}: ${r.error.message}`);
      }
    } finally {
      setBusyPid(null);
    }
  }, []);

  const handleResume = useCallback(async (proc: ProcessRow) => {
    setBusyPid(proc.pid);
    try {
      const r = await api.resumeProcess(proc.pid);
      if (r.ok) {
        setSuspendedPids((prev) => { const n = new Set(prev); n.delete(proc.pid); return n; });
        showToast(`${proc.name} (pid ${proc.pid}): resumed`);
      } else {
        // eslint-disable-next-line no-alert
        alert(`Resume failed: ${r.error.code}: ${r.error.message}`);
      }
    } finally {
      setBusyPid(null);
    }
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!pending) return;
    const { process: proc, kind } = pending;
    setBusyPid(proc.pid);
    setPending(null);
    try {
      let r;
      if (kind === 'kill') {
        r = await api.killProcess(proc.pid);
      } else {
        r = await api.suspendProcess(proc.pid);
      }
      if (r.ok) {
        if (kind === 'kill') {
          dropProcess(proc.pid);
          showToast(`${proc.name} (pid ${proc.pid}): killed`);
        } else {
          setSuspendedPids((prev) => { const n = new Set(prev); n.add(proc.pid); return n; });
          showToast(`${proc.name} (pid ${proc.pid}): suspended`);
        }
      } else {
        // eslint-disable-next-line no-alert
        alert(`${kind === 'kill' ? 'Kill' : 'Suspend'} failed: ${r.error.code}: ${r.error.message}`);
      }
    } finally {
      setBusyPid(null);
    }
  }, [pending, dropProcess]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-bold text-text-primary">Processes</h1>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="px-3 py-1 rounded-md border border-surface-600 text-text-secondary text-xs hover:bg-surface-700 disabled:opacity-50"
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Search by name or pid…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-1.5 rounded-md bg-surface-800 border border-surface-600 text-text-primary text-xs"
          aria-label="Search processes"
        />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="bg-surface-800 border border-surface-600 rounded px-2 py-1.5 text-xs text-text-primary"
          aria-label="Sort by"
        >
          <option value="memory">Sort: Memory</option>
          <option value="name">Sort: Name</option>
          <option value="pid">Sort: PID</option>
        </select>
        <span className="text-[11px] text-text-secondary whitespace-nowrap">
          {processes ? `${filtered.length} / ${processes.length}` : '—'}
        </span>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {(['all','user','system','critical'] as FilterChip[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setChip(c)}
            className={`px-2.5 py-1 rounded-full text-[11px] border transition ${
              chip === c
                ? 'bg-status-info/20 border-status-info/50 text-text-primary'
                : 'border-surface-600 text-text-secondary hover:bg-surface-700/50'
            }`}
          >
            {c === 'critical' ? '⚠ critical' : c}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="rounded-md border border-status-crit/40 bg-status-crit/10 px-3 py-2 text-xs text-text-primary">
          {loadError}
        </div>
      )}

      {!processes && loading && (
        <div className="flex items-center gap-2 text-xs text-text-secondary py-6">
          <LoadingSpinner /> Enumerating processes…
        </div>
      )}

      {processes && (
        <div className="rounded-lg border border-surface-600 bg-surface-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-surface-700 text-text-secondary uppercase text-[10px] tracking-wider">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Name</th>
                <th className="text-right px-3 py-2 font-semibold">PID</th>
                <th className="text-right px-3 py-2 font-semibold">Memory</th>
                <th className="text-left px-3 py-2 font-semibold">Priority</th>
                <th className="text-right px-3 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const busy = busyPid === p.pid;
                const suspended = suspendedPids.has(p.pid);
                return (
                  <tr key={p.pid} className="border-t border-surface-700 hover:bg-surface-700/30">
                    <td className="px-3 py-2 text-text-primary">
                      {p.system_critical && (
                        <span title={p.system_critical_reason ?? 'System process'} className="inline-block mr-1.5 text-status-warn">⚠</span>
                      )}
                      {p.name}
                      {suspended && <span className="ml-2 text-[10px] text-status-warn">[paused]</span>}
                    </td>
                    <td className="px-3 py-2 text-text-secondary font-mono text-right">{p.pid}</td>
                    <td className="px-3 py-2 text-text-secondary font-mono text-right">{p.ws_mb} MB</td>
                    <td className="px-3 py-2">
                      <select
                        defaultValue="Normal"
                        disabled={busy || p.system_critical}
                        onChange={(e) => void handlePriorityChange(p, e.target.value as ProcessPriorityClass)}
                        className="bg-surface-700 border border-surface-600 rounded px-1.5 py-0.5 text-[11px] text-text-primary disabled:opacity-30"
                        aria-label={`Priority for ${p.name}`}
                      >
                        {PRIORITIES.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-1.5">
                        {suspended ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleResume(p)}
                            className="px-2 py-0.5 rounded border border-status-info/50 text-[11px] text-status-info hover:bg-status-info/10 disabled:opacity-30"
                            aria-label={`Resume ${p.name}`}
                          >
                            ▶ Resume
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setPending({ process: p, kind: 'suspend' })}
                            className="px-2 py-0.5 rounded border border-surface-600 text-[11px] text-text-secondary hover:bg-surface-700 disabled:opacity-30"
                            aria-label={`Suspend ${p.name}`}
                          >
                            ⏸ Suspend
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setAffinityFor(p)}
                          title="Set CPU affinity (pin to specific cores)"
                          className="px-2 py-0.5 rounded border border-surface-600 text-[11px] text-text-secondary hover:bg-surface-700 disabled:opacity-30"
                          aria-label={`Set CPU affinity for ${p.name}`}
                        >
                          🧮 CPU
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setPending({ process: p, kind: 'kill' })}
                          className="px-2 py-0.5 rounded border border-status-crit/40 text-[11px] text-status-crit hover:bg-status-crit/10 disabled:opacity-30"
                          aria-label={`Kill ${p.name}`}
                        >
                          ☠ Kill
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && !loading && (
            <div className="p-6 text-center text-xs text-text-secondary">No processes match the current filter.</div>
          )}
        </div>
      )}

      {pending && (
        <ProcessConfirmDialog
          open={true}
          process={{ pid: pending.process.pid, name: pending.process.name }}
          kind={pending.kind}
          systemCritical={pending.process.system_critical}
          systemCriticalReason={pending.process.system_critical_reason}
          onCancel={() => setPending(null)}
          onConfirm={handleConfirm}
        />
      )}

      {affinityFor && (
        <AffinityModal
          pid={affinityFor.pid}
          name={affinityFor.name}
          systemCritical={affinityFor.system_critical}
          onClose={() => setAffinityFor(null)}
          onApplied={() => setToast({ message: `${affinityFor.name}: CPU affinity updated` })}
        />
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-40 max-w-[360px] rounded-lg border border-surface-600 bg-surface-800 shadow-2xl px-4 py-3 text-[12px] text-text-primary"
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
