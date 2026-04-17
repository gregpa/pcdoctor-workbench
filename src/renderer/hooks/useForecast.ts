import { useEffect, useState, useCallback } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { ForecastData } from '@shared/types.js';

export function useForecast() {
  const [data, setData] = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.getForecast();
    if (r.ok) { setData(r.data); setError(null); }
    else setError(r.error.message);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const regenerate = useCallback(async () => {
    setLoading(true);
    const r = await api.regenerateForecast();
    if (r.ok) { setData(r.data); setError(null); }
    else setError(r.error.message);
    setLoading(false);
  }, []);

  return { data, loading, error, regenerate };
}
