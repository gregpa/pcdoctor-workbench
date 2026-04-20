import { useEffect, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { usePoll } from './usePoll.js';
import type { SystemStatus, IpcError } from '@shared/types.js';

const POLL_INTERVAL_MS = 60_000;

export function useStatus() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<IpcError | null>(null);
  const [loading, setLoading] = useState(true);

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
    // Refresh on window focus too
    const onFocus = () => { void refetch(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return { status, error, loading, refetch };
}
