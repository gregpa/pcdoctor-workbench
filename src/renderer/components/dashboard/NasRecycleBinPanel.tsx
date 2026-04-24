/**
 * NasRecycleBinPanel (v2.4.13; v2.4.14 expanded to all drives;
 *                    v2.4.17 collapsible)
 *
 * Dashboard tile showing per-drive storage (used / free) plus a
 * one-click "Empty @Recycle" button on NAS drives. Auto-discovers every
 * Win32_LogicalDisk with DriveType in {2, 3, 4}:
 *   - 3 (local fixed): C:, D:, E:(Google Drive File Stream), J:(Elements)
 *   - 2 (removable):   F:(GoldKey), G:(portable USB)
 *   - 4 (network):     B:, M:, U:, V:, W:, Z: (QNAP shares)
 *
 * Placement: under the gauge row, so it sits in the "drive storage"
 * visual region of the dashboard.
 *
 * Trash button is NAS-only (unc populated + recycle_bytes > 0). Local
 * drives show a "local" badge instead - the existing empty_recycle_bins
 * Quick Action handles $Recycle.Bin on fixed drives in bulk.
 *
 * Actions are destructive and routed through the standard confirm flow
 * (ActionResultModal via the parent Dashboard's handleAction). We do NOT
 * offer a single "empty all" button - too easy to misclick when six
 * 14 TB shares are on screen.
 *
 * v2.4.17: collapsible via the header chevron. Collapsed state persists
 * in localStorage (keyed 'pcdoctor:drives-panel-collapsed') so it
 * survives app restarts. When collapsed the header stays visible with
 * a "N drives" summary so the user can tell at a glance how many
 * entries are hidden.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ActionResult, IpcResult } from '@shared/types.js';

export interface NasDrive {
  letter: string;              // "M:"
  unc: string | null;          // "\\\\server\\share" for network; null for local
  used_bytes: number | null;
  free_bytes: number | null;
  total_bytes: number | null;
  /** For network drives: size of {L}:\@Recycle. For local: always null
   *  (the trash button is NAS-only; local $Recycle.Bin is handled via
   *  the existing empty_recycle_bins action). */
  recycle_bytes: number | null;
  reachable: boolean;
  /** v2.4.14: volume label for local drives (e.g. "OS", "Elements").
   *  Optional + always null for network drives. */
  volume_name?: string | null;
  /** v2.4.14: 'network' | 'local' | 'removable'. Drives the UI badge. */
  kind?: 'network' | 'local' | 'removable';
}

interface NasApi {
  getNasDrives?: () => Promise<IpcResult<NasDrive[]>>;
}

export interface NasRecycleBinPanelProps {
  /** Called when user confirms an empty action. Parent handles the
   *  confirm modal + actionRunner call; we just emit the intent. */
  onEmptyDrive: (driveLetter: string) => Promise<ActionResult | void>;
  /** Reload trigger - parent bumps this after an empty succeeds so the
   *  panel refetches drive sizes. */
  refreshToken?: number;
}

function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024)      return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function pctUsed(d: NasDrive): number | null {
  if (d.total_bytes === null || d.total_bytes === 0) return null;
  if (d.used_bytes === null) return null;
  return Math.round((d.used_bytes / d.total_bytes) * 100);
}

function severityClass(pct: number | null): string {
  // v2.4.14: Tailwind config names this color 'status-crit' (not -critical).
  // Previous 'bg-status-critical' class was missing, which silently rendered
  // no bar for 95%+ drives (M:/U:/Z: on Greg's box showed blank).
  // Thresholds: <80 info (blue), 80-94 warn (yellow), >=95 crit (red).
  if (pct === null) return 'bg-surface-600';
  if (pct >= 95) return 'bg-status-crit';
  if (pct >= 80) return 'bg-status-warn';
  return 'bg-status-info';
}

const COLLAPSE_KEY = 'pcdoctor:drives-panel-collapsed';

