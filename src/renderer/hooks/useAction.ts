import { useState, useCallback } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { ActionName, ActionResult, IpcError } from '@shared/types.js';

export interface UseActionOptions {
  /** When true (default), triggers a background scan and polls for a fresh status after a successful action. */
  autoRefresh?: boolean;
  /** Called when getStatus generated_at advances post-action. Receives the fresh status. */
  onRefresh?: (freshStatus: unknown) => void;
}

export function useAction(options: UseActionOptions = {}) {
  const { autoRefresh = true, onRefresh } = options;
  const [running, setRunning] = useState<ActionName | null>(null);
  const [lastResult, setLastResult] = useState<ActionResult | null>(null);
  const [lastError, setLastError] = useState<IpcError | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const run = useCallback(async (req: { name: ActionName; params?: Record<string, string | number>; dry_run?: boolean }): Promise<IpcError | null> => {
    setRunning(req.name);
    setLastError(null);
    let err: IpcError | null = null;
    let actionSucceeded = false;
    try {
      const r = await api.runAction(req);
      if (r.ok) {
        setLastResult(r.data);
        actionSucceeded = r.data.success;
        // Expose no_op flag so callers (Dashboard) can show appropriate toast
        (window as any).__lastActionResult = r.data.result ?? null;
        if (!r.data.success && r.data.error) {
          err = r.data.error;
          setLastError(err);
        }
      } else {
        err = r.error;
        setLastError(err);
      }
    } catch (e: any) {
      // v2.4.51 (B51-HOOK-1): a thrown invoke (channel missing, preload
      // crashed) was leaving `running` stuck on the action name forever
      // because the existing finally only reset it but no catch surfaced
      // the error. Now both states resolve.
      err = { code: 'E_INVOKE_FAILED', message: e?.message ?? 'IPC invoke threw' };
      setLastError(err);
    } finally {
      setRunning(null);
    }

    // Auto-refresh: kick off a background scan and poll for new generated_at (max 90s).
    if (actionSucceeded && autoRefresh && !req.dry_run) {
      setRefreshing(true);
      try {
        const scanResult = await api.runScheduledTaskNow('PCDoctor-Daily-Quick');
        if (scanResult.ok) {
          let beforeTs = 0;
          try {
            const beforeStatus = await api.getStatus();
            beforeTs = beforeStatus.ok ? beforeStatus.data.generated_at : 0;
          } catch {
            // v2.4.51 (B51-HOOK-1): if the initial getStatus throws, treat
            // the baseline as 0 so the first successful poll wins.
            beforeTs = 0;
          }
          const deadline = Date.now() + 90_000;
          const poll = async (): Promise<void> => {
            if (Date.now() > deadline) {
              setRefreshing(false);
              return;
            }
            try {
              const fresh = await api.getStatus();
              if (fresh.ok && fresh.data.generated_at > beforeTs) {
                setRefreshing(false);
                window.dispatchEvent(new CustomEvent('statusRefreshed', { detail: fresh.data }));
                if (onRefresh) onRefresh(fresh.data);
                return;
              }
            } catch {
              // v2.4.51 (B51-HOOK-1): single-poll throw shouldn't kill the
              // refresh state; deadline-exceeded path will resolve.
            }
            setTimeout(poll, 3_000);
          };
          setTimeout(poll, 3_000);
        } else {
          setRefreshing(false);
        }
      } catch {
        // v2.4.51 (B51-HOOK-1): thrown invoke during auto-refresh setup.
        // Never leave `refreshing` stuck on true.
        setRefreshing(false);
      }
    }

    return err;
  }, [autoRefresh, onRefresh]);

  return { run, running, lastResult, lastError, refreshing };
}
