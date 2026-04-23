import { useEffect, useRef, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { usePoll } from './usePoll.js';
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

export function useStatus() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<IpcError | null>(null);
  const [loading, setLoading] = useState(true);
  const lastFocusRefetchRef = useRef(0);

  const refetch = async (): Promise<SystemStatus | null> => {
    const r = await api.getStatus();
    if (r.ok) {
      setStatus(r.data);
      setError(null);
      return r.data;
    }
    setError(r.error);
    return null;
  };

  usePoll(async () => {
    await refetch();
    setLoading(false);
  }, POLL_INTERVAL_MS);

  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusRefetchRef.current < REFOCUS_DEBOUNCE_MS) return;
      lastFocusRefetchRef.current = now;
      void refetch();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return { status, error, loading, refetch };
}
