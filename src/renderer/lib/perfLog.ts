/**
 * Renderer-side perf telemetry helper (v2.4.38).
 *
 * Thin wrapper around the `window.api.logRenderPerf` preload bridge. Use
 * `markPerf(phase)` to get a stopwatch with an `end(extra?)` method, or
 * `logPerf(phase, ms, extra?)` for a direct log.
 *
 * Every call is fire-and-forget. Any error in the IPC layer is swallowed
 * so telemetry cannot break the UI code that emits it.
 *
 * Purpose: v2.4.39 resize-freeze diagnosis. v2.4.37 locked the window as
 * a ship-blocker; before we unlock in v2.4.39 we need data on where the
 * UI thread actually stalls. Main-process perf log (pcdoctorBridge) ruled
 * out getStatus / IPC. Remaining suspects are in the renderer.
 */

interface ApiWithPerf {
  logRenderPerf?: (
    phase: string,
    durationMs: number,
    extra?: Record<string, string | number | boolean>,
  ) => void;
}

function getApi(): ApiWithPerf | null {
  if (typeof window === 'undefined') return null;
  const w = window as typeof window & { api?: ApiWithPerf };
  return w.api ?? null;
}

// v2.4.38 (code-reviewer): self-throttling per phase so a render storm
// can't turn this telemetry into the bottleneck it's measuring. At 60fps
// resize drag with an unthrottled dep-less Dashboard.render useEffect,
// we'd queue 60+ IPC sends/sec + 60+ main-process appendFile calls/sec,
// which would show up as latency on OTHER IPC channels during the drag.
// The storm SIGNAL is still preserved: every phase logs at least once
// per 100ms, and the extra `dropped_since_last` counter on each log
// line tells us how many sends were collapsed in the window. That data
// is what we actually need for resize-freeze diagnosis.
const MIN_LOG_INTERVAL_MS = 100;
const _lastSentAt = new Map<string, number>();
const _droppedSinceLast = new Map<string, number>();

export function logPerf(
  phase: string,
  durationMs: number,
  extra?: Record<string, string | number | boolean>,
): void {
  try {
    const now = performance.now();
    const last = _lastSentAt.get(phase) ?? -Infinity;
    if (now - last < MIN_LOG_INTERVAL_MS) {
      _droppedSinceLast.set(phase, (_droppedSinceLast.get(phase) ?? 0) + 1);
      return;
    }
    const dropped = _droppedSinceLast.get(phase) ?? 0;
    _droppedSinceLast.set(phase, 0);
    _lastSentAt.set(phase, now);

    const api = getApi();
    const payload: Record<string, string | number | boolean> = { ...(extra ?? {}) };
    if (dropped > 0) payload.dropped_since_last = dropped;
    api?.logRenderPerf?.(phase, durationMs, payload);
  } catch {
    /* telemetry must never throw */
  }
}

/**
 * Start a stopwatch. Returns an `end()` function that logs the elapsed
 * time under `phase` when called. Callers MUST call `end()` exactly once;
 * no auto-cleanup on GC.
 */
export function markPerf(phase: string): (extra?: Record<string, string | number | boolean>) => void {
  const start = performance.now();
  return (extra) => {
    const elapsed = performance.now() - start;
    logPerf(phase, elapsed, extra);
  };
}
