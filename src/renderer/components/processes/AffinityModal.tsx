/**
 * AffinityModal (v2.5.38)
 *
 * CPU-grid checkbox panel for setting process affinity. Opens from the
 * Processes page row's "🧮 CPU" button. Fetches current affinity from
 * api.getProcessDetail (so the checkboxes pre-fill with the live mask),
 * lets the user toggle individual logical CPUs, and writes the new mask
 * via api.setProcessAffinity (single UAC if the elevated worker isn't
 * already running).
 *
 * Background: api:setProcessAffinity has shipped since v2.5.30 but the
 * UI was deferred -- power-user feature, low frequency. Greg asked to
 * complete it 2026-05-06.
 *
 * Bitmask convention matches Win32: bit N = "process may run on logical
 * CPU N". Mask of 0 is illegal (process must be runnable on at least one
 * CPU); the Apply button is disabled when no checkboxes are selected.
 *
 * Not exposed: full hardware grouping (P-cores vs E-cores on Intel 12th
 * gen+, NUMA nodes, hyperthreading siblings). Renderer just shows N
 * boxes from 0 to navigator.hardwareConcurrency-1.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@renderer/lib/ipc.js';
import type { ProcessDetail } from '@shared/types.js';

export interface AffinityModalProps {
  pid: number;
  name: string;
  systemCritical: boolean;
  onClose: () => void;
  onApplied?: (newMask: number) => void;
}

function maskToSet(mask: number, n: number): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < n; i++) {
    if ((mask >>> i) & 1) s.add(i);
  }
  return s;
}

function setToMask(set: Set<number>): number {
  let mask = 0;
  for (const i of set) {
    mask |= (1 << i);
  }
  return mask >>> 0;  // unsigned 32-bit
}

export function AffinityModal({ pid, name, systemCritical, onClose, onApplied }: AffinityModalProps) {
  const cpuCount = useMemo(() => {
    return typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 8;
  }, []);

  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => {
    // Default: all CPUs selected. Will be overridden by the IPC fetch.
    const s = new Set<number>();
    for (let i = 0; i < 64; i++) s.add(i);
    return s;
  });
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Fetch current affinity on mount.
  useEffect(() => {
    let cancelled = false;
    void api.getProcessDetail(pid).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setDetail(r.data);
        if (typeof r.data.affinity_mask === 'number') {
          setSelected(maskToSet(r.data.affinity_mask, cpuCount));
        }
      } else {
        setLoadError(`${r.error.code}: ${r.error.message}`);
      }
    });
    return () => { cancelled = true; };
  }, [pid, cpuCount]);

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  function selectAll() {
    const s = new Set<number>();
    for (let i = 0; i < cpuCount; i++) s.add(i);
    setSelected(s);
  }

  async function apply() {
    if (selected.size === 0) return;
    setBusy(true);
    setApplyError(null);
    const mask = setToMask(selected);
    const r = await api.setProcessAffinity(pid, mask);
    setBusy(false);
    if (r.ok) {
      onApplied?.(mask);
      onClose();
    } else {
      setApplyError(`${r.error.code}: ${r.error.message}`);
    }
  }

  // Layout: 8 columns, wraps to multiple rows for >8 CPUs.
  const cols = Math.min(cpuCount, 8);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        className="pcd-modal w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 p-5 border-b border-surface-600">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-text-secondary font-semibold">CPU Affinity</div>
            <div className="text-sm font-semibold text-text-primary mt-0.5 truncate">
              {name} <span className="text-text-secondary font-mono text-xs">(PID {pid})</span>
            </div>
            <div className="text-xs text-text-secondary mt-0.5">
              Pin this process to specific logical CPUs. Changes take effect immediately.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-text-secondary hover:text-text-primary text-xl leading-none px-2">×</button>
        </div>

        <div className="p-5 space-y-4 text-xs">
          {loadError && (
            <div className="rounded-md border border-status-crit/40 bg-status-crit/10 px-3 py-2 text-text-primary">
              {loadError}
            </div>
          )}
          {systemCritical && (
            <div className="rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-text-primary">
              ⚠ This is a system-critical process. Restricting its CPUs can destabilize Windows.
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-text-secondary">
                Logical CPUs ({cpuCount} detected){detail && typeof detail.affinity_mask === 'number' && (
                  <span className="ml-2 font-mono text-[10px]">current mask: 0x{detail.affinity_mask.toString(16)}</span>
                )}
              </div>
              <button
                type="button"
                onClick={selectAll}
                className="px-2 py-0.5 rounded text-[10px] pcd-button"
              >
                Select all
              </button>
            </div>
            <div
              className="grid gap-1.5"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: cpuCount }, (_, i) => {
                const checked = selected.has(i);
                return (
                  <label
                    key={i}
                    className={`flex items-center justify-center gap-1.5 rounded border px-2 py-1.5 cursor-pointer text-[11px] ${
                      checked
                        ? 'bg-status-info/20 border-status-info/50 text-text-primary'
                        : 'border-surface-600 text-text-secondary hover:bg-surface-700'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(i)}
                      className="w-3 h-3"
                      aria-label={`CPU ${i}`}
                    />
                    <span className="font-mono">CPU {i}</span>
                  </label>
                );
              })}
            </div>
            <div className="mt-2 text-[10px] text-text-secondary font-mono">
              new mask: {selected.size === 0 ? <span className="text-status-crit">illegal (no CPUs selected)</span> : `0x${setToMask(selected).toString(16)}`}
              {' '}({selected.size} of {cpuCount} CPUs)
            </div>
          </div>

          {applyError && (
            <div className="rounded-md border border-status-crit/40 bg-status-crit/10 px-3 py-2 text-text-primary">
              {applyError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-surface-600">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-surface-600 text-text-secondary text-xs hover:bg-surface-700"
          >
            Cancel
          </button>
          <button
            onClick={() => { void apply(); }}
            disabled={busy || selected.size === 0}
            title={selected.size === 0 ? 'At least one CPU must be selected' : 'Apply the affinity mask (single UAC if the worker is not running)'}
            className="px-3 py-1.5 rounded-md bg-status-info text-white text-xs font-semibold disabled:opacity-40"
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
