/**
 * NasRecycleBinPanel (v2.4.13)
 *
 * Dashboard tile showing per-NAS-drive storage (used / free) plus a
 * one-click "Empty @Recycle" button per drive. Auto-discovers drives
 * from Win32_LogicalDisk DriveType=4 (network), so any letter mapped
 * outside the app's Settings page still appears here.
 *
 * Placement: under the gauge row, same column width as the CPU+RAM+Disk
 * gauges, so it picks up the "drive storage" visual theme Greg asked for.
 *
 * Actions are destructive and routed through the standard confirm flow
 * (ActionResultModal via the parent Dashboard's handleAction). We do NOT
 * offer a single "empty all" button - too easy to misclick when six
 * 14 TB shares are on screen.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ActionResult, IpcResult } from '@shared/types.js';

export interface NasDrive {
  letter: string;              // "M:"
  unc: string | null;          // "\\\\server\\share" or null
  used_bytes: number | null;
  free_bytes: number | null;
  total_bytes: number | null;
  recycle_bytes: number | null;
  reachable: boolean;
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
  if (pct === null) return 'bg-surface-600';
  if (pct >= 95) return 'bg-status-critical';
  if (pct >= 85) return 'bg-status-warn';
  return 'bg-status-info';
}

export function NasRecycleBinPanel({ onEmptyDrive, refreshToken = 0 }: NasRecycleBinPanelProps) {
  const [drives, setDrives] = useState<NasDrive[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  if (drives === null && !error) {
    return (
      <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 mb-3">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">
          NAS Drives
        </div>
        <div className="text-[11px] text-text-secondary">Enumerating network drives...</div>
      </div>
    );
  }

  if (error && (drives === null || drives.length === 0)) {
    return (
      <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 mb-3">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">
          NAS Drives
        </div>
        <div className="text-[11px] text-status-warn">{error}</div>
      </div>
    );
  }

  if (drives && drives.length === 0) {
    return (
      <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 mb-3">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">
          NAS Drives
        </div>
        <div className="text-[11px] text-text-secondary">No network drives mapped.</div>
      </div>
    );
  }

  return (
    <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold flex items-center gap-1">
          <span>🖧</span><span>NAS Drives</span>
        </div>
        <button
          onClick={() => void load()}
          className="text-[10px] text-text-secondary hover:text-text-primary underline-offset-2 hover:underline"
          aria-label="Refresh NAS drive list"
        >
          Refresh
        </button>
      </div>

      <div className="space-y-1.5">
        {(drives ?? []).map((d) => {
          const pct = pctUsed(d);
          const isOffline = !d.reachable;
          return (
            <div
              key={d.letter}
              className={`border border-surface-700 rounded-md p-2 ${isOffline ? 'opacity-50' : ''}`}
              title={d.unc ?? undefined}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-[12px] font-semibold w-10">{d.letter}</span>
                <span className="text-[10px] text-text-secondary flex-1 truncate">
                  {d.unc ?? (isOffline ? '(unreachable)' : 'local reference only')}
                </span>
                <span className="text-[10px] text-text-secondary whitespace-nowrap">
                  {isOffline
                    ? 'offline'
                    : `${fmtBytes(d.used_bytes)} / ${fmtBytes(d.total_bytes)}`}
                </span>
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
        @Recycle is the QNAP/Synology per-share recycle bin. Emptying is irreversible.
      </div>
    </div>
  );
}
