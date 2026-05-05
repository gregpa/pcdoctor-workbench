/**
 * v2.5.30: Services page.
 *
 * Lists every Windows service via api.listAllServices, with search +
 * filter chips + sortable table. Each row exposes Start/Stop/Restart
 * buttons + a StartupType select. Clicking any mutate fires:
 *   1. dryRun call -> ServiceConfirmDialog (load-bearing variant if applicable)
 *   2. on Confirm -> real call -> refresh row -> ServiceUndoToast
 *
 * Distinct from the Dashboard's curated ServicePill tile which only
 * surfaces ~10 health-watched services.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { ServiceRow, ServiceStartType } from '@shared/types.js';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';
import { ServiceConfirmDialog, type ServiceMutateKind, type ServicePreview } from '@renderer/components/services/ServiceConfirmDialog.js';
import { ServiceUndoToast } from '@renderer/components/services/ServiceUndoToast.js';

type FilterChip = 'all' | 'running' | 'stopped' | 'auto' | 'manual' | 'disabled' | 'load-bearing';

interface PendingAction {
  service: ServiceRow;
  kind: ServiceMutateKind;
  startupTypeTarget?: ServiceStartType;
  preview: ServicePreview | null;
  runningDependents?: string[];
}

interface ToastState {
  actionId: number;
  message: string;
}

const STARTUP_TYPES: ServiceStartType[] = ['Automatic', 'AutomaticDelayedStart', 'Manual', 'Disabled'];

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

function rowMatchesChip(row: ServiceRow, chip: FilterChip): boolean {
  switch (chip) {
    case 'all':           return true;
    case 'running':       return row.status === 'Running';
    case 'stopped':       return row.status === 'Stopped';
    case 'auto':          return row.start_type === 'Automatic' || row.start_type === 'AutomaticDelayedStart';
    case 'manual':        return row.start_type === 'Manual';
    case 'disabled':      return row.start_type === 'Disabled';
    case 'load-bearing':  return row.load_bearing;
  }
}

function rowMatchesSearch(row: ServiceRow, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return row.key.toLowerCase().includes(needle)
      || row.display.toLowerCase().includes(needle)
      || row.description.toLowerCase().includes(needle);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Services() {
  const [services, setServices] = useState<ServiceRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<FilterChip>('all');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const r = await api.listAllServices();
    setLoading(false);
    if (r.ok) {
      setServices(r.data);
    } else {
      setLoadError(`${r.error.code}: ${r.error.message}`);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Refresh a single row in-place after a successful mutation, rather than
  // re-fetching the whole list (which is ~1s).
  const refreshRow = useCallback((key: string, after: { status: string; start_type?: string }) => {
    setServices((prev) => prev?.map((s) =>
      s.key === key
        ? { ...s, status: after.status, start_type: after.start_type ?? s.start_type }
        : s,
    ) ?? null);
  }, []);

  const filtered = useMemo(() => {
    if (!services) return [];
    return services.filter((s) => rowMatchesChip(s, chip) && rowMatchesSearch(s, search))
      .sort((a, b) => a.display.localeCompare(b.display));
  }, [services, chip, search]);

  // ── Mutate orchestration ────────────────────────────────────────────────
  const openConfirm = useCallback(async (
    service: ServiceRow,
    kind: ServiceMutateKind,
    startupTypeTarget?: ServiceStartType,
  ) => {
    // Open dialog with preview=null first so the user gets immediate
    // feedback, then populate with the dry-run result.
    setPending({ service, kind, startupTypeTarget, preview: null });

    let preview: ServicePreview | null = null;
    let runningDependents: string[] | undefined;
    try {
      let r;
      switch (kind) {
        case 'set-startup':
          r = await api.setServiceStartup(service.key, startupTypeTarget!, { dryRun: true });
          break;
        case 'stop':
          r = await api.stopService(service.key, { dryRun: true });
          break;
        case 'start':
          r = await api.startService(service.key, { dryRun: true });
          break;
      }
      if (r.ok) {
        preview = { before: r.data.before, after: r.data.after };
        if (Array.isArray(r.data.dependents_running)) runningDependents = r.data.dependents_running;
      } else {
        // Bail and surface the dry-run error inline.
        setPending(null);
        // eslint-disable-next-line no-alert
        alert(`Cannot proceed: ${r.error.code}: ${r.error.message}`);
        return;
      }
    } catch (e) {
      setPending(null);
      // eslint-disable-next-line no-alert
      alert(`Preview failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    setPending((cur) => cur ? { ...cur, preview, runningDependents } : null);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!pending) return;
    const { service, kind, startupTypeTarget } = pending;
    setBusyKey(service.key);
    setPending(null);
    try {
      let r;
      switch (kind) {
        case 'set-startup':
          r = await api.setServiceStartup(service.key, startupTypeTarget!);
          break;
        case 'stop':
          r = await api.stopService(service.key);
          break;
        case 'start':
          r = await api.startService(service.key);
          break;
      }
      if (r.ok) {
        refreshRow(service.key, r.data.after);
        if (typeof r.data.action_id === 'number') {
          setToast({
            actionId: r.data.action_id,
            message: kind === 'set-startup'
              ? `${service.display}: startup ${r.data.before.start_type} → ${r.data.after.start_type}`
              : kind === 'stop'
                ? `${service.display}: stopped`
                : `${service.display}: started`,
          });
        }
      } else {
        // eslint-disable-next-line no-alert
        alert(`Action failed: ${r.error.code}: ${r.error.message}`);
      }
    } finally {
      setBusyKey(null);
    }
  }, [pending, refreshRow]);

  const handleUndo = useCallback(async (actionId: number) => {
    const r = await api.undoServiceAction(actionId);
    if (r.ok) {
      // Refresh the affected row from the undo result.
      const after = r.data.after as { status: string; start_type?: string };
      refreshRow(r.data.service, after);
    } else {
      throw new Error(`${r.error.code}: ${r.error.message}`);
    }
  }, [refreshRow]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-bold text-text-primary">Services</h1>
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
          placeholder="Search by key, display name, or description…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-1.5 rounded-md bg-surface-800 border border-surface-600 text-text-primary text-xs"
          aria-label="Search services"
        />
        <span className="text-[11px] text-text-secondary whitespace-nowrap">
          {services ? `${filtered.length} / ${services.length}` : '—'}
        </span>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {(['all','running','stopped','auto','manual','disabled','load-bearing'] as FilterChip[]).map((c) => (
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
            {c === 'load-bearing' ? '⚠ system' : c}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="rounded-md border border-status-crit/40 bg-status-crit/10 px-3 py-2 text-xs text-text-primary">
          {loadError}
        </div>
      )}

      {!services && loading && (
        <div className="flex items-center gap-2 text-xs text-text-secondary py-6">
          <LoadingSpinner /> Enumerating services…
        </div>
      )}

      {services && (
        <div className="rounded-lg border border-surface-600 bg-surface-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-surface-700 text-text-secondary uppercase text-[10px] tracking-wider">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Display</th>
                <th className="text-left px-3 py-2 font-semibold">Key</th>
                <th className="text-left px-3 py-2 font-semibold">Status</th>
                <th className="text-left px-3 py-2 font-semibold">Startup</th>
                <th className="text-right px-3 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const busy = busyKey === s.key;
                return (
                  <tr key={s.key} className="border-t border-surface-700 hover:bg-surface-700/30">
                    <td className="px-3 py-2 text-text-primary">
                      {s.load_bearing && (
                        <span
                          title={s.load_bearing_reason ?? 'System service'}
                          className="inline-block mr-1.5 text-status-warn"
                        >⚠</span>
                      )}
                      {s.display}
                    </td>
                    <td className="px-3 py-2 text-text-secondary font-mono">{s.key}</td>
                    <td className="px-3 py-2">
                      <span className={
                        s.status === 'Running'
                          ? 'text-status-good'
                          : s.status === 'Stopped'
                            ? 'text-text-secondary'
                            : 'text-status-warn'
                      }>{s.status}</span>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={STARTUP_TYPES.includes(s.start_type as ServiceStartType) ? (s.start_type as ServiceStartType) : 'Manual'}
                        disabled={busy}
                        onChange={(e) => {
                          const target = e.target.value as ServiceStartType;
                          if (target !== s.start_type) void openConfirm(s, 'set-startup', target);
                        }}
                        className="bg-surface-700 border border-surface-600 rounded px-1.5 py-0.5 text-[11px] text-text-primary"
                        aria-label={`Startup type for ${s.display}`}
                      >
                        {STARTUP_TYPES.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-1.5">
                        <button
                          type="button"
                          disabled={busy || s.status === 'Running'}
                          onClick={() => void openConfirm(s, 'start')}
                          className="px-2 py-0.5 rounded border border-surface-600 text-[11px] text-text-secondary hover:bg-surface-700 disabled:opacity-30"
                          aria-label={`Start ${s.display}`}
                        >
                          ▶ Start
                        </button>
                        <button
                          type="button"
                          disabled={busy || s.status !== 'Running'}
                          onClick={() => void openConfirm(s, 'stop')}
                          className="px-2 py-0.5 rounded border border-surface-600 text-[11px] text-text-secondary hover:bg-surface-700 disabled:opacity-30"
                          aria-label={`Stop ${s.display}`}
                        >
                          ■ Stop
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && !loading && (
            <div className="p-6 text-center text-xs text-text-secondary">No services match the current filter.</div>
          )}
        </div>
      )}

      {pending && (
        <ServiceConfirmDialog
          open={true}
          service={pending.service}
          kind={pending.kind}
          startupTypeTarget={pending.startupTypeTarget}
          preview={pending.preview}
          loadBearing={pending.service.load_bearing}
          loadBearingReason={pending.service.load_bearing_reason}
          runningDependents={pending.runningDependents}
          onCancel={() => setPending(null)}
          onConfirm={handleConfirm}
        />
      )}

      {toast && (
        <ServiceUndoToast
          actionId={toast.actionId}
          message={toast.message}
          onUndo={handleUndo}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
