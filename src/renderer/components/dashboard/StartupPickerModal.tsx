/**
 * StartupPickerModal (v2.3.0 - C1)
 *
 * Multi-select UI for disabling Windows startup entries. Pulls the list from
 * status.metrics.startup_items (emitted by Invoke-PCDoctor.ps1). Pre-checks any
 * entry NOT flagged is_essential, pre-unchecks the essential/protected ones.
 *
 * Emits the final picks via onDisable — caller wires that into the
 * `disable_startup_items_batch` action (params { items_json }).
 */
import { useMemo, useState } from 'react';
import type { StartupItemMetric } from '@shared/types.js';

export interface StartupPick {
  kind: StartupItemMetric['kind'];
  name: string;
}

export interface StartupPickerModalProps {
  items: StartupItemMetric[];
  onClose: () => void;
  onDisable: (picks: StartupPick[]) => void | Promise<void>;
  /** Threshold below which the scanner considers startup count healthy. */
  threshold?: number;
}

function fmtSize(n?: number): string {
  if (!n || !Number.isFinite(n)) return '—';
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function locationLabel(kind: StartupItemMetric['kind']): string {
  switch (kind) {
    case 'Run': return 'HKCU\\...\\Run';
    case 'HKLM_Run': return 'HKLM\\...\\Run';
    case 'StartupFolder': return 'Startup folder';
    default: return String(kind);
  }
}

export function StartupPickerModal({ items, onClose, onDisable, threshold = 20 }: StartupPickerModalProps) {
  // Filter to entries not yet disabled in the registry.
  const enabled = useMemo(() => items.filter(i => !i.disabled_in_registry), [items]);

  // Preselection: check non-essential entries, uncheck essential ones.
  const initialPicks = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const it of enabled) {
      out[`${it.kind}::${it.name}`] = !it.is_essential;
    }
    return out;
  }, [enabled]);
  const [picks, setPicks] = useState<Record<string, boolean>>(initialPicks);

  const toggleKey = (key: string) => setPicks(p => ({ ...p, [key]: !p[key] }));

  const selectedCount = Object.values(picks).filter(Boolean).length;
  const remaining = enabled.length - selectedCount;
  const thresholdNote = remaining <= threshold
    ? `brings startup count to ${remaining} (under ${threshold} threshold ✓)`
    : `brings startup count to ${remaining} (still above ${threshold})`;

  async function handleDisable() {
    const selected: StartupPick[] = enabled
      .filter(it => picks[`${it.kind}::${it.name}`])
      .map(it => ({ kind: it.kind, name: it.name }));
    if (selected.length === 0) return;
    await onDisable(selected);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Disable startup items"
    >
      <div
        className="bg-surface-800 border border-surface-600 rounded-lg w-full max-w-3xl p-5 shadow-2xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-1 flex items-center gap-2">
          <span>🚫</span><span>Disable startup items</span>
        </h2>
        <div className="text-[11px] text-text-secondary mb-3">
          {enabled.length} enabled entries. Protected/essential apps are pre-unchecked;
          everything else is pre-checked. Review before disabling.
        </div>

        <div className="overflow-auto border border-surface-700 rounded-lg flex-1">
          <table className="w-full text-[11px]">
            <thead className="bg-surface-700 text-text-secondary text-[10px] uppercase tracking-wider sticky top-0">
              <tr>
                <th className="text-left px-2 py-1.5 w-8"></th>
                <th className="text-left px-2 py-1.5 w-6"></th>
                <th className="text-left px-2 py-1.5">Name</th>
                <th className="text-left px-2 py-1.5">Location</th>
                <th className="text-left px-2 py-1.5">Publisher</th>
                <th className="text-right px-2 py-1.5">Size</th>
                <th className="text-left px-2 py-1.5 w-20">Role</th>
              </tr>
            </thead>
            <tbody>
              {enabled.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-text-secondary">
                    No enabled startup items found in the current scan. Run a scan first.
                  </td>
                </tr>
              )}
              {enabled.map((it) => {
                const key = `${it.kind}::${it.name}`;
                return (
                  <tr
                    key={key}
                    className="border-t border-surface-700 hover:bg-surface-700/40 cursor-pointer"
                    onClick={() => toggleKey(key)}
                  >
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Disable ${it.name}`}
                        checked={!!picks[key]}
                        onChange={() => toggleKey(key)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-text-secondary">
                      {it.is_essential ? '🛡' : '•'}
                    </td>
                    <td className="px-2 py-1.5 font-mono">{it.name}</td>
                    <td className="px-2 py-1.5 text-text-secondary">{locationLabel(it.kind)}</td>
                    <td className="px-2 py-1.5 text-text-secondary truncate max-w-[160px]">{it.publisher ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right text-text-secondary">{fmtSize(it.size_bytes)}</td>
                    <td className="px-2 py-1.5">
                      {it.is_essential ? (
                        <span className="text-[10px] text-status-good">protected</span>
                      ) : (
                        <span className="text-[10px] text-text-secondary">optional</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 text-[11px] text-text-secondary">
          Disabling <span className="font-semibold text-text-primary">{selectedCount}</span> of
          {' '}<span className="font-semibold text-text-primary">{enabled.length}</span> {thresholdNote}
        </div>

        <div className="flex justify-end gap-2 mt-3 pt-3 border-t border-surface-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600"
          >
            Cancel
          </button>
          <button
            onClick={handleDisable}
            disabled={selectedCount === 0}
            className="px-3 py-1.5 rounded-md text-xs bg-status-warn text-black font-semibold disabled:opacity-50"
          >
            Disable Selected ({selectedCount})
          </button>
        </div>
      </div>
    </div>
  );
}