export function NasRecycleBinPanel({ onEmptyDrive, refreshToken = 0 }: NasRecycleBinPanelProps) {
  const [drives, setDrives] = useState<NasDrive[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // v2.4.17: collapsed state lives in localStorage so it sticks across
  // app restarts. Lazy init reads the saved value once.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* storage denied */ }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    const api = (window as unknown as { api?: NasApi }).api;
    if (!api?.getNasDrives) {
      setError('NAS API unavailable in this build');
      return;
    }
    setError(null);
    try {
      const r = await api.getNasDrives();
      if (r.ok) {
        setDrives(r.data);
      } else {
        setError(r.error?.message ?? 'Failed to load NAS drives');
        setDrives([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDrives([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const handleEmpty = useCallback(async (drive: NasDrive) => {
    const letter = drive.letter.replace(':', '');
    setBusy(drive.letter);
    try {
      await onEmptyDrive(letter);
      // W4 fix: parent (Dashboard) bumps refreshToken after the PS action
      // completes, which re-fires our useEffect -> load(). An explicit
      // load() here would just duplicate that refetch. Parent is the
      // single source of truth for "when to refresh".
    } finally {
      setBusy(null);
    }
  }, [onEmptyDrive]);

  // v2.4.17: header is rendered in every state (loading / error / empty /
  // populated) so the collapse chevron is always reachable. Body content
  // below the header is conditionally rendered based on `collapsed`.
  const loadingBody = drives === null && !error;
  const errorBody = error && (drives === null || drives.length === 0);
  const emptyBody = drives && drives.length === 0;

  // Summary shown next to the header when collapsed so the panel is
  // useful even folded. Counts drives with >= 80% usage to surface
  // anything needing attention.
  const nearFullCount = (drives ?? []).filter((d) => {
    const pct = pctUsed(d);
    return pct !== null && pct >= 80;
  }).length;
  const headerSummary = drives
    ? nearFullCount > 0
      ? `${drives.length} drives (${nearFullCount} 80%+)`
      : `${drives.length} drives`
    : loadingBody
      ? 'loading...'
      : errorBody
        ? 'error'
        : '';

  return (
    <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 panel-contain mb-3">
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand Drives & Storage' : 'Collapse Drives & Storage'}
          className="text-[9.5px] uppercase tracking-wider text-text-secondary hover:text-text-primary font-semibold flex items-center gap-1.5"
        >
          <span className="text-xs">{collapsed ? '▸' : '▾'}</span>
          <span>🖧</span>
          <span>Drives &amp; Storage</span>
          {headerSummary && (
            <span className="ml-1 normal-case tracking-normal text-text-secondary font-normal">
              - {headerSummary}
            </span>
          )}
        </button>
        {!collapsed && (
          <button
            onClick={() => void load()}
            className="text-[10px] text-text-secondary hover:text-text-primary underline-offset-2 hover:underline"
            aria-label="Refresh drive list"
          >
            Refresh
          </button>
        )}
      </div>

      {collapsed ? null : loadingBody ? (
        <div className="text-[11px] text-text-secondary">Enumerating drives...</div>
      ) : errorBody ? (
        <div className="text-[11px] text-status-warn">{error}</div>
      ) : emptyBody ? (
        <div className="text-[11px] text-text-secondary">No drives detected.</div>
      ) : (
        <>
          <div className="space-y-1.5">
            {(drives ?? []).map((d) => {
              const pct = pctUsed(d);
              // v2.4.14: network drives have a unc; local drives don't. Only
              // network drives carry the @Recycle trash button - local drives
              // use $Recycle.Bin via the existing empty_recycle_bins action.
              const isNetwork = d.kind === 'network' || (d.unc !== null && d.unc !== undefined);
              const isOffline = isNetwork && !d.reachable;
              const displayPath = d.unc ?? d.volume_name ?? null;
              const kindLabel = isNetwork ? 'NAS' : d.kind === 'removable' ? 'USB' : 'Local';
              const kindBadgeClass = isNetwork
                ? 'bg-status-info/20 text-status-info border-status-info/40'
                : 'bg-surface-700 text-text-secondary border-surface-600';

              return (
                <div
                  key={d.letter}
                  className={`border border-surface-700 rounded-md p-2 ${isOffline ? 'opacity-50' : ''}`}
                  title={displayPath ?? undefined}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[12px] font-semibold w-10">{d.letter}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide border ${kindBadgeClass}`}>
                      {kindLabel}
                    </span>
                    <span className="text-[10px] text-text-secondary flex-1 truncate">
                      {displayPath ?? (isOffline ? '(unreachable)' : '(no label)')}
                    </span>
                    <span className="text-[10px] text-text-secondary whitespace-nowrap">
                      {isOffline
                        ? 'offline'
                        : `${fmtBytes(d.used_bytes)} / ${fmtBytes(d.total_bytes)}`}
                    </span>
                    {isNetwork ? (
                      <button
                        type="button"
                        onClick={() => void handleEmpty(d)}
                        disabled={isOffline || busy === d.letter || (d.recycle_bytes ?? 0) === 0}
                        title={isOffline
                          ? 'Drive offline'
                          : (d.recycle_bytes ?? 0) === 0
                            ? '@Recycle is empty or missing'
                            : `Empty ${d.letter}\\@Recycle (${fmtBytes(d.recycle_bytes)})`}
                        className="px-2 py-1 rounded-md text-[10px] bg-status-warn/20 border border-status-warn/50 text-status-warn hover:bg-status-warn/30 disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        {busy === d.letter ? '...' : `🗑 ${fmtBytes(d.recycle_bytes)}`}
                      </button>
                    ) : (
                      // Placeholder keeps row heights aligned when mixing local
                      // + network drives. The existing "Empty All Recycle Bins"
                      // Quick Action is where local $Recycle.Bin cleanup lives.
                      <span className="text-[10px] text-text-secondary italic whitespace-nowrap w-[72px] text-right">-</span>
                    )}
                  </div>
                  <div className="relative h-1 w-full rounded bg-surface-700 overflow-hidden">
                    <div
                      className={`absolute left-0 top-0 bottom-0 ${severityClass(pct)}`}
                      style={{ width: pct === null ? 0 : `${Math.min(100, Math.max(0, pct))}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-2 text-[9.5px] text-text-secondary italic">
            Used-pct bar: blue under 80%, yellow 80-94%, red 95%+. @Recycle empty
            targets NAS drives only (QNAP/Synology per-share bin); use "Empty All
            Recycle Bins" in Quick Actions for local $Recycle.Bin. Irreversible.
          </div>
        </>
      )}
    </div>
  );
}
