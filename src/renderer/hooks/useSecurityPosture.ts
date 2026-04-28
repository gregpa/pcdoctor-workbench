import { useEffect, useState, useCallback } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { SecurityPosture } from '@shared/types.js';

export function useSecurityPosture() {
  const [data, setData] = useState<SecurityPosture | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getSecurityPosture();
      if (r.ok) { setData(r.data); setError(null); }
      else setError(r.error.message);
    } catch (e: any) {
      // v2.4.51 (B51-HOOK-1): a thrown invoke (preload crashed, channel
      // missing) used to leave loading=true forever. Now both states
      // resolve and the user sees an actionable error.
      setError(e?.message ?? 'Security posture invoke failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const approve = useCallback(async (identifier: string, approve: boolean) => {
    await api.approvePersistence(identifier, approve);
    await load();
  }, [load]);

  return { data, loading, error, refresh: load, approve };
}
