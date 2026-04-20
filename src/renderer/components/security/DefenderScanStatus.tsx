import { useEffect, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';

interface DefenderScanStatusData {
  available: boolean;
  realtime_protection: boolean | null;
  quick_scan_running: boolean;
  full_scan_running: boolean;
  quick_scan_start_time: string | null;
  quick_scan_end_time: string | null;
  full_scan_start_time: string | null;
  full_scan_end_time: string | null;
  quick_scan_age_hours: number | null;
  full_scan_age_days: number | null;
  scan_elapsed_minutes: number | null;
  typical_quick_min: number;
  typical_full_min: number;
}

/**
 * Displays a prominent banner when a Defender scan is running.
 * - Polls every 10s while a scan is active, every 60s when idle.
 * - Caps the progress bar at 95% (we never truly know ETA).
 * - Turns amber + shimmer once elapsed > typical_*_min.
 */
export function DefenderScanStatus() {
  const [data, setData] = useState<DefenderScanStatusData | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      let nextDelay = 60_000;  // default to the idle cadence
      try {
        const r = await api.getDefenderScanStatus();
        if (cancelled) return;
        if (r.ok) {
          const d = r.data as DefenderScanStatusData;
          setData(d);
          if (d.quick_scan_running || d.full_scan_running) nextDelay = 10_000;
        }
      } catch { /* ignore transient errors */ }

      if (cancelled) return;
      timer = setTimeout(tick, nextDelay);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data || !data.available) return null;
  if (!data.quick_scan_running && !data.full_scan_running) return null;

  const isFull = data.full_scan_running;
  const kind = isFull ? 'Full Scan' : 'Quick Scan';
  const typicalMin = isFull ? data.typical_full_min : data.typical_quick_min;
  const elapsed = data.scan_elapsed_minutes ?? 0;

  const rawPct = typicalMin > 0 ? (elapsed / typicalMin) * 100 : 0;
  const cappedPct = Math.min(95, Math.max(1, rawPct));
  const overrun = elapsed > typicalMin;

  const barClass = overrun
    ? 'bg-status-warn animate-pulse'
    : 'bg-status-info';
  const borderClass = overrun
    ? 'border-status-warn/50 bg-status-warn/10'
    : 'border-status-info/50 bg-status-info/10';

  return (
    <div className={`mb-3 p-3 rounded-lg border ${borderClass}`}>
      <div className="flex justify-between items-start">
        <div>
          <div className="text-sm font-semibold">
            {isFull ? '🔍' : '🛡'} Defender {kind} in progress
          </div>
          <div className="text-[11px] text-text-secondary mt-0.5">
            Elapsed: <strong>{elapsed.toFixed(1)} min</strong> / typical <strong>{typicalMin} min</strong>
            {overrun && <span className="ml-2 text-status-warn font-semibold">· OVERRUN</span>}
          </div>
        </div>
        <div className="text-[10px] text-text-secondary">
          Polling every 10s
        </div>
      </div>
      <div className="mt-2 h-2 w-full bg-surface-900 rounded-full overflow-hidden">
        <div
          className={`h-full ${barClass} transition-[width] duration-500`}
          style={{ width: `${cappedPct}%` }}
        />
      </div>
    </div>
  );
}
