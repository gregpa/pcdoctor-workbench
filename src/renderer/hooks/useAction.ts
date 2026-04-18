import { useState, useCallback } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { ActionName, ActionResult, IpcError } from '@shared/types.js';

export function useAction() {
  const [running, setRunning] = useState<ActionName | null>(null);
  const [lastResult, setLastResult] = useState<ActionResult | null>(null);
  const [lastError, setLastError] = useState<IpcError | null>(null);

  const run = useCallback(async (req: { name: ActionName; params?: Record<string, string | number>; dry_run?: boolean }) => {
    setRunning(req.name);
    setLastError(null);
    try {
      const r = await api.runAction(req);
      if (r.ok) {
        setLastResult(r.data);
        if (!r.data.success && r.data.error) setLastError(r.data.error);
      } else {
        setLastError(r.error);
      }
    } finally {
      setRunning(null);
    }
  }, []);

  return { run, running, lastResult, lastError };
}
