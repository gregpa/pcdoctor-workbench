import { useEffect, useState, useCallback } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { WeeklyReview } from '@shared/types.js';

export function useWeeklyReview(reviewDate?: string) {
  const [review, setReview] = useState<WeeklyReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  const load = useCallback(async (date?: string) => {
    setLoading(true);
    const [r, list] = await Promise.all([
      api.getWeeklyReview(date),
      api.listWeeklyReviews(),
    ]);
    if (r.ok) setReview(r.data);
    if (list.ok) setAvailableDates(list.data);
    setLoading(false);
  }, []);

  useEffect(() => { load(reviewDate); }, [load, reviewDate]);

  const dismissFlag = useCallback(async () => {
    await api.dismissWeeklyReviewFlag();
    await load(reviewDate);
  }, [load, reviewDate]);

  const setItemState = useCallback(async (itemId: string, state: string, appliedActionId?: number) => {
    if (!review) return;
    await api.setWeeklyReviewItemState(review.review_date, itemId, state, appliedActionId);
    await load(review.review_date);
  }, [review, load]);

  const archiveToObsidian = useCallback(async () => {
    if (!review) return { ok: false as const, error: { code: 'E_NO_REVIEW', message: 'No review' } };
    return await api.archiveWeeklyReviewToObsidian(review.review_date);
  }, [review]);

  return { review, loading, availableDates, dismissFlag, refresh: () => load(reviewDate), setItemState, archiveToObsidian };
}
