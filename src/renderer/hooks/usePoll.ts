import { useEffect, useRef } from 'react';

/** Invokes `fn` immediately, then every `intervalMs` while mounted. */
export function usePoll(fn: () => void | Promise<void>, intervalMs: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        await fnRef.current();
      } catch {
        // v2.4.51 (B51-HOOK-1): a thrown polled fn must not break the
        // interval. The caller is responsible for any user-visible error
        // state — this hook just keeps polling.
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);
}
