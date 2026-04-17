import { useEffect, useState, useCallback } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { WeeklyReview } from '@shared/types.js';

export function useWeeklyReview() {
  const [review, setReview] = useState<WeeklyReview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const r = await api.getWeeklyReview();
    if (r.ok) setReview(r.data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const dismissFlag = useCallback(async () => {
    await api.dismissWeeklyReviewFlag();
    await load();
  }, [load]);

  return { review, loading, dismissFlag, refresh: load };
}
