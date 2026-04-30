import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { usePoll } from './usePoll.js';
import { logPerf, markPerf } from '@renderer/lib/perfLog.js';
import type { SystemStatus, IpcError } from '@shared/types.js';

const POLL_INTERVAL_MS = 60_000;

// v2.4.36 (B43): Electron's window.focus event can fire repeatedly during a
// resize drag -- Chromium treats many native window-manipulation ticks as
// focus changes. Pre-v2.4.36 each focus event triggered a full getStatus
// refetch (file read + JSON parse + sync SQLite snapshot + notifier diff),
// which on Greg's box produced >1 minute of UI freeze while resizing.
// A leading-edge debounce collapses a storm of focus events into a single
// refetch per REFOCUS_DEBOUNCE_MS window. Genuine alt-tab returns still
// trigger the first refetch immediately.
const REFOCUS_DEBOUNCE_MS = 500;

// v2.5.13 cold-start mitigation: when the renderer mounts before the
// main-process startup-preload has populated the status cache, the first
// refetch returns E_BRIDGE_CACHE_EMPTY. Pre-v2.5.13 the user then waited
// up to POLL_INTERVAL_MS (60s) for the next regular tick. We retry every
// COLD_START_RETRY_MS (500ms) up to MAX_COLD_START_RETRIES (20 = 10s
// total) so the UI sees real data within ~1s of the preload completing
// instead of after a 60s gap. After max retries we stop and let usePoll
// take over -- a permanent E_BRIDGE_CACHE_EMPTY would indicate a deeper
// problem (refresh path broken, scanner not running) that polling at
// 500ms forever wouldn't fix anyway.
const COLD_START_RETRY_MS = 500;
const MAX_COLD_START_RETRIES = 20;

export function useStatus() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<IpcError | null>(null);
  const [loading, setLoading] = useState(true);
  const lastFocusRefetchRef = useRef(0);
  const coldStartRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coldStartRetryCountRef = useRef(0);

  // Wrapped in useCallback with empty deps so the closure identity is
  // stable across renders. The retry timer's setTimeout captures `refetch`;
  // without useCallback, React strict mode (which double-mounts in dev)
  // gives each mount its own ref objects, leaving timers from the first
  // mount calling into stale-mount refs the cleanup never sees. Stable
  // identity makes the strict-mode and prod paths behave identically.
  const refetch = useCallback(async (): Promise<SystemStatus | null> => {
    const r = await api.getStatus();
    if (r.ok) {
      setStatus(r.data);
      setError(null);
      // Cache populated — cancel any pending cold-start retry and reset
      // the retry counter so a future legitimate cache-empty (rare) gets
      // a fresh budget.
      if (coldStartRetryTimerRef.current) {
        clearTimeout(coldStartRetryTimerRef.current);
        coldStartRetryTimerRef.current = null;
      }
      coldStartRetryCountRef.current = 0;
      return r.data;
    }
    setError(r.error);
    if (
      r.error.code === 'E_BRIDGE_CACHE_EMPTY' &&
      coldStartRetryCountRef.current < MAX_COLD_START_RETRIES
    ) {
      coldStartRetryCountRef.current += 1;
      // Only one in-flight retry at a time -- clear any prior pending
      // retry before scheduling the next one. Prevents stacking when
      // refetch is called concurrently from usePoll + focus handler.
      if (coldStartRetryTimerRef.current) clearTimeout(coldStartRetryTimerRef.current);
      coldStartRetryTimerRef.current = setTimeout(() => {
        coldStartRetryTimerRef.current = null;
        void refetch();
      }, COLD_START_RETRY_MS);
    }
    return null;
  }, []);

  // Cancel any pending cold-start retry on unmount.
  useEffect(() => {
    return () => {
      if (coldStartRetryTimerRef.current) {
        clearTimeout(coldStartRetryTimerRef.current);
        coldStartRetryTimerRef.current = null;
      }
    };
  }, []);

  usePoll(async () => {
    await refetch();
    setLoading(false);
  }, POLL_INTERVAL_MS);

  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      // v2.4.38: log both accepted and dropped focus events so we can
      // see focus cadence during a resize drag (once window is unlocked
      // in v2.4.39). `dropped` is the v2.4.36 debounce behavior; we want
      // to confirm it actually kicks in during storms, not just in tests.
      if (now - lastFocusRefetchRef.current < REFOCUS_DEBOUNCE_MS) {
        logPerf('useStatus.focus.dropped', 0, {
          since_last_ms: now - lastFocusRefetchRef.current,
        });
        return;
      }
      lastFocusRefetchRef.current = now;
      const end = markPerf('useStatus.focus.refetch');
      void refetch().finally(() => end());
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return { status, error, loading, refetch };
}
