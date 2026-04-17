import { useEffect, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { Trend } from '@shared/types.js';

export function useTrend(category: string, metric: string, days = 7) {
  const [trend, setTrend] = useState<Trend | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await api.getTrend({ category, metric, days });
      if (!cancelled) {
        if (r.ok) setTrend(r.data);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [category, metric, days]);

  return { trend, loading };
}
